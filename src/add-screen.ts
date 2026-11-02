import { Share } from '@capacitor/share';
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
const SHEETS = ['joining-sheet', 'newch-sheet'];

/** The same code as a link (…/#add-K7PM4QXD), for whoever would rather tap than type. */
export function inviteLink(code: string): string {
  return `${publicUrl()}#${LINK_PREFIX}${code}`;
}

/**
 * ＋ Add a person — one screen: your code to give them, and a box for theirs. Whoever types the
 * other's code, both phones have each other (adding.ts). No link to send, no call.
 */
export class AddScreen {
  private readonly d: AddScreenDeps;
  /** The code on screen, and the code being joined on screen. */
  private showing: string | null = null;
  private joining: string | null = null;
  private patience?: ReturnType<typeof setTimeout>;
  /** A double tap joins once. */
  private busy = false;

  constructor(deps: AddScreenDeps) {
    this.d = deps;
    this.wire();
  }

  /** ＋. `enter`: the box for their code gets the keyboard. */
  open(enter = false): void {
    this.d.withName(() => void this.show(enter));
  }

  /** Opened from an invite link. */
  join(code: string): void {
    this.d.withName(() => void this.take(code));
  }

  /** A code being joined, tapped in the list. */
  openTaken(code: string): void {
    this.joining = code;
    this.drawJoining('waiting');
  }

  /** Someone typed this phone's code. */
  joined(s: Sent, ch: Channel, name: string): void {
    const here = this.showing === s.code && !$('newch-sheet').hidden;
    if (here && s.size === 2) {
      this.close();
      this.d.openThread(ch);
      return this.d.toast(`✓ ${name} added — you're saved on both phones.`);
    }
    if (here) this.drawInvite();
    this.d.toast(s.size === 2 ? `✓ ${name} added with your code.` : `✓ ${name} joined ${ch.name}.`);
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

  changed(): void {
    if (this.showing && !$('newch-sheet').hidden) this.drawInvite();
  }

  /** Android's Back: the top sheet closes. */
  back(): boolean {
    if (!$('joining-sheet').hidden) {
      this.closeJoining();
      return true;
    }
    if (!$('newch-sheet').hidden) {
      this.close();
      return true;
    }
    return false;
  }

  /* ---------- Your code ---------- */

  private async show(enter: boolean): Promise<void> {
    const s = await this.d.adding.current();
    this.showing = s.code;
    $<HTMLInputElement>('code-input').value = '';
    $('code-error').hidden = true;
    this.toggleOptions(false);
    this.drawOptions(s);
    this.drawInvite();
    $('newch-sheet').hidden = false;
    if (enter) $('code-input').focus();
  }

  private close(): void {
    $('newch-sheet').hidden = true;
    this.showing = null;
  }

  private sent(): Sent | undefined {
    return this.d.adding.sent.find((x) => x.code === this.showing);
  }

  private drawInvite(): void {
    const s = this.sent();
    // Used up or cancelled while on screen: the next free code.
    if (!s || full(s)) return void this.show(false);
    $('invite-code').textContent = formatCode(s.code);
    $('invite-code').setAttribute('aria-label', `Your code ${formatCode(s.code)} — tap to copy`);
    const names = s.joined.map((j) => j.name);
    const left = s.size === null ? null : s.size - 1 - s.joined.length;
    const state = $('invite-state');
    state.classList.toggle('ok', names.length > 0);
    state.textContent = names.length
      ? `✓ ${listNames(names)} joined · ${left === null ? 'more can join' : `${left} more can join`}`
      : `They tap ＋ on their phone and enter it. ${s.size === 2 ? 'Works once' : s.size === null ? 'Anyone can use it' : `Works for ${s.size - 1} people`}, for 24 hours.`;
    // Who it is for is fixed once someone has joined.
    $('invite-more').hidden = names.length > 0;
    if (names.length) this.toggleOptions(false);
  }

  private toggleOptions(open: boolean): void {
    $('invite-options').hidden = !open;
    $('invite-more').setAttribute('aria-expanded', String(open));
  }

  private drawOptions(s: Sent): void {
    const custom = $<HTMLInputElement>('newch-custom');
    custom.value = [2, 3, 4, 6, null].includes(s.size) ? '' : String(s.size);
    $<HTMLInputElement>('newch-name').value = s.name;
    $<HTMLInputElement>('newch-protect').checked = s.appOnly;
    this.drawSize(s.size);
  }

  private drawSize(n: number | null): void {
    const custom = $<HTMLInputElement>('newch-custom');
    for (const b of $('newch-sizes').querySelectorAll<HTMLButtonElement>('button')) {
      const on = (b.dataset['n'] ? Number(b.dataset['n']) : null) === n && custom.value === '';
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    custom.classList.toggle('on', custom.value !== '');
    $('newch-name-field').hidden = n === 2;
    $('newch-note').textContent = n === 2
      ? 'Just the two of you — the code works once.'
      : n ? `Up to ${n} people, including you.${n > SMOOTH_PEOPLE ? ` Above ${SMOOTH_PEOPLE}, video may lag on phones.` : ''}`
        : 'Anyone with the code can join, for 24 hours.';
  }

  private setSize(n: number | null): void {
    if (this.showing) this.d.adding.update(this.showing, { size: n });
    this.drawSize(n);
    this.drawInvite();
  }

  private async share(): Promise<void> {
    const code = this.showing;
    if (!code) return;
    const text = `My Ekanto code: ${formatCode(code)}\nOpen Ekanto, tap ＋ and enter it (works once, for 24 hours) — or just tap ${inviteLink(code)}`;
    try {
      if (this.d.inApp) await Share.share({ title: 'Ekanto code', text });
      else if (navigator.share) await navigator.share({ title: 'Ekanto code', text });
      else await this.copy(formatCode(code), 'Code copied.');
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

  /* ---------- Their code ---------- */

  private submitCode(): void {
    const code = parseCode($<HTMLInputElement>('code-input').value);
    if (!code) {
      $('code-error').hidden = false;
      return;
    }
    this.close();
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
        this.d.toast('That is your own code — give it to the person you want to add.');
        return;
      }
      clearTimeout(this.patience);
      // No answer yet: their Ekanto is closed. It finishes when they open it.
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
        ? ['Waiting for them', `Code ${code}. It finishes by itself as soon as they open Ekanto — you can close this.`]
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
        else this.close();
      });
    }
    $('invite-code').addEventListener('click', () => this.showing && void this.copy(formatCode(this.showing), 'Code copied.'));
    $('invite-share').addEventListener('click', () => void this.share());
    $('invite-more').addEventListener('click', () => this.toggleOptions($('invite-options').hidden !== false));
    $('invite-new').addEventListener('click', () => {
      // The old code stops working: for a code told to the wrong person.
      if (this.showing) this.d.adding.cancelInvite(this.showing);
      this.showing = null;
      void this.show(false).then(() => this.d.toast('New code — the old one works no more.'));
    });
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
    $('newch-name').addEventListener('input', () => {
      if (this.showing) this.d.adding.update(this.showing, { name: $<HTMLInputElement>('newch-name').value.replace(/\s+/g, ' ').trim().slice(0, 30) });
    });
    $('newch-protect').addEventListener('change', () => {
      if (this.showing) this.d.adding.update(this.showing, { appOnly: this.d.inApp && $<HTMLInputElement>('newch-protect').checked });
    });
    $('newch-cancel').addEventListener('click', () => this.close());

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

    $('joining-ok').addEventListener('click', () => this.closeJoining());
    $('joining-cancel').addEventListener('click', () => {
      const code = this.joining;
      this.closeJoining();
      if (code) this.d.adding.cancelJoin(code);
    });
  }
}
