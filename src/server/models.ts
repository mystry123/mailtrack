import mongoose, { Schema, type InferSchemaType, type Types } from 'mongoose';

const accountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    // Display name used in the From header; falls back to the Google name.
    fromName: { type: String, default: '' },
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
    to: { type: [recipientSchema], default: [] },
    cc: { type: [recipientSchema], default: [] },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    // Rendered HTML without the pixel, for the dashboard preview.
    html: { type: String, default: '' },
    links: { type: [linkSchema], default: [] },
    gmailMessageId: String,
    gmailThreadId: String,
    sentAt: { type: Date, required: true },
    stats: { type: statsSchema, default: () => ({}) },
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
    type: { type: String, enum: ['open', 'click'], required: true },
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

const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
});

export type Account = InferSchemaType<typeof accountSchema>;
export type Message = InferSchemaType<typeof messageSchema> & { _id: Types.ObjectId };
export type TrackEvent = InferSchemaType<typeof eventSchema> & { _id: Types.ObjectId };

export const AccountModel = mongoose.model('Account', accountSchema);
export const MessageModel = mongoose.model('Message', messageSchema);
export const EventModel = mongoose.model('Event', eventSchema);
export const SettingModel = mongoose.model('Setting', settingSchema);
