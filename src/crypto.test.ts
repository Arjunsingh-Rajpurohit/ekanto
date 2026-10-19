import { describe, expect, it } from 'vitest';
import { deriveRoom, fingerprintOf, newSecret, open, safetyEmojis, seal } from './crypto';
import { cleanReason, expired, inviteScope, inviteToHash, newInvite, parseInvite } from './invite';

describe('sealed messages', () => {
  it('open with the same link, never with another', async () => {
    const secret = newSecret();
    const a = await deriveRoom(secret, 'limit=2|app=0');
    const b = await deriveRoom(secret, 'limit=2|app=0');
    const stranger = await deriveRoom(newSecret(), 'limit=2|app=0');
    const sealed = await seal(a.key, { t: 'hello', name: 'Arjun' });

    expect(a.topic).toBe(b.topic);
    expect(await open(b.key, sealed)).toEqual({ t: 'hello', name: 'Arjun' });
    expect(await open(stranger.key, sealed)).toBeNull();
  });

  it('a relay that changes even one byte gets nothing through', async () => {
    const room = await deriveRoom(newSecret(), 'limit=none|app=0');
    const sealed = await seal(room.key, { t: 'offer', sdp: 'v=0' });
    const tampered = sealed.slice();
    tampered[20] ^= 1;
    expect(await open(room.key, tampered)).toBeNull();
  });

  it('the relays never see the secret: the topic is a one-way hash of it', async () => {
    const secret = newSecret();
    const room = await deriveRoom(secret, 'limit=none|app=0');
    expect(room.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(room.topic).not.toContain(secret.slice(0, 8));
  });

  it('each message looks different even when the content is the same', async () => {
    const room = await deriveRoom(newSecret(), 'limit=none|app=0');
    const one = await seal(room.key, { t: 'hello' });
    const two = await seal(room.key, { t: 'hello' });
    expect(one).not.toEqual(two);
  });
});

describe('links', () => {
  it('round-trips limit and protection', () => {
    const invite = newInvite(4, true);
    const hash = inviteToHash(invite);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}\.4\.p\.e[0-9a-z]+$/);
    expect(parseInvite(`https://example.github.io/hush/#${hash}`)).toEqual(invite);
    expect(parseInvite(inviteToHash(newInvite(null)))?.limit).toBeNull();
  });

  it('rejects broken, cut-short or out-of-range links', () => {
    const secret = newSecret();
    expect(parseInvite(secret.slice(0, 40))).toBeNull();
    expect(parseInvite(`${secret}.1`)).toBeNull();
    expect(parseInvite(`${secret}.21`)).toBeNull();
    expect(parseInvite(`${secret}.x`)).toBeNull();
    expect(parseInvite('hello')).toBeNull();
  });

  it('editing the limit or removing protection leads to a different, empty call', async () => {
    const invite = newInvite(2, true);
    const real = await deriveRoom(invite.secret, inviteScope(invite));
    const bigger = await deriveRoom(invite.secret, inviteScope({ ...invite, limit: 20 }));
    const unprotected = await deriveRoom(invite.secret, inviteScope({ ...invite, appOnly: false }));
    expect(bigger.topic).not.toBe(real.topic);
    expect(unprotected.topic).not.toBe(real.topic);
    const sealed = await seal(real.key, { t: 'hello' });
    expect(await open(bigger.key, sealed)).toBeNull();
  });
});

describe('24-hour links', () => {
  const HOUR = 3600 * 1000;

  it('work for a day, then stop', () => {
    const made = Date.UTC(2026, 9, 19, 10, 30);
    const invite = newInvite(2, false, false, made);
    const back = parseInvite(inviteToHash(invite))!;
    expect(back.expires).toBe(invite.expires);
    expect(expired(back, made + 23 * HOUR)).toBe(false);
    expect(expired(back, made + 25 * HOUR)).toBe(true);
  });

  it('an old link without an expiry still opens the same call', async () => {
    const old = parseInvite(`${newSecret()}.2`)!;
    expect(old.expires).toBeNull();
    expect(expired(old)).toBe(false);
    expect(inviteScope(old)).toBe('limit=2|app=0|voice=0');
  });

  it('moving the expiry to next year leads to a different, empty call', async () => {
    const invite = newInvite(2);
    const real = await deriveRoom(invite.secret, inviteScope(invite));
    const stretched = await deriveRoom(invite.secret, inviteScope({ ...invite, expires: invite.expires! + 24 * 365 }));
    expect(stretched.topic).not.toBe(real.topic);
  });
});

describe('call reason in the link', () => {
  it('round-trips, in any language', () => {
    for (const why of ['Dinner plans?', 'खाना कब बनेगा? 🍲', 'Quick question']) {
      const invite = newInvite(2, false, true, Date.now(), why);
      expect(parseInvite(`https://x.github.io/ekanto/#${inviteToHash(invite)}`)?.reason).toBe(why);
    }
  });

  it('is cleaned to one short line', () => {
    expect(cleanReason('  hi\n\tthere  ')).toBe('hi there');
    expect(cleanReason('   ')).toBeNull();
    expect([...cleanReason('x'.repeat(200))!]).toHaveLength(60);
  });

  it('editing the reason in a forwarded link leads to a different, empty call', async () => {
    const invite = newInvite(2, false, false, Date.now(), 'Dinner plans?');
    const real = await deriveRoom(invite.secret, inviteScope(invite));
    const edited = parseInvite(inviteToHash({ ...invite, reason: 'Send money now' }))!;
    expect((await deriveRoom(edited.secret, inviteScope(edited))).topic).not.toBe(real.topic);
  });

  it('a link without a reason keeps its exact old key', () => {
    const invite = newInvite(3);
    expect(invite.reason).toBeNull();
    expect(inviteScope(invite)).not.toContain('why=');
  });

  it('a broken or oversized reason means a broken link', () => {
    const base = inviteToHash(newInvite(2));
    expect(parseInvite(`${base}.r!!`)).toBeNull();
    const tooLong = Buffer.from('y'.repeat(100)).toString('base64url');
    expect(parseInvite(`${base}.r${tooLong}`)).toBeNull();
  });
});

describe('safety emojis', () => {
  const sdp = (fp: string) => `v=0\r\na=fingerprint:sha-256 ${fp}\r\n`;

  it('are the same on both phones, whichever side computes them', async () => {
    const a = fingerprintOf(sdp('AA:BB:CC'))!;
    const b = fingerprintOf(sdp('11:22:33'))!;
    const mine = await safetyEmojis(a, b);
    expect(mine).toHaveLength(5);
    expect(await safetyEmojis(b, a)).toEqual(mine);
  });

  it('differ when someone sits in the middle with their own key', async () => {
    const a = 'SHA-256 AA:BB:CC';
    const b = 'SHA-256 11:22:33';
    const middle = 'SHA-256 99:88:77';
    expect(await safetyEmojis(a, middle)).not.toEqual(await safetyEmojis(a, b));
  });
});
