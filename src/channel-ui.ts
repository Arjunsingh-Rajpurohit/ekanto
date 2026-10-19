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

/** 3:15 pm today, or 12 Oct for an older day. */
export function timeText(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export interface RowActions {
  open(ch: Channel): void;
  call(ch: Channel, voice: boolean): void;
}

export interface RowIcons {
  voice: string;
  video: string;
}

/** One saved channel: who, its state, and the two call buttons (like a contact in a phone app). */
export function channelRow(ch: Channel, live: boolean, icons: RowIcons, actions: RowActions): HTMLLIElement {
  const li = document.createElement('li');
  let line: string;
  let state = '';
  if (ch.gone) {
    line = `${ch.gone} deleted this channel`;
    state = 'gone';
  } else if (live) {
    line = '● In a call now — tap to join';
    state = 'live';
  } else if (ch.missed) {
    line = `Missed call · ${timeText(ch.missed)}${ch.missedWhy ? ` · ${ch.missedWhy}` : ''}`;
    state = 'missed';
  } else {
    line = ch.members.length ? `You and ${listNames(ch.members)}` : 'Saved channel';
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
  main.append(avatar, text);
  main.addEventListener('click', () => actions.open(ch));

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
