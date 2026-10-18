import { ICE_SERVERS } from './config';
import { deriveRoom, fingerprintOf, open, safetyEmojis, seal, toBase64Url, type Room } from './crypto';
import { inviteScope, type Invite } from './invite';
import { Relay } from './relay';

export type Phase = 'starting' | 'waiting' | 'live' | 'full' | 'offline';

/** Someone else in the call, as the screen sees them. */
export interface Person {
  id: string;
  name: string;
  stream: MediaStream | null;
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
  sdp?: string;
}

interface Peer {
  id: string;
  name: string;
  joined: number;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  connected: boolean;
  safety: string[] | null;
  route: 'direct' | 'relay' | null;
  lastHeard: number;
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
  state: CallState = { phase: 'starting', relaysUp: 0, people: [], liveSince: null, news: null };

  private room?: Room;
  private relay = new Relay();
  private peers = new Map<string, Peer>();
  private joined = 0;
  private helloTimer?: ReturnType<typeof setInterval>;
  private fullTimer?: ReturnType<typeof setTimeout>;
  private sending: Promise<void> = Promise.resolve();
  private ended = false;
  private readonly invite: Invite;
  private readonly name: string;
  private readonly relayOnly: boolean;
  private readonly getLocal: () => MediaStream;
  private readonly onChange: (state: CallState) => void;

  constructor(options: {
    invite: Invite;
    name: string;
    /** Send everything through the backup relay, so others never learn this phone's IP address. */
    relayOnly: boolean;
    local: () => MediaStream;
    onChange: (state: CallState) => void;
  }) {
    this.invite = options.invite;
    this.name = options.name;
    this.relayOnly = options.relayOnly;
    this.getLocal = options.local;
    this.onChange = options.onChange;
  }

  async start(): Promise<void> {
    this.room = await deriveRoom(this.invite.secret, inviteScope(this.invite));
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
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    }
  }

  leave(): void {
    if (this.ended) return;
    this.ended = true;
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
      .map((p) => ({ id: p.id, name: p.name, stream: p.stream, connected: p.connected, safety: p.safety, route: p.route }));
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
  }

  /** Sealing is async; the queue keeps messages in the order they were made. */
  private post(message: Pick<Message, 't' | 'to' | 'sdp'>): Promise<void> {
    const room = this.room;
    if (!room) return Promise.resolve();
    const full: Message = { ...message, from: this.id, ts: Date.now(), name: this.name, joined: this.joined };
    log('out', message.t, short(this.id), '->', message.to ? short(message.to) : 'all',
      message.sdp ? `paths: ${(message.sdp.match(/a=candidate:\S+ \d \S+ \d+ \S+ \d+ typ \w+/g) ?? []).map((c) => c.split(' ').pop()).join(',')}` : '');
    this.sending = this.sending.then(async () => this.relay.send(await seal(room.key, full))).catch(() => undefined);
    return this.sending;
  }

  private async receive(data: Uint8Array): Promise<void> {
    if (!this.room || this.ended) return;
    const m = await open<Message>(this.room.key, data);
    // Not sealed with this call's key, our own echo, meant for someone else, or an old replay.
    if (!m || m.from === this.id || (m.to && m.to !== this.id) || Math.abs(Date.now() - m.ts) > MAX_AGE_MS) return;
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
        const peer = this.peers.get(m.from);
        if (peer) this.removePeer(peer, `${peer.name} left`);
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
    const peer: Peer = {
      id: m.from, name: m.name?.slice(0, 30) || 'Guest', joined: m.joined, pc,
      stream: null, connected: false, safety: null, route: null, lastHeard: Date.now(),
    };
    this.peers.set(peer.id, peer);
    const local = this.getLocal();
    for (const track of local.getTracks()) pc.addTrack(track, local);
    pc.ontrack = (e) => {
      peer.stream = e.streams[0] ?? new MediaStream([e.track]);
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
   * Each phone sends its video to every other phone, so the more people, the lighter each copy:
   * one person gets sharp video, six people get a lighter stream each so phones keep up.
   */
  private tune(): void {
    const n = this.peers.size;
    const bitrate = n <= 1 ? 1_500_000 : n === 2 ? 900_000 : n <= 4 ? 500_000 : 300_000;
    const scale = n <= 2 ? 1 : n <= 4 ? 1.5 : 2;
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = bitrate;
      params.encodings[0].scaleResolutionDownBy = scale;
      sender.setParameters(params).catch(() => undefined);
    }
  }
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
