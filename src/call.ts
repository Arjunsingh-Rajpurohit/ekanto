import { ICE_SERVERS } from './config';
import { deriveRoom, fingerprintOf, open, safetyEmojis, seal, toBase64Url, type Room } from './crypto';
import { inviteScope, type Invite } from './invite';
import { Relay } from './relay';

export type Phase = 'starting' | 'waiting' | 'live' | 'full' | 'offline';

/** Someone else in the call, as the screen sees them. */
/** What each phone tells the others over the private side-channel. */
export interface MediaState {
  cam: boolean;
  screen: boolean;
}

export interface Person {
  id: string;
  name: string;
  stream: MediaStream | null;
  /** Camera on? (false = show their initial instead of video). Null until they say. */
  cam: boolean | null;
  /** Sharing their screen: show it whole, not cropped. */
  screen: boolean;
  /** Where they are: the app blocks screenshots, the website can't. */
  platform: 'app' | 'web' | null;
  /** The private side-channel is open: chat and files can go to this person. */
  channelOpen: boolean;
  connected: boolean;
  /** Five emojis from both phones' encryption keys; the same on both phones = nobody in between. */
  safety: string[] | null;
  route: 'direct' | 'relay' | null;
}

export interface CallState {
  phase: Phase;
  relaysUp: number;
  people: Person[];
  liveSince: number | null;
  /** A one-off line for the screen, e.g. "Ravi left". */
  news: string | null;
  /** A one-off "Ravi joined", the first time someone connects. */
  joined: string | null;
  /** A one-off: the name of someone who just hung up on purpose (not a lost connection). */
  hungUp: string | null;
  /** Messages that reached this call's room but weren't sealed with its key: break-in attempts. */
  blocked: number;
}

type Kind = 'hello' | 'ack' | 'offer' | 'answer' | 'bye' | 'full';

interface Message {
  t: Kind;
  from: string;
  to?: string;
  ts: number;
  name: string;
  /** When the sender joined: the earliest joiners keep their seats when a call is full. */
  joined: number;
  /**
   * "Same phone" tag: equal when the same phone rejoins this call, different in every other call
   * (it is derived from the call's own room), so it can't link anyone's calls together.
   */
  tag?: string;
  sdp?: string;
}

interface Peer {
  id: string;
  tag: string | undefined;
  name: string;
  joined: number;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  connected: boolean;
  safety: string[] | null;
  route: 'direct' | 'relay' | null;
  lastHeard: number;
  /** "Ravi joined" is shown once per person. */
  announced: boolean;
  /**
   * A private side-channel inside the same encrypted connection (WebRTC data channel, DTLS).
   * Chat, files and camera/screen signals go phone to phone through it — never via any relay.
   */
  channel: RTCDataChannel;
  cam: boolean | null;
  screen: boolean;
  platform: 'app' | 'web' | null;
  offerTimer?: ReturnType<typeof setTimeout>;
  failTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Opt-in troubleshooting (localStorage hush.debug = 1): logs message kinds and short ids to this
 * phone's own console. Never names, never content, never sent anywhere.
 */
const DEBUG = (() => {
  try {
    return localStorage.getItem('hush.debug') === '1';
  } catch {
    return false;
  }
})();
const log = (...parts: unknown[]) => DEBUG && console.debug('[hush]', ...parts);
const short = (id: string) => id.slice(0, 4);

/** Older than this, a message is a replay, not news. */
const MAX_AGE_MS = 2 * 60 * 1000;
/**
 * How often to say "I'm here": often while alone, rarely once in a call. The rare one lets people
 * whose first replies got lost still find each other, while keeping traffic on the free public
 * relays light — they slow down anyone who talks too much.
 */
const HELLO_ALONE_MS = 3000;
const HELLO_IN_CALL_MS = 20000;
/** An offer nobody answers is retried this many times (5 s apart), then that person is dropped. */
const MAX_OFFERS = 8;

/**
 * One person's side of a call. Every two people get their own encrypted connection
 * (the one with the smaller id makes the offer, so they never talk over each other).
 * When the call is full, everyone agrees on who stays — the earliest joiners — so a
 * latecomer is turned away by all, and never receives anyone's video.
 */
export class CallSession {
  readonly id = toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  state: CallState = { phase: 'starting', relaysUp: 0, people: [], liveSince: null, news: null, joined: null, hungUp: null, blocked: 0 };

  private room?: Room;
  private relay = new Relay();
  private peers = new Map<string, Peer>();
  private joined = 0;
  private helloTimer?: ReturnType<typeof setInterval>;
  private fullTimer?: ReturnType<typeof setTimeout>;
  private sending: Promise<void> = Promise.resolve();
  private ended = false;
  /** People who said goodbye: a late message from them (relays can deliver out of order) is not a return. */
  private gone = new Set<string>();
  private readonly invite: Invite;
  private readonly name: string;
  private readonly relayOnly: boolean;
  private readonly getLocal: () => MediaStream;
  private readonly onChange: (state: CallState) => void;
  private readonly platform: 'app' | 'web';
  private readonly deviceKey: string;
  private tag = '';
  private media: MediaState;
  /** Chat and files: everything on the side-channel that isn't a camera/screen signal. */
  onChannelData: (from: Person, data: string | ArrayBuffer) => void = () => undefined;
  /** Someone's chat line just opened (a moment after their video, more over the relay). */
  onChannelOpen: (id: string) => void = () => undefined;
  /** "Save this call as a channel" and the answers to it ({"k":"chan…"}), phone to phone. */
  onControl: (from: Person, message: Record<string, unknown>) => void = () => undefined;

  constructor(options: {
    invite: Invite;
    name: string;
    /** Send everything through the backup relay, so others never learn this phone's IP address. */
    relayOnly: boolean;
    local: () => MediaStream;
    onChange: (state: CallState) => void;
    platform: 'app' | 'web';
    media: MediaState;
    /** A random secret kept on this phone; only ever used to derive per-call tags. */
    deviceKey: string;
  }) {
    this.invite = options.invite;
    this.name = options.name;
    this.relayOnly = options.relayOnly;
    this.getLocal = options.local;
    this.onChange = options.onChange;
    this.platform = options.platform;
    this.media = options.media;
    this.deviceKey = options.deviceKey;
  }

  /** Tell everyone the camera went on/off or screen sharing started/stopped. */
  setMedia(media: MediaState): void {
    this.media = media;
    for (const peer of this.peers.values()) this.sayHi(peer);
  }

  /** Send on one person's side-channel. False if it isn't open (they left, or not connected yet). */
  sendTo(id: string, data: string | ArrayBuffer): boolean {
    const channel = this.peers.get(id)?.channel;
    if (channel?.readyState !== 'open') return false;
    channel.send(data as never);
    return true;
  }

  /** Bytes still queued for a person: senders of big files wait while this is high. */
  buffered(id: string): number {
    return this.peers.get(id)?.channel.bufferedAmount ?? Infinity;
  }

  /** Resolves once a person's queue has drained below `low` bytes (or they left). */
  drained(id: string, low: number): Promise<void> {
    const channel = this.peers.get(id)?.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount <= low) return Promise.resolve();
    channel.bufferedAmountLowThreshold = low;
    return new Promise((resolve) => {
      const done = () => {
        channel.removeEventListener('bufferedamountlow', done);
        channel.removeEventListener('close', done);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', done);
      channel.addEventListener('close', done);
    });
  }

  async start(): Promise<void> {
    this.room = await deriveRoom(this.invite.secret, inviteScope(this.invite));
    this.tag = await callTag(this.deviceKey, this.room.topic);
    this.joined = Date.now();
    let first = true;
    this.relay.connect(this.room.topic, (data) => void this.receive(data), (count) => {
      this.state = { ...this.state, relaysUp: count };
      if (count === 0 && this.state.phase === 'waiting') this.state.phase = 'offline';
      if (count > 0 && this.state.phase === 'offline') this.state.phase = this.peers.size ? 'live' : 'waiting';
      this.publish();
      if (count > 0 && first) {
        first = false;
        void this.post({ t: 'hello' });
      }
    });
    this.update({ phase: 'waiting' });
    let lastHello = 0;
    this.helloTimer = setInterval(() => {
      const every = this.peers.size === 0 ? HELLO_ALONE_MS : HELLO_IN_CALL_MS;
      if (Date.now() - lastHello >= every && this.state.phase !== 'full') {
        lastHello = Date.now();
        void this.post({ t: 'hello' });
      }
    }, 1000);
  }

  /** Swap the camera (front/back) without reconnecting anyone. */
  /** Camera, screen, or nothing (null): swapped in place, no reconnecting. */
  async replaceVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = videoSender(peer.pc);
      if (sender) await sender.replaceTrack(track).catch(() => undefined);
    }
    this.tune();
  }

  leave(): void {
    if (this.ended) return;
    this.ended = true;
    // Straight down each connection first: it arrives at once, even while this page is closing.
    for (const peer of this.peers.values()) {
      try {
        if (peer.channel.readyState === 'open') peer.channel.send('{"k":"bye"}');
      } catch {
        // Already closing.
      }
    }
    void this.post({ t: 'bye' });
    clearInterval(this.helloTimer);
    clearTimeout(this.fullTimer);
    for (const peer of this.peers.values()) this.dropPeer(peer);
    // Let the goodbye reach the relays before hanging up on them.
    setTimeout(() => this.relay.close(), 400);
  }

  private update(changes: Partial<CallState>): void {
    this.state = { ...this.state, ...changes };
    this.publish();
  }

  private publish(): void {
    const people: Person[] = [...this.peers.values()]
      .sort((a, b) => a.joined - b.joined)
      .map((p) => ({
        id: p.id, name: p.name, stream: p.stream, connected: p.connected, safety: p.safety, route: p.route,
        cam: p.cam, screen: p.screen, platform: p.platform, channelOpen: p.channel.readyState === 'open',
      }));
    const anyLive = people.some((p) => p.connected);
    const phase = this.state.phase === 'full' || this.state.phase === 'offline' || this.state.phase === 'starting'
      ? this.state.phase
      : people.length ? 'live' : 'waiting';
    this.state = {
      ...this.state,
      phase,
      people,
      liveSince: anyLive ? (this.state.liveSince ?? Date.now()) : people.length ? this.state.liveSince : null,
    };
    this.onChange(this.state);
    this.state.news = null;
    this.state.joined = null;
    this.state.hungUp = null;
  }

  /** Sealing is async; the queue keeps messages in the order they were made. */
  private post(message: Pick<Message, 't' | 'to' | 'sdp'>): Promise<void> {
    const room = this.room;
    if (!room) return Promise.resolve();
    const full: Message = { ...message, from: this.id, ts: Date.now(), name: this.name, joined: this.joined, tag: this.tag };
    log('out', message.t, short(this.id), '->', message.to ? short(message.to) : 'all',
      message.sdp ? `paths: ${(message.sdp.match(/a=candidate:\S+ \d \S+ \d+ \S+ \d+ typ \w+/g) ?? []).map((c) => c.split(' ').pop()).join(',')}` : '');
    this.sending = this.sending.then(async () => this.relay.send(await seal(room.key, full))).catch(() => undefined);
    return this.sending;
  }

  private async receive(data: Uint8Array): Promise<void> {
    if (!this.room || this.ended) return;
    const m = await open<Message>(this.room.key, data);
    if (!m) {
      // Only someone who learned this call's room name could post here, and without the key
      // nothing they send opens. Count it, so the people in the call know someone tried.
      this.update({ blocked: this.state.blocked + 1 });
      return;
    }
    // Our own echo, meant for someone else, or an old replay.
    if (m.from === this.id || (m.to && m.to !== this.id) || Math.abs(Date.now() - m.ts) > MAX_AGE_MS) return;
    // This phone's own earlier self (before a reload or rejoin): a late message from it is not a person.
    if (m.tag && m.tag === this.tag) return;
    if (this.gone.has(m.from)) return;
    log('in', m.t, short(m.from), '->', short(this.id));
    const known = this.peers.get(m.from);
    if (known) known.lastHeard = Date.now();

    switch (m.t) {
      case 'hello':
      case 'ack':
      case 'offer':
        if (!this.admit(m)) return;
        // Reply only to people we are not talking to yet; the rest is just a heartbeat.
        if (m.t === 'hello' && !this.peers.get(m.from)?.connected) void this.post({ t: 'ack', to: m.from });
        if (m.t === 'offer') await this.answer(m);
        return;
      case 'answer': {
        const peer = this.peers.get(m.from);
        if (peer && m.sdp && peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => undefined);
        }
        return;
      }
      case 'bye': {
        this.gone.add(m.from);
        const peer = this.peers.get(m.from);
        if (peer) {
          this.state.hungUp = peer.name;
          this.removePeer(peer, `${peer.name} left`);
        }
        return;
      }
      case 'full':
        // Everyone already inside said no. Wait a little first: if someone inside just reloaded,
        // their old connection takes a few seconds to drop and free the seat.
        if (![...this.peers.values()].some((p) => p.connected) && !this.fullTimer) {
          this.fullTimer = setTimeout(() => {
            if (![...this.peers.values()].some((p) => p.connected) && !this.ended) {
              this.update({ phase: 'full' });
              this.leave();
            }
          }, 15000);
        }
        return;
    }
  }

  /**
   * Seats go to the earliest joiners. Every phone runs this same rule on the same facts,
   * so they all agree on who is in and who is turned away. True = talk to this person.
   */
  private admit(m: Message): boolean {
    // The same phone rejoining (reload, back button, app restarted): its old self is gone.
    if (m.tag) {
      for (const p of [...this.peers.values()]) {
        if (p.tag === m.tag && p.id !== m.from) this.removePeer(p, null);
      }
    }
    const limit = this.invite.limit;
    if (limit) {
      const others = [...this.peers.values()].filter((p) => p.id !== m.from && this.alive(p));
      const everyone = [
        { id: this.id, joined: this.joined },
        { id: m.from, joined: m.joined },
        ...others.map((p) => ({ id: p.id, joined: p.joined })),
      ].sort((a, b) => a.joined - b.joined || a.id.localeCompare(b.id));
      const seated = new Set(everyone.slice(0, limit).map((p) => p.id));
      if (!seated.has(m.from)) {
        const peer = this.peers.get(m.from);
        if (peer) this.dropPeer(peer);
        void this.post({ t: 'full', to: m.from });
        return false;
      }
      if (!seated.has(this.id)) return false;
      // Stale peers that lost their seat to this check are let go.
      for (const p of [...this.peers.values()]) if (!this.alive(p)) this.removePeer(p, null);
    }

    let peer = this.peers.get(m.from);
    if (!peer) {
      peer = this.newPeer(m);
      clearTimeout(this.fullTimer);
      this.fullTimer = undefined;
      if (this.id < m.from) void this.offer(peer);
    }
    peer.name = m.name?.slice(0, 30) || 'Guest';
    return true;
  }

  private sayHi(peer: Peer): void {
    if (peer.channel.readyState !== 'open') return;
    peer.channel.send(JSON.stringify({ k: 'hi', platform: this.platform, cam: this.media.cam, screen: this.media.screen }));
  }

  private onChannel(peer: Peer, data: string | ArrayBuffer): void {
    if (data === '{"k":"bye"}') {
      this.gone.add(peer.id);
      if (this.peers.get(peer.id) === peer) {
        this.state.hungUp = peer.name;
        this.removePeer(peer, `${peer.name} left`);
      }
      return;
    }
    if (typeof data === 'string' && data.startsWith('{"k":"hi"')) {
      try {
        const hi = JSON.parse(data) as { platform?: string; cam?: boolean; screen?: boolean };
        peer.platform = hi.platform === 'app' ? 'app' : 'web';
        peer.cam = !!hi.cam;
        peer.screen = !!hi.screen;
        this.publish();
      } catch {
        // Ignore a broken signal.
      }
      return;
    }
    const person = this.state.people.find((p) => p.id === peer.id);
    if (!person) return;
    if (typeof data === 'string' && data.startsWith('{"k":"chan')) {
      try {
        this.onControl(person, JSON.parse(data) as Record<string, unknown>);
      } catch {
        // Ignore a broken signal.
      }
      return;
    }
    this.onChannelData(person, data);
  }

  private alive(p: Peer): boolean {
    const s = p.pc.connectionState;
    return s === 'connected' || s === 'connecting' || s === 'new' || Date.now() - p.lastHeard < 15000;
  }

  private newPeer(m: Message): Peer {
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
    });
    // Same id on both sides ("negotiated"), so the channel exists without an extra round trip.
    const channel = pc.createDataChannel('hush', { negotiated: true, id: 0, ordered: true });
    channel.binaryType = 'arraybuffer';
    const peer: Peer = {
      id: m.from, tag: m.tag, name: m.name?.slice(0, 30) || 'Guest', joined: m.joined, pc,
      stream: null, connected: false, safety: null, route: null, lastHeard: Date.now(), announced: false,
      channel, cam: null, screen: false, platform: null,
    };
    this.peers.set(peer.id, peer);
    channel.onopen = () => {
      this.sayHi(peer);
      this.onChannelOpen(peer.id);
      this.publish();
    };
    // The side-channel only closes when their connection is gone for good (hung up, page closed).
    channel.onclose = () => {
      setTimeout(() => {
        if (this.peers.get(peer.id) === peer && !this.ended) this.removePeer(peer, `${peer.name} left`);
      }, 1500);
    };
    channel.onmessage = (e) => this.onChannel(peer, e.data);
    const local = this.getLocal();
    for (const track of local.getAudioTracks()) pc.addTrack(track, local);
    // Always a video slot, even in a voice call or with the camera off, so the camera or a shared
    // screen can be switched in later without reconnecting. The phone making the offer creates
    // it; the other one opens the slot from the offer when answering (see answer()).
    const camera = local.getVideoTracks()[0];
    if (camera) pc.addTrack(camera, local);
    else if (this.id < m.from) pc.addTransceiver('video', { direction: 'sendrecv', streams: [local] });
    // One stream per person holding their sound and their picture, however they arrive.
    pc.ontrack = (e) => {
      peer.stream ??= new MediaStream();
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      this.publish();
    };
    pc.onconnectionstatechange = () => {
      log('pc', short(peer.id), pc.connectionState);
      void this.onConnection(peer);
    };
    this.update({ news: null });
    this.tune();
    return peer;
  }

  /** Offers carry every network path at once (no trickling), so each pair needs just two messages. */
  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    const pc = peer.pc;
    await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
    await gathered(pc);
    let tries = 0;
    const send = () => {
      if (this.peers.get(peer.id) !== peer || pc.signalingState !== 'have-local-offer') return;
      if (++tries > MAX_OFFERS) return this.removePeer(peer, null);
      void this.post({ t: 'offer', to: peer.id, sdp: pc.localDescription!.sdp });
      // Networks drop messages: repeat until answered.
      peer.offerTimer = setTimeout(send, 5000);
    };
    send();
  }

  private async answer(m: Message): Promise<void> {
    const peer = this.peers.get(m.from);
    if (!peer || !m.sdp) return;
    const pc = peer.pc;
    // The same offer again means our answer got lost: just send it again.
    if (pc.remoteDescription?.sdp === m.sdp && pc.localDescription?.type === 'answer') {
      return void this.post({ t: 'answer', to: peer.id, sdp: pc.localDescription.sdp });
    }
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') return;
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    // Without a camera we added no video track, so the slot from the offer would only receive.
    // Open it both ways now, so turning the camera on (or sharing a screen) later reaches them.
    const slot = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video');
    if (slot && slot.direction === 'recvonly') {
      slot.direction = 'sendrecv';
      slot.sender.setStreams?.(this.getLocal());
    }
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    void this.post({ t: 'answer', to: peer.id, sdp: pc.localDescription!.sdp });
  }

  private async onConnection(peer: Peer): Promise<void> {
    if (this.peers.get(peer.id) !== peer || this.ended) return;
    const pc = peer.pc;
    clearTimeout(peer.failTimer);
    switch (pc.connectionState) {
      case 'connected': {
        clearTimeout(peer.offerTimer);
        const mine = fingerprintOf(pc.currentLocalDescription?.sdp);
        const theirs = fingerprintOf(pc.currentRemoteDescription?.sdp);
        peer.connected = true;
        peer.safety = mine && theirs ? await safetyEmojis(mine, theirs) : null;
        peer.route = await routeOf(pc);
        if (!peer.announced) {
          peer.announced = true;
          this.state.joined = `${peer.name} joined`;
        }
        this.publish();
        this.tune();
        return;
      }
      case 'disconnected':
        // Often a blip (Wi-Fi to mobile data). Give it a moment, then look for a new path.
        peer.connected = false;
        this.publish();
        peer.failTimer = setTimeout(() => void this.recover(peer), 6000);
        return;
      case 'failed':
        peer.connected = false;
        return this.recover(peer);
    }
  }

  private async recover(peer: Peer): Promise<void> {
    if (this.peers.get(peer.id) !== peer || peer.pc.connectionState === 'connected') return;
    if (this.id < peer.id) {
      peer.pc.restartIce();
      await this.offer(peer, true);
    }
    peer.failTimer = setTimeout(() => {
      if (this.peers.get(peer.id) === peer && peer.pc.connectionState !== 'connected') this.removePeer(peer, `Lost ${peer.name}`);
    }, 20000);
  }

  private removePeer(peer: Peer, news: string | null): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.dropPeer(peer);
    this.peers.delete(peer.id);
    this.state.news = news;
    this.publish();
    this.tune();
    if (!this.peers.size) void this.post({ t: 'hello' });
  }

  private dropPeer(peer: Peer): void {
    clearTimeout(peer.offerTimer);
    clearTimeout(peer.failTimer);
    peer.pc.close();
  }

  /**
   * Quality follows the network on its own. These are only ceilings: WebRTC measures each
   * connection live and sends less when the internet is weak (a lift, a crowded station), and
   * lowers the picture size when the phone gets busy. With a strong network it goes right up to
   * the ceiling. Ceilings fall as the call grows because every phone uploads one copy per person,
   * and phone uploads are far slower than downloads:
   *   2 people → 2.5 Mbps (sharp HD)   4 people → 1.2 Mbps each (near HD)   6 people → 0.8 Mbps each.
   */
  private tune(): void {
    const others = this.peers.size;
    const ceiling = others <= 1 ? 2_500_000 : others === 2 ? 1_600_000 : others === 3 ? 1_200_000 : others <= 5 ? 800_000 : 500_000;
    for (const peer of this.peers.values()) {
      const sender = videoSender(peer.pc);
      if (!sender?.track) continue;
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = ceiling;
      // No forced shrinking: full size whenever the network and phone can carry it.
      params.encodings[0].scaleResolutionDownBy = 1;
      // When something has to give, trade a little sharpness and a little smoothness evenly.
      params.degradationPreference = 'balanced';
      sender.setParameters(params).catch(() => undefined);
    }
  }
}

/** HMAC(device key, room): stable for this phone in this call, unrelated across calls. */
async function callTag(deviceKey: string, topic: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(deviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`tag|${topic}`)));
  return toBase64Url(mac.slice(0, 12));
}

/** The video slot's sender, whether it currently carries a camera, a screen, or nothing. */
function videoSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
}

/**
 * Waits until the phone has found its network paths (or 2.5 s), so they all go in one message.
 * After a reconnect the state can still read "complete" from the previous round, so it also
 * waits until the new description really lists paths.
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  const ready = () => pc.iceGatheringState === 'complete' && /a=candidate/.test(pc.localDescription?.sdp ?? '');
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(poll);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => ready() && finish();
    pc.addEventListener('icegatheringstatechange', check);
    const poll = setInterval(check, 100);
    setTimeout(finish, 2500);
  });
}

/** Whether a call runs straight between two phones or through the encrypted backup relay. */
async function routeOf(pc: RTCPeerConnection): Promise<'direct' | 'relay' | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    const pair = pairId ? stats.get(pairId) : undefined;
    const local = pair ? stats.get(pair.localCandidateId) : undefined;
    const remote = pair ? stats.get(pair.remoteCandidateId) : undefined;
    if (!local) return null;
    return local.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
  } catch {
    return null;
  }
}
