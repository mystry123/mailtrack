import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';
import { SOURCES, STAGES } from '../shared/stages.js';
import { tenancy } from './context.js';

const accountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    // Display name used in the From header; falls back to the Google name.
    fromName: { type: String, default: '' },
    // Markdown, appended under "--" when Compose's "Include signature" is on.
    signature: { type: String, default: '' },
    // Background for Gemini: who you are, what you've built, what you're after.
    aboutMe: { type: String, default: '' },
    // Applications started (applied / reached out) per week the Today page aims for.
    weeklyGoal: { type: Number, default: 20 },
    // Working days without a reply before a follow-up is due.
    followUpDays: { type: Number, default: 4 },
    // Auto follow-up sequence offered in Compose: working days after the first email.
    sequenceDays: { type: [Number], default: [4, 9] },
    sequenceByDefault: { type: Boolean, default: true },
    // Emails per day (including scheduled and automatic follow-ups). Protects your Gmail reputation.
    dailyCap: { type: Number, default: 50 },
    timezone: { type: String, default: 'Asia/Kolkata' },
    weeklyDigest: { type: Boolean, default: true },
    lastDigestAt: Date,
    calendarSyncedAt: Date,
    refreshTokenEnc: { type: String, required: true },
    scopes: { type: [String], default: [] },
    needsReauth: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const linkSchema = new Schema(
  {
    token: { type: String, required: true },
    url: { type: String, required: true },
    label: { type: String, default: '' },
    clicks: { type: Number, default: 0 },
  },
  { _id: false },
);

const recipientSchema = new Schema({ email: String, name: String }, { _id: false });

const statsSchema = new Schema(
  {
    opens: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    autoOpens: { type: Number, default: 0 },
    botClicks: { type: Number, default: 0 },
    firstOpenAt: Date,
    lastOpenAt: Date,
    firstClickAt: Date,
    lastClickAt: Date,
    replies: { type: Number, default: 0 },
    firstReplyAt: Date,
    lastActivityAt: Date,
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    // 'email' is sent through Gmail; 'link' is a standalone tracked link you
    // paste somewhere else (LinkedIn DM, a form, ...).
    kind: { type: String, enum: ['email', 'link'], required: true },
    // Pixel token. Links get their own tokens so a click identifies the link.
    token: { type: String, required: true, unique: true },
    label: { type: String, default: '' },
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', index: true },
    // Set on follow-ups: the email this one follows up on (same Gmail thread).
    followUpOf: { type: Schema.Types.ObjectId, ref: 'Message' },
    // Sent by an automatic follow-up sequence (rather than by hand).
    automatic: { type: Boolean, default: false },
    // On first emails: follow-ups that go out unless someone replies.
    sequence: {
      type: new Schema(
        {
          status: { type: String, enum: ['active', 'stopped', 'done'], default: 'active' },
          stopReason: String,
          steps: {
            type: [
              new Schema({
                afterDays: { type: Number, required: true },
                dueAt: { type: Date, required: true },
                status: { type: String, enum: ['pending', 'sent', 'skipped', 'cancelled'], default: 'pending' },
                subject: { type: String, default: '' },
                body: { type: String, default: '' },
                draftedAt: Date,
                // You changed the draft: never overwrite it with a new one.
                edited: { type: Boolean, default: false },
                messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
                error: String,
              }),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // No tracking pixel: for important one-to-one emails (clicks and replies still count).
    trackOpens: { type: Boolean, default: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' },
    // scheduled → sending → sent; or failed / cancelled. Old messages have no status (= sent).
    status: { type: String, enum: ['scheduled', 'sending', 'sent', 'failed', 'cancelled'], default: 'sent' },
    scheduledAt: Date,
    sendError: String,
    to: { type: [recipientSchema], default: [] },
    cc: { type: [recipientSchema], default: [] },
    subject: { type: String, default: '' },
    // What you typed (without the signature), so "Send again" can reuse it.
    body: { type: String, default: '' },
    includeSignature: { type: Boolean, default: false },
    // Rendered HTML without the pixel (dashboard preview), and the plain-text part.
    html: { type: String, default: '' },
    text: { type: String, default: '' },
    links: { type: [linkSchema], default: [] },
    gmailMessageId: String,
    gmailThreadId: { type: String, index: true },
    // RFC 5322 Message-ID, for threading follow-ups (In-Reply-To / References).
    rfcMessageId: String,
    replyCheckedAt: Date,
    replyIds: { type: [String], default: [] },
    sentAt: { type: Date, required: true },
    stats: { type: statsSchema, default: () => ({}) },
    // Last time the Chrome extension saw this email open in your own Gmail.
    selfSeenAt: Date,
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);
// Partial, not sparse: an empty links array would otherwise index as a
// duplicate "undefined" key for every message without links.
messageSchema.index(
  { 'links.token': 1 },
  { unique: true, partialFilterExpression: { 'links.token': { $exists: true } } },
);
messageSchema.index({ archived: 1, sentAt: -1 });

export const SIGNALS = ['real', 'self', 'auto', 'bot'] as const;
export type Signal = (typeof SIGNALS)[number];

const eventSchema = new Schema(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true, index: true },
    type: { type: String, enum: ['open', 'click', 'reply'], required: true },
    // Replies: who wrote back, and (with read access) what Gemini made of it.
    from: String,
    summary: String,
    suggestedStage: String,
    gmailId: String,
    linkToken: String,
    at: { type: Date, required: true },
    ip: String,
    ua: String,
    method: String,
    country: String,
    region: String,
    city: String,
    // Where the request came from: gmail | apple | yahoo | outlook | browser | unknown
    source: String,
    // How much to believe it. Only 'real' counts toward opens/clicks.
    signal: { type: String, enum: SIGNALS, required: true },
    reason: String,
    // Set when you overrode the classifier from the dashboard.
    manual: { type: Boolean, default: false },
  },
  { timestamps: false },
);

const noteSchema = new Schema({ text: { type: String, required: true }, at: { type: Date, default: Date.now } });
const contactSchema = new Schema(
  { name: String, email: String, title: String, linkedin: String },
  { _id: false },
);
const checkSchema = new Schema({ text: { type: String, required: true }, done: { type: Boolean, default: false } });

const applicationSchema = new Schema(
  {
    company: { type: String, required: true, trim: true },
    role: { type: String, default: '', trim: true },
    jobUrl: { type: String, default: '' },
    jobDescription: { type: String, default: '' },
    source: { type: String, enum: SOURCES, default: 'cold_email' },
    stage: { type: String, enum: STAGES, default: 'wishlist' },
    stageHistory: { type: [new Schema({ stage: String, at: Date }, { _id: false })], default: [] },
    // First time it reached Applied / Reached out: what the weekly goal counts.
    startedAt: Date,
    location: { type: String, default: '' },
    salary: { type: String, default: '' },
    // 1-3 stars: how much you want it.
    priority: { type: Number, default: 2, min: 1, max: 3 },
    contacts: { type: [contactSchema], default: [] },
    notes: { type: [noteSchema], default: [] },
    interviewAt: Date,
    // From Google Calendar: events that look like interviews for this company.
    interviews: {
      type: [
        new Schema(
          { eventId: String, title: String, start: Date, end: Date, attendees: [String], matchedBy: String, thankYouDone: { type: Boolean, default: false } },
          { _id: false },
        ),
      ],
      default: [],
    },
    // Interviews you've sent (or skipped) a thank-you for: calendar event ids, or "manual:<interviewAt>".
    thankYous: { type: [String], default: [] },
    // A stage change Gemini proposes after reading a reply; you accept or dismiss it.
    suggestion: { stage: String, reason: String, at: Date },
    // Captured from the job page: how old the posting is, reposts, salary shown.
    posting: { postedAt: Date, reposted: Boolean, salary: String, capturedAt: Date, source: String },
    // Hide follow-up nudges until then.
    snoozedUntil: Date,
    brief: { text: String, sources: [{ title: String, url: String, _id: false }], at: Date },
    prep: { type: [checkSchema], default: [] },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);
applicationSchema.index({ archived: 1, updatedAt: -1 });

const contactSchema2 = new Schema(
  {
    name: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },
    company: { type: String, default: '' },
    title: { type: String, default: '' },
    linkedin: { type: String, default: '' },
    relationship: { type: String, enum: ['referral', 'recruiter', 'hiring_manager', 'founder', 'friend', 'other'], default: 'other' },
    notes: { type: String, default: '' },
    applicationIds: { type: [Schema.Types.ObjectId], default: [] },
    lastContactAt: Date,
  },
  { timestamps: true },
);
contactSchema2.index({ userId: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $gt: '' } } });

const templateSchema = new Schema(
  { name: { type: String, required: true }, subject: { type: String, default: '' }, body: { type: String, default: '' } },
  { timestamps: true },
);

const settingSchema = new Schema({
  key: { type: String, required: true },
  value: Schema.Types.Mixed,
});

export type Account = InferSchemaType<typeof accountSchema>;
// userId comes from the tenancy plugin.
type Owned = { _id: Types.ObjectId; userId?: Types.ObjectId };
export type Message = InferSchemaType<typeof messageSchema> & Owned;
export type TrackEvent = InferSchemaType<typeof eventSchema> & Owned;
export type Application = InferSchemaType<typeof applicationSchema> & Owned;
export type Contact = InferSchemaType<typeof contactSchema2> & Owned;

// People you've let in (besides the owner, ALLOWED_EMAIL). Not per-user data.
const inviteSchema = new Schema(
  { email: { type: String, required: true, unique: true, lowercase: true, trim: true }, note: { type: String, default: '' } },
  { timestamps: true },
);

// Everything below holds one person's data: the tenancy plugin scopes every
// query to the current user (src/server/context.ts).
for (const schema of [messageSchema, eventSchema, settingSchema, applicationSchema, templateSchema, contactSchema2]) schema.plugin(tenancy);
settingSchema.index({ userId: 1, key: 1 }, { unique: true });
templateSchema.index({ userId: 1, name: 1 });

export const AccountModel = mongoose.model('Account', accountSchema);
export const InviteModel = mongoose.model('Invite', inviteSchema);
export const MessageModel = mongoose.model('Message', messageSchema);
export const EventModel = mongoose.model('Event', eventSchema);
export const SettingModel = mongoose.model('Setting', settingSchema);
export const ApplicationModel = mongoose.model('Application', applicationSchema);
export const TemplateModel = mongoose.model('Template', templateSchema);
export const ContactModel = mongoose.model('Contact', contactSchema2);
