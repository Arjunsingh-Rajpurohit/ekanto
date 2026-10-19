import {
  listenDays, myTag, openRing, ringKey, ringSecret, ringTopic, sealRing, today, type Channel, type Ring,
} from './channels';
import { fromBase64Url, toBase64Url } from './crypto';
import { RingRelay } from './ring-relay';

interface Prepared {
  ch: Channel;
  ring: Uint8Array;
  key: CryptoKey;
  me: string;
}

/** What the Android app's background listener needs for one channel: never the channel secret. */
export interface NativeChannel {
  id: string;
  name: string;
  /** The ring-only part of the secret (base64url). */
  ring: string;
  me: string;
  gone: boolean;
}

/** A ring older than this is history, not a call. */
const MAX_AGE_MS = 90 * 1000;

/**
 * Sends and hears rings for every saved channel.
 *
 * On the website it listens the whole time the page is open. In the Android app a native listener
 * does the listening (even with the app closed) and hands what it hears to `feed`; the page then
 * only opens its own connections while it is ringing someone or in a channel's call, to hear
 * "declined" or "busy" straight away.
 */
export class Ringing {
  private prepared = new Map<string, Prepared>();
  /** Every topic of the last, current and next day → its channel. */
  private byTopic = new Map<string, Prepared>();
  private relay: RingRelay | null = null;
  private held = new Set<string>();
  private seen = new Set<string>();
  private dayTimer?: ReturnType<typeof setInterval>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly deviceKey: string;
  /** True in the app: the native listener hears rings, this page doesn't need to. */
  private readonly nativeListens: boolean;
  private readonly onRing: (ch: Channel, ring: Ring) => void;

  constructor(deviceKey: string, nativeListens: boolean, onRing: (ch: Channel, ring: Ring) => void) {
    this.deviceKey = deviceKey;
    this.nativeListens = nativeListens;
    this.onRing = onRing;
  }

  async setChannels(list: Channel[]): Promise<void> {
    const next = new Map<string, Prepared>();
    for (const ch of list) {
      const known = this.prepared.get(ch.id);
      if (known && known.ch.secret === ch.secret) {
        next.set(ch.id, { ...known, ch });
        continue;
      }
      const ring = await ringSecret(ch.secret);
      next.set(ch.id, { ch, ring, key: await ringKey(ring), me: await myTag(this.deviceKey, ch.id) });
    }
    this.prepared = next;
    await this.refresh();
    clearInterval(this.dayTimer);
    // Topics change at midnight (UTC): look again every few minutes.
    if (next.size) this.dayTimer = setInterval(() => void this.refresh(), 5 * 60 * 1000);
  }

  /** For the Android app's background listener. */
  async forNative(): Promise<NativeChannel[]> {
    return [...this.prepared.values()].map((p) => ({ id: p.ch.id, name: p.ch.name, ring: toBase64Url(p.ring), me: p.me, gone: !!p.ch.gone }));
  }

  /** A sealed ring the native listener heard. */
  feed(topic: string, text: string): void {
    try {
      void this.receive(topic, fromBase64Url(text));
    } catch {
      // Not a ring.
    }
  }

  /** Keep this page's own connection open for a channel while calling in it. */
  hold(id: string): void {
    this.held.add(id);
    void this.refresh();
  }

  release(id: string): void {
    this.held.delete(id);
    void this.refresh();
  }

  async send(ch: Channel, ring: Omit<Ring, 'by' | 'ts'>): Promise<void> {
    const p = this.prepared.get(ch.id);
    if (!p) return;
    const relay = this.open();
    // Just opened: wait for a relay to answer (up to 8 s) so the first ring isn't lost.
    for (let i = 0; i < 40 && !relay.up; i++) await new Promise((r) => setTimeout(r, 200));
    relay.send(await ringTopic(p.ring, today()), await sealRing(p.key, { ...ring, by: p.me, ts: Date.now() }));
    this.closeWhenIdle();
  }

  stop(): void {
    clearInterval(this.dayTimer);
    clearTimeout(this.idleTimer);
    this.relay?.close();
    this.relay = null;
  }

  private open(): RingRelay {
    clearTimeout(this.idleTimer);
    this.relay ??= new RingRelay((topic, data) => void this.receive(topic, data));
    return this.relay;
  }

  /** In the app, a connection opened only to send closes again once nothing needs it. */
  private closeWhenIdle(): void {
    if (!this.nativeListens || this.held.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.held.size) {
        this.relay?.close();
        this.relay = null;
      }
    }, 10000);
  }

  private async refresh(): Promise<void> {
    const byTopic = new Map<string, Prepared>();
    const day = today();
    for (const p of this.prepared.values()) {
      for (const d of [day - 1, day, day + 1]) byTopic.set(await ringTopic(p.ring, d), p);
    }
    this.byTopic = byTopic;

    const listenTo = [...this.prepared.values()].filter((p) => !p.ch.gone && (!this.nativeListens || this.held.has(p.ch.id)));
    if (!listenTo.length) {
      if (this.relay && !this.nativeListens) {
        this.relay.close();
        this.relay = null;
      } else this.relay?.listen([]);
      return;
    }
    const topics: string[] = [];
    for (const p of listenTo) for (const d of listenDays()) topics.push(await ringTopic(p.ring, d));
    this.open().listen(topics);
  }

  private async receive(topic: string, data: Uint8Array): Promise<void> {
    const p = this.byTopic.get(topic);
    if (!p) return;
    const ring = await openRing(p.key, data);
    // Our own ring, or an old one played back ("deleted" counts however late it arrives).
    if (!ring || ring.by === p.me || (ring.t !== 'gone' && Math.abs(Date.now() - ring.ts) > MAX_AGE_MS)) return;
    // Heard twice (from the native listener and this page): handle once.
    const id = `${ring.t}|${ring.by}|${ring.ts}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.clear();
    this.onRing(p.ch, ring);
  }
}
