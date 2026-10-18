import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import mqtt, { type MqttClient } from 'mqtt';
import { MQTT_RELAYS, NOSTR_RELAYS } from './config';
import { fromBase64Url, toBase64Url } from './crypto';

/** One meeting point. Carries base64 text that is already sealed; never sees anything else. */
interface Link {
  readonly url: string;
  up: boolean;
  send(text: string): void;
  close(): void;
}

type Deliver = (text: string) => void;
type Changed = () => void;

class MqttLink implements Link {
  up = false;
  readonly url: string;
  private readonly client: MqttClient;
  private readonly channel: string;

  constructor(url: string, topic: string, deliver: Deliver, changed: Changed) {
    this.url = url;
    const channel = `h1/${topic}`;
    this.channel = channel;
    this.client = mqtt.connect(url, {
      // A fresh random name every call: nothing ties two calls together.
      clientId: `h${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`,
      clean: true, reconnectPeriod: 4000, connectTimeout: 10000, keepalive: 30,
      // Plain timers: the default runs a worker from a blob URL, which the page's security policy forbids.
      timerVariant: 'native',
    });
    this.client.on('connect', () => {
      this.client.subscribe(channel, { qos: 0 });
      this.up = true;
      changed();
    });
    this.client.on('close', () => {
      if (this.up) {
        this.up = false;
        changed();
      }
    });
    this.client.on('error', () => undefined);
    this.client.on('message', (_t, payload) => deliver(payload.toString()));
  }

  send(text: string): void {
    // retain: false — the relay forwards it and keeps nothing.
    if (this.up) this.client.publish(this.channel, text, { qos: 0, retain: false });
  }

  close(): void {
    this.client.end(true);
  }
}

/** Nostr "ephemeral" events (kind 20000–29999): relays pass them on and never store them. */
const KIND = 21733;

class NostrLink implements Link {
  up = false;
  readonly url: string;
  private ws?: WebSocket;
  private closed = false;
  private retry = 2000;
  private readonly topic: string;
  private readonly deliver: Deliver;
  private readonly changed: Changed;
  /** A throwaway signing key for this call only. */
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;
  private readonly subId = toBase64Url(crypto.getRandomValues(new Uint8Array(6)));

  constructor(url: string, topic: string, deliver: Deliver, changed: Changed, secretKey: Uint8Array) {
    this.url = url;
    this.topic = topic;
    this.deliver = deliver;
    this.changed = changed;
    this.secretKey = secretKey;
    this.pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 2000;
      ws.send(JSON.stringify(['REQ', this.subId, { kinds: [KIND], '#t': [this.topic], since: Math.floor(Date.now() / 1000) - 30 }]));
      this.up = true;
      this.changed();
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m[0] === 'EVENT' && m[1] === this.subId && m[2]?.kind === KIND) this.deliver(String(m[2].content));
      } catch {
        // Not for us.
      }
    };
    ws.onclose = () => {
      if (this.up) {
        this.up = false;
        this.changed();
      }
      if (!this.closed) {
        setTimeout(() => this.open(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      }
    };
    ws.onerror = () => undefined;
  }

  send(text: string): void {
    if (!this.up || this.ws?.readyState !== WebSocket.OPEN) return;
    const event = { pubkey: this.pubkey, created_at: Math.floor(Date.now() / 1000), kind: KIND, tags: [['t', this.topic]], content: text };
    const hash = sha256(new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])));
    this.ws.send(JSON.stringify(['EVENT', { ...event, id: bytesToHex(hash), sig: bytesToHex(schnorr.sign(hash, this.secretKey)) }]));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/** Picks `count` items, the same way on every phone with the same seed. */
function pick<T>(items: T[], seed: Uint8Array, count: number): T[] {
  return [...items]
    .map((item, i) => ({ item, rank: seed[i % seed.length] ^ (i * 37) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, count)
    .map((x) => x.item);
}

/**
 * All meeting points for one call. For privacy, each call uses only 2 MQTT + 2 Nostr points,
 * chosen from the call's own secret (so everyone in the call picks the same four, and different
 * calls spread over different operators). If fewer than two answer, it adds the rest — a call
 * should never fail because a few relays are down.
 */
export class Relay {
  private links: Link[] = [];
  private seen = new Set<string>();
  private fallback?: ReturnType<typeof setTimeout>;

  connect(topic: string, onData: (data: Uint8Array) => void, onUp: (count: number) => void): void {
    const seed = fromHex(topic);
    const nostrKey = schnorr.utils.randomSecretKey();
    const deliver: Deliver = (text) => {
      // The same message arrives once per relay; its random 12-byte nonce identifies it.
      const id = text.slice(0, 16);
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 3000) this.seen.clear();
      try {
        onData(fromBase64Url(text));
      } catch {
        // Not ours.
      }
    };
    const changed = () => onUp(this.links.filter((l) => l.up).length);
    const add = (url: string) => {
      if (this.links.some((l) => l.url === url)) return;
      this.links.push(MQTT_RELAYS.includes(url)
        ? new MqttLink(url, topic, deliver, changed)
        : new NostrLink(url, topic, deliver, changed, nostrKey));
    };

    for (const url of [...pick(MQTT_RELAYS, seed, 2), ...pick(NOSTR_RELAYS, seed.slice(8), 2)]) add(url);
    this.fallback = setTimeout(() => {
      if (this.links.filter((l) => l.up).length < 2) [...MQTT_RELAYS, ...NOSTR_RELAYS].forEach(add);
    }, 7000);
  }

  send(data: Uint8Array): void {
    const text = toBase64Url(data);
    for (const link of this.links) link.send(text);
  }

  close(): void {
    clearTimeout(this.fallback);
    for (const link of this.links) link.close();
    this.links = [];
  }
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
}
