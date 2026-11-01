import type { Channel } from './channels';
import { keepText, tickOf, type Msg, type Thread, type Tick } from './messages';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** One tick, two ticks, two bright ticks — read at a glance, like every chat app. */
const TICK: Record<Tick, { icon: string; label: string }> = {
  sending: { icon: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'), label: 'Sending' },
  sent: { icon: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), label: 'Sent' },
  delivered: { icon: svg('<path d="m2 12.5 4.5 4.5L16 7.5"/><path d="m11.5 16 1 1L22 7.5"/>'), label: 'Delivered' },
  read: { icon: svg('<path d="m2 12.5 4.5 4.5L16 7.5"/><path d="m11.5 16 1 1L22 7.5"/>'), label: 'Read' },
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

/** The line at the top: what this chat promises. */
export function promise(keep: number): string {
  return `🔒 Messages go phone to phone, encrypted. Only your phones keep them${keep ? ` — for ${keepText(keep)}` : ''}.`;
}

function line(className: string, text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = className;
  li.textContent = text;
  return li;
}

function noteText(m: Msg): string {
  if (m.note === 'missed') return `📞 Missed call · ${time(m.ts)}${m.why ? ` · “${m.why}”` : ''}`;
  const who = m.mine ? 'You' : m.from;
  return m.k ? `⏱ ${who} set messages to disappear after ${keepText(m.k)}` : `${who} set messages to stay until deleted`;
}

function bubble(m: Msg, ch: Channel): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `bubble ${m.mine ? 'mine' : 'theirs'}`;
  // In a group, whose message it is; one-to-one it is obvious.
  if (!m.mine && ch.size > 2) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = m.from;
    li.append(who);
  }
  const p = document.createElement('p');
  p.textContent = m.x;
  const meta = document.createElement('span');
  meta.className = 'meta';
  const at = document.createElement('time');
  at.textContent = time(m.ts);
  meta.append(at);
  if (m.mine) {
    const tick = tickOf(m, ch);
    const t = document.createElement('span');
    t.className = `tick ${tick}`;
    t.innerHTML = TICK[tick].icon;
    t.setAttribute('aria-label', TICK[tick].label);
    t.title = TICK[tick].label;
    meta.append(t);
  }
  li.append(p, meta);
  return li;
}

export function drawThread(list: HTMLElement, ch: Channel, t: Thread): void {
  const items: HTMLLIElement[] = [line('sys promise', promise(t.keep))];
  let day = '';
  for (const m of t.msgs) {
    const d = dayText(m.ts);
    if (d !== day) {
      day = d;
      items.push(line('sys day', d));
    }
    items.push(m.note ? line(`sys${m.note === 'missed' ? ' missed' : ''}`, noteText(m)) : bubble(m, ch));
  }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.replaceChildren(...items);
  if (nearBottom || t.msgs[t.msgs.length - 1]?.mine) list.scrollTop = list.scrollHeight;
}
