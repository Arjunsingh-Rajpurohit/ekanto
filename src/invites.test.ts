import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH, boxWelcome, formatCode, newCode, newKeyPair, openInvite, openWelcome, parseCode, rendezvous, sealInvite,
  type InviteMsg, type Welcome,
} from './invites';

const welcome: Welcome = { cs: 'A'.repeat(43), n: 'Arjun', ms: [], size: 2, app: false, pid: 'B'.repeat(22) };

describe('invite codes', () => {
  it('a new code is 8 letters and numbers that never read as something else', () => {
    for (let i = 0; i < 200; i++) {
      const code = newCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(code).toHaveLength(CODE_LENGTH);
    }
  });

  it('reads a code however it is typed, pasted or linked', () => {
    expect(formatCode('K7PM4QXD')).toBe('K7PM-4QXD');
    expect(parseCode('K7PM-4QXD')).toBe('K7PM4QXD');
    expect(parseCode('  k7pm 4qxd ')).toBe('K7PM4QXD');
    // O for zero, I or L for one: the same code.
    expect(parseCode('K7PM-4QXO')).toBe('K7PM4QX0');
    expect(parseCode('K7PM-4QXl')).toBe('K7PM4QX1');
    expect(parseCode('https://arjunsingh-rajpurohit.github.io/ekanto/#add-K7PM4QXD')).toBe('K7PM4QXD');
    expect(parseCode('add-K7PM4QXD')).toBe('K7PM4QXD');
  });

  it('refuses anything that is not a code', () => {
    for (const bad of ['', 'K7PM-4QX', 'K7PM-4QXDD', 'K7PM-4QX!', 'K7PM-4QXU', null, undefined, 'https://x/#add-']) {
      expect(parseCode(bad)).toBeNull();
    }
  });
});

describe('meeting at an invite', () => {
  it('both phones work out the same place and key from the code alone; another code meets elsewhere', async () => {
    const [a, b, other] = await Promise.all([rendezvous('K7PM4QXD'), rendezvous('K7PM4QXD'), rendezvous('K7PM4QXE')]);
    expect(a.joins).toMatch(/^[0-9a-f]{32}$/);
    expect(a.joins).toBe(b.joins);
    expect(await a.answers('tag1')).toBe(await b.answers('tag1'));
    expect(await a.answers('tag1')).not.toBe(await a.answers('tag2'));
    expect(other.joins).not.toBe(a.joins);
    const msg: InviteMsg = { t: 'join', by: 'tag1', from: 'Akul', ts: 1, pk: 'p'.repeat(43), pid: 'q'.repeat(22) };
    const sealed = await sealInvite(a.key, msg);
    expect(await openInvite(b.key, sealed)).toEqual(msg);
    // Another code's key, or a bent byte, opens nothing.
    expect(await openInvite(other.key, sealed)).toBeNull();
    const bent = sealed.slice();
    bent[20] ^= 1;
    expect(await openInvite(b.key, bent)).toBeNull();
  });

  it("the channel's secret opens only for the one joiner it was boxed for", async () => {
    const inviter = newKeyPair();
    const joiner = newKeyPair();
    const stranger = newKeyPair();
    const box = await boxWelcome(inviter, joiner.pk, welcome);
    expect(await openWelcome(joiner, inviter.pk, box)).toEqual(welcome);
    // Someone who knows the code but not the joiner's key — e.g. a relay that worked the code out later.
    expect(await openWelcome(stranger, inviter.pk, box)).toBeNull();
    expect(await openWelcome(joiner, stranger.pk, box)).toBeNull();
    expect(await openWelcome(joiner, inviter.pk, `${box.slice(0, -2)}AA`)).toBeNull();
  });
});
