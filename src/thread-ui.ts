import type { Channel } from './channels';
import { keepText, labelOf, reactionsOf, shown, tickOf, wrapped, type Msg, type Thread, type Tick } from './messages';
import { clock, kindOf, sizeText } from './prepare';
import type { FetchState } from './transfer';

const svg = (body: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** One tick, two ticks, two bright ticks — read at a glance, like every chat app. */
const TICK: Record<Tick, { icon: string; label: string }> = {
  sending: { icon: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'), label: 'Sending' },
  sent: { icon: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), label: 'Sent' },
  delivered: { icon: svg('<path d="m2 12.5 4.5 4.5L16 7.5"/><path d="m11.5 16 1 1L22 7.5"/>'), label: 'Delivered' },
  read: { icon: svg('<path d="m2 12.5 4.5 4.5L16 7.5"/><path d="m11.5 16 1 1L22 7.5"/>'), label: 'Read' },
};

export const ICONS = {
  down: svg('<path d="M12 4v12"/><path d="m6 11 6 6 6-6"/><path d="M5 20h14"/>', 22),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 22),
  play: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  wait: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>', 20),
  retry: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', 20),
  gift: '🎁',
};

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayText(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Sat 2 Nov, 12:00 AM" — when a surprise opens. */
export function whenText(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'Today'
    : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow'
      : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time(at)}`;
}

/** "in 3h 12m" — the countdown on a wrapped surprise. */
export function untilText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((at - now) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  if (m) return `in ${m}m ${s % 60}s`;
  return `in ${s}s`;
}

/** The line at the top: what this chat promises. */
export function promise(keep: number): string {
  return `🔒 Messages, photos and files go phone to phone, encrypted. Only your phones keep them${keep ? ` — for ${keepText(keep)}` : ''}.`;
}

/** What the thread needs from outside: files that are here, and how the rest is coming along. */
export interface ThreadView {
  /** A picture or file of this message, ready to show — or undefined (it starts loading). */
  url(m: Msg): string | undefined;
  state(id: string): FetchState | undefined;
  /** Voice note playing now, and how far (0..1). */
  playing(): { id: string; at: number } | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function line(className: string, text: string): HTMLLIElement {
  return el('li', className, text);
}

function noteText(m: Msg): string {
  if (m.note === 'missed') return `📞 Missed call · ${time(m.ts)}${m.why ? ` · “${m.why}”` : ''}`;
  const who = m.mine ? 'You' : m.from;
  return m.k ? `⏱ ${who} set messages to disappear after ${keepText(m.k)}` : `${who} set messages to stay until deleted`;
}

function meta(m: Msg, ch: Channel): HTMLSpanElement {
  const meta = el('span', 'meta');
  meta.append(el('time', '', time(m.ts)));
  if (m.mine && !m.gone) {
    const tick = tickOf(m, ch);
    const t = el('span', `tick ${tick}`);
    t.innerHTML = TICK[tick].icon;
    t.setAttribute('aria-label', TICK[tick].label);
    t.title = TICK[tick].label;
    meta.append(t);
  }
  return meta;
}

/** Bytes here so far, as a ring — or what to tap. */
export function progressOf(m: Msg, state: FetchState | undefined): { cls: string; html: string; label: string; pct?: number } {
  if (m.dl === 'none') return { cls: 'gone', html: '', label: 'No longer available' };
  if (m.dl === 'failed') return { cls: 'tap', html: ICONS.retry, label: 'Try again' };
  if (m.dl === 'big' && !state) return { cls: 'tap', html: ICONS.down, label: `Download · ${sizeText(m.f!.z)}` };
  if (state?.state === 'loading') {
    const pct = m.f!.z ? Math.min(1, state.got / m.f!.z) : 1;
    return { cls: 'loading', html: '', label: `${Math.round(pct * 100)}%`, pct };
  }
  return { cls: 'waiting', html: ICONS.wait, label: `Waiting for ${m.from}` };
}

function progress(m: Msg, view: ThreadView): HTMLElement {
  const p = progressOf(m, view.state(m.id));
  const b = el('button', `dl ${p.cls}`);
  b.type = 'button';
  b.dataset.act = p.cls === 'tap' ? 'fetch' : 'none';
  b.dataset.prog = m.id;
  b.innerHTML = p.html;
  if (p.pct !== undefined) b.style.setProperty('--p', String(p.pct));
  b.setAttribute('aria-label', p.label);
  b.append(el('span', 'dl-label', p.label));
  return b;
}

const here = (m: Msg) => m.mine || m.dl === 'done';

function quote(m: Msg, t: Thread, ch: Channel): HTMLElement | null {
  if (!m.q) return null;
  const q = t.msgs.find((o) => o.id === m.q);
  const b = el('button', 'quote');
  b.type = 'button';
  b.dataset.act = 'quote';
  b.dataset.q = m.q;
  b.append(el('strong', '', q ? (q.mine ? 'You' : q.from) : ch.name), el('span', '', q ? labelOf(q) : 'Message not here'));
  return b;
}

/** A photo, video or GIF, at its own shape. View-only ones stay a closed card until opened. */
function picture(m: Msg, view: ThreadView): HTMLElement {
  const f = m.f!;
  const kind = kindOf(f);
  const box = el('div', `pic${f.v ? ' lock' : ''}`);
  const ratio = f.w && f.h ? Math.min(1.8, Math.max(0.6, f.w / f.h)) : 4 / 3;
  box.style.aspectRatio = String(f.v ? 1.6 : ratio);
  if (f.th) {
    const blur = el('img', 'blur');
    blur.src = f.th;
    blur.alt = '';
    box.append(blur);
  }
  const url = here(m) && !f.v ? view.url(m) : undefined;
  if (url) {
    if (kind === 'gif' && f.m.startsWith('video/')) {
      const v = el('video', 'real');
      Object.assign(v, { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      box.append(v);
    } else if (kind !== 'video') {
      const img = el('img', 'real');
      img.src = url;
      img.alt = kind === 'gif' ? 'GIF' : 'Photo';
      img.draggable = false;
      // Big originals decode off the main thread and only when scrolled to.
      img.decoding = 'async';
      img.loading = 'lazy';
      box.append(img);
    }
  }
  box.dataset.act = here(m) ? 'view' : 'none';
  if (f.v) {
    const lock = el('span', 'lock-label');
    lock.innerHTML = ICONS.eye;
    lock.append(el('span', '', `${kind === 'video' ? 'Video' : 'Photo'} · View only`));
    box.append(lock);
  } else if (kind === 'video' && here(m)) {
    const play = el('span', 'play');
    play.innerHTML = ICONS.play;
    box.append(play);
  }
  if (kind === 'gif') box.append(el('span', 'pic-chip gif-chip', 'GIF'));
  if (kind === 'video' && f.d) box.append(el('span', 'pic-chip dur', clock(f.d)));
  if (!here(m)) box.append(progress(m, view));
  return box;
}

function voice(m: Msg, view: ThreadView): HTMLElement {
  const f = m.f!;
  const row = el('div', 'voice-row');
  const now = view.playing();
  const on = now?.id === m.id;
  if (here(m)) {
    const b = el('button', 'vplay');
    b.type = 'button';
    b.dataset.act = 'play';
    b.innerHTML = on ? ICONS.pause : ICONS.play;
    b.setAttribute('aria-label', on ? 'Pause' : 'Play voice message');
    row.append(b);
  } else row.append(progress(m, view));
  const wave = el('span', 'wave');
  const bars = (f.wf || '3'.repeat(40)).split('');
  const played = on ? Math.round(now!.at * bars.length) : 0;
  bars.forEach((b, i) => {
    const bar = el('i', i < played ? 'on' : '');
    bar.style.height = `${18 + Number(b) * 9}%`;
    wave.append(bar);
  });
  row.append(wave, el('span', 'vtime', clock(f.d ?? 0)));
  return row;
}

function doc(m: Msg, view: ThreadView): HTMLElement {
  const f = m.f!;
  const box = el('div', 'doc');
  box.dataset.act = here(m) ? 'view' : 'none';
  const ext = (f.n.includes('.') ? f.n.split('.').pop()! : f.m.split('/')[1] || 'file').slice(0, 4).toUpperCase();
  const icon = el('span', 'doc-icon', ext);
  const info = el('span', 'doc-info');
  info.append(el('strong', '', f.n), el('small', '', `${sizeText(f.z)}${f.v ? ' · View only' : ''}`));
  box.append(icon, info);
  if (!here(m)) box.append(progress(m, view));
  return box;
}

function sticker(m: Msg): HTMLElement {
  const s = m.s!;
  if (s.startsWith('e:')) return el('span', 'stk-e', s.slice(2));
  const img = el('img', 'stk-i');
  img.src = s.slice(2);
  img.alt = 'Sticker';
  img.draggable = false;
  return img;
}

/** A surprise of theirs, still wrapped: a gift with a countdown. */
function gift(m: Msg): HTMLElement {
  const b = el('button', 'gift');
  b.type = 'button';
  b.dataset.act = 'gift';
  const ready = m.op! <= Date.now();
  b.append(el('span', 'gift-box', ICONS.gift), el('strong', '', ready ? 'Tap to open' : `A surprise from ${m.from}`));
  const when = el('small', 'countdown', ready ? `From ${m.from}` : `Opens ${untilText(m.op!)}`);
  if (!ready) when.dataset.op = String(m.op);
  b.append(when);
  return b;
}

function reactions(on: Map<string, string> | undefined, ch: Channel): HTMLElement | null {
  if (!on?.size) return null;
  const counts = new Map<string, number>();
  for (const e of on.values()) counts.set(e, (counts.get(e) ?? 0) + 1);
  const box = el('span', 'reacts');
  box.dataset.act = 'react-info';
  for (const [e, n] of counts) box.append(el('span', '', ch.size > 2 && n > 1 ? `${e} ${n}` : e));
  return box;
}

function bubble(m: Msg, ch: Channel, t: Thread, view: ThreadView, reacts?: Map<string, string>): HTMLLIElement {
  const li = el('li', `bubble ${m.mine ? 'mine' : 'theirs'}`);
  li.dataset.id = m.id;
  const isWrapped = !m.mine && wrapped(m);
  if (!m.mine && ch.size > 2 && !m.s) li.append(el('span', 'who', m.from));

  if (m.gone) {
    li.classList.add('deleted');
    li.append(el('p', '', m.mine ? '🚫 You deleted this message' : '🚫 This message was deleted'), meta(m, ch));
    return li;
  }
  if (isWrapped) {
    li.classList.add('wrapped');
    li.append(gift(m), meta(m, ch));
    return li;
  }
  const q = quote(m, t, ch);
  if (q) li.append(q);
  if (m.s) {
    li.classList.add('sticker');
    li.append(sticker(m));
  } else if (m.f) {
    const kind = kindOf(m.f);
    if (kind === 'voice') {
      li.classList.add('voice');
      li.append(voice(m, view));
    } else if (kind === 'image' || kind === 'video' || kind === 'gif') {
      li.classList.add('media');
      li.append(picture(m, view));
    } else {
      li.classList.add('file');
      li.append(doc(m, view));
    }
  }
  if (m.mine && m.op && wrapped(m)) {
    const note = el('small', 'surprise-note', `🎁 Opens for ${ch.size > 2 ? 'everyone' : ch.name} ${whenText(m.op)}`);
    note.dataset.op = String(m.op);
    li.append(note);
  }
  if (m.x) li.append(el('p', '', m.x));
  li.append(meta(m, ch));
  const r = reactions(reacts, ch);
  if (r) {
    li.classList.add('has-react');
    li.append(r);
  }
  return li;
}

/** What makes a bubble look different: if none of it changed, the old one stays (a GIF keeps playing). */
function signature(m: Msg, ch: Channel, t: Thread, view: ThreadView, reacts?: Map<string, string>): string {
  const p = m.f && !here(m) ? progressOf(m, view.state(m.id)) : null;
  return JSON.stringify([
    m.x, m.gone, m.dl, m.un, m.s?.length, m.mine ? tickOf(m, ch) : '', m.f?.th?.length, p?.cls,
    m.f && here(m) && !m.f.v ? !!view.url(m) : 0, m.q && labelOf(t.msgs.find((o) => o.id === m.q) ?? m),
    reacts ? [...reacts.values()].join('') : '', wrapped(m), view.playing()?.id === m.id,
    // A surprise turns from "Opens in…" to "Tap to open" when its time comes.
    m.op ? m.op <= Date.now() : 0,
  ]);
}

export function drawThread(list: HTMLElement, ch: Channel, t: Thread, view: ThreadView): void {
  const reacts = reactionsOf(t);
  const want: { key: string; sig: string; make: () => HTMLLIElement }[] = [
    { key: 'promise', sig: String(t.keep), make: () => line('sys promise', promise(t.keep)) },
  ];
  let day = '';
  for (const m of t.msgs) {
    if (!shown(m)) continue;
    const d = dayText(m.ts);
    if (d !== day) {
      day = d;
      want.push({ key: `day:${d}`, sig: d, make: () => line('sys day', d) });
    }
    if (m.note) want.push({ key: m.id, sig: noteText(m), make: () => line(`sys${m.note === 'missed' ? ' missed' : ''}`, noteText(m)) });
    else {
      const r = reacts.get(m.id);
      want.push({ key: m.id, sig: signature(m, ch, t, view, r), make: () => bubble(m, ch, t, view, r) });
    }
  }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const old = new Map<string, HTMLElement>();
  for (const child of [...list.children] as HTMLElement[]) if (child.dataset.key) old.set(child.dataset.key, child);
  const items = want.map((w) => {
    const prev = old.get(w.key);
    if (prev && prev.dataset.sig === w.sig) return prev;
    const li = w.make();
    li.dataset.key = w.key;
    li.dataset.sig = w.sig;
    return li;
  });
  // Only what changed is replaced; the rest keeps its place (and a playing GIF keeps playing).
  items.forEach((li, i) => {
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  while (list.children.length > items.length) list.lastElementChild!.remove();
  const last = t.msgs.filter(shown).at(-1);
  if (nearBottom || last?.mine) list.scrollTop = list.scrollHeight;
}

/**
 * Just the arriving file's ring — many times a second, without touching the rest of the chat.
 * False when the bubble must be drawn again instead (it started, finished or stalled).
 */
export function drawProgress(list: HTMLElement, m: Msg, state: FetchState | undefined): boolean {
  const b = list.querySelector<HTMLElement>(`[data-prog="${CSS.escape(m.id)}"]`);
  if (!b) return false;
  const p = progressOf(m, state);
  if (!b.classList.contains(p.cls)) return false;
  if (p.pct !== undefined) b.style.setProperty('--p', String(p.pct));
  const label = b.querySelector('.dl-label');
  if (label) label.textContent = p.label;
  return true;
}

/** Ticks the surprise countdowns; true when one just reached its time (the thread is drawn again). */
export function tickCountdowns(list: HTMLElement, now = Date.now()): boolean {
  let due = false;
  for (const c of list.querySelectorAll<HTMLElement>('[data-op]')) {
    const at = Number(c.dataset.op);
    if (at <= now) due = true;
    else c.textContent = c.classList.contains('countdown') ? `Opens ${untilText(at, now)}` : c.textContent;
  }
  return due;
}
