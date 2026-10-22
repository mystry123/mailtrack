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

export interface EnhanceInput {
  subject: string;
  body: string;
  instruction: string;
  to: string;
  label: string;
  aboutMe: string;
}

export interface EnhanceResult {
  subject: string;
  body: string;
  notes: string;
  model: string;
  warnings: string[];
}

const SYSTEM = `You help one person write outreach emails (job applications, founder cold emails, follow-ups).
You get their current draft and an instruction, and return an improved subject and body.

Rules:
- Do exactly what the instruction asks. With no specific instruction, polish: clearer, tighter, confident, warm, specific.
- Never invent facts: no new achievements, numbers, companies, names, dates or claims that aren't in the draft or the "about me" notes. If something important is missing, say so in "notes" instead of making it up.
- Keep every URL exactly as written, and keep links in [label](url) form. Never add a URL that wasn't given.
- Link labels must say what the link is ("my resume", "Shotline", "the demo video"), never "here" or "this link": the sender's dashboard reports clicks by label.
- Keep the sender's voice and language. No clichés ("I hope this email finds you well", "I am writing to"), no emojis unless the draft has them, no exclamation-mark spam.
- Format the body in markdown: **bold**, *italic*, ++underline++, "- " bullet lists, "1. " numbered lists, blank lines between paragraphs, single newlines for sign-off lines. Use formatting sparingly, the way a person would in Gmail. No headings unless asked.
- Don't add a signature block (one is appended separately). Keep a short sign-off if the draft has one.
- Subject: short (under ~60 characters), specific, not clickbait. Keep the original if it's already good, unless asked to change it.
- If the draft is empty, write the email from the instruction and the "about me" notes.
- "notes": one or two short sentences on what you changed or what's missing. Empty if nothing to say.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject: { type: 'STRING' },
    body: { type: 'STRING' },
    notes: { type: 'STRING' },
  },
  required: ['subject', 'body', 'notes'],
};

class Retryable extends Error {}

async function callVertex(model: string, prompt: string): Promise<{ subject: string; body: string; notes: string }> {
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
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
    }>({
      url,
      method: 'POST',
      timeout: 90_000,
      data: {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          // Gemini 3+ is tuned for temperature 1.
          temperature: gemini3 ? 1 : 0.7,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          ...(gemini3 ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
        },
      },
    });
    const text = (res.data.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    const parsed = JSON.parse(text);
    if (typeof parsed.body !== 'string' || typeof parsed.subject !== 'string') throw new Retryable('bad answer shape');
    return { subject: parsed.subject, body: parsed.body, notes: String(parsed.notes ?? '') };
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

const URL_RE = /https?:\/\/[^\s)\]>]+/g;

export async function enhanceEmail(input: EnhanceInput): Promise<EnhanceResult> {
  const prompt = [
    input.aboutMe && `About me (the sender):\n${input.aboutMe}`,
    input.to && `Recipient: ${input.to}`,
    input.label && `Company / context: ${input.label}`,
    `Instruction: ${input.instruction || 'Polish this email.'}`,
    `Current subject: ${input.subject || '(none)'}`,
    `Current body:\n${input.body || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let result: { subject: string; body: string; notes: string } | undefined;
  let used = env.AI_MODEL;
  const models = [env.AI_MODEL, env.AI_MODEL, ...(env.AI_MODEL_FALLBACK ? [env.AI_MODEL_FALLBACK] : [])];
  for (const [i, model] of models.entries()) {
    try {
      result = await callVertex(model, prompt);
      used = model;
      break;
    } catch (err) {
      if (!(err instanceof Retryable) || i === models.length - 1) throw err;
      logger.warn({ err: (err as Error).message }, 'Gemini attempt failed, retrying');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!result) throw new AiUnavailable('Gemini did not answer');

  // Links are what we track; flag any the model dropped or made up.
  const before = new Set(input.body.match(URL_RE) ?? []);
  const given = new Set([...before, ...(input.instruction.match(URL_RE) ?? []), ...(input.aboutMe.match(URL_RE) ?? [])]);
  const after = new Set(result.body.match(URL_RE) ?? []);
  const warnings = [
    ...[...before].filter((u) => !after.has(u)).map((u) => `Gemini dropped a link: ${u}`),
    ...[...after].filter((u) => !given.has(u)).map((u) => `Gemini added a link that wasn't in your draft: ${u}`),
  ];

  return { ...result, subject: result.subject.trim(), body: result.body.trim(), model: used, warnings };
}
