/*
 * The whole privacy story in one file.
 *
 * A call link is https://…/#<secret>. The part after # never leaves the phone — browsers don't
 * send it to any website. From that secret both phones derive, on their own:
 *   - a room name the relays see (a random-looking hash, useless without the secret), and
 *   - an AES-256-GCM key that seals every message the phones exchange.
 * A relay without the secret can't read a message, can't change one, and can't make up a new one,
 * so it can't slip itself into the call. The video itself is then encrypted phone-to-phone by
 * WebRTC (DTLS-SRTP), whose fingerprints travel inside those sealed messages.
 */

const SALT = new TextEncoder().encode('hush/v1');
/** Bound into every sealed message, so a message from another app or version never opens. */
const AAD = new TextEncoder().encode('hush/v1/message');

export interface Room {
  /** What the relays see. */
  topic: string;
  key: CryptoKey;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 256 random bits — the call's only key. */
export function newSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The creator's choices (people limit, app-only) are mixed in too: a link edited from ".4" to
 * ".40" derives a different room and key, so it reaches an empty call instead of a bigger one.
 */
export async function deriveRoom(secret: string, scopeText: string): Promise<Room> {
  const material = await crypto.subtle.importKey('raw', fromBase64Url(secret) as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const scope = `|${scopeText}`;
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode('topic' + scope) }, material, 128);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode('seal' + scope) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const topic = [...new Uint8Array(topicBits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { topic, key };
}

/** iv (12 bytes) + ciphertext with its 16-byte tag. */
export async function seal(key: CryptoKey, message: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(message));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return out;
}

/** Null for anything not sealed with this call's key — wrong call, noise, or tampering. */
export async function open<T>(key: CryptoKey, data: Uint8Array): Promise<T | null> {
  if (data.length < 12 + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: AAD }, key, data.slice(12));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

const EMOJIS = [
  '🐶', '🐱', '🦁', '🐼', '🐸', '🐵', '🦊', '🐻', '🐯', '🐨', '🐷', '🐮', '🐔', '🐧', '🐢', '🐙',
  '🦋', '🐝', '🌵', '🌻', '🍀', '🍄', '🌙', '⭐', '🔥', '🌈', '⚡', '❄️', '🍎', '🍌', '🍉', '🍇',
  '🍕', '🍔', '🍩', '🍪', '🎂', '☕', '🥕', '🌽', '⚽', '🏀', '🎾', '🎲', '🎸', '🎺', '🎈', '🎁',
  '🚀', '🚗', '🚲', '⛵', '✈️', '🏠', '⏰', '🔑', '💡', '📚', '✏️', '🎩', '👓', '🧢', '💎', '🧲',
];

/** Pulls the DTLS certificate fingerprint out of an SDP. */
export function fingerprintOf(sdp: string | undefined): string | null {
  const m = sdp?.match(/a=fingerprint:(\S+ [0-9A-Fa-f:]+)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Five emojis computed from BOTH phones' encryption fingerprints. If someone sat in the middle,
 * each phone would hold a different fingerprint pair, so the emojis would differ.
 * Same emojis on both screens = the line is private. Order-independent, so both sides agree.
 */
export async function safetyEmojis(fingerprintA: string, fingerprintB: string): Promise<string[]> {
  const joined = [fingerprintA, fingerprintB].sort().join('|');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined)));
  return [...hash.slice(0, 5)].map((b) => EMOJIS[b % EMOJIS.length]);
}
