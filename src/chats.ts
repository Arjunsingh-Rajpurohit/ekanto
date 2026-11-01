import type { Channel, FileMeta, Ring } from './channels';
import { deleteChannel, deleteFile, fileKey, getFile, putFile, sweep } from './filestore';
import {
  MAX_TEXT, ack, addMsg, forgetThread, loadThread, newMsgId, prune, readMsg, ringOf, saveThread, undelivered,
  type Msg, type Thread,
} from './messages';
import { AUTO_FETCH, Transfers } from './transfer';

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
  /** My tag in a channel, and "Hide my IP" (files then go through our relay only). */
  me(ch: Channel): string | null;
  relayOnly(): boolean;
  /** A file of theirs moved on (waiting → arriving → here): the screen updates just that bubble. */
  progress(channel: string, id: string): void;
}

export interface SendOptions {
  /** A caption, a reply, a surprise's opening time. */
  x?: string;
  q?: string;
  op?: number;
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
  readonly transfers: Transfers;

  constructor(deps: ChatDeps) {
    this.deps = deps;
    this.transfers = new Transfers({
      send: (ch, ring) => deps.send(ch, ring),
      channel: (id) => deps.channels().find((c) => c.id === id),
      me: (ch) => deps.me(ch),
      myName: () => deps.myName(),
      mine: (ch, id) => this.mineFile(ch, id),
      relayOnly: () => deps.relayOnly(),
      progress: (ch, id) => deps.progress(ch, id),
      arrived: (ch, id, ok) => this.arrived(ch, id, ok),
      missing: (ch, id) => this.setDl(ch, id, 'none'),
    });
    setInterval(() => this.tick(), 15000);
  }

  /** On start: fetch whatever of theirs is still on its way (it goes on where it stopped). */
  resumeFetches(): void {
    for (const ch of this.deps.channels()) {
      if (ch.gone) continue;
      for (const m of this.thread(ch.id).msgs) if (this.shouldFetch(m)) this.transfers.want(ch, m.by, m.id, m.f!.z);
    }
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

  send(ch: Channel, text: string, opts: SendOptions = {}): void {
    const x = text.trim().slice(0, MAX_TEXT);
    if (!x || ch.gone) return;
    this.add(ch, { ...this.mine(opts), x });
  }

  /**
   * A photo, video, voice note or any file. It is kept on this phone (the other phones fetch it
   * from here, phone to phone) before the message about it goes out.
   */
  async sendFile(ch: Channel, blob: Blob, f: FileMeta, opts: SendOptions = {}): Promise<void> {
    if (ch.gone) return;
    const m: Msg = { ...this.mine(opts), x: (opts.x ?? '').trim().slice(0, MAX_TEXT), f };
    await putFile(fileKey(ch.id, m.id), blob);
    this.add(ch, m);
  }

  sendSticker(ch: Channel, s: string, opts: SendOptions = {}): void {
    if (!ch.gone) this.add(ch, { ...this.mine({ q: opts.q }), x: '', s });
  }

  /** A reaction; the same one again takes it off. */
  react(ch: Channel, id: string, e: string): void {
    const t = this.thread(ch.id);
    const current = [...t.msgs].reverse().find((m) => m.note === 'react' && m.mine && m.on === id);
    this.add(ch, { ...this.mine({}), x: '', note: 'react', on: id, e: current?.e === e ? '' : e });
  }

  /** Delete for everyone — any time, not just in the first hours. A view-only file is taken back. */
  deleteForEveryone(ch: Channel, id: string): void {
    const m = this.thread(ch.id).msgs.find((o) => o.id === id && o.mine && !o.note);
    if (!m || m.gone) return;
    this.add(ch, { ...this.mine({}), x: '', note: 'del', del: id });
    void this.cleanFiles(ch.id);
  }

  /** Delete on this phone only. */
  deleteForMe(ch: Channel, id: string): void {
    const t = this.thread(ch.id);
    t.msgs = t.msgs.filter((m) => m.id !== id && m.on !== id);
    this.transfers.drop(id);
    this.save(ch.id, t);
    void this.cleanFiles(ch.id);
  }

  /** A surprise of theirs opens (only once its time has come). */
  unwrap(ch: Channel, id: string): boolean {
    const m = this.thread(ch.id).msgs.find((o) => o.id === id);
    if (!m || m.mine || !m.op || m.op > Date.now() || m.un) return false;
    m.un = true;
    this.save(ch.id, this.thread(ch.id));
    return true;
  }

  /** Fetch a file by tap: one too big to come by itself, or one that broke. */
  fetch(ch: Channel, id: string): void {
    const m = this.thread(ch.id).msgs.find((o) => o.id === id);
    if (!m?.f || m.mine || m.gone || m.dl === 'done') return;
    delete m.dl;
    this.save(ch.id, this.thread(ch.id));
    this.transfers.want(ch, m.by, m.id, m.f.z);
  }

  /** The file of a message, if this phone has it. */
  file(ch: Channel, m: Msg): Promise<Blob | null> {
    return m.f && !m.gone && (m.mine || m.dl === 'done') ? getFile(fileKey(ch.id, m.id)) : Promise.resolve(null);
  }

  /** Their phone said something: anything waiting on it is asked for now. */
  heard(ch: Channel, by: string): void {
    this.transfers.heard(ch, by);
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
    if (ring.t === 'fx') return this.transfers.onRing(ch, ring);
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
      if (ch && m && addMsg(this.thread(ch.id), m)) {
        if (m.f && !m.gone && m.f.z > AUTO_FETCH) m.dl = 'big';
        touched.add(ch.id);
      }
    }
    for (const a of acks) {
      if ((a.kind === 'got' || a.kind === 'seen') && Array.isArray(a.ids) && ack(this.thread(a.channel), a.kind, a.by, a.ids)) touched.add(a.channel);
    }
    for (const id of touched) this.save(id, this.thread(id));
    if (touched.size) this.syncOutbox();
    for (const id of touched) void this.cleanFiles(id);
    this.resumeFetches();
  }

  forget(id: string): void {
    for (const m of this.threads.get(id)?.msgs ?? []) this.transfers.drop(m.id);
    this.threads.delete(id);
    forgetThread(id);
    void deleteChannel(id).catch(() => undefined);
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

  private mine(opts: SendOptions): Msg {
    return {
      id: newMsgId(), mine: true, by: '', from: this.deps.myName(), x: '', ts: Date.now(),
      ...(opts.q ? { q: opts.q } : {}), ...(opts.op && opts.op > Date.now() ? { op: opts.op } : {}),
    };
  }

  private shouldFetch(m: Msg): boolean {
    return !!m.f && !m.mine && !m.gone && !m.dl;
  }

  private async mineFile(ch: Channel, id: string): Promise<Blob | null> {
    const m = this.thread(ch.id).msgs.find((o) => o.id === id);
    return m?.mine && m.f && !m.gone ? getFile(fileKey(ch.id, id)) : null;
  }

  private arrived(chId: string, id: string, ok: boolean): void {
    if (!ok) void deleteFile(fileKey(chId, id));
    this.setDl(chId, id, ok ? 'done' : 'failed');
  }

  private setDl(chId: string, id: string, dl: Msg['dl']): void {
    const t = this.thread(chId);
    const m = t.msgs.find((o) => o.id === id);
    if (!m || m.gone) return;
    m.dl = dl;
    this.save(chId, t);
  }

  /** Files of messages that expired or were deleted leave this phone too. */
  private async cleanFiles(chId: string): Promise<void> {
    const t = this.thread(chId);
    for (const m of t.msgs) if (m.gone) this.transfers.drop(m.id);
    await sweep(chId, new Set(t.msgs.filter((m) => m.f && !m.gone).map((m) => m.id))).catch(() => undefined);
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
    if (this.deps.isOpen(ch.id) && !m.note) {
      m.read = true;
      if (this.deps.receipts()) this.queue(ch, 'seen', [m.id]);
    }
    if (m.f && !m.gone && m.f.z > AUTO_FETCH) m.dl = 'big';
    this.save(ch.id, t, m);
    if (this.shouldFetch(m)) this.transfers.want(ch, m.by, m.id, m.f!.z);
    if (m.note === 'del') void this.cleanFiles(ch.id);
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
      if (prune(t, now)) {
        this.save(ch.id, t);
        void this.cleanFiles(ch.id);
      }
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
