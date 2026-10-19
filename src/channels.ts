import { fromBase64Url, newSecret, toBase64Url } from './crypto';

/*
 * Saved channels: "call Priya" with one tap, no new link every day.
 *
 * A channel is one random secret that only its members' phones hold. It is handed over once,
 * inside a call the members are already in (phone to phone, encrypted) — never in a link — so a
 * link copied from a chat can't get anyone into a channel.
 *
 * From that secret each phone works out, on its own:
 *   - today's "ring topic" on the public relays (a different random-looking name every day, so the
 *     relays can't tell that Monday's and Tuesday's rings belong together), and
 *   - a ring key that seals every ring, so a relay can't read who is calling, fake a ring, or learn
 *     the call link inside it.
 * Each call itself still gets a brand-new secret: a channel never reuses a call room.
 */

export interface Channel {
  /** Same on every member's phone (derived from the secret), so a channel is never saved twice. */
  id: string;
  /** The shared secret. Never shown, never in a link. */
  secret: string;
  /** What this phone calls it ("Priya", "Family"). Each member names it for themselves. */
  name: string;
  /** Calls in this channel are protected (Ekanto app only), like the call it was saved from. */
  appOnly: boolean;
  /** How many people were in the call it was saved from: 2 = a one-to-one channel. */
  size: number;
  /** The other people's names when it was saved. */
  members: string[];
  created: number;
  /** Set when another member deleted it: their name. Calls are then off. */
  gone?: string;
  /** When the last call was missed (shown on the channel until the next call). */
  missed?: number;
  /** Why that missed call was made, if the caller said. */
  missedWhy?: string;
}

/** What travels on a channel's ring topic, sealed with the ring key. */
export interface Ring {
  /**
   * ring: "pick up!" (repeated while ringing) · cancel: the caller gave up, or the call is over ·
   * live: I'm in a call you can join · left: I left it · decline / busy: the answer to a ring ·
   * gone: the sender deleted the channel.
   */
  t: 'ring' | 'cancel' | 'live' | 'left' | 'decline' | 'busy' | 'gone';
  /** The call's own link (its secret). Only members can read it. */
  call?: string;
  /** The sender's name. */
  from: string;
  /** "This is me" for the sender's phone in this channel, so a phone ignores its own rings. */
  by: string;
  ts: number;
  /** Voice call (camera off at the start). */
  v?: boolean;
  /** Why the caller is calling ("Dinner plans?"), if they said. Sealed like the rest of the ring. */
  r?: string;
}

const enc = new TextEncoder();
/** Bound into every sealed ring, so a ring never opens as anything else (or the other way round). */
const RING_AAD = enc.encode('hush/v1/ring');
const DAY = 24 * 3600 * 1000;

async function hmac(key: Uint8Array, text: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function newChannelSecret(): string {
  return newSecret();
}

export async function channelId(secret: string): Promise<string> {
  return hex((await hmac(fromBase64Url(secret), 'hush/id')).slice(0, 8));
}

/**
 * The part of the secret that only rings: the Android app keeps it to listen while closed.
 * It can open rings, never a call that doesn't ring this phone.
 */
export async function ringSecret(secret: string): Promise<Uint8Array> {
  return hmac(fromBase64Url(secret), 'hush/ring');
}

/** The channel's meeting name for one day (UTC days, the same on every phone). */
export async function ringTopic(ring: Uint8Array, day: number): Promise<string> {
  return hex((await hmac(ring, `topic|${day}`)).slice(0, 16));
}

export async function ringKey(ring: Uint8Array): Promise<CryptoKey> {
  const raw = await hmac(ring, 'key');
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** "This is me" in one channel: from this phone's own random key, different in every channel. */
export async function myTag(deviceKey: string, id: string): Promise<string> {
  return toBase64Url((await hmac(enc.encode(deviceKey), `ring-me|${id}`)).slice(0, 12));
}

export const today = (now = Date.now()) => Math.floor(now / DAY);

/**
 * Days to listen on: today, plus yesterday or tomorrow near midnight, so a ring sent just before
 * midnight by one phone still reaches a phone whose clock already says tomorrow.
 */
export function listenDays(now = Date.now()): number[] {
  const day = today(now);
  const into = now - day * DAY;
  const days = [day];
  if (into < 2 * 3600 * 1000) days.push(day - 1);
  if (into > 22 * 3600 * 1000) days.push(day + 1);
  return days;
}

export async function sealRing(key: CryptoKey, ring: Ring): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: RING_AAD }, key, enc.encode(JSON.stringify(ring))));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

export async function openRing(key: CryptoKey, data: Uint8Array): Promise<Ring | null> {
  if (data.length < 12 + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: RING_AAD }, key, data.slice(12));
    const ring = JSON.parse(new TextDecoder().decode(plain)) as Ring;
    return typeof ring?.t === 'string' && typeof ring.by === 'string' && typeof ring.ts === 'number' ? ring : null;
  } catch {
    return null;
  }
}

/* ---------- Kept on this phone only ---------- */

const KEY = 'hush.channels';

export function loadChannels(): Channel[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Channel[];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.secret === 'string' && typeof c.id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveChannels(list: Channel[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private mode or storage full: the channel lasts until the page closes.
  }
}

/** Adds a channel, or updates it if this phone already has it (saved twice from the same call). */
export function upsertChannel(list: Channel[], channel: Channel): Channel[] {
  const rest = list.filter((c) => c.id !== channel.id);
  return [channel, ...rest];
}
