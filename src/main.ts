import './style.css';
import { App as NativeApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { CallSession, type CallState, type Person } from './call';
import { APP_DOWNLOAD_URL, APP_SCHEME, HAS_TURN, publicUrl } from './config';
import { MAX_PEOPLE, MIN_PEOPLE, SMOOTH_PEOPLE, inviteToHash, newInvite, parseInvite, type Invite } from './invite';
import { MediaProblem, cameraTrack, openCamera, type Facing } from './media';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  micOff: svg('<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  cam: svg('<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
  camOff: svg('<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>'),
  flip: svg('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>'),
  invite: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>'),
  end: svg('<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>'),
};

type Screen = 'home' | 'join' | 'protected' | 'call' | 'message';

const IN_APP = Capacitor.isNativePlatform();

let invite: Invite | null = null;
let size: number | null = null;
let stream: MediaStream | null = null;
let session: CallSession | null = null;
let facing: Facing = 'user';
let wakeLock: WakeLockSentinel | null = null;
let clock: ReturnType<typeof setInterval> | undefined;
let lastState: CallState | null = null;
let warnedBlocked = false;

/* ---------- Small helpers ---------- */

/** The only thing kept on the phone: the name you typed, so you don't type it every time. */
const NAME_KEY = 'hush.name';
function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private mode: fine, just not remembered.
  }
}

function show(screen: Screen): void {
  for (const s of ['home', 'join', 'protected', 'call', 'message'] as Screen[]) $(s).hidden = s !== screen;
}

function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(Number(t.dataset['timer']));
  t.dataset['timer'] = String(setTimeout(() => (t.hidden = true), 3200));
}

function message(icon: string, title: string, text: string): void {
  $('message-icon').textContent = icon;
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  show('message');
}

/** The secret sits after the #, which browsers never send to any server. */
function link(): string {
  return invite ? `${publicUrl()}#${inviteToHash(invite)}` : publicUrl();
}

const peopleText = (limit: number | null) => (limit ? `up to ${limit} people` : 'no limit on people');

/* ---------- Home ---------- */

function setSize(n: number | null): void {
  size = n;
  for (const b of $('sizes').querySelectorAll<HTMLButtonElement>('button')) {
    const on = (b.dataset['n'] ? Number(b.dataset['n']) : null) === n && $<HTMLInputElement>('size-custom').value === '';
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  $<HTMLInputElement>('size-custom').classList.toggle('on', $<HTMLInputElement>('size-custom').value !== '');
  $('size-note').textContent = n === null
    ? `Anyone with the link can join. Smooth for up to ${SMOOTH_PEOPLE} people.`
    : n === 2
      ? 'Just the two of you. A third person is turned away.'
      : n > SMOOTH_PEOPLE
        ? `Only ${n} can join. Above ${SMOOTH_PEOPLE}, video may lag on phones.`
        : `Only ${n} people can join. The rest are turned away.`;
}

function route(): void {
  const hash = location.hash.slice(1);
  if (!hash) return show('home');
  const parsed = parseInvite(hash);
  if (!parsed) return message('🔗', 'This link is broken', 'Ask for the link again — part of it may be missing.');
  invite = parsed;
  // A protected call is never joined from a browser, where extensions could watch it.
  if (parsed.appOnly && !IN_APP) return show('protected');
  $('join-sub').textContent = `You're invited to a ${parsed.appOnly ? 'protected' : 'private'} video call — ${peopleText(parsed.limit)}.`;
  $<HTMLInputElement>('join-name').value = savedName();
  show('join');
}

function startNew(): void {
  const name = $<HTMLInputElement>('name').value.trim();
  saveName(name);
  invite = newInvite(size, IN_APP && $<HTMLInputElement>('protect').checked);
  history.replaceState(null, '', `#${inviteToHash(invite)}`);
  void enterCall(name);
}

/* ---------- Call ---------- */

async function enterCall(name: string): Promise<void> {
  if (!invite) return;
  try {
    stream = await openCamera(facing);
  } catch (e) {
    return message('🎥', 'Camera or mic not available', e instanceof MediaProblem ? e.message : 'Please try again.');
  }
  show('call');
  const local = $<HTMLVideoElement>('local');
  local.srcObject = stream;
  local.hidden = stream.getVideoTracks().length === 0;
  $('waiting-sub').textContent = `Send them the link. This call allows ${peopleText(invite.limit)}${invite.appOnly ? ' and only the Hush app can join' : ''}.`;
  warnedBlocked = false;
  drawControls();

  session = new CallSession({
    invite,
    name: name || 'Guest',
    relayOnly: HAS_TURN && hideIp(),
    local: () => stream!,
    onChange: render,
  });
  await session.start();
  void keepAwake();
  clock = setInterval(() => lastState && drawStatus(lastState), 1000);
}

function render(state: CallState): void {
  lastState = state;
  if (state.phase === 'full') {
    finish();
    message('👥', 'This call is full', invite?.limit
      ? `It allows ${invite.limit} people and they are all in. Ask them for a new link.`
      : 'Ask them for a new link.');
    return;
  }
  const alone = state.people.length === 0;
  $('waiting').hidden = !alone;
  $('waiting-title').textContent = state.phase === 'offline' ? 'No internet — trying again…' : 'Waiting for others';
  if (state.news) toast(state.news);
  if (state.joined) {
    toast(state.joined);
    navigator.vibrate?.(60);
  }
  if (state.blocked > 0 && !warnedBlocked) {
    warnedBlocked = true;
    toast('🛡️ Someone without the key tried to get in. They were blocked.');
    navigator.vibrate?.([60, 80, 60]);
  }
  drawGrid(state.people);
  drawStatus(state);
}

/** One tile per person; tiles are reused so their video doesn't flicker on every update. */
function drawGrid(people: Person[]): void {
  const grid = $('grid');
  grid.dataset['count'] = String(Math.min(people.length, 9));
  const keep = new Set(people.map((p) => p.id));
  for (const tile of [...grid.children] as HTMLElement[]) if (!keep.has(tile.dataset['id']!)) tile.remove();
  for (const person of people) {
    let tile = grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(person.id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset['id'] = person.id;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      const label = document.createElement('span');
      label.className = 'name';
      const wait = document.createElement('div');
      wait.className = 'tile-wait';
      wait.innerHTML = '<div class="spinner"></div><p>Connecting securely…</p>';
      tile.append(video, label, wait);
      grid.append(tile);
    }
    const video = tile.querySelector('video')!;
    if (video.srcObject !== person.stream) video.srcObject = person.stream;
    // textContent, never innerHTML: a name is whatever someone typed.
    tile.querySelector('.name')!.textContent = person.name;
    tile.classList.toggle('waiting', !person.connected);
  }
}

function drawStatus(state: CallState): void {
  const chip = $('status');
  const connected = state.people.filter((p) => p.connected).length;
  chip.classList.toggle('secure', connected > 0);
  if (connected > 0 && state.liveSince) {
    const s = Math.floor((Date.now() - state.liveSince) / 1000);
    const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const count = connected + 1;
    chip.textContent = `🔒 Private · ${count === 2 ? time : `${count} people · ${time}`}`;
  } else {
    chip.textContent = state.phase === 'offline' ? 'Offline' : state.people.length ? 'Connecting…' : 'Waiting…';
  }
}

function drawControls(): void {
  const audio = stream?.getAudioTracks()[0];
  const video = stream?.getVideoTracks()[0];
  const set = (id: string, icon: string, off: boolean, label: string, disabled = false) => {
    const b = $<HTMLButtonElement>(id);
    b.innerHTML = icon;
    b.classList.toggle('off', off);
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
  };
  set('mic', audio?.enabled === false ? ICON.micOff : ICON.mic, audio?.enabled === false, audio?.enabled === false ? 'Unmute' : 'Mute', !audio);
  set('cam', video?.enabled ? ICON.cam : ICON.camOff, !video?.enabled, video?.enabled ? 'Camera off' : 'Camera on', !video);
  set('flip', ICON.flip, false, 'Switch camera', !video);
  set('invite', ICON.invite, false, 'Invite someone');
  set('end', ICON.end, false, 'End call');
  $('local').classList.toggle('mirror', facing === 'user');
  $('local').classList.toggle('cam-off', !video?.enabled);
}

async function flipCamera(): Promise<void> {
  const old = stream?.getVideoTracks()[0];
  if (!stream || !old) return;
  const next: Facing = facing === 'user' ? 'environment' : 'user';
  const wasOn = old.enabled;
  // Phones can't always hold both cameras open: release the old one first.
  old.stop();
  stream.removeTrack(old);
  let track = await cameraTrack(next).catch(() => null);
  if (track) facing = next;
  else {
    toast("Couldn't switch camera.");
    track = await cameraTrack(facing).catch(() => null);
  }
  if (track) {
    track.enabled = wasOn;
    stream.addTrack(track);
    await session?.replaceVideoTrack(track);
  }
  $<HTMLVideoElement>('local').srcObject = stream;
  drawControls();
}

async function shareLink(): Promise<void> {
  const url = link();
  const text = 'Join my private video call';
  try {
    if (Capacitor.isNativePlatform()) await Share.share({ title: 'Private call', text, url });
    else if (navigator.share) await navigator.share({ title: 'Private call', text, url });
    else await copyLink();
  } catch {
    // Closing the share sheet is fine.
  }
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link());
    toast('Link copied — send it only to the people you want.');
  } catch {
    toast(link());
  }
}

async function keepAwake(): Promise<void> {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    // Not supported: the screen may dim, the call goes on.
  }
}

/** Hang up and leave nothing behind: camera off, link wiped from the address bar. */
function finish(): number {
  const since = lastState?.liveSince;
  session?.leave();
  session = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  clearInterval(clock);
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  $('grid').replaceChildren();
  $<HTMLVideoElement>('local').srcObject = null;
  $('sheet').hidden = true;
  lastState = null;
  history.replaceState(null, '', location.pathname);
  return since ? Date.now() - since : 0;
}

function endCall(): void {
  const ms = finish();
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  message('👋', 'Call ended', ms ? `You talked for ${min ? `${min} min ` : ''}${sec} sec. Nothing was saved.` : 'Nothing was saved.');
}

function openSheet(): void {
  const people = (lastState?.people ?? []).filter((p) => p.connected);
  if (!people.length) return;
  const list = $('safety');
  list.replaceChildren(...people.map((p) => {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = p.name;
    const emojis = document.createElement('span');
    emojis.className = 'emojis';
    emojis.textContent = p.safety?.join(' ') ?? '…';
    const path = document.createElement('small');
    path.textContent = p.route === 'relay' ? 'via encrypted relay' : p.route === 'direct' ? 'direct, phone to phone' : '';
    li.append(name, emojis, path);
    return li;
  }));
  $('sheet').hidden = false;
}

/* ---------- Extra privacy: hide your IP (only when a backup relay is set up) ---------- */

const HIDE_KEY = 'hush.hideIp';
function hideIp(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function addHideIpToggles(): void {
  if (!HAS_TURN) return;
  for (const before of ['create', 'join-btn']) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = hideIp();
    box.addEventListener('change', () => {
      try {
        localStorage.setItem(HIDE_KEY, box.checked ? '1' : '0');
      } catch {
        // Not remembered, still applied to this call.
      }
      document.querySelectorAll<HTMLInputElement>('.toggle input').forEach((b) => (b.checked = box.checked));
    });
    const text = document.createElement('span');
    text.innerHTML = '<strong>Hide my IP address</strong><br>The call goes through the encrypted relay, so others never see where you are. A little slower.';
    label.append(box, text);
    $(before).before(label);
  }
}

/* ---------- Wiring ---------- */

$<HTMLInputElement>('name').value = savedName();
for (const b of $('sizes').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    $<HTMLInputElement>('size-custom').value = '';
    setSize(b.dataset['n'] ? Number(b.dataset['n']) : null);
  });
}
$('size-custom').addEventListener('input', () => {
  const input = $<HTMLInputElement>('size-custom');
  const n = Math.round(Number(input.value));
  if (input.value === '') return setSize(null);
  setSize(Number.isFinite(n) ? Math.min(MAX_PEOPLE, Math.max(MIN_PEOPLE, n)) : null);
});
$('size-custom').addEventListener('change', () => {
  const input = $<HTMLInputElement>('size-custom');
  if (input.value !== '' && size !== null) input.value = String(size);
});
setSize(null);
addHideIpToggles();

// Protected calls are created in the app; the website points people to the app instead.
$('protect-row').hidden = !IN_APP;
if (!IN_APP && APP_DOWNLOAD_URL) {
  for (const id of ['get-app', 'download-app']) {
    $<HTMLAnchorElement>(id).href = APP_DOWNLOAD_URL;
    $(id).hidden = false;
  }
}
$('open-app').addEventListener('click', () => {
  if (invite) location.href = `${APP_SCHEME}://join#${inviteToHash(invite)}`;
});
$('copy-protected').addEventListener('click', () => void copyLink());

$('create').addEventListener('click', startNew);
$('again').addEventListener('click', () => {
  $<HTMLInputElement>('name').value = savedName();
  show('home');
});
$('home-btn').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  show('home');
});
$('join-btn').addEventListener('click', () => {
  const name = $<HTMLInputElement>('join-name').value.trim();
  saveName(name);
  void enterCall(name);
});
$('paste').addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseInvite($<HTMLInputElement>('paste-input').value);
  if (!parsed) return toast("That doesn't look like a Hush call link.");
  history.replaceState(null, '', `#${inviteToHash(parsed)}`);
  $<HTMLInputElement>('paste-input').value = '';
  route();
});
$('share').addEventListener('click', () => void shareLink());
$('copy').addEventListener('click', () => void copyLink());
$('invite').addEventListener('click', () => void shareLink());
$('status').addEventListener('click', openSheet);
$('sheet-close').addEventListener('click', () => ($('sheet').hidden = true));
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) $('sheet').hidden = true;
});
$('mic').addEventListener('click', () => {
  const t = stream?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  drawControls();
});
$('cam').addEventListener('click', () => {
  const t = stream?.getVideoTracks()[0];
  if (t) t.enabled = !t.enabled;
  drawControls();
});
$('flip').addEventListener('click', () => void flipCamera());
$('end').addEventListener('click', endCall);
window.addEventListener('hashchange', () => {
  if (!session) route();
});
// Closing the tab says goodbye, so nobody is left waiting for a ghost.
window.addEventListener('pagehide', () => session?.leave());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && !wakeLock) void keepAwake();
});

/** A link opened from outside (hushcall://join#…) lands here, in the app. */
function openFromOutside(url: string | undefined): void {
  const parsed = url ? parseInvite(url) : null;
  if (!parsed || session) return;
  history.replaceState(null, '', `#${inviteToHash(parsed)}`);
  route();
}

if (IN_APP) {
  void NativeApp.addListener('appUrlOpen', (e) => openFromOutside(e.url));
  void NativeApp.getLaunchUrl().then((r) => openFromOutside(r?.url));
  void NativeApp.addListener('backButton', () => {
    if (session) endCall();
    else if (!$('home').hidden) void NativeApp.exitApp();
    else show('home');
  });
}

route();
