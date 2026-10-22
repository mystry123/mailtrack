import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env, runJobs } from './env.js';
import { logger } from './logger.js';
import { apiRouter } from './routes/api.js';
import { applicationsRouter } from './routes/applications.js';
import { contactsRouter } from './routes/contacts.js';
import { startJobs } from './jobs.js';
import { ApplicationModel, ContactModel } from './models.js';
import { authRouter } from './routes/auth.js';
import { trackRouter } from './routes/track.js';

const app = express();
app.disable('x-powered-by');
// Behind nginx on the same box: trust exactly one hop for req.ip.
app.set('trust proxy', 'loopback');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:'],
        // The email preview iframe uses srcdoc.
        'frame-src': ["'self'"],
      },
    },
    // Recipients' mail clients load the pixel cross-origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 });
});

app.use(trackRouter);
app.use('/auth', express.json({ limit: '10kb' }), authRouter);
app.use('/api/applications', express.json({ limit: '200kb' }), applicationsRouter);
app.use('/api/contacts', express.json({ limit: '50kb' }), contactsRouter);
if (env.NODE_ENV === 'test') {
  const { testingRouter } = await import('./routes/testing.js');
  app.use('/api/test', express.json(), testingRouter);
}
app.use('/api', express.json({ limit: '200kb' }), apiRouter);

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
app.use('/app', express.static(webDir, { index: false, maxAge: '1h' }));
app.get(['/app', '/app/*'], (_req, res) => res.sendFile(path.join(webDir, 'index.html')));

// Anyone curious enough to visit the bare domain just lands on shotline.
app.get('/', (_req, res) => res.redirect('https://shotline.in'));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return;
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'internal' });
});

// Contacts used to live inside each application; they're a shared list now.
// Idempotent: moves any left inside applications, then empties those fields.
async function migrateEmbeddedContacts() {
  const apps = await ApplicationModel.find({ 'contacts.0': { $exists: true } });
  for (const app of apps) {
    for (const c of app.contacts) {
      if (!c.name && !c.email) continue;
      const email = (c.email ?? '').trim().toLowerCase();
      const fields = { name: c.name ?? '', title: c.title ?? '', linkedin: c.linkedin ?? '', company: app.company };
      if (email) {
        await ContactModel.updateOne({ email }, { $setOnInsert: { email, ...fields }, $addToSet: { applicationIds: app._id } }, { upsert: true });
      } else {
        await ContactModel.create({ ...fields, applicationIds: [app._id] });
      }
    }
    app.set('contacts', []);
    await app.save();
    logger.info({ company: app.company }, 'moved contacts to the shared list');
  }
}

async function main() {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB });
  await mongoose.syncIndexes();
  await migrateEmbeddedContacts();
  if (runJobs) startJobs();
  else logger.info('background jobs off (not production; set RUN_JOBS=true to enable)');
  const server = app.listen(env.PORT, '127.0.0.1', () => logger.info({ port: env.PORT }, 'mailtrack listening'));

  const shutdown = () => {
    server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
