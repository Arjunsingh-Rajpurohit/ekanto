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
  chat: string;
  voice: string;
  video: string;
}

/** The chat's newest line and how many are unread. */
export interface RowChat {
  text: string;
  at: number;
  unread: number;
}

/** One saved person: who, their state, and chat · voice · video (like a contact in a phone app). */
export function channelRow(ch: Channel, live: boolean, icons: RowIcons, actions: RowActions, chat?: RowChat): HTMLLIElement {
  const li = document.createElement('li');
  let line: string;
  let state = '';
  if (ch.gone) {
    line = `${ch.gone} removed you`;
    state = 'gone';
  } else if (live) {
    line = '● In a call now — tap to join';
    state = 'live';
  } else if (ch.missed && (!chat || ch.missed >= chat.at)) {
    line = `Missed · ${timeText(ch.missed)}${ch.missedWhy ? ` · ${ch.missedWhy}` : ''}`;
    state = 'missed';
  } else if (chat) {
    line = `${chat.text} · ${timeText(chat.at)}`;
    if (chat.unread) state = 'unread';
  } else {
    line = ch.members.length ? `You and ${listNames(ch.members)}` : 'Saved';
  }
  li.className = `ch${state ? ` ${state}` : ''}`;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ch-main';
  main.setAttribute('aria-label', `Chat with ${ch.name}${chat?.unread ? `, ${chat.unread} unread` : ''}`);
  const avatar = document.createElement('span');
  avatar.className = 'ch-avatar';
  avatar.textContent = initial(ch.name);
  if (chat?.unread) {
    const badge = document.createElement('span');
    badge.className = 'ch-unread';
    badge.textContent = chat.unread > 99 ? '99+' : String(chat.unread);
    avatar.append(badge);
  }
  const text = document.createElement('span');
  text.className = 'ch-text';
  const name = document.createElement('strong');
  name.textContent = ch.name;
  const small = document.createElement('small');
  small.textContent = line;
  text.append(name, small);
  main.append(avatar, text);
  // Like a chat app: the row opens the conversation; so does the chat button, for anyone who looks for one.
  main.addEventListener('click', () => actions.open(ch));

  const chatButton = document.createElement('button');
  chatButton.type = 'button';
  chatButton.className = 'ch-call ch-chat';
  chatButton.innerHTML = icons.chat;
  chatButton.setAttribute('aria-label', `Chat with ${ch.name}`);
  chatButton.addEventListener('click', () => actions.open(ch));

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
    chatButton,
    button(icons.voice, live ? `Join the call in ${ch.name}` : `Voice call ${ch.name}`, true),
    button(icons.video, live ? `Join the call in ${ch.name} with video` : `Video call ${ch.name}`, false),
  );
  return li;
}
