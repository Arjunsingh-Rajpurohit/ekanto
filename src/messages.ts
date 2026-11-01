import type { Channel, FileMeta, Ring } from './channels';
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
/** Biggest file one phone sends: the same as WhatsApp's. It goes phone to phone, so nothing else limits it. */
export const MAX_FILE = 2 * 1024 * 1024 * 1024;
/** A sticker you made rides inside the message itself, so it must stay small. */
export const MAX_STICKER = 40_000;
/** The quick reactions, like every chat app's. */
export const REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🙏'] as const;
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
  /** A line in the thread instead of a message; react / del are never shown, they change another message. */
  note?: 'missed' | 'keep' | 'react' | 'del';
  /** keep: the new setting. */
  k?: number;
  /** missed: why they called. */
  why?: string;
  f?: FileMeta;
  s?: string;
  q?: string;
  on?: string;
  e?: string;
  del?: string;
  op?: number;
  /** Deleted for everyone (its words and file are gone, a line says so). */
  gone?: boolean;
  /** A file of theirs: here in full, still coming, too big to fetch by itself, or no longer offered. */
  dl?: 'done' | 'big' | 'none' | 'failed';
  /** A surprise of theirs, opened on this phone. */
  un?: boolean;
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

export const unreadOf = (t: Thread) => t.msgs.filter((m) => !m.mine && !m.note && !m.read && !m.gone).length;

/** Shown in the thread (reactions and deletes only change other messages). */
export const shown = (m: Msg) => m.note !== 'react' && m.note !== 'del';

/** The newest real message or note, for the list row. */
export const lastOf = (t: Thread): Msg | undefined => [...t.msgs].reverse().find(shown);

/** Still wrapped: a surprise whose time hasn't come (mine are wrapped for them, not for me). */
export const wrapped = (m: Msg, now = Date.now()) => !!m.op && !m.gone && (m.op > now || (!m.mine && !m.un));

/** A message in a few words, for the list, a notification or a reply: never a surprise's insides. */
export function labelOf(m: Msg, now = Date.now()): string {
  if (m.gone) return m.mine ? 'You deleted this message' : 'This message was deleted';
  if (!m.mine && m.op && wrapped(m, now)) return '🎁 A surprise';
  if (m.s) return 'Sticker';
  if (m.f) {
    const kind = m.f.vo ? '🎤 Voice message' : m.f.g ? 'GIF' : m.f.m.startsWith('image/') ? '📷 Photo'
      : m.f.m.startsWith('video/') ? '🎬 Video' : `📄 ${m.f.n}`;
    return m.x ? `${kind.split(' ')[0]} ${m.x}` : kind;
  }
  return m.x;
}

/** Who reacted with what, newest choice per phone. */
export function reactionsOf(t: Thread): Map<string, Map<string, string>> {
  const all = new Map<string, Map<string, string>>();
  for (const m of t.msgs) {
    if (m.note !== 'react' || !m.on) continue;
    const on = all.get(m.on) ?? new Map<string, string>();
    if (m.e) on.set(m.mine ? '' : m.by, m.e);
    else on.delete(m.mine ? '' : m.by);
    all.set(m.on, on);
  }
  return all;
}

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
  const f = ring.f === undefined ? undefined : readFile(ring.f);
  const s = ring.s === undefined ? undefined : readSticker(ring.s);
  if (f === null || s === null) return null;
  const q = idOrNull(ring.q);
  const on = idOrNull(ring.on);
  const del = idOrNull(ring.del);
  if (q === null || on === null || del === null) return null;
  const e = typeof ring.e === 'string' ? [...ring.e].slice(0, 8).join('') : undefined;
  // A surprise opens within a year; anything else is someone playing with the clock.
  const op = typeof ring.op === 'number' && ring.op > ring.ts && ring.op - ring.ts < 400 * DAY ? Math.round(ring.op) : undefined;
  const base = { id: ring.id, mine: false, by: ring.by, from: String(ring.from ?? '').trim().slice(0, 30) || 'Someone', x, ts: ring.ts };
  if (k !== undefined) return { ...base, note: 'keep', k };
  if (on) return e === undefined ? null : { ...base, x: '', note: 'react', on, e };
  if (del) return { ...base, x: '', note: 'del', del };
  if (!x.trim() && !f && !s) return null;
  return { ...base, ...(f ? { f } : {}), ...(s ? { s, x: '' } : {}), ...(q ? { q } : {}), ...(op ? { op } : {}) };
}

/** undefined: not given · null: given but broken (the whole message is refused). */
function idOrNull(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === 'string' && ID.test(v) ? v : null;
}

const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function readFile(v: unknown): FileMeta | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (n: unknown, max: number) => (typeof n === 'number' && n >= 0 && n <= max ? Math.round(n) : undefined);
  const z = num(o.z, MAX_FILE);
  if (typeof o.n !== 'string' || z === undefined) return null;
  const m = typeof o.m === 'string' && MIME.test(o.m) && o.m.length <= 100 ? o.m.toLowerCase() : 'application/octet-stream';
  const th = typeof o.th === 'string' && /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(o.th) && o.th.length <= 8000 ? o.th : undefined;
  const wf = typeof o.wf === 'string' && /^[0-9]{1,64}$/.test(o.wf) ? o.wf : undefined;
  const d = typeof o.d === 'number' && o.d >= 0 && o.d <= 36000 ? Math.round(o.d * 10) / 10 : undefined;
  const meta: FileMeta = { n: o.n.replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'file', z, m };
  if (o.v === true) meta.v = true;
  if (o.g === true) meta.g = true;
  if (o.vo === true) meta.vo = true;
  const w = num(o.w, 20000);
  const h = num(o.h, 20000);
  if (w && h) Object.assign(meta, { w, h });
  if (d !== undefined) meta.d = d;
  if (th) meta.th = th;
  if (wf) meta.wf = wf;
  return meta;
}

function readSticker(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith('e:')) {
    const emoji = v.slice(2);
    return emoji && [...emoji].length <= 8 && !/[<>&"']/.test(emoji) ? v : null;
  }
  return v.startsWith('i:') && v.length <= MAX_STICKER && /^i:data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

/** Adds a message once (it comes once per relay and again until "got"). True when new. */
export function addMsg(t: Thread, m: Msg): boolean {
  if (t.msgs.some((o) => o.id === m.id)) return false;
  if (m.note === 'keep' && m.k !== undefined) t.keep = m.k;
  // Kept in time order, however late it arrives.
  let i = t.msgs.length;
  while (i > 0 && t.msgs[i - 1].ts > m.ts) i--;
  t.msgs.splice(i, 0, m);
  applyDeletes(t);
  return true;
}

/**
 * Deleted for everyone: the message keeps its place and time, its words and file go. Only the
 * person who sent a message can delete it, however the delete arrives (before the message, too).
 * Returns the ids whose files must go from this phone.
 */
export function applyDeletes(t: Thread): string[] {
  const dropped: string[] = [];
  for (const d of t.msgs) {
    if (d.note !== 'del' || !d.del) continue;
    const m = t.msgs.find((o) => o.id === d.del && o.mine === d.mine && (d.mine || o.by === d.by));
    if (!m || m.gone || m.note) continue;
    if (m.f) dropped.push(m.id);
    m.gone = true;
    m.x = '';
    delete m.f;
    delete m.s;
    delete m.q;
    delete m.dl;
  }
  return dropped;
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
  return t.msgs.filter((m) => m.mine && m.note !== 'missed' && !m.gone && now - m.ts < MSG_MAX_AGE_MS
    && ['sending', 'sent'].includes(tickOf(m, ch)));
}

/** The ring a message travels as. */
export function ringOf(m: Msg): Omit<Ring, 'by'> {
  const base = { t: 'msg' as const, id: m.id, from: m.from, ts: m.ts };
  if (m.note === 'keep') return { ...base, k: m.k };
  if (m.note === 'react') return { ...base, on: m.on, e: m.e ?? '' };
  if (m.note === 'del') return { ...base, del: m.del };
  return {
    ...base, x: m.x,
    ...(m.f ? { f: m.f } : {}), ...(m.s ? { s: m.s } : {}), ...(m.q ? { q: m.q } : {}), ...(m.op ? { op: m.op } : {}),
  };
}
