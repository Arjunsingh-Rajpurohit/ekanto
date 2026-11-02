import { listNames } from './channel-ui';
import { channelId, newChannelSecret, type Channel } from './channels';
import {
  INVITE_MS, boxWelcome, full, loadSent, loadTaken, newCode, newKeyPair, newTag, openInvite, openWelcome, personId,
  rendezvous, saveSent, saveTaken, sealInvite, type InviteMsg, type Rendezvous, type Sent, type Taken, type Welcome,
} from './invites';
import { RingRelay } from './ring-relay';

export interface AddingDeps {
  channels(): Channel[];
  /** Saves a channel (taking `drop` off the list) and resolves once rings can go in it. */
  keep(ch: Channel, drop: string[]): Promise<void>;
  myName(): string;
  /** An invite or a code waiting changed: redraw. */
  changed(): void;
  /** Someone joined with this phone's code. */
  joined(sent: Sent, ch: Channel, name: string): void;
  /** This phone's code worked. */
  added(taken: Taken, ch: Channel): void;
  /** This phone's code was already used up. */
  refused(taken: Taken): void;
  /** "I just joined", to the others in the channel. */
  hello(ch: Channel): void;
}

type Spot = { kind: 'sent' | 'taken'; code: string };

/** A join is said again every 5 s at first, then every 30 s, while this page is open. */
const FAST_MS = 2 * 60 * 1000;
const PID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const clip = (name: unknown) => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 30) : '');

/**
 * Adding a person with a code (invites.ts): this phone's open invites, the codes it is using, and
 * the one relay connection both need. Both sides leave their sealed note with the relays for up to
 * a day, so the two phones never have to be open at the same moment.
 */
export class Adding {
  sent: Sent[] = loadSent();
  taken: Taken[] = loadTaken();
  private readonly d: AddingDeps;
  private rdv = new Map<string, Promise<Rendezvous>>();
  private relay: RingRelay | null = null;
  private spots = new Map<string, Spot>();
  private timer?: ReturnType<typeof setInterval>;
  private closer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  /** Joins being answered (or answers being opened) now: a second copy waits its turn, then does nothing. */
  private busy = new Set<string>();
  private lastJoin = new Map<string, number>();

  constructor(deps: AddingDeps) {
    this.d = deps;
  }

  start(): void {
    void this.refresh();
  }

  /** A new invite: its code, link and QR are shown at once; nothing is saved until someone joins. */
  async invite(name: string, size: number | null, appOnly: boolean): Promise<Sent> {
    const s: Sent = {
      code: newCode(), name: clip(name), size, appOnly, cs: newChannelSecret(), keys: newKeyPair(), tag: newTag(), made: Date.now(), joined: [],
    };
    this.sent = [s, ...this.sent];
    saveSent(this.sent);
    this.d.changed();
    await this.refresh();
    return s;
  }

  cancelInvite(code: string): void {
    this.sent = this.sent.filter((s) => s.code !== code);
    saveSent(this.sent);
    this.d.changed();
    void this.refresh();
  }

  /** Uses a code. The same code again (tapped twice, the link opened again) is the same join. */
  async take(code: string): Promise<Taken | 'own'> {
    if (this.sent.some((s) => s.code === code)) return 'own';
    let t = this.taken.find((x) => x.code === code);
    if (!t) {
      t = { code, keys: newKeyPair(), tag: newTag(), at: Date.now() };
      this.taken = [t, ...this.taken];
      saveTaken(this.taken);
      this.d.changed();
    }
    await this.refresh();
    await this.sendJoin(t);
    return t;
  }

  cancelJoin(code: string): void {
    const t = this.taken.find((x) => x.code === code);
    if (!t) return;
    this.taken = this.taken.filter((x) => x !== t);
    saveTaken(this.taken);
    void this.clearNotes(t);
    this.d.changed();
    void this.refresh();
  }

  /** Back online, or back on screen: say it again now. */
  wake(): void {
    for (const t of this.taken) void this.sendJoin(t);
  }

  private rendezvousOf(code: string): Promise<Rendezvous> {
    let r = this.rdv.get(code);
    if (!r) {
      r = rendezvous(code);
      this.rdv.set(code, r);
    }
    return r;
  }

  /** One at a time, so an older list never wins over a newer one. */
  private refresh(): Promise<void> {
    this.chain = this.chain.then(() => this.listen()).catch(() => undefined);
    return this.chain;
  }

  private async listen(): Promise<void> {
    const now = Date.now();
    // A day is up: forgotten (the relays forget their notes by themselves).
    const sent = this.sent.filter((s) => now - s.made < INVITE_MS);
    const taken = this.taken.filter((t) => now - t.at < INVITE_MS);
    if (sent.length !== this.sent.length || taken.length !== this.taken.length) {
      this.sent = sent;
      this.taken = taken;
      saveSent(sent);
      saveTaken(taken);
      this.d.changed();
    }
    const spots = new Map<string, Spot>();
    for (const s of sent) spots.set((await this.rendezvousOf(s.code)).joins, { kind: 'sent', code: s.code });
    for (const t of taken) spots.set(await (await this.rendezvousOf(t.code)).answers(t.tag), { kind: 'taken', code: t.code });
    this.spots = spots;
    clearTimeout(this.closer);
    if (!spots.size) {
      clearInterval(this.timer);
      this.timer = undefined;
      // A moment later, so a last "done, take the notes away" leaves first.
      this.closer = setTimeout(() => {
        if (this.spots.size) return;
        this.relay?.close();
        this.relay = null;
      }, 3000);
      return;
    }
    this.relay ??= new RingRelay((topic, data) => void this.heard(topic, data), { keep: true });
    this.relay.listen([...spots.keys()]);
    this.timer ??= setInterval(() => this.tick(), 5000);
  }

  private tick(): void {
    const now = Date.now();
    if (this.sent.some((s) => now - s.made >= INVITE_MS) || this.taken.some((t) => now - t.at >= INVITE_MS)) void this.refresh();
    if (document.visibilityState !== 'visible') return;
    for (const t of this.taken) {
      const gap = now - t.at < FAST_MS ? 5000 : 30000;
      if (now - (this.lastJoin.get(t.tag) ?? 0) >= gap - 500) void this.sendJoin(t);
    }
  }

  private async relayUp(): Promise<RingRelay | null> {
    // Just opened: wait for a relay to answer (up to 8 s), so the first note isn't lost.
    for (let i = 0; i < 40 && this.relay && !this.relay.up; i++) await new Promise((r) => setTimeout(r, 200));
    return this.relay;
  }

  private async sendJoin(t: Taken): Promise<void> {
    const r = await this.rendezvousOf(t.code);
    this.lastJoin.set(t.tag, Date.now());
    const relay = await this.relayUp();
    if (!relay || !this.taken.includes(t)) return;
    const msg: InviteMsg = { t: 'join', by: t.tag, from: this.d.myName(), ts: Date.now(), pk: t.keys.pk, pid: personId() };
    relay.send(r.joins, await sealInvite(r.key, msg), t.tag);
  }

  private async reply(r: Rendezvous, to: string, msg: InviteMsg): Promise<void> {
    const relay = await this.relayUp();
    relay?.send(await r.answers(to), await sealInvite(r.key, msg), 'a');
  }

  private async clearNotes(t: Taken): Promise<void> {
    const r = await this.rendezvousOf(t.code);
    this.relay?.clear(r.joins, t.tag);
    this.relay?.clear(await r.answers(t.tag), 'a');
  }

  private async heard(topic: string, data: Uint8Array): Promise<void> {
    const spot = this.spots.get(topic);
    if (!spot) return;
    const r = await this.rendezvousOf(spot.code);
    const m = await openInvite(r.key, data);
    if (!m || Math.abs(Date.now() - m.ts) > INVITE_MS) return;
    if (spot.kind === 'sent' && m.t === 'join') await this.answer(spot.code, r, m);
    else if (spot.kind === 'taken' && m.t !== 'join') await this.answered(spot.code, m);
  }

  /** The inviter's side: someone has the code. */
  private async answer(code: string, r: Rendezvous, m: InviteMsg): Promise<void> {
    const s = this.sent.find((x) => x.code === code);
    if (!s || m.by === s.tag || typeof m.pk !== 'string' || !KEY.test(m.pk) || this.busy.has(m.by)) return;
    // This very phone (the code typed into its own other tab): nothing to add.
    if (m.pid === personId()) return;
    this.busy.add(m.by);
    try {
      const me = this.d.myName();
      const prior = s.joined.find((j) => j.tag === m.by);
      if (prior && prior.pk !== m.pk) return;
      if (!prior && full(s)) return await this.reply(r, m.by, { t: 'used', by: s.tag, from: me, ts: Date.now(), to: m.by });
      const one = s.size === 2;
      const pid = typeof m.pid === 'string' && PID.test(m.pid) ? m.pid : undefined;
      const name = clip(m.from) || 'Someone';
      let cs = prior?.cs ?? s.cs;
      // Already saved (added before, maybe deleted on their phone since): the same entry, never a second one.
      if (!prior && one && pid) cs = this.d.channels().find((c) => c.size <= 2 && c.peer === pid)?.secret ?? cs;
      const id = await channelId(cs);
      const existing = this.d.channels().find((c) => c.id === id);
      if (!prior) {
        s.joined.push({ tag: m.by, pk: m.pk, name, cs });
        saveSent(this.sent);
      }
      const others = s.joined.filter((j) => j.tag !== m.by).map((j) => j.name);
      const members = one ? [name] : [...new Set([...(existing?.members ?? []), ...s.joined.map((j) => j.name)])];
      const ch: Channel = {
        id, secret: cs,
        name: existing?.name ?? (s.name || (one ? name : listNames(members)) || 'Group').slice(0, 30),
        appOnly: existing?.appOnly ?? s.appOnly,
        size: one ? 2 : Math.max(3, Math.min(20, members.length + 1)),
        members, created: existing?.created ?? Date.now(),
        ...(one && (pid ?? existing?.peer) ? { peer: pid ?? existing?.peer } : {}),
      };
      if (!prior || !existing) await this.d.keep(ch, []);
      const welcome: Welcome = {
        cs, n: me, ...(one ? {} : { gn: ch.name }), ms: one ? [] : others, size: ch.size, app: ch.appOnly, pid: personId(),
      };
      await this.reply(r, m.by, { t: 'welcome', by: s.tag, from: me, ts: Date.now(), to: m.by, pk: s.keys.pk, bx: await boxWelcome(s.keys, m.pk, welcome) });
      if (!prior) {
        this.d.joined(s, ch, name);
        this.d.changed();
      }
    } finally {
      this.busy.delete(m.by);
    }
  }

  /** The joiner's side: the inviter answered. */
  private async answered(code: string, m: InviteMsg): Promise<void> {
    const t = this.taken.find((x) => x.code === code);
    if (!t || m.to !== t.tag || this.busy.has(t.tag)) return;
    if (m.t === 'used') {
      this.taken = this.taken.filter((x) => x !== t);
      saveTaken(this.taken);
      void this.clearNotes(t);
      this.d.refused(t);
      this.d.changed();
      void this.refresh();
      return;
    }
    if (typeof m.pk !== 'string' || !KEY.test(m.pk) || typeof m.bx !== 'string') return;
    this.busy.add(t.tag);
    try {
      const w = await openWelcome(t.keys, m.pk, m.bx);
      if (!w || !this.taken.includes(t)) return;
      const one = w.size <= 2;
      const pid = PID.test(w.pid) ? w.pid : undefined;
      const id = await channelId(w.cs);
      const list = this.d.channels();
      const existing = list.find((c) => c.id === id);
      // Someone added twice (they had deleted me): the old entry goes, the new one stays.
      const drop = one && pid ? list.filter((c) => c.id !== id && c.size <= 2 && c.peer === pid).map((c) => c.id) : [];
      const members = [w.n, ...w.ms].map(clip).filter(Boolean).slice(0, 19);
      const ch: Channel = {
        id, secret: w.cs,
        name: existing?.name ?? ((clip(w.gn) || (one ? clip(w.n) : listNames(members))) || 'Someone').slice(0, 30),
        appOnly: w.app === true,
        size: one ? 2 : Math.max(3, Math.min(20, Math.round(w.size))),
        members: existing ? [...new Set([...existing.members, ...members])] : members,
        created: existing?.created ?? Date.now(),
        ...(one && pid ? { peer: pid } : {}),
      };
      this.taken = this.taken.filter((x) => x !== t);
      saveTaken(this.taken);
      await this.d.keep(ch, drop);
      // The notes did their job: off the relays now rather than in a day.
      await this.clearNotes(t);
      this.d.hello(ch);
      this.d.added(t, ch);
      this.d.changed();
      void this.refresh();
    } finally {
      this.busy.delete(t.tag);
    }
  }
}
