import type { Channel, Ring } from './channels';
import { ICE_SERVERS } from './config';
import { fileKey, finishPieces, getPieces, putPiece } from './filestore';

/*
 * Photos, videos and files go straight from the sender's phone to the other phone — no server
 * ever holds them, not even encrypted, and nothing squeezes them: the exact original arrives.
 *
 * The message ("msg" ring) says what the file is; the phone that wants it asks the sender's phone
 * for it. The two phones set up a direct line (WebRTC, encrypted end to end — DTLS) with an offer
 * and an answer sealed with the channel's key ("fx" rings), so nobody outside the channel can step
 * in between. The file then flows over that line in pieces that are saved as they come: a dropped
 * connection goes on where it stopped. If the sender's phone is off, the file waits there until
 * both are on — the message (and its blurred preview) has already arrived.
 */

/** Fetched by itself up to this size; bigger ones wait for a tap, like WhatsApp on mobile data. */
export const AUTO_FETCH = 25 * 1024 * 1024;
/** Written to the phone's storage every this many bytes (the resume point). */
const PIECE = 1024 * 1024;
const HIGH = 4 * 1024 * 1024;
const LOW = 1024 * 1024;
const ANSWER_WAIT = 12_000;
const OPEN_WAIT = 25_000;
const IDLE_CLOSE = 30_000;
const FIRST_RETRY = 15_000;
const MAX_RETRY = 5 * 60_000;
const MAX_SERVING = 8;
/** No bytes for this long while a file is coming: the line is stuck. Start again where it stopped. */
const STALL = 15_000;

/** Troubleshooting only (hush.debug = 1): short ids and byte counts in this phone's console, never content. */
const DEBUG = (() => {
  try {
    return localStorage.getItem('hush.debug') === '1';
  } catch {
    return false;
  }
})();
const log = (...parts: unknown[]) => DEBUG && console.debug('[hush:fx]', ...parts);

type Wire = { get: string; at: number } | { ok: string; z: number; at: number } | { no: string } | { end: string };

export interface TransferDeps {
  send(ch: Channel, ring: Omit<Ring, 'by' | 'ts' | 'from'> & { from: string }): Promise<boolean>;
  channel(id: string): Channel | undefined;
  /** My tag in this channel (what other phones call me). */
  me(ch: Channel): string | null;
  myName(): string;
  /** One of my files in this chat that its members may fetch, or null (deleted, taken back, expired). */
  mine(ch: Channel, id: string): Promise<Blob | null>;
  relayOnly(): boolean;
  /** Theirs: bytes here so far / here in full / the sender no longer offers it. */
  progress(ch: string, id: string): void;
  arrived(ch: string, id: string, ok: boolean): void;
  missing(ch: string, id: string): void;
}

export type FetchState = { state: 'waiting' } | { state: 'loading'; got: number };

interface Want {
  id: string;
  size: number;
}

interface Link {
  key: string;
  ch: Channel;
  peer: string;
  sid: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  role: 'fetch' | 'serve';
  closed: boolean;
  idle?: ReturnType<typeof setTimeout>;
  answerTimer?: ReturnType<typeof setTimeout>;
  /** fetch: the file coming in now, when its last bytes came, and a finished one still being written. */
  current?: Incoming;
  lastByte: number;
  finishing: boolean;
  watch?: ReturnType<typeof setInterval>;
  /** serve: requests, one at a time. */
  queue?: Promise<void>;
}

interface Incoming {
  id: string;
  size: number;
  got: number;
  n: number;
  buffer: ArrayBuffer[];
  buffered: number;
}

const sid = () => crypto.randomUUID().slice(0, 8);

export class Transfers {
  /** What this phone wants, per sender: "<channel>|<their tag>". */
  private wants = new Map<string, Map<string, Want>>();
  private links = new Map<string, Link>();
  private serving = new Map<string, Link>();
  private retry = new Map<string, { n: number; timer?: ReturnType<typeof setTimeout> }>();
  /** Pieces still being written, per file: a new line waits for them before it asks where to go on. */
  private writes = new Map<string, Promise<void>>();
  readonly states = new Map<string, FetchState>();
  private readonly deps: TransferDeps;

  constructor(deps: TransferDeps) {
    this.deps = deps;
  }

  /** Fetch one of their files (again), now or as soon as their phone is on. */
  want(ch: Channel, by: string, id: string, size: number): void {
    const key = `${ch.id}|${by}`;
    const list = this.wants.get(key) ?? new Map<string, Want>();
    if (list.has(id)) return;
    list.set(id, { id, size });
    this.wants.set(key, list);
    if (!this.states.has(id)) this.states.set(id, { state: 'waiting' });
    this.deps.progress(ch.id, id);
    // A line to their phone is already open and resting: use it.
    const link = this.links.get(key);
    if (link && !link.closed && link.dc.readyState === 'open' && !link.current && !link.finishing) this.next(link);
    else this.connect(key);
  }

  /** Stop wanting a file (deleted, taken back, or the chat removed). */
  drop(id: string): void {
    for (const list of this.wants.values()) list.delete(id);
    this.states.delete(id);
  }

  /** Any sign of life from their phone: what waits for it is asked for now, not at the next retry. */
  heard(ch: Channel, by: string): void {
    const key = `${ch.id}|${by}`;
    if (!this.wants.get(key)?.size || this.links.has(key)) return;
    const r = this.retry.get(key);
    if (r) {
      clearTimeout(r.timer);
      r.n = 0;
    }
    this.connect(key);
  }

  /** Back online or back on screen: try every waiting file now. */
  wake(): void {
    for (const key of this.wants.keys()) {
      if (this.links.has(key) || !this.wants.get(key)?.size) continue;
      clearTimeout(this.retry.get(key)?.timer);
      this.connect(key);
    }
  }

  onRing(ch: Channel, ring: Ring): void {
    const me = this.deps.me(ch);
    if (ring.t !== 'fx' || !me || ring.to !== me || typeof ring.sid !== 'string' || typeof ring.sdp !== 'string' && ring.a !== 'none') return;
    if (ring.a === 'offer') void this.serve(ch, ring);
    else {
      const link = this.links.get(`${ch.id}|${ring.by}`);
      if (!link || link.sid !== ring.sid || link.closed) return;
      clearTimeout(link.answerTimer);
      if (ring.a === 'answer') void link.pc.setRemoteDescription({ type: 'answer', sdp: ring.sdp! }).catch(() => this.fail(link));
      else this.fail(link);
    }
  }

  stop(): void {
    for (const link of [...this.links.values(), ...this.serving.values()]) this.close(link);
  }

  /* ---------- Fetching (the phone that wants the file) ---------- */

  private connect(key: string): void {
    const [chId, peer] = key.split('|');
    const ch = this.deps.channel(chId);
    if (!ch || ch.gone || !this.wants.get(key)?.size || this.links.has(key)) return;
    const link = this.newLink(key, ch, peer, sid(), 'fetch');
    this.links.set(key, link);
    link.dc.onopen = () => {
      log('open', link.sid);
      this.retry.delete(key);
      link.watch = setInterval(() => {
        if (link.current && Date.now() - link.lastByte > STALL) {
          log('stalled', link.sid, link.current.got);
          this.fail(link);
        }
      }, 5000);
      this.next(link);
    };
    link.dc.onmessage = (e) => this.fetched(link, e.data as string | ArrayBuffer);
    void (async () => {
      try {
        await link.pc.setLocalDescription(await link.pc.createOffer());
        const sdp = await gathered(link.pc);
        if (link.closed) return;
        await this.deps.send(ch, { t: 'fx', to: peer, sid: link.sid, a: 'offer', sdp, from: this.deps.myName() });
        // No answer: their phone is off (or Ekanto is closed there). Try again later.
        link.answerTimer = setTimeout(() => this.fail(link), ANSWER_WAIT);
        setTimeout(() => {
          if (!link.closed && link.dc.readyState !== 'open') this.fail(link);
        }, OPEN_WAIT);
      } catch {
        this.fail(link);
      }
    })();
  }

  /** Asks for the next file, or closes the line a little after the last one. */
  private next(link: Link): void {
    clearTimeout(link.idle);
    const list = this.wants.get(link.key);
    const want = list?.values().next().value as Want | undefined;
    if (!want) {
      link.idle = setTimeout(() => this.close(link), IDLE_CLOSE);
      return;
    }
    void (async () => {
      await this.writes.get(want.id);
      const pieces = await getPieces(fileKey(link.ch.id, want.id));
      const at = pieces.reduce((n, b) => n + b.size, 0);
      if (link.closed) return;
      link.current = { id: want.id, size: want.size, got: at, n: pieces.length, buffer: [], buffered: 0 };
      link.lastByte = Date.now();
      log('get', want.id.slice(0, 4), 'from', at, 'of', want.size);
      this.states.set(want.id, { state: 'loading', got: at });
      this.deps.progress(link.ch.id, want.id);
      this.wire(link, { get: want.id, at });
    })();
  }

  private fetched(link: Link, data: string | ArrayBuffer): void {
    const cur = link.current;
    if (typeof data !== 'string') {
      if (!cur) return;
      cur.got += data.byteLength;
      link.lastByte = Date.now();
      if (cur.got > cur.size) {
        // More than the message said: something is wrong. Start that file again later.
        this.fail(link);
        return;
      }
      cur.buffer.push(data);
      cur.buffered += data.byteLength;
      if (cur.buffered >= PIECE) this.flush(link.ch.id, cur);
      this.states.set(cur.id, { state: 'loading', got: cur.got });
      this.deps.progress(link.ch.id, cur.id);
      return;
    }
    let w: Wire;
    try {
      w = JSON.parse(data) as Wire;
    } catch {
      return;
    }
    if ('no' in w && cur?.id === w.no) {
      this.finished(link, cur.id);
      this.deps.missing(link.ch.id, cur.id);
      this.next(link);
    } else if ('end' in w && cur?.id === w.end) {
      this.flush(link.ch.id, cur);
      const done = cur;
      link.current = undefined;
      link.finishing = true;
      log('end', done.id.slice(0, 4), done.got);
      void (this.writes.get(done.id) ?? Promise.resolve()).then(async () => {
        const key = fileKey(link.ch.id, done.id);
        const whole = await finishPieces(key);
        const ok = whole.size === done.size;
        this.finished(link, done.id);
        this.deps.arrived(link.ch.id, done.id, ok);
        link.finishing = false;
        if (!link.closed) this.next(link);
      });
    }
  }

  /** What has arrived so far goes to storage: the resume point. */
  private flush(chId: string, cur: Incoming): void {
    if (!cur.buffered) return;
    const blob = new Blob(cur.buffer);
    const n = cur.n++;
    cur.buffer = [];
    cur.buffered = 0;
    const writing = (this.writes.get(cur.id) ?? Promise.resolve()).then(() => putPiece(fileKey(chId, cur.id), n, blob)).catch(() => undefined);
    this.writes.set(cur.id, writing);
    void writing.then(() => this.writes.get(cur.id) === writing && this.writes.delete(cur.id));
  }

  private finished(link: Link, id: string): void {
    this.wants.get(link.key)?.delete(id);
    this.states.delete(id);
  }

  /** Didn't connect or broke off: keep what came, try again later (sooner if their phone speaks up). */
  private fail(link: Link): void {
    if (link.closed) return;
    log('fail', link.role, link.sid, link.current?.got);
    const cur = link.current;
    if (cur) this.flush(link.ch.id, cur);
    this.close(link);
    if (link.role !== 'fetch' || !this.wants.get(link.key)?.size) return;
    for (const id of this.wants.get(link.key)!.keys()) {
      this.states.set(id, { state: 'waiting' });
      this.deps.progress(link.ch.id, id);
    }
    const r = this.retry.get(link.key) ?? { n: 0 };
    clearTimeout(r.timer);
    r.timer = setTimeout(() => this.connect(link.key), Math.min(FIRST_RETRY * 2 ** r.n, MAX_RETRY));
    r.n++;
    this.retry.set(link.key, r);
  }

  /* ---------- Serving (the phone that sent the file) ---------- */

  private async serve(ch: Channel, ring: Ring): Promise<void> {
    const key = `${ch.id}|${ring.by}`;
    this.serving.get(key)?.closed === false && this.close(this.serving.get(key)!);
    if (this.serving.size >= MAX_SERVING || ch.gone) return;
    const link = this.newLink(key, ch, ring.by, ring.sid!, 'serve');
    this.serving.set(key, link);
    link.queue = Promise.resolve();
    link.dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let w: Wire;
      try {
        w = JSON.parse(e.data) as Wire;
      } catch {
        return;
      }
      if ('get' in w && typeof w.get === 'string') {
        const at = Math.max(0, Math.floor(Number(w.at) || 0));
        link.queue = link.queue!.then(() => this.push(link, w.get, at)).catch(() => this.close(link));
      }
    };
    link.idle = setTimeout(() => this.close(link), OPEN_WAIT + IDLE_CLOSE);
    try {
      await link.pc.setRemoteDescription({ type: 'offer', sdp: ring.sdp! });
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      const sdp = await gathered(link.pc);
      if (!link.closed) await this.deps.send(ch, { t: 'fx', to: ring.by, sid: link.sid, a: 'answer', sdp, from: this.deps.myName() });
    } catch {
      this.close(link);
    }
  }

  private async push(link: Link, id: string, at: number): Promise<void> {
    clearTimeout(link.idle);
    const blob = await this.deps.mine(link.ch, id);
    log('push', id.slice(0, 4), 'from', at, 'of', blob?.size);
    if (!blob || at > blob.size) {
      this.wire(link, { no: id });
    } else {
      this.wire(link, { ok: id, z: blob.size, at });
      const chunk = Math.min(64 * 1024, link.pc.sctp?.maxMessageSize || 16 * 1024);
      for (let offset = at; offset < blob.size; offset += chunk) {
        if (link.closed || link.dc.readyState !== 'open') throw new Error('gone');
        if (link.dc.bufferedAmount > HIGH) await drained(link.dc);
        link.dc.send(await blob.slice(offset, offset + chunk).arrayBuffer());
      }
      this.wire(link, { end: id });
    }
    link.idle = setTimeout(() => this.close(link), IDLE_CLOSE);
  }

  /* ---------- Both ---------- */

  private newLink(key: string, ch: Channel, peer: string, id: string, role: Link['role']): Link {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy: this.deps.relayOnly() ? 'relay' : 'all' });
    // Same id on both sides ("negotiated"): the line exists without an extra round trip.
    const dc = pc.createDataChannel('files', { negotiated: true, id: 0, ordered: true });
    dc.binaryType = 'arraybuffer';
    const link: Link = { key, ch, peer, sid: id, pc, dc, role, closed: false, lastByte: Date.now(), finishing: false };
    // A fetching line that closes with files still wanted tries again later (fail keeps what came).
    dc.onclose = () => (role === 'fetch' ? this.fail(link) : this.close(link));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') (role === 'fetch' ? this.fail(link) : this.close(link));
    };
    return link;
  }

  private wire(link: Link, w: Wire): void {
    if (link.dc.readyState === 'open') link.dc.send(JSON.stringify(w));
  }

  private close(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    log('close', link.role, link.sid);
    clearTimeout(link.idle);
    clearInterval(link.watch);
    clearTimeout(link.answerTimer);
    link.dc.onclose = null;
    link.pc.onconnectionstatechange = null;
    try {
      link.dc.close();
      link.pc.close();
    } catch {
      // Already closed.
    }
    const map = link.role === 'fetch' ? this.links : this.serving;
    if (map.get(link.key) === link) map.delete(link.key);
  }
}

/** Waits (briefly) for the phone's addresses, so one offer and one answer are all it takes. */
function gathered(pc: RTCPeerConnection): Promise<string> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve(pc.localDescription?.sdp ?? '');
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, 3000);
    pc.addEventListener('icegatheringstatechange', check);
    check();
  });
}

function drained(dc: RTCDataChannel): Promise<void> {
  dc.bufferedAmountLowThreshold = LOW;
  // Already drained before we started listening: the event won't come.
  if (dc.bufferedAmount <= LOW || dc.readyState !== 'open') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
  });
}
