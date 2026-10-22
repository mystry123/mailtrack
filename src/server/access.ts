import { env } from './env.js';
import { InviteModel } from './models.js';

// Who may use Mailtrack: the owner (ALLOWED_EMAIL) plus anyone they've invited.
export async function mayUse(email: string): Promise<boolean> {
  return email === env.ALLOWED_EMAIL || !!(await InviteModel.exists({ email }));
}

export const isOwner = (email: string | undefined) => email === env.ALLOWED_EMAIL;
