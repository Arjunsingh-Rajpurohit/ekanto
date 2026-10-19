import './style.css';
import { App as NativeApp } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { CallSession, type CallState } from './call';
import { Chat } from './chat';
import { ChatPanel } from './chat-ui';
import { APP_DOWNLOAD_URL, APP_SCHEME, HAS_TURN, publicUrl } from './config';
import { MAX_PEOPLE, MIN_PEOPLE, SMOOTH_PEOPLE, inviteToHash, newInvite, parseInvite, type Invite } from './invite';
import { MediaProblem, cameraTrack, canShareScreenInBrowser, openCamera, screenTrack, type Facing } from './media';
import { IN_APP, nativeAudio, nativeCall, nativeFloat, nativeScreenTrack, type AudioRoute, type AudioRoutes } from './native';
import type { PluginListenerHandle } from '@capacitor/core';
import { SpeakingMeter } from './speaking';
import { Stage } from './stage';
import { clearSaved } from './viewer';

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
  chat: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  screen: svg('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  grid: svg('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
  speaker: svg('<rect width="18" height="12" x="3" y="3" rx="2"/><rect width="5" height="3" x="3" y="18" rx="1"/><rect width="5" height="3" x="10" y="18" rx="1"/><rect width="5" height="3" x="17" y="18" rx="1"/>'),
  pip: svg('<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>'),
  speakerOut: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
  earpiece: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  bluetooth: svg('<path d="m7 7 10 10-5 5V2l5 5L7 17"/>'),
  headphones: svg('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'),
  full: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  end: svg('<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>'),
};

type Screen = 'home' | 'join' | 'protected' | 'call' | 'message';

let invite: Invite | null = null;
let size: number | null = null;
let voice = false;
let stream: MediaStream | null = null;
let session: CallSession | null = null;
let chat: Chat | null = null;
let panel: ChatPanel | null = null;
let facing: Facing = 'user';
let wakeLock: WakeLockSentinel | null = null;
let clock: ReturnType<typeof setInterval> | undefined;
let lastState: CallState | null = null;
let warnedBlocked = false;
/** The screen being shared, and how to stop it. */
let sharing: { track: MediaStreamTrack; stop: () => Promise<void> } | null = null;
/** Your own picture's stream, rebuilt only when its video track changes (so it never flickers). */
let meView: { trackId: string; stream: MediaStream } | null = null;

/* ---------- Sound output: speaker, earpiece, Bluetooth, headphones ---------- */

const ROUTE: Record<AudioRoute, { label: string; icon: keyof typeof ICON }> = {
  speaker: { label: 'Speaker', icon: 'speakerOut' },
  earpiece: { label: 'Phone (earpiece)', icon: 'earpiece' },
  bluetooth: { label: 'Bluetooth', icon: 'bluetooth' },
  wired: { label: 'Headphones', icon: 'headphones' },
};
let appRoutes: AudioRoutes | null = null;
let routeListener: PluginListenerHandle | null = null;
/** Computers: the outputs the browser lists, and the one chosen ('' = default). */
let webOutputs: MediaDeviceInfo[] = [];
let webSink = '';

async function startAudio(voiceStart: boolean): Promise<void> {
  if (IN_APP) {
    await nativeCall.start(voiceStart);
    routeListener = await nativeAudio.onChange((r) => {
      appRoutes = r;
      drawAudioButton();
      if (!$('audio-sheet').hidden) drawAudioSheet();
    }).catch(() => null);
    appRoutes = await nativeAudio.routes().catch(() => null);
  } else if ('setSinkId' in HTMLMediaElement.prototype) {
    // Phone browsers don't let a website choose; computers list their speakers and headsets.
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    webOutputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  }
  drawAudioButton();
}

/** Video anywhere in the call: then leaving the app floats it in a small window. */
let floatAllowed = false;
function updateFloating(state: CallState | null): void {
  const video = !!stream?.getVideoTracks()[0] || !!sharing || !!state?.people.some((p) => p.cam || p.screen);
  if (video !== floatAllowed) {
    floatAllowed = video;
    void nativeFloat.allow(video);
  }
}

function drawAudioButton(): void {
  const btn = $<HTMLButtonElement>('audio-btn');
  if (IN_APP) {
    btn.hidden = !appRoutes || appRoutes.routes.length < 2;
    const route = ROUTE[appRoutes?.current ?? 'speaker'];
    btn.innerHTML = ICON[route.icon];
    btn.setAttribute('aria-label', `Sound: ${route.label}`);
  } else {
    btn.hidden = webOutputs.length < 2;
    btn.innerHTML = ICON.speakerOut;
    btn.setAttribute('aria-label', 'Sound output');
  }
}

function drawAudioSheet(): void {
  const list = $('audio-list');
  const item = (label: string, icon: string, on: boolean, pick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `menu-item${on ? ' on' : ''}`;
    const mi = document.createElement('span');
    mi.className = 'mi';
    mi.innerHTML = icon;
    const text = document.createElement('span');
    text.textContent = label;
    b.append(mi, text);
    if (on) {
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      b.append(check);
    }
    b.addEventListener('click', pick);
    return b;
  };
  if (IN_APP && appRoutes) {
    list.replaceChildren(...appRoutes.routes.map((r) => item(ROUTE[r].label, ICON[ROUTE[r].icon], r === appRoutes!.current, () => {
      void nativeAudio.set(r).then((now) => {
        appRoutes = now;
        drawAudioButton();
        $('audio-sheet').hidden = true;
      }).catch(() => toast("That output isn't available right now."));
    })));
  } else {
    list.replaceChildren(...webOutputs.map((d, i) => item(d.label || `Speaker ${i + 1}`, ICON.speakerOut,
      (webSink || 'default') === d.deviceId, () => {
        webSink = d.deviceId === 'default' ? '' : d.deviceId;
        stage.setSink(webSink);
        $('audio-sheet').hidden = true;
      })));
  }
}

const stage = new Stage($('stage'), () => $('call').classList.toggle('clean'));
const meter = new SpeakingMeter((speaking, loudest) => stage.setSpeaking(speaking, loudest));

/* ---------- Small helpers ---------- */

/**
 * A random secret that stays on this phone, so rejoining a call replaces your old self instead of
 * showing a second "you". Only per-call tags derived from it ever leave the phone.
 */
function deviceKey(): string {
  try {
    let key = localStorage.getItem('hush.device');
    if (!key) {
      key = crypto.randomUUID() + crypto.randomUUID();
      localStorage.setItem('hush.device', key);
    }
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

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
const callWord = (i: Invite) => (i.voice ? 'voice call' : 'video call');

/* ---------- Home ---------- */

function setKind(isVoice: boolean): void {
  voice = isVoice;
  for (const b of $('kinds').querySelectorAll<HTMLButtonElement>('button')) {
    const on = (b.dataset['kind'] === 'voice') === isVoice;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

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
  $('join-sub').textContent = `You're invited to a ${parsed.appOnly ? 'protected' : 'private'} ${callWord(parsed)} — ${peopleText(parsed.limit)}.`;
  $('join-btn').textContent = parsed.voice ? 'Join voice call' : 'Join call';
  $<HTMLInputElement>('join-name').value = savedName();
  show('join');
}

function startNew(): void {
  const name = $<HTMLInputElement>('name').value.trim();
  saveName(name);
  invite = newInvite(size, IN_APP && $<HTMLInputElement>('protect').checked, voice);
  history.replaceState(null, '', `#${inviteToHash(invite)}`);
  void enterCall(name);
}

/* ---------- Call ---------- */

async function enterCall(name: string): Promise<void> {
  if (!invite) return;
  try {
    stream = await openCamera(facing, !invite.voice);
  } catch (e) {
    return message(invite.voice ? '🎙️' : '🎥', invite.voice ? 'Microphone not available' : 'Camera or mic not available',
      e instanceof MediaProblem ? e.message : 'Please try again.');
  }
  show('call');
  stage.reset();
  meter.watch('me', stream);
  updateMe(name);
  $('waiting-sub').textContent = `Send them the link. This ${callWord(invite)} allows ${peopleText(invite.limit)}${invite.appOnly ? ' and only the Hush app can join' : ''}.`;
  warnedBlocked = false;

  session = new CallSession({
    invite,
    name: name || 'Guest',
    relayOnly: HAS_TURN && hideIp(),
    local: () => stream!,
    onChange: render,
    platform: IN_APP ? 'app' : 'web',
    media: { cam: !!stream.getVideoTracks()[0], screen: false },
    deviceKey: deviceKey(),
  });
  // The browser's Back button asks first instead of leaving (see 'popstate' below).
  if (!IN_APP) history.pushState({ hushCall: true }, '', location.href);
  chat = new Chat(session, () => panel?.render());
  panel = new ChatPanel(chat, () => lastState?.people ?? [], toast);
  drawControls();
  await session.start();
  void startAudio(!stream.getVideoTracks()[0]);
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
  stage.setPeople(state.people);
  meter.keep(new Set(['me', ...state.people.map((p) => p.id)]));
  for (const p of state.people) meter.watch(p.id, p.stream);
  drawTopActions(state);
  drawStatus(state);
  updateFloating(state);
}

/** Layout, pop-out and full-screen buttons, only where they make sense. */
function drawTopActions(state: CallState): void {
  const layoutBtn = $('layout-btn');
  layoutBtn.hidden = state.people.length < 2;
  layoutBtn.innerHTML = stage.getMode() === 'grid' ? ICON.speaker : ICON.grid;
  layoutBtn.setAttribute('aria-label', stage.getMode() === 'grid' ? 'Speaker view' : 'Grid view');
  $('pip-btn').innerHTML = ICON.pip;
  $('pip-btn').hidden = IN_APP || !document.pictureInPictureEnabled || state.people.length === 0;
  $('full-btn').innerHTML = ICON.full;
  $('full-btn').hidden = IN_APP || !document.fullscreenEnabled || window.innerWidth < 700;
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

/** Your own picture: camera (mirrored), your shared screen, or your initial. */
function updateMe(name = savedName()): void {
  const camera = stream?.getVideoTracks()[0];
  const track = sharing?.track ?? camera ?? null;
  if (!track) meView = null;
  else if (meView?.trackId !== track.id) meView = { trackId: track.id, stream: new MediaStream([track]) };
  stage.setMe({ stream: meView?.stream ?? null, name: name || 'You', video: !!track, mirror: !sharing && facing === 'user', screen: !!sharing });
}

function drawControls(): void {
  const audio = stream?.getAudioTracks()[0];
  const camOn = !!stream?.getVideoTracks()[0];
  const set = (id: string, icon: string, off: boolean, label: string, disabled = false) => {
    const b = $<HTMLButtonElement>(id);
    const badge = b.querySelector('.badge');
    b.innerHTML = icon;
    if (badge) b.append(badge);
    b.classList.toggle('off', off);
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
  };
  set('mic', audio?.enabled === false ? ICON.micOff : ICON.mic, audio?.enabled === false, audio?.enabled === false ? 'Unmute' : 'Mute', !audio);
  set('cam', camOn ? ICON.cam : ICON.camOff, !camOn, camOn ? 'Camera off' : 'Camera on');
  set('chat-btn', ICON.chat, false, 'Chat');
  set('more', ICON.more, false, 'More');
  set('end', ICON.end, false, 'End call');
  $('flip').querySelector('.mi')!.innerHTML = ICON.flip;
  $('screen').querySelector('.mi')!.innerHTML = ICON.screen;
  $('invite').querySelector('.mi')!.innerHTML = ICON.invite;
  ($('flip') as HTMLButtonElement).disabled = !camOn || !!sharing;
  const canShare = IN_APP || canShareScreenInBrowser();
  ($('screen') as HTMLButtonElement).disabled = !canShare;
  $('screen-note').hidden = canShare;
  $('screen-label').textContent = sharing ? 'Stop sharing screen' : 'Share my screen';
  updateMe();
}

/** Camera off really switches the camera off (its light goes out); on starts it again. */
async function toggleCamera(): Promise<void> {
  if (!stream) return;
  const current = stream.getVideoTracks()[0];
  if (current) {
    current.stop();
    stream.removeTrack(current);
    if (!sharing) await session?.replaceVideoTrack(null);
  } else {
    try {
      const track = await cameraTrack(facing);
      stream.addTrack(track);
      if (!sharing) await session?.replaceVideoTrack(track);
    } catch {
      toast("Couldn't turn the camera on. Check the camera permission.");
    }
  }
  session?.setMedia({ cam: !!stream.getVideoTracks()[0], screen: !!sharing });
  void nativeAudio.setVoice(!stream.getVideoTracks()[0]);
  drawControls();
}

async function flipCamera(): Promise<void> {
  const old = stream?.getVideoTracks()[0];
  if (!stream || !old || sharing) return;
  const next: Facing = facing === 'user' ? 'environment' : 'user';
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
    stream.addTrack(track);
    await session?.replaceVideoTrack(track);
  }
  drawControls();
}

/** Your screen replaces your camera for everyone until you stop. */
async function toggleScreen(): Promise<void> {
  $('more-sheet').hidden = true;
  if (sharing) return stopScreen();
  try {
    if (IN_APP) {
      sharing = await nativeScreenTrack(() => void stopScreen());
    } else {
      const track = await screenTrack();
      sharing = { track, stop: async () => track.stop() };
      // The browser's own "Stop sharing" button ends it too.
      track.addEventListener('ended', () => void stopScreen());
    }
  } catch {
    // Cancelled the picker, or not allowed.
    return;
  }
  await session?.replaceVideoTrack(sharing.track);
  session?.setMedia({ cam: !!stream?.getVideoTracks()[0], screen: true });
  toast(IN_APP ? 'Sharing your screen. Hush itself shows as black — open the app you want to show.' : 'Sharing your screen.');
  drawControls();
}

async function stopScreen(): Promise<void> {
  if (!sharing) return;
  const was = sharing;
  sharing = null;
  await was.stop();
  await session?.replaceVideoTrack(stream?.getVideoTracks()[0] ?? null);
  session?.setMedia({ cam: !!stream?.getVideoTracks()[0], screen: false });
  drawControls();
}

async function shareLink(): Promise<void> {
  $('more-sheet').hidden = true;
  const url = link();
  const text = invite?.voice ? 'Join my private voice call' : 'Join my private video call';
  try {
    if (IN_APP) await Share.share({ title: 'Private call', text, url });
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

/** Hang up and leave nothing behind: camera off, chat and files forgotten, link wiped. */
function finish(): number {
  const since = lastState?.liveSince;
  void sharing?.stop();
  sharing = null;
  session?.leave();
  session = null;
  chat?.dispose();
  chat = null;
  panel?.reset();
  panel = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  clearInterval(clock);
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  void nativeCall.end();
  floatAllowed = false;
  document.body.classList.remove('floating');
  void routeListener?.remove();
  routeListener = null;
  appRoutes = null;
  webOutputs = [];
  webSink = '';
  $('audio-btn').hidden = true;
  void clearSaved();
  stage.reset();
  meter.stop();
  meView = null;
  $('call').classList.remove('clean');
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
  for (const id of ['sheet', 'more-sheet', 'send-sheet', 'leave-sheet', 'audio-sheet']) $(id).hidden = true;
  lastState = null;
  history.replaceState(null, '', location.pathname);
  return since ? Date.now() - since : 0;
}

function endCall(): void {
  const ms = finish();
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  message('👋', 'Call ended', ms ? `You talked for ${min ? `${min} min ` : ''}${sec} sec. Nothing was saved — the chat and files are gone too.` : 'Nothing was saved.');
}

function openSafety(): void {
  $('more-sheet').hidden = true;
  const people = (lastState?.people ?? []).filter((p) => p.connected);
  if (!people.length) return toast('The safety check starts once someone is connected.');
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
      document.querySelectorAll<HTMLInputElement>('.toggle.hide-ip input').forEach((b) => (b.checked = box.checked));
    });
    label.classList.add('hide-ip');
    const text = document.createElement('span');
    text.innerHTML = '<strong>Hide my IP address</strong><br>The call goes through the encrypted relay, so others never see where you are. A little slower.';
    label.append(box, text);
    $(before).before(label);
  }
}

/* ---------- Wiring ---------- */

$<HTMLInputElement>('name').value = savedName();
for (const b of $('kinds').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => setKind(b.dataset['kind'] === 'voice'));
}
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
setKind(false);
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

// In the call
$('share').addEventListener('click', () => void shareLink());
$('copy').addEventListener('click', () => void copyLink());
$('status').addEventListener('click', openSafety);
$('sheet-close').addEventListener('click', () => ($('sheet').hidden = true));
$('mic').addEventListener('click', () => {
  const t = stream?.getAudioTracks()[0];
  if (t) t.enabled = !t.enabled;
  drawControls();
});
$('cam').addEventListener('click', () => void toggleCamera());
$('end').addEventListener('click', endCall);
$('more').addEventListener('click', () => ($('more-sheet').hidden = false));
$('more-close').addEventListener('click', () => ($('more-sheet').hidden = true));
$('flip').addEventListener('click', () => {
  $('more-sheet').hidden = true;
  void flipCamera();
});
$('screen').addEventListener('click', () => void toggleScreen());
$('audio-btn').addEventListener('click', () => {
  drawAudioSheet();
  $('audio-sheet').hidden = false;
});
$('audio-close').addEventListener('click', () => ($('audio-sheet').hidden = true));
$('layout-btn').addEventListener('click', () => {
  stage.setMode(stage.getMode() === 'grid' ? 'speaker' : 'grid');
  if (lastState) drawTopActions(lastState);
});
$('full-btn').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void $('call').requestFullscreen().catch(() => undefined);
});
$('pip-btn').addEventListener('click', () => {
  if (document.pictureInPictureElement) return void document.exitPictureInPicture();
  const video = stage.mainVideo() ?? document.querySelector<HTMLVideoElement>('#grid video');
  void video?.requestPictureInPicture().catch(() => toast("This browser can't pop out the video."));
});
$('invite').addEventListener('click', () => void shareLink());
$('safety-btn').addEventListener('click', openSafety);
for (const id of ['sheet', 'more-sheet', 'send-sheet', 'audio-sheet', 'leave-sheet']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === $(id)) $(id).hidden = true;
  });
}

// Chat
$('chat-btn').addEventListener('click', () => panel?.openPanel());
$('chat-close').addEventListener('click', () => panel?.closePanel());
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  panel?.sendText();
});
$('attach').addEventListener('click', () => $<HTMLInputElement>('file-input').click());
$('file-input').addEventListener('change', () => {
  const input = $<HTMLInputElement>('file-input');
  const file = input.files?.[0];
  input.value = '';
  if (file) panel?.pick(file);
});
$('send-download').addEventListener('click', () => panel?.send('download'));
$('send-view').addEventListener('click', () => panel?.send('view'));
$('send-cancel').addEventListener('click', () => panel?.cancelSend());
$('viewer-close').addEventListener('click', () => panel?.hideViewer());

window.addEventListener('hashchange', () => {
  if (!session) route();
});
// Back in a browser during a call: stay on the call and ask.
window.addEventListener('popstate', () => {
  if (!session) return;
  history.pushState({ hushCall: true }, '', location.href);
  $('leave-sheet').hidden = false;
});
$('leave-yes').addEventListener('click', () => {
  $('leave-sheet').hidden = true;
  endCall();
});
$('leave-no').addEventListener('click', () => ($('leave-sheet').hidden = true));
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
  void nativeFloat.onChange((floating) => document.body.classList.toggle('floating', floating));
  void nativeFloat.onHangUp(() => {
    if (session) endCall();
  });
  void NativeApp.addListener('appUrlOpen', (e) => openFromOutside(e.url));
  void NativeApp.getLaunchUrl().then((r) => openFromOutside(r?.url));
  void NativeApp.addListener('backButton', () => {
    // Back closes whatever is open on top; in the call itself it keeps the call going in the
    // background (it never hangs up by accident).
    if (!$('viewer').hidden) return panel?.hideViewer();
    for (const id of ['send-sheet', 'more-sheet', 'audio-sheet', 'sheet']) if (!$(id).hidden) return void ($(id).hidden = true);
    if (!$('chat').hidden) return panel?.closePanel();
    // In a call, Back never hangs up: a video call floats in a small window, a voice call keeps
    // going in the background (the notification brings it back).
    if (session) {
      void nativeFloat.enter().then((floated) => {
        if (!floated) void NativeApp.minimizeApp();
      });
      return;
    }
    if (!$('home').hidden) return void NativeApp.exitApp();
    show('home');
  });
}

route();
