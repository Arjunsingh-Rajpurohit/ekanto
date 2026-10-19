import { describe, expect, it } from 'vitest';
import { channelId, listenDays, myTag, newChannelSecret, openRing, ringKey, ringSecret, ringTopic, sealRing, today, type Ring } from './channels';
import { deriveRoom, open, toBase64Url } from './crypto';

const DAY = 24 * 3600 * 1000;

describe('saved channels', () => {
  it('every member works out the same id, topic and key on their own', async () => {
    const secret = newChannelSecret();
    const a = await ringSecret(secret);
    const b = await ringSecret(secret);
    expect(await channelId(secret)).toMatch(/^[0-9a-f]{16}$/);
    expect(await ringTopic(a, 20000)).toBe(await ringTopic(b, 20000));
    const ring: Ring = { t: 'ring', call: 'abc', from: 'Arjun', by: 'x', ts: 1, v: true };
    expect(await openRing(await ringKey(b), await sealRing(await ringKey(a), ring))).toEqual(ring);
  });

  it("the topic changes every day, so relays can't link one day's rings to the next", async () => {
    const ring = await ringSecret(newChannelSecret());
    expect(await ringTopic(ring, 20000)).not.toBe(await ringTopic(ring, 20001));
    expect(await ringTopic(ring, 20000)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('another channel, or a tampered ring, opens nothing', async () => {
    const mine = await ringKey(await ringSecret(newChannelSecret()));
    const other = await ringKey(await ringSecret(newChannelSecret()));
    const sealed = await sealRing(mine, { t: 'ring', from: 'A', by: 'b', ts: 1 });
    expect(await openRing(other, sealed)).toBeNull();
    const bent = sealed.slice();
    bent[20] ^= 1;
    expect(await openRing(mine, bent)).toBeNull();
  });

  it('a ring never opens as a call message and the other way round', async () => {
    const secret = newChannelSecret();
    const room = await deriveRoom(secret, 'limit=none|app=0|voice=0');
    const ringed = await sealRing(await ringKey(await ringSecret(secret)), { t: 'ring', from: 'A', by: 'b', ts: 1 });
    expect(await open(room.key, ringed)).toBeNull();
  });

  it('"this is me" differs per channel, so channels of one phone are not linked', async () => {
    expect(await myTag('device', 'aaaa')).not.toBe(await myTag('device', 'bbbb'));
    expect(await myTag('device', 'aaaa')).toBe(await myTag('device', 'aaaa'));
  });

  it('listens on yesterday or tomorrow too, near midnight only', () => {
    const day = 20000;
    expect(listenDays(day * DAY + 12 * 3600 * 1000)).toEqual([day]);
    expect(listenDays(day * DAY + 30 * 60 * 1000)).toEqual([day, day - 1]);
    expect(listenDays(day * DAY + 23.5 * 3600 * 1000)).toEqual([day, day + 1]);
    expect(today(day * DAY + 1)).toBe(day);
  });

  /** The Android app works these out in Java: this fixed example must match RingCryptoTest there. */
  it('matches the Android listener (shared example)', async () => {
    const secret = toBase64Url(new Uint8Array(32).map((_, i) => i));
    const ring = await ringSecret(secret);
    expect(toBase64Url(ring)).toBe('e-v7F32U84Gn4hggqer2mXXbWF4VQcBfvuraW9_tGVw');
    expect(await ringTopic(ring, 20745)).toBe('48628575be48e4665945e1f04734602a');
  });
});
