import { describe, expect, it } from 'vitest';
import { DAY, DEFAULT_KEEP, ack, addMsg, prune, readMsg, ringOf, tickOf, undelivered, unreadOf, type Msg, type Thread } from './messages';

const thread = (): Thread => ({ msgs: [], keep: DEFAULT_KEEP });
const mine = (id: string, ts = Date.now()): Msg => ({ id, mine: true, by: '', from: 'Arjun', x: 'hi', ts });
const ring = (extra: object) => ({ t: 'msg' as const, by: 'priya-tag', from: 'Priya', ts: Date.now(), ...extra });

describe('ticks', () => {
  it('one-to-one: sending → sent → delivered → read', () => {
    const m = mine('aaaaaaaa1');
    const ch = { size: 2 };
    expect(tickOf(m, ch)).toBe('sending');
    m.sent = true;
    expect(tickOf(m, ch)).toBe('sent');
    m.got = ['p'];
    expect(tickOf(m, ch)).toBe('delivered');
    m.seen = ['p'];
    expect(tickOf(m, ch)).toBe('read');
  });

  it('a group counts every other phone, and "read" means it arrived too', () => {
    const m = { ...mine('aaaaaaaa2'), sent: true, got: ['a'] };
    const ch = { size: 3 };
    expect(tickOf(m, ch)).toBe('sent');
    m.seen = ['b'];
    expect(tickOf(m, ch)).toBe('delivered');
    m.seen = ['a', 'b'];
    expect(tickOf(m, ch)).toBe('read');
  });
});

describe('arriving', () => {
  it('a message that comes again (another relay, a resend) is shown once', () => {
    const t = thread();
    const m = readMsg(ring({ id: 'bbbbbbbb1', x: 'hello' }))!;
    expect(addMsg(t, m)).toBe(true);
    expect(addMsg(t, { ...m })).toBe(false);
    expect(t.msgs).toHaveLength(1);
    expect(unreadOf(t)).toBe(1);
  });

  it('a late message lands in time order', () => {
    const t = thread();
    addMsg(t, mine('cccccccc2', 2000));
    addMsg(t, readMsg(ring({ id: 'cccccccc1', x: 'first', ts: 1000 }))!);
    expect(t.msgs.map((m) => m.id)).toEqual(['cccccccc1', 'cccccccc2']);
  });

  it('refuses a malformed message: bad id, nothing to say, an unknown setting', () => {
    expect(readMsg(ring({ id: 'x', x: 'hi' }))).toBeNull();
    expect(readMsg(ring({ id: 'dddddddd1', x: '   ' }))).toBeNull();
    expect(readMsg(ring({ id: 'dddddddd2', k: 12345 }))).toBeNull();
  });

  it('a long message is cut to 1000 characters', () => {
    expect(readMsg(ring({ id: 'eeeeeeee1', x: 'a'.repeat(5000) }))!.x).toHaveLength(1000);
  });

  it('a "disappear after" message changes the setting for this chat', () => {
    const t = thread();
    addMsg(t, readMsg(ring({ id: 'ffffffff1', k: DAY }))!);
    expect(t.keep).toBe(DAY);
    expect(ringOf({ ...mine('ffffffff2'), note: 'keep', k: 0, x: '' })).toMatchObject({ t: 'msg', k: 0 });
  });
});

describe('delivery', () => {
  it('"got" from the other phone stops the resending; a repeat changes nothing', () => {
    const t = thread();
    const m = { ...mine('gggggggg1'), sent: true };
    addMsg(t, m);
    expect(undelivered(t, { size: 2 })).toHaveLength(1);
    expect(ack(t, 'got', 'p', ['gggggggg1'])).toBe(true);
    expect(ack(t, 'got', 'p', ['gggggggg1'])).toBe(false);
    expect(undelivered(t, { size: 2 })).toHaveLength(0);
  });

  it('a "got" never touches their messages', () => {
    const t = thread();
    addMsg(t, readMsg(ring({ id: 'hhhhhhhh1', x: 'yo' }))!);
    expect(ack(t, 'got', 'p', ['hhhhhhhh1'])).toBe(false);
  });

  it('gives up resending after 7 days', () => {
    const t = thread();
    addMsg(t, mine('iiiiiiii1', Date.now() - 8 * DAY));
    expect(undelivered(t, { size: 2 })).toHaveLength(0);
  });
});

describe('disappearing', () => {
  it('drops what is past the chat\'s time, keeps the rest', () => {
    const t: Thread = { msgs: [mine('jjjjjjjj1', Date.now() - 2 * DAY), mine('jjjjjjjj2')], keep: DAY };
    expect(prune(t)).toBe(true);
    expect(t.msgs.map((m) => m.id)).toEqual(['jjjjjjjj2']);
  });

  it('"Never" keeps everything', () => {
    const t: Thread = { msgs: [mine('kkkkkkkk1', Date.now() - 400 * DAY)], keep: 0 };
    expect(prune(t)).toBe(false);
  });
});
