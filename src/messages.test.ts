import { describe, expect, it } from 'vitest';
import { DAY, DEFAULT_KEEP, ack, addMsg, labelOf, lastReaction, prune, reactionsOf, readMsg, ringOf, shown, tickOf, undelivered, unreadOf, wrapped, type Msg, type Thread } from './messages';

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

describe('photos, files, stickers', () => {
  const file = { n: 'beach.jpg', z: 4_200_000, m: 'image/jpeg', w: 4000, h: 3000, th: 'data:image/jpeg;base64,AAAA' };

  it('a photo message carries what it is; the photo itself is not in it', () => {
    const m = readMsg(ring({ id: 'llllllll1', f: file, x: 'look' }))!;
    expect(m.f).toMatchObject({ n: 'beach.jpg', z: 4_200_000, m: 'image/jpeg', w: 4000, h: 3000 });
    expect(m.x).toBe('look');
    expect(labelOf(m)).toBe('📷 look');
    expect(ringOf({ ...m, mine: true })).toMatchObject({ f: { n: 'beach.jpg' }, x: 'look' });
  });

  it('refuses a broken file description or a sticker that is too big or not a picture', () => {
    expect(readMsg(ring({ id: 'mmmmmmmm1', f: { n: 'x', z: -1, m: 'image/png' } }))).toBeNull();
    expect(readMsg(ring({ id: 'mmmmmmmm2', f: { n: 'x', z: 3 * 1024 ** 3, m: 'image/png' } }))).toBeNull();
    expect(readMsg(ring({ id: 'mmmmmmmm3', s: 'i:javascript:alert(1)' }))).toBeNull();
    expect(readMsg(ring({ id: 'mmmmmmmm4', s: `i:data:image/webp;base64,${'A'.repeat(50_000)}` }))).toBeNull();
    expect(readMsg(ring({ id: 'mmmmmmmm5', s: 'e:<img>' }))).toBeNull();
    // A preview that is not a small picture is dropped, the message still comes.
    expect(readMsg(ring({ id: 'mmmmmmmm6', f: { ...file, th: 'data:text/html;base64,AAAA' } }))!.f!.th).toBeUndefined();
  });

  it('a sticker is a message of its own', () => {
    const m = readMsg(ring({ id: 'nnnnnnnn1', s: 'e:😂' }))!;
    expect(m.s).toBe('e:😂');
    expect(labelOf(m)).toBe('Sticker');
  });
});

describe('reactions and delete for everyone', () => {
  it('the newest reaction from each phone counts; the same again takes it off', () => {
    const t = thread();
    addMsg(t, readMsg(ring({ id: 'oooooooo1', x: 'hi' }))!);
    addMsg(t, { ...mine('oooooooo2'), x: '', note: 'react', on: 'oooooooo1', e: '❤️' });
    addMsg(t, readMsg(ring({ id: 'oooooooo3', on: 'oooooooo1', e: '😂' }))!);
    expect([...reactionsOf(t).get('oooooooo1')!.values()]).toEqual(['❤️', '😂']);
    addMsg(t, { ...mine('oooooooo4', Date.now() + 1), x: '', note: 'react', on: 'oooooooo1', e: '' });
    expect([...reactionsOf(t).get('oooooooo1')!.values()]).toEqual(['😂']);
    // Reactions are not messages: nothing unread, nothing in the list row.
    expect(t.msgs.filter(shown)).toHaveLength(1);
  });

  it('the list row shows the newest reaction while it stands, like WhatsApp', () => {
    const t = thread();
    const now = Date.now();
    addMsg(t, { ...mine('qqqqqqqq1', now - 3000), x: 'Yes, at 8' });
    expect(lastReaction(t)).toBeUndefined();
    addMsg(t, readMsg(ring({ id: 'qqqqqqqq2', on: 'qqqqqqqq1', e: '❤️', ts: now - 2000 }))!);
    const r = lastReaction(t)!;
    expect([r.r.from, r.r.e, labelOf(r.on)]).toEqual(['Priya', '❤️', 'Yes, at 8']);
    // Taken off: nothing to show.
    addMsg(t, readMsg(ring({ id: 'qqqqqqqq3', on: 'qqqqqqqq1', e: '', ts: now - 1000 }))!);
    expect(lastReaction(t)).toBeUndefined();
  });

  it('only the sender can delete a message, even if the delete comes first', () => {
    const t = thread();
    addMsg(t, readMsg(ring({ id: 'pppppppp1', del: 'pppppppp2' }))!);
    addMsg(t, readMsg(ring({ id: 'pppppppp2', f: { n: 'a.pdf', z: 10, m: 'application/pdf' }, ts: Date.now() - 1000 }))!);
    const m = t.msgs.find((o) => o.id === 'pppppppp2')!;
    expect(m.gone).toBe(true);
    expect(m.f).toBeUndefined();
    expect(labelOf(m)).toBe('This message was deleted');
    // Someone else can't delete my message.
    addMsg(t, mine('pppppppp3'));
    addMsg(t, readMsg(ring({ id: 'pppppppp4', del: 'pppppppp3' }))!);
    expect(t.msgs.find((o) => o.id === 'pppppppp3')!.gone).toBeUndefined();
  });

  it('a deleted message is not sent again', () => {
    const t = thread();
    addMsg(t, { ...mine('qqqqqqqq1'), sent: true });
    addMsg(t, { ...mine('qqqqqqqq2'), note: 'del', del: 'qqqqqqqq1', x: '' });
    expect(undelivered(t, { size: 2 }).map((m) => m.id)).toEqual(['qqqqqqqq2']);
  });
});

describe('surprises', () => {
  it('stays wrapped until its time, and never says what is inside', () => {
    const now = Date.now();
    const m = readMsg(ring({ id: 'rrrrrrrr1', x: 'Happy birthday!', op: now + 3600_000 }))!;
    expect(m.op).toBe(now + 3600_000);
    expect(wrapped(m, now)).toBe(true);
    expect(labelOf(m, now)).toBe('🎁 A surprise');
    // Its time has come, but it stays wrapped until it is opened on this phone.
    expect(wrapped(m, now + 7200_000)).toBe(true);
    m.un = true;
    expect(wrapped(m, now + 7200_000)).toBe(false);
  });

  it('a time in the past, or years away, is not a surprise', () => {
    expect(readMsg(ring({ id: 'ssssssss1', x: 'hi', op: Date.now() - 1000 }))!.op).toBeUndefined();
    expect(readMsg(ring({ id: 'ssssssss2', x: 'hi', op: Date.now() + 500 * DAY }))!.op).toBeUndefined();
  });
});
