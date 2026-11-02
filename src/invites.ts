import { x25519 } from '@noble/curves/ed25519.js';
import { fromBase64Url, toBase64Url } from './crypto';

/*
 * Adding a person without a call: a short code (K7PM-4QXD), or the same code as a link or a QR.
 *
 * The code is NOT the channel's key — a copied code is not a way in for ever:
 *   - it works once (for one person; a group invite for as many as it was made for) and for a day;
 *   - from it each phone works out, slowly on purpose (PBKDF2, 200 000 rounds), a meeting point on
 *     the relays and a key that seals what the two phones say there. Guessing a code from what a
 *     relay sees costs about a year of a fast graphics card per code — far longer than it lives;
 *   - the channel's own secret then travels inside a box only those two phones can open (a fresh
 *     X25519 key pair each), so a code worked out later, from an old recording, opens nothing.
 * Whoever holds the code before the person it was meant for can still take the place — like any
 * invite. That is why it works only once, for a day, and the inviter sees who joined.
 */

/** Crockford's letters: no I, L, O or U, so nothing reads as something else. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
/** An invite works for a day, like a call link. */
export const INVITE_MS = 24 * 3600 * 1000;
const ROUNDS = 200_000;
const enc = new TextEncoder();
const AAD = enc.encode('hush/v1/invite');
const BOX_AAD = enc.encode('hush/v1/invite-box');

export function newCode(): string {
  // 40 random bits, one letter per 5 bits.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b & 31]).join('');
}

/** "K7PM4QXD" → "K7PM-4QXD". */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What the link carries after the #. */
export const LINK_PREFIX = 'add-';

/** A code as typed or read aloud ("k7pm 4qxd", "K7PM-4QXD", an O for a 0) or a whole link → "K7PM4QXD". */
export function parseCode(text: string | null | undefined): string | null {
  let s = (text ?? '').trim();
  const at = s.lastIndexOf(`#${LINK_PREFIX}`);
  if (at >= 0) s = s.slice(at + 1 + LINK_PREFIX.length);
  else if (s.toLowerCase().startsWith(LINK_PREFIX)) s = s.slice(LINK_PREFIX.length);
  const code = s.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** The invite's own meeting point and key, worked out from the code alone. */
export interface Rendezvous {
  /** Where joins are left (each joiner under its own slot). */
  joins: string;
  key: CryptoKey;
  /** Where the answer for one joiner is left. */
  answers(tag: string): Promise<string>;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function rendezvous(code: string): Promise<Rendezvous> {
  const pass = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('hush/v1/invite-code'), iterations: ROUNDS }, pass, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const part = (info: string) => crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: AAD, info: enc.encode(info) }, material, 128);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: AAD, info: enc.encode('seal') }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { joins: hex(await part('joins')), key, answers: async (tag) => hex(await part(`answer|${tag}`)) };
}

/** What two phones say at the invite's meeting point (sealed with the code's key). */
export interface InviteMsg {
  /** join: "I have the code" · welcome: the box with the channel · used: "already taken, sorry". */
  t: 'join' | 'welcome' | 'used';
  /** Who sends it ("this is me" at this invite, random) and their name. */
  by: string;
  from: string;
  ts: number;
  /** The joiner's key for the box (join) or the inviter's (welcome). */
  pk?: string;
  /** welcome / used: which joiner it answers. */
  to?: string;
  /** welcome: the box. */
  bx?: string;
  /** join: the joiner's own long-lived "this is me" (see personId). */
  pid?: string;
}

export async function sealInvite(key: CryptoKey, msg: InviteMsg): Promise<Uint8Array> {
  return seal(key, AAD, enc.encode(JSON.stringify(msg)));
}

export async function openInvite(key: CryptoKey, data: Uint8Array): Promise<InviteMsg | null> {
  const plain = await unseal(key, AAD, data);
  if (!plain) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(plain)) as InviteMsg;
    return ['join', 'welcome', 'used'].includes(m?.t) && typeof m.by === 'string' && typeof m.ts === 'number'
      && typeof m.from === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** What the box carries: everything the joiner needs to have the channel. */
export interface Welcome {
  /** The channel's secret. */
  cs: string;
  /** The inviter's name, and the group's name when it is one. */
  n: string;
  gn?: string;
  /** Who else is in it already. */
  ms: string[];
  size: number;
  app: boolean;
  /** The inviter's own long-lived "this is me", so the same two people are never saved twice. */
  pid: string;
}

export interface KeyPair {
  sk: string;
  pk: string;
}

export function newKeyPair(): KeyPair {
  const sk = x25519.utils.randomSecretKey();
  return { sk: toBase64Url(sk), pk: toBase64Url(x25519.getPublicKey(sk)) };
}

async function boxKey(mine: KeyPair, theirs: string, joinerPk: string, inviterPk: string): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(fromBase64Url(mine.sk), fromBase64Url(theirs));
  const material = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: BOX_AAD, info: enc.encode(`${joinerPk}|${inviterPk}`) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function boxWelcome(inviter: KeyPair, joinerPk: string, welcome: Welcome): Promise<string> {
  const key = await boxKey(inviter, joinerPk, joinerPk, inviter.pk);
  return toBase64Url(await seal(key, BOX_AAD, enc.encode(JSON.stringify(welcome))));
}

export async function openWelcome(joiner: KeyPair, inviterPk: string, box: string): Promise<Welcome | null> {
  try {
    const key = await boxKey(joiner, inviterPk, joiner.pk, inviterPk);
    const plain = await unseal(key, BOX_AAD, fromBase64Url(box));
    if (!plain) return null;
    const w = JSON.parse(new TextDecoder().decode(plain)) as Welcome;
    return typeof w?.cs === 'string' && /^[A-Za-z0-9_-]{43}$/.test(w.cs) && typeof w.n === 'string' && Array.isArray(w.ms)
      && typeof w.pid === 'string' && Number.isFinite(w.size) ? w : null;
  } catch {
    return null;
  }
}

async function seal(key: CryptoKey, aad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad as BufferSource }, key, plain as BufferSource));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return out;
}

async function unseal(key: CryptoKey, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  if (data.length < 12 + 16) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: aad as BufferSource }, key, data.slice(12)));
  } catch {
    return null;
  }
}

/* ---------- Kept on this phone ---------- */

/** An invite this phone made, until it is used up or a day has passed. */
export interface Sent {
  code: string;
  /** What the inviter calls them (empty = their own name, when they join). */
  name: string;
  /** How many people the channel is for, including the inviter (null = any number). */
  size: number | null;
  appOnly: boolean;
  /** The new channel's secret: the same for everyone who joins with this code. */
  cs: string;
  keys: KeyPair;
  /** "This is me" at this invite. */
  tag: string;
  made: number;
  /** Who joined: their tag (to answer a repeated join the same way) and the channel they got. */
  joined: { tag: string; pk: string; name: string; cs: string }[];
}

/** A code this phone used, until the inviter's answer arrives or a day has passed. */
export interface Taken {
  code: string;
  keys: KeyPair;
  tag: string;
  at: number;
}

const SENT_KEY = 'hush.invites';
const TAKEN_KEY = 'hush.joins';
const PERSON_KEY = 'hush.person';

function load<T>(key: string): T[] {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]') as T[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function keep(key: string, list: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private mode: it lasts while the page is open.
  }
}

export const loadSent = (now = Date.now()) => load<Sent>(SENT_KEY).filter((s) => parseCode(s?.code) && now - s.made < INVITE_MS);
export const saveSent = (list: Sent[]) => keep(SENT_KEY, list);
export const loadTaken = (now = Date.now()) => load<Taken>(TAKEN_KEY).filter((t) => parseCode(t?.code) && now - t.at < INVITE_MS);
export const saveTaken = (list: Taken[]) => keep(TAKEN_KEY, list);

/** True once nobody more can join with it. */
export const full = (s: Sent) => s.size !== null && s.joined.length >= s.size - 1;

/**
 * This phone's own "this is me" for the people it adds: it never goes to a relay unsealed, and
 * lets two phones see they already have each other, so adding someone twice keeps one entry.
 */
let unsaved: string | null = null;
export function personId(): string {
  try {
    const known = localStorage.getItem(PERSON_KEY);
    if (known && /^[A-Za-z0-9_-]{22}$/.test(known)) return known;
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(PERSON_KEY, id);
    return id;
  } catch {
    // Nothing can be kept: a random one for this visit (never one shared by every such phone).
    return (unsaved ??= toBase64Url(crypto.getRandomValues(new Uint8Array(16))));
  }
}

export const newTag = () => toBase64Url(crypto.getRandomValues(new Uint8Array(9)));
