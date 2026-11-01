import type { Channel, Ring } from './channels';
import {
  MAX_TEXT, ack, addMsg, forgetThread, loadThread, newMsgId, prune, readMsg, ringOf, saveThread, undelivered,
  type Msg, type Thread,
} from './messages';

type Send = Omit<Ring, 'by' | 'ts'> & { ts?: number };

export interface ChatDeps {
  /** Sends on the channel's ring topic; true when a relay took it. */
  send(ch: Channel, ring: Send): Promise<boolean>;
  channels(): Channel[];
  myName(): string;
  /** This channel's chat is on screen and the page is visible. */
  isOpen(id: string): boolean;
  /** Read receipts are switched on (Settings). */
  receipts(): boolean;
  /** In the app the background listener answers "got" itself, even while Ekanto is closed. */
  nativeAcks: boolean;
  changed(id: string, news?: Msg): void;
  /** What the background listener keeps sending while Ekanto is closed. */
  outbox(items: { channel: string; id: string; json: string }[]): void;
  json(ch: Channel, ring: Omit<Ring, 'by'>): string | null;
}

/** First retry after 30 s, then doubling, at most every 10 minutes. */
const FIRST_RETRY = 30 * 1000;
const MAX_RETRY = 10 * 60 * 1000;
const SYNC_EVERY = 60 * 1000;
const ID = /^[A-Za-z0-9_-]{8,24}$/;

/** Every saved channel's chat on this phone. */
export class Chats {
  private threads = new Map<string, Thread>();
  private retry = new Map<string, { n: number; next: number }>();
  private queued = { got: new Map<string, Set<string>>(), seen: new Map<string, Set<string>>() };
  private flushTimer?: ReturnType<typeof setTimeout>;
  private outboxTimer?: ReturnType<typeof setTimeout>;
  private lastSync = new Map<string, number>();
  private readonly deps: ChatDeps;

  constructor(deps: ChatDeps) {
    this.deps = deps;
    setInterval(() => this.tick(), 15000);
  }

  thread(id: string): Thread {
    let t = this.threads.get(id);
    if (!t) {
      t = loadThread(id);
      this.threads.set(id, t);
      if (prune(t)) saveThread(id, t);
    }
    return t;
  }

  send(ch: Channel, text: string): void {
    const x = text.trim().slice(0, MAX_TEXT);
    if (!x || ch.gone) return;
    this.add(ch, { id: newMsgId(), mine: true, by: '', from: this.deps.myName(), x, ts: Date.now() });
  }

  /** How long messages stay — for everyone in the channel, like WhatsApp's disappearing messages. */
  setKeep(ch: Channel, keep: number): void {
    if (ch.gone || this.thread(ch.id).keep === keep) return;
    this.add(ch, { id: newMsgId(), mine: true, by: '', from: this.deps.myName(), x: '', ts: Date.now(), note: 'keep', k: keep });
  }

  /** A missed call, shown in the chat where it happened. Kept on this phone only. */
  missed(ch: Channel, at: number, why?: string): void {
    const t = this.thread(ch.id);
    if (addMsg(t, { id: `missed-${at}`, mine: false, by: '', from: ch.name, x: '', ts: at, note: 'missed', why, read: true })) {
      this.save(ch.id, t);
    }
  }

  onRing(ch: Channel, ring: Ring): void {
    if (ring.t === 'msg') return this.received(ch, ring);
    if (ring.t === 'sync') return this.resend(ch);
    if (ring.t !== 'got' && ring.t !== 'seen') return;
    const ids = Array.isArray(ring.ids) ? ring.ids.filter((i) => typeof i === 'string' && ID.test(i)).slice(0, 200) : [];
    const t = this.thread(ch.id);
    if (ids.length && ack(t, ring.t, ring.by, ids)) {
      this.save(ch.id, t);
      this.syncOutbox();
    }
  }

  /** The chat is on screen: theirs are read now (and they hear so, unless read receipts are off). */
  markRead(ch: Channel): void {
    const t = this.thread(ch.id);
    const fresh = t.msgs.filter((m) => !m.mine && !m.note && !m.read);
    if (!fresh.length) return;
    for (const m of fresh) m.read = true;
    this.save(ch.id, t);
    if (this.deps.receipts()) this.queue(ch, 'seen', fresh.map((m) => m.id));
  }

  /** "I'm here": anyone holding a message for this phone sends it now instead of in a few minutes. */
  sync(ch: Channel): void {
    if (ch.gone || Date.now() - (this.lastSync.get(ch.id) ?? 0) < SYNC_EVERY) return;
    this.lastSync.set(ch.id, Date.now());
    void this.deps.send(ch, { t: 'sync', from: this.deps.myName() });
  }

  /** What the Android listener heard while Ekanto was closed (it already answered "got"). */
  merge(msgs: Ring[], acks: { channel: string; kind: string; by: string; ids: string[] }[]): void {
    const touched = new Set<string>();
    for (const r of msgs) {
      const ch = this.deps.channels().find((c) => c.id === (r as Ring & { channel?: string }).channel);
      const m = ch ? readMsg(r) : null;
      if (ch && m && addMsg(this.thread(ch.id), m)) touched.add(ch.id);
    }
    for (const a of acks) {
      if ((a.kind === 'got' || a.kind === 'seen') && Array.isArray(a.ids) && ack(this.thread(a.channel), a.kind, a.by, a.ids)) touched.add(a.channel);
    }
    for (const id of touched) this.save(id, this.thread(id));
    if (touched.size) this.syncOutbox();
  }

  forget(id: string): void {
    this.threads.delete(id);
    forgetThread(id);
    this.syncOutbox();
  }

  /** Back online, or the app came back: send what is waiting now. */
  resendAll(): void {
    for (const ch of this.deps.channels()) this.resend(ch);
  }

  /** The background listener's copy of what is still on its way. */
  syncOutbox(): void {
    clearTimeout(this.outboxTimer);
    this.outboxTimer = setTimeout(() => {
      const items: { channel: string; id: string; json: string }[] = [];
      for (const ch of this.deps.channels()) {
        if (ch.gone) continue;
        for (const m of undelivered(this.thread(ch.id), ch)) {
          const json = this.deps.json(ch, ringOf(m));
          if (json) items.push({ channel: ch.id, id: m.id, json });
        }
      }
      this.deps.outbox(items);
    }, 800);
  }

  private add(ch: Channel, m: Msg): void {
    const t = this.thread(ch.id);
    addMsg(t, m);
    this.save(ch.id, t, m);
    this.retry.set(m.id, { n: 0, next: Date.now() + FIRST_RETRY });
    void this.transmit(ch, m);
    this.syncOutbox();
  }

  private received(ch: Channel, ring: Ring): void {
    const m = readMsg(ring);
    if (!m || ch.gone) return;
    // Every copy is answered: the "got" for an earlier one may have been lost on the way.
    if (!this.deps.nativeAcks) this.queue(ch, 'got', [m.id]);
    const t = this.thread(ch.id);
    if (!addMsg(t, m)) return;
    if (this.deps.isOpen(ch.id)) {
      m.read = true;
      if (this.deps.receipts()) this.queue(ch, 'seen', [m.id]);
    }
    this.save(ch.id, t, m);
  }

  private async transmit(ch: Channel, m: Msg): Promise<void> {
    const took = await this.deps.send(ch, ringOf(m));
    if (took && !m.sent) {
      m.sent = true;
      this.save(ch.id, this.thread(ch.id));
    }
  }

  private resend(ch: Channel): void {
    for (const m of undelivered(this.thread(ch.id), ch)) {
      this.retry.set(m.id, { n: 0, next: Date.now() + FIRST_RETRY });
      void this.transmit(ch, m);
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const ch of this.deps.channels()) {
      if (ch.gone) continue;
      const t = this.thread(ch.id);
      if (prune(t, now)) this.save(ch.id, t);
      for (const m of undelivered(t, ch, now)) {
        const r = this.retry.get(m.id) ?? { n: 0, next: 0 };
        if (now < r.next) continue;
        this.retry.set(m.id, { n: r.n + 1, next: now + Math.min(FIRST_RETRY * 2 ** r.n, MAX_RETRY) });
        void this.transmit(ch, m);
      }
    }
  }

  /** "got" and "seen" go out together, a moment later: one ring for many messages. */
  private queue(ch: Channel, kind: 'got' | 'seen', ids: string[]): void {
    const map = this.queued[kind];
    const set = map.get(ch.id) ?? new Set<string>();
    ids.forEach((i) => set.add(i));
    map.set(ch.id, set);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 600);
  }

  private flush(): void {
    for (const kind of ['got', 'seen'] as const) {
      for (const [id, set] of this.queued[kind]) {
        const ch = this.deps.channels().find((c) => c.id === id);
        if (ch && set.size) void this.deps.send(ch, { t: kind, ids: [...set], from: this.deps.myName() });
      }
      this.queued[kind].clear();
    }
  }

  private save(id: string, t: Thread, news?: Msg): void {
    saveThread(id, t);
    this.deps.changed(id, news);
  }
}
