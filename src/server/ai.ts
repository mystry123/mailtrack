import { GoogleAuth } from 'google-auth-library';
import { env } from './env.js';
import { fakeAi } from './fakes.js';
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
  // What this call is for (test fakes answer by kind).
  kind: 'email' | 'followup' | 'thankyou' | 'referral' | 'reply' | 'prep' | 'people' | 'brief' | 'resume';
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
  if (env.FAKE_AI) return { text: fakeAi(req.kind, `${req.system}\n${req.prompt}`), sources: [], model: 'fake' };
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
- Don't add a signature block (one is appended separately). End with just a closing line such as "Best," — the signature carries the name.
- Never write placeholders like [Your Name], [Company] or [Link]: use what you were given, or leave it out.
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
  // Belt and braces: drop a placeholder name line the model added anyway (the signature has the real one).
  parsed.body = parsed.body.replace(/\n\s*\[(?:your name|name|your full name)\]\s*$/i, '');
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
  const raw = await generate({ kind: 'email', system, prompt, schema: EMAIL_SCHEMA });
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
  const raw = await generate({ kind: 'followup', system, prompt, schema: EMAIL_SCHEMA });
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
  const raw = await generate({ kind: 'brief', system, prompt, search: true });
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
    kind: 'prep',
    system,
    prompt,
    schema: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['items'] },
  });
  const parsed = JSON.parse(raw.text) as { items: string[] };
  return { items: parsed.items.map((s) => s.trim()).filter(Boolean).slice(0, 15), model: raw.model };
}

export interface ReplyReading {
  summary: string;
  suggestedStage: string;
}

const REPLY_STAGES = ['replied', 'screening', 'interviewing', 'offer', 'rejected'];

// One-line summary of a reply and the stage it implies.
export async function readReply(input: { text: string; subject: string; company?: string; role?: string }): Promise<ReplyReading> {
  const system = `You read a reply to a job seeker's outreach email and return:
- "summary": one short sentence on what they said and any concrete next step, with dates/times if given (e.g. "Wants a 30-min call Thu 3pm IST").
- "suggestedStage": one of ${REPLY_STAGES.join(', ')}. "screening" = intro/recruiter call proposed; "interviewing" = technical/onsite interview scheduled; "offer" = an offer; "rejected" = a no; otherwise "replied".`;
  const prompt = [input.company && `Company: ${input.company}`, input.role && `Role: ${input.role}`, `Original subject: ${input.subject}`, `Their reply:\n${input.text}`]
    .filter(Boolean)
    .join('\n\n');
  const raw = await generate({
    kind: 'reply',
    system,
    prompt,
    schema: {
      type: 'OBJECT',
      properties: { summary: { type: 'STRING' }, suggestedStage: { type: 'STRING', enum: REPLY_STAGES } },
      required: ['summary', 'suggestedStage'],
    },
  });
  const parsed = JSON.parse(raw.text) as ReplyReading;
  return {
    summary: String(parsed.summary ?? '').slice(0, 300),
    suggestedStage: REPLY_STAGES.includes(parsed.suggestedStage) ? parsed.suggestedStage : 'replied',
  };
}

export async function draftThankYou(input: { job: JobContext; interviewTitle: string; interviewers: string; aboutMe: string; notes: string }): Promise<EmailDraft> {
  const system = `You write a short thank-you email a candidate sends a few hours after an interview.
- 3 to 5 sentences: thank them, recall one specific topic from the interview notes if any (never invent one), restate genuine interest in one line, sign off.
- Subject: "Thank you – " + the role or interview title.
${EMAIL_RULES}`;
  const prompt = [
    input.aboutMe && `About me:\n${input.aboutMe}`,
    jobBlock(input.job),
    `Interview: ${input.interviewTitle}`,
    input.interviewers && `Interviewers: ${input.interviewers}`,
    input.notes && `My notes on this company:\n${input.notes}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await generate({ kind: 'thankyou', system, prompt, schema: EMAIL_SCHEMA });
  return finishDraft(raw, [input.aboutMe, input.notes], '');
}

export async function draftReferralAsk(input: {
  contact: { name: string; title: string; relationship: string; notes: string };
  job: JobContext;
  aboutMe: string;
}): Promise<EmailDraft> {
  const system = `You write a short, warm email asking someone for a referral to a specific role at their company.
- Match the relationship: a friend or ex-colleague gets a casual note; a stranger gets a respectful, specific one.
- 4 to 6 sentences: why this role, one or two concrete proofs from the sender's background, a clear and easy ask (refer me / point me to the right person), an easy out.
- Include the job link if given.
${EMAIL_RULES}`;
  const prompt = [
    input.aboutMe && `About me (the sender):\n${input.aboutMe}`,
    `Contact: ${input.contact.name}${input.contact.title ? `, ${input.contact.title}` : ''} (relationship: ${input.contact.relationship})`,
    input.contact.notes && `Notes on them: ${input.contact.notes}`,
    jobBlock(input.job),
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await generate({ kind: 'referral', system, prompt, schema: EMAIL_SCHEMA });
  return finishDraft(raw, [input.aboutMe, input.job.jobUrl ?? '', input.job.jobDescription ?? ''], '');
}

export interface FoundPerson {
  name: string;
  title: string;
}

// People at the company worth emailing for this role (founders, hiring managers), via Google Search.
export async function findPeople(job: JobContext): Promise<{ people: FoundPerson[]; sources: { title: string; url: string }[] }> {
  const system = `Using Google Search, find up to 5 real people at the company a job seeker should email about the role: founders/CEO/CTO at small startups, otherwise the likely hiring manager, engineering lead or recruiter.
Only people search results show currently work there. Answer with JSON only, no prose: {"people":[{"name":"…","title":"…"}]}`;
  const raw = await generate({ kind: 'people', system, prompt: jobBlock(job) || 'No company given.', search: true });
  const json = raw.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
  let people: FoundPerson[] = [];
  try {
    people = ((JSON.parse(json) as { people?: FoundPerson[] }).people ?? [])
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({ name: p.name.trim(), title: String(p.title ?? '').trim() }))
      .slice(0, 5);
  } catch {
    people = [];
  }
  return { people, sources: raw.sources.slice(0, 6) };
}

export interface ResumeChoice {
  // Index into the resumes given.
  index: number;
  reason: string;
  model: string;
}

// Which of the sender's resumes fits this job best, with a one-line reason.
export async function chooseResume(job: JobContext, resumes: { name: string; text: string }[]): Promise<ResumeChoice> {
  const system = `A job seeker keeps several versions of their resume. Pick the one that fits this job best: match the role's core skills and seniority, not shared buzzwords.
Return "resume" (the number of the best resume) and "reason": one short sentence naming the 1-2 things in the job it matches, e.g. "The JD is about TTS and voice cloning".`;
  const prompt = [
    jobBlock(job),
    ...resumes.map((r, i) => `### Resume ${i + 1}: ${r.name}\n${r.text.slice(0, 6_000) || '(text not available: judge by the name)'}`),
  ].join('\n\n');
  const raw = await generate({
    kind: 'resume',
    system,
    prompt,
    schema: { type: 'OBJECT', properties: { resume: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['resume', 'reason'] },
  });
  const parsed = JSON.parse(raw.text) as { resume: number; reason: string };
  const index = Math.round(Number(parsed.resume)) - 1;
  if (!(index >= 0 && index < resumes.length)) throw new Error(`Gemini picked resume ${parsed.resume} of ${resumes.length}`);
  return { index, reason: String(parsed.reason ?? '').slice(0, 200), model: raw.model };
}
