import { MQTT_RELAYS, NOSTR_RELAYS, ALL_RELAYS } from './relays';

export { MQTT_RELAYS, NOSTR_RELAYS, ALL_RELAYS };

/**
 * STUN tells a phone its own public address so the phones can find a direct path.
 * Cloudflare's only — no Google. It sees an address, never a call.
 */
const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * TURN is the backup relay when a direct path is blocked (common on mobile data). It carries the
 * call already encrypted by the phones, so it can't see or hear anything. Set at build time from
 * VITE_TURN_* (a GitHub secret) — never written in the code.
 */
const env = import.meta.env;
const TURN: RTCIceServer[] = env.VITE_TURN_URLS && env.VITE_TURN_USERNAME && env.VITE_TURN_CREDENTIAL
  ? [{ urls: String(env.VITE_TURN_URLS).split(',').map((u: string) => u.trim()), username: env.VITE_TURN_USERNAME, credential: env.VITE_TURN_CREDENTIAL }]
  : [];

export const ICE_SERVERS: RTCIceServer[] = [...STUN, ...TURN];
export const HAS_TURN = TURN.length > 0;

/** Where the Android app can be downloaded (a GitHub release), set when building. */
export const APP_DOWNLOAD_URL = (env.VITE_APP_URL as string | undefined) ?? '';

/** Opens a link straight in the installed app: hushcall://join#<link> */
export const APP_SCHEME = 'hushcall';

/** Where shared links point: the website itself, or (inside the Android app) the website's address. */
export function publicUrl(): string {
  const fromBuild = env.VITE_PUBLIC_URL as string | undefined;
  // Written the standard way (host in lower case): Android matches app links letter for letter,
  // so a link starting "https://Arjunsingh-…" would open the browser instead of the app.
  const href = new URL(fromBuild || `${location.origin}${location.pathname}`).href;
  return href.endsWith('/') ? href : `${href}/`;
}
