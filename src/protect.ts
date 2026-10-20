/**
 * Protected calls: what everyone sees, and the "someone tried to record" signal phones send each
 * other on the call's own data channel ({"k":"rec","on":true}) — never through a relay.
 */

/** The promise, on the join screen and the safety sheet. Honest: it is what FLAG_SECURE does. */
export const PROTECTED_PROMISE = "🛡️ Protected call — can't be screenshotted or recorded on either phone.";
/** The one thing no app can stop; said next to the promise so nobody over-trusts it. */
export const PROTECTED_LIMIT = "A second phone filming the screen can't be stopped.";

/** The share text for a protected link (the reason line, if any, goes between the two). */
export const PROTECTED_INVITE = ['🛡️ Join my protected Ekanto call — no screenshots, no recording, no login.', 'Works for 24 hours.'];

export const REC_WIRE_PREFIX = '{"k":"rec"';

/** What a phone sends the others when Android says a recorder is on (or off again). */
export function recordingWire(on: boolean): string {
  return JSON.stringify({ k: 'rec', on });
}

/** The {on} of a "rec" message; null for anything else, including a broken one. */
export function parseRecording(message: Record<string, unknown>): boolean | null {
  return message['k'] === 'rec' && typeof message['on'] === 'boolean' ? message['on'] : null;
}

/** What the OTHER phones see, with the recorder's name: "Ravi's phone tried to record — blocked." */
export function recordingNotice(name: string): string {
  return `${name.slice(0, 30) || 'Someone'}'s phone tried to record — blocked.`;
}

/** What the recording phone itself sees. */
export const RECORDING_SELF = 'Recording is blocked in a protected call.';
