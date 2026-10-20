import type { Channel } from './channels';

/** "Priya" · "Priya and Ravi" · "Priya, Ravi and Asha". */
export function listNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

export function initial(name: string): string {
  return ([...name.trim()][0] ?? '?').toUpperCase();
}

/** "9:02 pm" today · "Yesterday 9:02 pm" · "18 Oct" for an older day. */
export function timeText(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  if (d.toDateString() === new Date(now - 24 * 3600 * 1000).toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export interface RowActions {
  open(ch: Channel): void;
  call(ch: Channel, voice: boolean): void;
}

export interface RowIcons {
  voice: string;
  video: string;
}

/** One saved person: who, their state, and the two call buttons (like a contact in a phone app). */
export function channelRow(ch: Channel, live: boolean, icons: RowIcons, actions: RowActions): HTMLLIElement {
  const li = document.createElement('li');
  let line: string;
  let second = '';
  let state = '';
  if (ch.gone) {
    line = `${ch.gone} removed you`;
    state = 'gone';
  } else if (live) {
    line = '● In a call now — tap to join';
    state = 'live';
  } else if (ch.missed) {
    line = `Missed · ${timeText(ch.missed)} — tap to call back`;
    second = ch.missedWhy ?? '';
    state = 'missed';
  } else {
    line = ch.members.length ? `You and ${listNames(ch.members)}` : 'Saved';
  }
  li.className = `ch${state ? ` ${state}` : ''}`;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ch-main';
  main.setAttribute('aria-label', `${ch.name}: options`);
  const avatar = document.createElement('span');
  avatar.className = 'ch-avatar';
  avatar.textContent = initial(ch.name);
  const text = document.createElement('span');
  text.className = 'ch-text';
  const name = document.createElement('strong');
  name.textContent = ch.name;
  const small = document.createElement('small');
  small.textContent = line;
  text.append(name, small);
  if (second) {
    const why = document.createElement('small');
    why.className = 'ch-why';
    why.textContent = second;
    text.append(why);
  }
  main.append(avatar, text);
  // A missed call is called back with one tap on the row (video); otherwise the row opens options.
  main.addEventListener('click', () => (state === 'missed' ? actions.call(ch, false) : actions.open(ch)));
  if (state === 'missed') main.setAttribute('aria-label', `Call ${ch.name} back`);

  const button = (icon: string, label: string, voice: boolean) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ch-call';
    b.innerHTML = icon;
    b.setAttribute('aria-label', label);
    b.disabled = !!ch.gone;
    b.addEventListener('click', () => actions.call(ch, voice));
    return b;
  };
  li.append(
    main,
    button(icons.voice, live ? `Join the call in ${ch.name}` : `Voice call ${ch.name}`, true),
    button(icons.video, live ? `Join the call in ${ch.name} with video` : `Video call ${ch.name}`, false),
  );
  return li;
}
