import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import mqtt, { type MqttClient } from 'mqtt';
import { fromBase64Url, toBase64Url } from './crypto';
import { RING_MQTT, RING_NOSTR } from './relays';

/** Same ephemeral kind as calls: relays pass these on and never store them. */
const KIND = 21733;

type Deliver = (topic: string, text: string) => void;

/**
 * One connection per ring relay, listening on every channel's ring topic at once (a phone with
 * five channels still opens only four connections). It only ever carries sealed rings.
 */
export class RingRelay {
  private topics: string[] = [];
  private mqttClients: MqttClient[] = [];
  private nostr: NostrRing[] = [];
  private seen = new Set<string>();
  private readonly onData: (topic: string, data: Uint8Array) => void;

  constructor(onData: (topic: string, data: Uint8Array) => void) {
    this.onData = onData;
    const deliver: Deliver = (topic, text) => {
      // The same ring arrives once per relay; its random 12-byte nonce identifies it.
      const id = text.slice(0, 16);
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 2000) this.seen.clear();
      try {
        this.onData(topic, fromBase64Url(text));
      } catch {
        // Not a ring.
      }
    };
    for (const url of RING_MQTT) {
      const client = mqtt.connect(url, {
        // A fresh random name each time: nothing ties two sessions together.
        clientId: `r${toBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`,
        clean: true, reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 45,
        timerVariant: 'native',
      });
      client.on('connect', () => {
        if (this.topics.length) client.subscribe(this.topics.map((t) => `h1/${t}`), { qos: 0 });
      });
      client.on('error', () => undefined);
      client.on('message', (topic, payload) => deliver(topic.replace(/^h1\//, ''), payload.toString()));
      this.mqttClients.push(client);
    }
    const key = schnorr.utils.randomSecretKey();
    for (const url of RING_NOSTR) this.nostr.push(new NostrRing(url, key, deliver, () => this.topics));
  }

  /** Listen on exactly these topics (replaces the previous ones). */
  listen(topics: string[]): void {
    const next = [...new Set(topics)].sort();
    if (next.join() === this.topics.join()) return;
    const gone = this.topics.filter((t) => !next.includes(t));
    const added = next.filter((t) => !this.topics.includes(t));
    this.topics = next;
    for (const client of this.mqttClients) {
      if (!client.connected) continue;
      if (gone.length) client.unsubscribe(gone.map((t) => `h1/${t}`));
      if (added.length) client.subscribe(added.map((t) => `h1/${t}`), { qos: 0 });
    }
    for (const n of this.nostr) n.resubscribe();
  }

  send(topic: string, data: Uint8Array): void {
    const text = toBase64Url(data);
    // Our own copy comes back from the relays: mark it seen so it isn't handled as news.
    this.seen.add(text.slice(0, 16));
    for (const client of this.mqttClients) {
      // retain: false — the relay forwards it and keeps nothing.
      if (client.connected) client.publish(`h1/${topic}`, text, { qos: 0, retain: false });
    }
    for (const n of this.nostr) n.send(topic, text);
  }

  /** True once at least one relay is connected (a ring sent now gets somewhere). */
  get up(): boolean {
    return this.mqttClients.some((c) => c.connected) || this.nostr.some((n) => n.up);
  }

  close(): void {
    for (const client of this.mqttClients) client.end(true);
    for (const n of this.nostr) n.close();
    this.mqttClients = [];
    this.nostr = [];
  }
}

class NostrRing {
  up = false;
  private ws?: WebSocket;
  private closed = false;
  private retry = 2000;
  private readonly subId = toBase64Url(crypto.getRandomValues(new Uint8Array(6)));
  private readonly pubkey: string;
  private readonly url: string;
  private readonly key: Uint8Array;
  private readonly deliver: Deliver;
  private readonly topics: () => string[];

  constructor(url: string, key: Uint8Array, deliver: Deliver, topics: () => string[]) {
    this.url = url;
    this.key = key;
    this.deliver = deliver;
    this.topics = topics;
    this.pubkey = bytesToHex(schnorr.getPublicKey(key));
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 2000;
      this.up = true;
      this.resubscribe();
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m[0] !== 'EVENT' || m[1] !== this.subId || m[2]?.kind !== KIND) return;
        const topic = (m[2].tags as string[][]).find((t) => t[0] === 't')?.[1];
        if (topic) this.deliver(topic, String(m[2].content));
      } catch {
        // Not for us.
      }
    };
    ws.onclose = () => {
      this.up = false;
      if (!this.closed) {
        setTimeout(() => this.open(), this.retry);
        this.retry = Math.min(this.retry * 2, 30000);
      }
    };
    ws.onerror = () => undefined;
  }

  /** The same subscription id again replaces the old filter. */
  resubscribe(): void {
    if (!this.up || this.ws?.readyState !== WebSocket.OPEN) return;
    const topics = this.topics();
    this.ws.send(JSON.stringify(topics.length
      ? ['REQ', this.subId, { kinds: [KIND], '#t': topics, since: Math.floor(Date.now() / 1000) - 30 }]
      : ['CLOSE', this.subId]));
  }

  send(topic: string, text: string): void {
    if (!this.up || this.ws?.readyState !== WebSocket.OPEN) return;
    const event = { pubkey: this.pubkey, created_at: Math.floor(Date.now() / 1000), kind: KIND, tags: [['t', topic]], content: text };
    const hash = sha256(new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])));
    this.ws.send(JSON.stringify(['EVENT', { ...event, id: bytesToHex(hash), sig: bytesToHex(schnorr.sign(hash, this.key)) }]));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
