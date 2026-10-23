import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { ApplicationModel, ResumeModel } from '../models.js';
import { driveFile, pickResume, readResume, ResumeUnreadable } from '../resumes.js';
import { requireSameOrigin, requireSession } from './auth.js';
import { h, objectId } from './api.js';

export const resumesRouter = Router();
resumesRouter.use(requireSession, requireSameOrigin);

const LIST = '-text';

const fields = z.object({
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => !!driveFile(u), 'Use a Google Drive file link (drive.google.com/file/d/…) or a Google Doc link'),
});

type Doc = InstanceType<typeof ResumeModel>;

// Reads the file's text into the resume. A failure is saved, not thrown.
async function refresh(resume: Doc): Promise<void> {
  try {
    const { text, pages } = await readResume(resume.url);
    resume.set({ text, pages, readError: '', readAt: new Date() });
  } catch (err) {
    if (!(err instanceof ResumeUnreadable)) throw err;
    resume.set({ text: '', pages: 0, readError: err.message, readAt: new Date() });
  }
  await resume.save();
}

const view = (r: Doc) => {
  const { text, ...rest } = r.toObject();
  return { ...rest, chars: text.length };
};

resumesRouter.get(
  '/',
  h(async (_req, res) => res.json({ resumes: await ResumeModel.find().select(LIST).sort({ createdAt: 1 }).lean() })),
);

resumesRouter.post(
  '/',
  h(async (req, res) => {
    const input = fields.parse(req.body);
    if ((await ResumeModel.countDocuments()) >= 10) return res.status(400).json({ error: 'too many', message: 'Up to 10 resumes' });
    const resume = new ResumeModel(input);
    await refresh(resume);
    res.json({ resume: view(resume) });
  }),
);

resumesRouter.post(
  '/pick',
  h(async (req, res) => {
    const input = z
      .object({
        applicationId: objectId.optional(),
        company: z.string().max(100).default(''),
        role: z.string().max(150).default(''),
        jobDescription: z.string().max(20_000).default(''),
      })
      .parse(req.body);
    const app = input.applicationId ? await ApplicationModel.findById(input.applicationId).select('company role jobUrl jobDescription').lean() : null;
    const job = {
      company: app?.company || input.company,
      role: app?.role || input.role,
      jobUrl: app?.jobUrl ?? '',
      jobDescription: app?.jobDescription || input.jobDescription,
    };
    if (!job.role && !job.jobDescription) return res.json({ pick: null, message: 'Add the role or job description to get a suggestion' });
    const resumes = await ResumeModel.find().sort({ createdAt: 1 }).lean();
    res.json({ pick: await pickResume(job, resumes) });
  }),
);

resumesRouter.patch(
  '/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const input = fields.partial().parse(req.body);
    const resume = await ResumeModel.findById(req.params.id);
    if (!resume) return res.status(404).json({ error: 'not found' });
    const moved = input.url !== undefined && input.url !== resume.url;
    resume.set(input);
    if (moved) await refresh(resume);
    else await resume.save();
    res.json({ resume: view(resume) });
  }),
);

// Read the file again (after you fix its sharing or update it in Drive).
resumesRouter.post(
  '/:id/read',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    const resume = await ResumeModel.findById(req.params.id);
    if (!resume) return res.status(404).json({ error: 'not found' });
    await refresh(resume);
    res.json({ resume: view(resume) });
  }),
);

resumesRouter.delete(
  '/:id',
  h(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: 'not found' });
    await ResumeModel.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  }),
);
