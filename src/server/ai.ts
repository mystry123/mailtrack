import { GoogleAuth } from 'google-auth-library';
import { env } from './env.js';
import { logger } from './logger.js';

// Gemini on Vertex AI, same project as shotline's Cue. Credentials come from
// the environment: `gcloud auth application-default login` locally, the box's
// workload-identity config (GOOGLE_APPLICATION_CREDENTIALS) in production.
// The project is given so the library never looks it up (keyless AWS sign-in
// would need the Resource Manager API for that).
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: env.VERTEX_PROJECT });

export class AiUnavailable extends Error {}
class Retryable extends Error {}

interface GenerateRequest {
  system: string;
  prompt: string;
  // Answer as JSON matching this Vertex schema.
  schema?: Record<string, unknown>;
  // Let Gemini search Google (grounding). Can't be combined with a schema.
  search?: boolean;
}

interface Generated {
  text: string;
  sources: { title: string; url: string }[];
  model: string;
}

async function callVertex(model: string, req: GenerateRequest): Promise<Omit<Generated, 'model'>> {
  const host = env.VERTEX_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${env.VERTEX_LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${env.VERTEX_PROJECT}/locations/${env.VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
  const gemini3 = /^gemini-([3-9]|\d\d)/.test(model);

  let client;
  try {
    client = await auth.getClient();
  } catch (err) {
    logger.error({ err }, 'no Google credentials for Vertex');
    throw new AiUnavailable('Gemini is not configured on this server');
  }

  try {
    const res = await client.request<{
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
      }>;
    }>({
      url,
      method: 'POST',
      timeout: 120_000,
      data: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        ...(req.search ? { tools: [{ googleSearch: {} }] } : {}),
        generationConfig: {
          // Gemini 3+ is tuned for temperature 1.
          temperature: gemini3 ? 1 : 0.7,
          ...(req.schema ? { responseMimeType: 'application/json', responseSchema: req.schema } : {}),
          ...(gemini3 ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
        },
      },
    });
    const candidate = res.data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Retryable('empty answer');
    if (req.schema) JSON.parse(text);
    const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => ({ title: c.web?.title ?? '', url: c.web?.uri ?? '' }))
      .filter((s) => s.url);
    return { text, sources };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429 || (status && status >= 500) || err instanceof SyntaxError || err instanceof Retryable) {
      throw new Retryable(`${model}: ${status ?? (err as Error).message}`);
    }
    if (status === 401 || status === 403) {
      logger.error({ err, status }, 'Vertex refused credentials');
      throw new AiUnavailable('Gemini rejected this server’s credentials');
    }
    throw err;
  }
}

// The main model twice (rate limits are bursty), then the fallback.
async function generate(req: GenerateRequest): Promise<Generated> {
  const models = [env.AI_MODEL, env.AI_MODEL, ...(env.AI_MODEL_FALLBACK ? [env.AI_MODEL_FALLBACK] : [])];
  for (const [i, model] of models.entries()) {
    try {
      return { ...(await callVertex(model, req)), model };
    } catch (err) {
      if (!(err instanceof Retryable) || i === models.length - 1) throw err;
      logger.warn({ err: (err as Error).message }, 'Gemini attempt failed, retrying');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new AiUnavailable('Gemini did not answer');
}

const EMAIL_RULES = `Rules:
- Never invent facts: no new achievements, numbers, companies, names, dates or claims that aren't in the draft, the job details or the "about me" notes. If something important is missing, say so in "notes" instead of making it up.
- Keep every URL exactly as written, and keep links in [label](url) form. Never add a URL that wasn't given.
- Link labels must say what the link is ("my resume", "Shotline", "the demo video"), never "here" or "this link": the sender's dashboard reports clicks by label.
- Keep the sender's voice and language. No clichés ("I hope this email finds you well", "I am writing to", "just circling back"), no emojis unless the draft has them, no exclamation-mark spam.
- Format the body in markdown: **bold**, *italic*, ++underline++, "- " bullet lists, "1. " numbered lists, blank lines between paragraphs, single newlines for sign-off lines. Use formatting sparingly, the way a person would in Gmail. No headings unless asked.
- Don't add a signature block (one is appended separately). Keep a short sign-off if the draft has one.
- "notes": one or two short sentences on what you changed or what's missing. Empty if nothing to say.`;

const EMAIL_SCHEMA = {
  type: 'OBJECT',
  properties: { subject: { type: 'STRING' }, body: { type: 'STRING' }, notes: { type: 'STRING' } },
  required: ['subject', 'body', 'notes'],
};

const URL_RE = /https?:\/\/[^\s)\]>]+/g;

export interface JobContext {
  company?: string;
  role?: string;
  jobUrl?: string;
  jobDescription?: string;
}

function jobBlock(job: JobContext | undefined): string {
  if (!job) return '';
  return [
    job.company && `Company: ${job.company}`,
    job.role && `Role: ${job.role}`,
    job.jobUrl && `Job posting: ${job.jobUrl}`,
    job.jobDescription && `Job description:\n${job.jobDescription.slice(0, 8_000)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface EmailDraft {
  subject: string;
  body: string;
  notes: string;
  model: string;
  warnings: string[];
}

function finishDraft(raw: Generated, given: string[], originalBody: string): EmailDraft {
  const parsed = JSON.parse(raw.text) as { subject: string; body: string; notes?: string };
  // Links are what we track; flag any the model dropped or made up.
  const before = new Set(originalBody.match(URL_RE) ?? []);
  const allowed = new Set([...before, ...given.flatMap((g) => g.match(URL_RE) ?? [])]);
  const after = new Set(parsed.body.match(URL_RE) ?? []);
  const warnings = [
    ...[...before].filter((u) => !after.has(u)).map((u) => `Gemini dropped a link: ${u}`),
    ...[...after].filter((u) => !allowed.has(u)).map((u) => `Gemini added a link that wasn't in your draft: ${u}`),
  ];
  return { subject: parsed.subject.trim(), body: parsed.body.trim(), notes: String(parsed.notes ?? ''), model: raw.model, warnings };
}

export interface EnhanceInput {
  subject: string;
  body: string;
  instruction: string;
  to: string;
  label: string;
  aboutMe: string;
  job?: JobContext;
}

export async function enhanceEmail(input: EnhanceInput): Promise<EmailDraft> {
  const system = `You help one person write outreach emails for their job search (founder cold emails, applications, referrals).
You get their current draft and an instruction, and return an improved subject and body.
- Do exactly what the instruction asks. With no specific instruction, polish: clearer, tighter, confident, warm, specific.
- When job details are given, connect the sender's real experience to what this role needs. Be specific, not generic.
- Subject: short (under ~60 characters), specific, not clickbait. Keep the original if it's already good, unless asked to change it.
- If the draft is empty, write the email from the instruction, the job details and the "about me" notes.
${EMAIL_RULES}`;
  const prompt = [
    input.aboutMe && `About me (the sender):\n${input.aboutMe}`,
    input.to && `Recipient: ${input.to}`,
    input.label && `Company / context: ${input.label}`,
    jobBlock(input.job),
    `Instruction: ${input.instruction || 'Polish this email.'}`,
    `Current subject: ${input.subject || '(none)'}`,
    `Current body:\n${input.body || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await generate({ system, prompt, schema: EMAIL_SCHEMA });
  return finishDraft(raw, [input.instruction, input.aboutMe, input.job?.jobDescription ?? '', input.job?.jobUrl ?? ''], input.body);
}

export interface FollowUpInput {
  original: { subject: string; body: string; sentAt: Date; to: string };
  followUpNumber: number;
  daysSince: number;
  aboutMe: string;
  job?: JobContext;
  instruction?: string;
}

export async function draftFollowUp(input: FollowUpInput): Promise<EmailDraft> {
  const system = `You write short follow-up emails for one person's job search. The follow-up is sent as a reply in the same email thread, so the recipient sees the original right below it.
- 2 to 4 sentences. Friendly, confident, zero guilt-tripping, no "just checking in" / "bumping this".
- Add one small new piece of value or a concrete ask (a 15-minute call, whether the role is still open), using only facts from the original email or the "about me" notes.
- Never mention or hint that you know whether they opened the email or clicked anything.
- A second follow-up is the last one: make it gracious and easy to answer (e.g. "if the timing's wrong, no worries").
- Subject: "Re: " + the original subject, unchanged otherwise.
${EMAIL_RULES}`;
  const prompt = [
    input.aboutMe && `About me (the sender):\n${input.aboutMe}`,
    jobBlock(input.job),
    `This is follow-up number ${input.followUpNumber}, ${input.daysSince} days after the last email.`,
    input.instruction && `Extra instruction: ${input.instruction}`,
    `Original recipient: ${input.original.to}`,
    `Original subject: ${input.original.subject}`,
    `Original body:\n${input.original.body}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await generate({ system, prompt, schema: EMAIL_SCHEMA });
  return finishDraft(raw, [input.original.body, input.aboutMe, input.instruction ?? ''], '');
}

export interface Brief {
  text: string;
  sources: { title: string; url: string }[];
  model: string;
}

export async function companyBrief(job: JobContext): Promise<Brief> {
  const system = `You research companies for a job seeker, using Google Search. Write a compact brief in markdown:
**What they do** (2 sentences), **Product & customers**, **Stage & funding** (with dates), **Recent news** (last 6 months, 2-4 bullets with dates), **Tech & team** (only what's public), **Angles for outreach** (2-3 bullets: concrete things the candidate could mention).
Use only what search results support; write "not found" rather than guessing. Under 250 words. No preamble.`;
  const prompt = jobBlock(job) || 'No company given.';
  const raw = await generate({ system, prompt, search: true });
  return { text: raw.text, sources: raw.sources.slice(0, 8), model: raw.model };
}

export interface Prep {
  items: string[];
  model: string;
}

export async function interviewPrep(job: JobContext, aboutMe: string, brief?: string): Promise<Prep> {
  const system = `You prepare a candidate for interviews at a specific company. Return a checklist of 8-12 short, concrete items:
likely questions to rehearse (tied to the role and the candidate's real experience), stories from their background to have ready, things to research, and 2-3 sharp questions to ask them.
Each item is one line, imperative, specific to this company and role. Never invent facts about the candidate.`;
  const prompt = [aboutMe && `About the candidate:\n${aboutMe}`, jobBlock(job), brief && `Company brief:\n${brief}`].filter(Boolean).join('\n\n');
  const raw = await generate({
    system,
    prompt,
    schema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['items'] },
  });
  const parsed = JSON.parse(raw.text) as { items: string[] };
  return { items: parsed.items.map((s) => s.trim()).filter(Boolean).slice(0, 15), model: raw.model };
}
