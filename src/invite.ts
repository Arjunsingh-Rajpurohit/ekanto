import { fromBase64Url, newSecret } from './crypto';

/**
 * What a link carries after the #: the call's secret, the people limit and whether it is a
 * protected (app-only) call. Example: …/#Kq3…Xw.4.p is a protected call for at most 4 people;
 * no ".n" means no limit. Both choices are mixed into the call's key, so editing ".4" into ".40"
 * (or deleting ".p") just leads to an empty, different call.
 */
export interface Invite {
  secret: string;
  /** Most people allowed in the call, including the person who made it. Null = no limit. */
  limit: number | null;
  /**
   * Protected call: joinable only from the Hush app, which blocks screenshots, screen recording
   * and has no browser extensions. Link ends in ".p".
   */
  appOnly: boolean;
  /** Voice call: everyone starts with the camera off (they can still turn it on). Link ends in ".v". */
  voice: boolean;
}

export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 20;
/** Above this, a call without a server gets slow on phones: every phone sends to every other. */
export const SMOOTH_PEOPLE = 6;

export function newInvite(limit: number | null, appOnly = false, voice = false): Invite {
  return { secret: newSecret(), limit, appOnly, voice };
}

export function inviteToHash(invite: Invite): string {
  return `${invite.secret}${invite.limit ? `.${invite.limit}` : ''}${invite.appOnly ? '.p' : ''}${invite.voice ? '.v' : ''}`;
}

/** Everything the link's creator chose, mixed into the call's key so the link can't be edited. */
export function inviteScope(invite: Invite): string {
  return `limit=${invite.limit ?? 'none'}|app=${invite.appOnly ? 1 : 0}|voice=${invite.voice ? 1 : 0}`;
}

/** Null for anything that isn't a well-formed link: broken, cut short, or tampered with. */
export function parseInvite(text: string): Invite | null {
  const hash = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text.trim();
  const m = hash.match(/^([A-Za-z0-9_-]{43})(?:\.(\d{1,2}))?(\.p)?(\.v)?$/);
  if (!m) return null;
  try {
    if (fromBase64Url(m[1]).length !== 32) return null;
  } catch {
    return null;
  }
  const limit = m[2] === undefined ? null : Number(m[2]);
  if (limit !== null && (limit < MIN_PEOPLE || limit > MAX_PEOPLE)) return null;
  return { secret: m[1], limit, appOnly: m[3] === '.p', voice: m[4] === '.v' };
}
