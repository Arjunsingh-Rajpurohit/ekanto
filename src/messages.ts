import type { Channel, Ring } from './channels';
import { MSG_MAX_AGE_MS } from './ringing';

/*
 * Messages in a saved channel, like WhatsApp — without a server.
 *
 * A message is a sealed ring ("msg") on the channel's own topic, so only its members can read it.
 * Nothing on the way keeps it: if the other phone is off, this phone sends it again (every few
 * minutes, and at once when they come back and say "sync") until their phone answers "got".
 * Messages live only on the members' phones, and only for as long as the channel says (24 hours,
 * 7 days, or until deleted) — one setting for everyone in the channel.
 */

export const DAY = 24 * 3600 * 1000;
export const KEEP_CHOICES = [DAY, 7 * DAY, 0] as const;
export const DEFAULT_KEEP = 7 * DAY;
export const MAX_TEXT = 1000;
/** A long chat keeps its newest messages; a phone's storage is small. */
const MAX_MSGS = 1000;

export interface Msg {
  id: string;
  mine: boolean;
  /** The sender's tag in this channel ('' for mine) and their name. */
  by: string;
  from: string;
  x: string;
  /** When it was written (the sender's clock). */
  ts: number;
  /** Mine: handed to a relay at least once (one tick). */
  sent?: boolean;
  /** Mine: the phones that have it / have read it (two ticks / read). */
  got?: string[];
  seen?: string[];
  /** Theirs: read on this phone. */
  read?: boolean;
  /** A line in the thread instead of a message. */
  note?: 'missed' | 'keep';
  /** keep: the new setting. */
  k?: number;
  /** missed: why they called. */
  why?: string;
}

export interface Thread {
  msgs: Msg[];
  /** How long messages stay (ms, 0 = until deleted). */
  keep: number;
}

export type Tick = 'sending' | 'sent' | 'delivered' | 'read';

const key = (id: string) => `hush.chat.${id}`;

export function loadThread(id: string): Thread {
  try {
    const t = JSON.parse(localStorage.getItem(key(id)) ?? 'null') as Thread | null;
    if (t && Array.isArray(t.msgs)) return { msgs: t.msgs, keep: KEEP_CHOICES.includes(t.keep as never) ? t.keep : DEFAULT_KEEP };
  } catch {
    // Unreadable: start again.
  }
  return { msgs: [], keep: DEFAULT_KEEP };
}

export function saveThread(id: string, t: Thread): void {
  try {
    localStorage.setItem(key(id), JSON.stringify(t));
  } catch {
    // Storage full or private mode: the chat lasts until the page closes.
  }
}

export function forgetThread(id: string): void {
  try {
    localStorage.removeItem(key(id));
  } catch {
    // Nothing kept anyway.
  }
}

/** Drops what is past the channel's time. True when something went. */
export function prune(t: Thread, now = Date.now()): boolean {
  const before = t.msgs.length;
  if (t.keep) t.msgs = t.msgs.filter((m) => now - m.ts < t.keep);
  if (t.msgs.length > MAX_MSGS) t.msgs = t.msgs.slice(-MAX_MSGS);
  return t.msgs.length !== before;
}

/** One phone in a two-person channel; everyone but me in a group. */
export const needed = (ch: Pick<Channel, 'size'>) => Math.max(1, (ch.size || 2) - 1);

export function tickOf(m: Msg, ch: Pick<Channel, 'size'>): Tick {
  const need = needed(ch);
  const seen = new Set(m.seen ?? []);
  if (seen.size >= need) return 'read';
  // Read on a phone means it got there too.
  if (new Set([...(m.got ?? []), ...seen]).size >= need) return 'delivered';
  return m.sent ? 'sent' : 'sending';
}

export const unreadOf = (t: Thread) => t.msgs.filter((m) => !m.mine && !m.note && !m.read).length;

/** The newest real message or note, for the list row. */
export const lastOf = (t: Thread): Msg | undefined => t.msgs[t.msgs.length - 1];

export function keepText(keep: number): string {
  return keep === DAY ? '24 hours' : keep ? `${Math.round(keep / DAY)} days` : '';
}

export const newMsgId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
};

const ID = /^[A-Za-z0-9_-]{8,24}$/;

/** A received message, or null for anything malformed. */
export function readMsg(ring: Ring): Msg | null {
  if (typeof ring.id !== 'string' || !ID.test(ring.id)) return null;
  const k = ring.k;
  if (k !== undefined && !KEEP_CHOICES.includes(k as never)) return null;
  const x = typeof ring.x === 'string' ? ring.x.slice(0, MAX_TEXT) : '';
  if (!x.trim() && k === undefined) return null;
  return {
    id: ring.id, mine: false, by: ring.by, from: String(ring.from ?? '').trim().slice(0, 30) || 'Someone', x, ts: ring.ts,
    ...(k !== undefined ? { note: 'keep' as const, k } : {}),
  };
}

/** Adds a message once (it comes once per relay and again until "got"). True when new. */
export function addMsg(t: Thread, m: Msg): boolean {
  if (t.msgs.some((o) => o.id === m.id)) return false;
  if (m.note === 'keep' && m.k !== undefined) t.keep = m.k;
  // Kept in time order, however late it arrives.
  let i = t.msgs.length;
  while (i > 0 && t.msgs[i - 1].ts > m.ts) i--;
  t.msgs.splice(i, 0, m);
  return true;
}

/** "got" or "seen" from one phone. True when a tick changed. */
export function ack(t: Thread, kind: 'got' | 'seen', by: string, ids: string[]): boolean {
  let changed = false;
  const wanted = new Set(ids);
  for (const m of t.msgs) {
    if (!m.mine || !wanted.has(m.id)) continue;
    const list = (m[kind] ??= []);
    if (!list.includes(by)) {
      list.push(by);
      changed = true;
    }
  }
  return changed;
}

/** Mine and not yet on every phone: still to be sent again. */
export function undelivered(t: Thread, ch: Pick<Channel, 'size'>, now = Date.now()): Msg[] {
  return t.msgs.filter((m) => m.mine && m.note !== 'missed' && now - m.ts < MSG_MAX_AGE_MS
    && ['sending', 'sent'].includes(tickOf(m, ch)));
}

/** The ring a message travels as. */
export function ringOf(m: Msg): Omit<Ring, 'by'> {
  return { t: 'msg', id: m.id, from: m.from, ts: m.ts, ...(m.note === 'keep' ? { k: m.k } : { x: m.x }) };
}
