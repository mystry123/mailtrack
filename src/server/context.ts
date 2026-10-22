// Who the current code is acting for. Every request runs inside withUser()
// (set by requireSession); background jobs loop over accounts with withUser().
// The tenancy plugin below adds { userId } to every query on user-owned
// models and stamps it on new documents, so one person can never read or
// change another's data. A query with no context throws, so a forgotten
// scope fails loudly instead of leaking; code that really needs to look
// across users (public tracking links, migrations, the job loop) says so
// with asSystem().

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Schema, Types } from 'mongoose';

type Store = { userId: Types.ObjectId } | { system: true };
const als = new AsyncLocalStorage<Store>();

export const withUser = <T>(userId: Types.ObjectId, fn: () => T): T => als.run({ userId }, fn);
export const asSystem = <T>(fn: () => T): T => als.run({ system: true }, fn);

export function currentUserId(): Types.ObjectId {
  const s = als.getStore();
  if (!s || !('userId' in s)) throw new Error('No user in context');
  return s.userId;
}

export class UnscopedQuery extends Error {}

function scope(): { userId: Types.ObjectId } | null {
  const s = als.getStore();
  if (!s) throw new UnscopedQuery('Query on user data outside withUser()/asSystem()');
  return 'userId' in s ? { userId: s.userId } : null;
}

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
] as const;

// Applied to every model that holds a user's data.
export function tenancy(schema: Schema): void {
  schema.add({ userId: { type: 'ObjectId', ref: 'Account', index: true } });

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function () {
      const s = scope();
      if (s) this.where(s);
    });
  }
  schema.pre('aggregate', function () {
    const s = scope();
    if (s) this.pipeline().unshift({ $match: s });
  });
  schema.pre('validate', function () {
    const s = scope();
    if (s && !this.get('userId')) this.set('userId', s.userId);
    if (!this.get('userId')) throw new UnscopedQuery('New document without an owner');
  });
  schema.pre('insertMany', function (next: () => void, docs: Array<Record<string, unknown>>) {
    const s = scope();
    if (s) for (const d of docs) d.userId ??= s.userId;
    next();
  });
}
