import { Share } from '@capacitor/share';
import { encode } from 'uqr';
import type { Adding } from './adding';
import { listNames } from './channel-ui';
import type { Channel } from './channels';
import { publicUrl } from './config';
import { MAX_PEOPLE, MIN_PEOPLE, SMOOTH_PEOPLE } from './invite';
import { LINK_PREFIX, formatCode, full, parseCode, type Sent, type Taken } from './invites';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AddScreenDeps {
  adding: Adding;
  toast(text: string): void;
  withName(then: () => void): void;
  openThread(ch: Channel): void;
  inApp: boolean;
}

/** After this long with no answer, "Adding…" says what is going on. */
const PATIENCE_MS = 6000;
const SHEETS = ['invite-sheet', 'joining-sheet', 'code-sheet', 'newch-sheet'];

/** The link an invite's code travels as: https://…/#add-K7PM4QXD (it opens the app when installed). */
export function inviteLink(code: string): string {
  return `${publicUrl()}#${LINK_PREFIX}${code}`;
}

/** A QR of the link, black on white whatever the theme, with a quiet border scanners need. */
function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      if (!data[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && data[y][x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const q = 3;
  return `<svg viewBox="${-q} ${-q} ${size + 2 * q} ${size + 2 * q}" shape-rendering="crispEdges" aria-hidden="true">`
    + `<rect x="${-q}" y="${-q}" width="${size + 2 * q}" height="${size + 2 * q}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/**
 * ＋ Add a person: name it, make an invite (code · link · QR), or type a code someone gave you.
 * No call needed — adding.ts does the rest, and both phones have each other.
 */
export class AddScreen {
  private readonly d: AddScreenDeps;
  private size: number | null = 2;
  /** The invite on screen, and the code being joined on screen. */
  private showing: string | null = null;
  private joining: string | null = null;
  private patience?: ReturnType<typeof setTimeout>;
  /** A double tap makes one invite, and joins once. */
  private busy = false;

  constructor(deps: AddScreenDeps) {
    this.d = deps;
    this.wire();
  }

  open(): void {
    this.d.withName(() => {
      $<HTMLInputElement>('newch-name').value = '';
      $<HTMLInputElement>('newch-custom').value = '';
      $<HTMLInputElement>('newch-protect').checked = false;
      this.setSize(2);
      $('newch-sheet').hidden = false;
      $('newch-name').focus();
    });
  }

  /** Opened from an invite link, or a code typed in. */
  join(code: string): void {
    this.d.withName(() => void this.take(code));
  }

  /** A waiting invite or code in the list was tapped. */
  openSent(code: string): void {
    const s = this.d.adding.sent.find((x) => x.code === code);
    if (s) this.showInvite(s);
  }

  openTaken(code: string): void {
    this.joining = code;
    this.drawJoining('waiting');
  }

  /** Someone joined with this phone's code. */
  joined(s: Sent, ch: Channel, name: string): void {
    if (this.showing === s.code && s.size === 2) {
      $('invite-sheet').hidden = true;
      this.showing = null;
      this.d.openThread(ch);
      return this.d.toast(`✓ ${name} added — you're saved on both phones.`);
    }
    if (this.showing === s.code) this.drawInvite();
    this.d.toast(s.size === 2 ? `✓ ${name} joined with your code.` : `✓ ${name} joined ${ch.name}.`);
  }

  /** This phone's code worked. */
  added(t: Taken, ch: Channel): void {
    const here = this.joining === t.code && !$('joining-sheet').hidden;
    if (this.joining === t.code) this.closeJoining();
    if (here) this.d.openThread(ch);
    this.d.toast(ch.size > 2 ? `✓ You joined ${ch.name}.` : `✓ You and ${ch.name} are connected.`);
  }

  refused(t: Taken): void {
    if (this.joining === t.code && !$('joining-sheet').hidden) return this.drawJoining('used');
    this.d.toast(`Code ${formatCode(t.code)} was already used — ask for a new one.`);
  }

  /** Something on the list changed: an invite on screen redraws (or goes, once cancelled). */
  changed(): void {
    if (this.showing && !$('invite-sheet').hidden) this.drawInvite();
  }

  /** Android's Back: the top sheet closes. */
  back(): boolean {
    const open = SHEETS.find((id) => !$(id).hidden);
    if (!open) return false;
    if (open === 'joining-sheet') this.closeJoining();
    else $(open).hidden = true;
    if (open === 'invite-sheet') this.showing = null;
    return true;
  }

  /* ---------- Making an invite ---------- */

  private setSize(n: number | null): void {
    this.size = n;
    const custom = $<HTMLInputElement>('newch-custom');
    for (const b of $('newch-sizes').querySelectorAll<HTMLButtonElement>('button')) {
      const on = (b.dataset['n'] ? Number(b.dataset['n']) : null) === n && custom.value === '';
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    custom.classList.toggle('on', custom.value !== '');
    $('newch-note').textContent = n === 2
      ? 'Just the two of you — the code works once.'
      : n ? `Up to ${n} people, including you.${n > SMOOTH_PEOPLE ? ` Above ${SMOOTH_PEOPLE}, video may lag on phones.` : ''}`
        : 'Anyone with the code can join, for 24 hours.';
  }

  private async make(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const appOnly = this.d.inApp && $<HTMLInputElement>('newch-protect').checked;
      const s = await this.d.adding.invite($<HTMLInputElement>('newch-name').value, this.size, appOnly);
      $('newch-sheet').hidden = true;
      this.showInvite(s);
    } finally {
      this.busy = false;
    }
  }

  private showInvite(s: Sent): void {
    this.showing = s.code;
    $('invite-qr').innerHTML = qrSvg(inviteLink(s.code));
    $('invite-code').textContent = formatCode(s.code);
    $('invite-code').setAttribute('aria-label', `Code ${formatCode(s.code)} — tap to copy`);
    $('invite-title').textContent = s.name ? `Invite ${s.name}` : s.size === 2 ? 'Invite someone' : 'Invite people';
    this.drawInvite();
    $('invite-sheet').hidden = false;
  }

  private drawInvite(): void {
    const s = this.d.adding.sent.find((x) => x.code === this.showing);
    if (!s) {
      $('invite-sheet').hidden = true;
      this.showing = null;
      return;
    }
    const names = s.joined.map((j) => j.name);
    const left = s.size === null ? null : s.size - 1 - s.joined.length;
    const state = $('invite-state');
    state.classList.toggle('ok', names.length > 0);
    state.textContent = names.length
      ? `✓ ${listNames(names)} joined${full(s) ? '' : left === null ? ' · works for more, for 24 hours' : ` · works for ${left} more`}`
      : s.size === 2 ? 'Works once · for 24 hours · no call needed'
        : `Works for ${s.size === null ? 'anyone' : `${s.size - 1} people`} · for 24 hours`;
    $('invite-cancel').hidden = full(s);
  }

  private async share(): Promise<void> {
    const code = this.showing;
    if (!code) return;
    const url = inviteLink(code);
    const text = `Add me on Ekanto — private calls and chat, phone to phone.\nTap the link, or type the code ${formatCode(code)} in Ekanto (＋ › Have a code?).\nWorks once, for 24 hours.`;
    try {
      if (this.d.inApp) await Share.share({ title: 'Ekanto invite', text, url });
      else if (navigator.share) await navigator.share({ title: 'Ekanto invite', text, url });
      else await this.copy(url, 'Link copied — send it to the person you want to add.');
    } catch {
      // Closing the share sheet is fine.
    }
  }

  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.d.toast(done);
    } catch {
      this.d.toast(text);
    }
  }

  /* ---------- Using a code ---------- */

  enterCode(): void {
    $('newch-sheet').hidden = true;
    const input = $<HTMLInputElement>('code-input');
    input.value = '';
    $('code-error').hidden = true;
    $('code-sheet').hidden = false;
    input.focus();
  }

  private submitCode(): void {
    const code = parseCode($<HTMLInputElement>('code-input').value);
    if (!code) {
      $('code-error').hidden = false;
      return;
    }
    $('code-sheet').hidden = true;
    this.join(code);
  }

  private async take(code: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.joining = code;
    this.drawJoining('adding');
    try {
      const t = await this.d.adding.take(code);
      if (t === 'own') {
        this.closeJoining();
        this.d.toast('That is your own code — send it to the person you want to add.');
        return;
      }
      clearTimeout(this.patience);
      // No answer yet: the inviter's Ekanto is closed. It finishes when they open it.
      this.patience = setTimeout(() => {
        if (this.joining === code && this.d.adding.taken.some((x) => x.code === code) && !$('joining-sheet').hidden) this.drawJoining('waiting');
      }, PATIENCE_MS);
    } finally {
      this.busy = false;
    }
  }

  private drawJoining(state: 'adding' | 'waiting' | 'used'): void {
    const code = this.joining ? formatCode(this.joining) : '';
    const [title, sub] = state === 'adding'
      ? ['Adding…', `Code ${code}`]
      : state === 'waiting'
        ? ['Waiting for them', `Code ${code}. It finishes by itself as soon as the person who invited you opens Ekanto — you can close this.`]
        : ['This code was already used', 'Each code works once. Ask them for a new one.'];
    $('joining-title').textContent = title;
    $('joining-sub').textContent = sub;
    $('joining-spin').hidden = state === 'used';
    $('joining-cancel').hidden = state === 'used';
    $('joining-sheet').hidden = false;
  }

  private closeJoining(): void {
    clearTimeout(this.patience);
    $('joining-sheet').hidden = true;
    this.joining = null;
  }

  private wire(): void {
    // A tap outside a sheet closes it, like Back.
    for (const id of SHEETS) {
      $(id).addEventListener('click', (e) => {
        if (e.target !== $(id)) return;
        if (id === 'joining-sheet') this.closeJoining();
        else $(id).hidden = true;
        if (id === 'invite-sheet') this.showing = null;
      });
    }
    for (const b of $('newch-sizes').querySelectorAll<HTMLButtonElement>('button')) {
      b.addEventListener('click', () => {
        $<HTMLInputElement>('newch-custom').value = '';
        this.setSize(b.dataset['n'] ? Number(b.dataset['n']) : null);
      });
    }
    // Your own number, 2–20 — the same as the home screen's "#".
    $('newch-custom').addEventListener('input', () => {
      const input = $<HTMLInputElement>('newch-custom');
      if (Math.round(Number(input.value)) > MAX_PEOPLE) input.value = String(MAX_PEOPLE);
      const n = Math.round(Number(input.value));
      if (input.value === '') return this.setSize(2);
      this.setSize(Number.isFinite(n) ? Math.min(MAX_PEOPLE, Math.max(MIN_PEOPLE, n)) : 2);
    });
    $('newch-custom').addEventListener('change', () => {
      const input = $<HTMLInputElement>('newch-custom');
      if (input.value !== '' && this.size !== null) input.value = String(this.size);
    });
    $('newch-start').addEventListener('click', () => void this.make());
    $('newch-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.make();
    });
    $('newch-cancel').addEventListener('click', () => ($('newch-sheet').hidden = true));
    $('newch-code').addEventListener('click', () => this.enterCode());

    $('invite-share').addEventListener('click', () => void this.share());
    $('invite-code').addEventListener('click', () => this.showing && void this.copy(formatCode(this.showing), 'Code copied.'));
    $('invite-done').addEventListener('click', () => {
      $('invite-sheet').hidden = true;
      this.showing = null;
    });
    $('invite-cancel').addEventListener('click', () => {
      const code = this.showing;
      $('invite-sheet').hidden = true;
      this.showing = null;
      if (code) this.d.adding.cancelInvite(code);
      this.d.toast('Invite cancelled — that code works no more.');
    });

    const input = $<HTMLInputElement>('code-input');
    input.addEventListener('input', () => {
      $('code-error').hidden = true;
      // K7PM4QXD → K7PM-4QXD as it is typed (a pasted link is left as it is, and still works).
      if (/[/#.]/.test(input.value)) return;
      const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
      const shown = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
      if (shown !== input.value) input.value = shown;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitCode();
    });
    $('code-go').addEventListener('click', () => this.submitCode());
    $('code-cancel').addEventListener('click', () => ($('code-sheet').hidden = true));

    $('joining-ok').addEventListener('click', () => this.closeJoining());
    $('joining-cancel').addEventListener('click', () => {
      const code = this.joining;
      this.closeJoining();
      if (code) this.d.adding.cancelJoin(code);
    });
  }
}
