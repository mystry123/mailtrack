import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';
import { SOURCES, STAGES } from '../shared/stages.js';

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
    // Replies: who wrote back.
    from: String,
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
    // Hide follow-up nudges until then.
    snoozedUntil: Date,
    brief: { text: String, sources: [{ title: String, url: String, _id: false }], at: Date },
    prep: { type: [checkSchema], default: [] },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);
applicationSchema.index({ archived: 1, updatedAt: -1 });

const templateSchema = new Schema(
  { name: { type: String, required: true }, subject: { type: String, default: '' }, body: { type: String, default: '' } },
  { timestamps: true },
);

const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
});

export type Account = InferSchemaType<typeof accountSchema>;
export type Message = InferSchemaType<typeof messageSchema> & { _id: Types.ObjectId };
export type TrackEvent = InferSchemaType<typeof eventSchema> & { _id: Types.ObjectId };
export type Application = InferSchemaType<typeof applicationSchema> & { _id: Types.ObjectId };

export const AccountModel = mongoose.model('Account', accountSchema);
export const MessageModel = mongoose.model('Message', messageSchema);
export const EventModel = mongoose.model('Event', eventSchema);
export const SettingModel = mongoose.model('Setting', settingSchema);
export const ApplicationModel = mongoose.model('Application', applicationSchema);
export const TemplateModel = mongoose.model('Template', templateSchema);
