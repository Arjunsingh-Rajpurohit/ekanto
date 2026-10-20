import './style.css';
import { App as NativeApp } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { CallSession, type CallState, type Person } from './call';
import { channelRow, initial, listNames } from './channel-ui';
import {
  channelId, loadChannels, newChannelSecret, saveChannels, upsertChannel, type Channel, type Ring,
} from './channels';
import { Chat } from './chat';
import { ChatPanel } from './chat-ui';
import { APP_DOWNLOAD_URL, APP_SCHEME, HAS_TURN, publicUrl } from './config';
import { LINK_HOURS, MAX_PEOPLE, MIN_PEOPLE, SMOOTH_PEOPLE, cleanReason, expired, inviteToHash, newInvite, parseInvite, type Invite } from './invite';
import { LOWDATA_KEY, MediaProblem, NOISE_KEY, cameraTrack, canShareScreenInBrowser, lowDataOn, micCleanup, noiseOn, openCamera, screenTrack, type Facing } from './media';
import { IN_APP, nativeAudio, nativeCall, nativeFloat, nativeProtect, nativeRing, nativeScreenTrack, type AudioRoute, type AudioRoutes, type RingSetting } from './native';
import { PROTECTED_INVITE, PROTECTED_LIMIT, PROTECTED_PROMISE, RECORDING_SELF, parseRecording, recordingNotice, recordingWire } from './protect';
import { Ringing } from './ringing';
import type { PluginListenerHandle } from '@capacitor/core';
import { SpeakingMeter } from './speaking';
import { Stage } from './stage';
import { startTone } from './tones';
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
  star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  full: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  end: svg('<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>'),
};

type Screen = 'home' | 'join' | 'protected' | 'call' | 'message' | 'incoming';

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

/**
 * The app's outputs: whatever the phone reports, and always Speaker and Phone (earpiece) — the
 * choice must never vanish because the phone was slow to answer, or answered with just one.
 */
function appOutputs(): AudioRoutes {
  const reported = appRoutes?.routes ?? [];
  const order: AudioRoute[] = ['bluetooth', 'wired', 'earpiece', 'speaker'];
  const all = order.filter((r) => reported.includes(r) || r === 'earpiece' || r === 'speaker');
  // Until the phone says, the usual start: earpiece for a voice call, speaker with video.
  return { routes: all, current: appRoutes?.current ?? (stream?.getVideoTracks()[0] ? 'speaker' : 'earpiece') };
}

function drawAudioButton(): void {
  const btn = $<HTMLButtonElement>('audio-btn');
  if (IN_APP) {
    // Always there during a call, from its first moment.
    btn.hidden = !session;
    const route = ROUTE[appOutputs().current];
    btn.innerHTML = ICON[route.icon];
    btn.setAttribute('aria-label', 'Speaker');
  } else {
    // Always shown: a first-time user looks for it. With nothing to pick, tapping it explains.
    btn.hidden = false;
    btn.innerHTML = ICON.speakerOut;
    btn.setAttribute('aria-label', 'Speaker');
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
  if (IN_APP) {
    const outputs = appOutputs();
    list.replaceChildren(...outputs.routes.map((r) => item(ROUTE[r].label, ICON[ROUTE[r].icon], r === outputs.current, () => {
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
// Buttons tapped away: a tap anywhere but a picture brings them back.
$('call').addEventListener('click', (e) => {
  if (!(e.target as Element).closest('.tile')) $('call').classList.remove('clean');
});
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
  if (name === savedName()) return;
  try {
    localStorage.setItem(NAME_KEY, name);
    void syncChannels();
  } catch {
    // Private mode: fine, just not remembered.
  }
}

function show(screen: Screen): void {
  for (const s of ['home', 'join', 'protected', 'call', 'message', 'incoming'] as Screen[]) $(s).hidden = s !== screen;
  // A toast belongs to the screen it was shown on: "Priya joined" must not sit under "Priya hung up".
  hideToast();
  if (screen === 'home') {
    drawMe();
    void drawRingSetup(true);
  }
}

function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(Number(t.dataset['timer']));
  t.dataset['timer'] = String(setTimeout(() => (t.hidden = true), 3200));
}

function hideToast(): void {
  const t = $('toast');
  clearTimeout(Number(t.dataset['timer']));
  t.hidden = true;
}

/** Where a blocked camera or mic is switched back on — the one thing a stuck user needs. */
const WHERE_TO_ALLOW = IN_APP
  ? 'To allow it: Android Settings › Apps › Ekanto › Permissions.'
  : 'To allow it: tap the lock icon in the address bar and allow Camera and Microphone.';

/** "Ravi's phone tried to record — blocked." Sticky too: everyone in the call should see it. */
function recordingNote(text: string): void {
  $('rec-text').textContent = text;
  $('rec-note').hidden = false;
}

/** Android 15+ says a screen recorder is on: tell the others (and me) — the picture is black anyway. */
function onRecording(on: boolean): void {
  if (!invite?.appOnly || !session) return;
  if (on) recordingNote(RECORDING_SELF);
  const wire = recordingWire(on);
  for (const p of lastState?.people ?? []) session.sendTo(p.id, wire);
}

/** Stays on screen until dismissed — a 3-second toast is gone before it is read. */
function blockedNote(text: string): void {
  $('blocked-text').textContent = text;
  $('blocked').hidden = false;
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
  // Only the one thing worth a line: big calls can lag.
  const note = n !== null && n > SMOOTH_PEOPLE ? `Above ${SMOOTH_PEOPLE} people, video may lag on phones.` : '';
  $('size-note').textContent = note;
  $('size-note').hidden = !note;
  drawOptions();
}

/* Tabs on a phone (Calls · Link · Settings); on a computer Calls and Link sit side by side. */

type Tab = 'calls' | 'link' | 'settings';
const HOME_SHEETS = ['options-sheet', 'paste-sheet', 'name-sheet', 'privacy-sheet'];
const TAB_TITLE: Record<Tab, string> = { calls: 'Ekanto', link: 'Call link', settings: 'Settings' };
const wide = window.matchMedia('(min-width: 900px)');

function setTab(tab: Tab): void {
  $('home').dataset['tab'] = tab;
  $('home-title').textContent = wide.matches ? 'Ekanto' : TAB_TITLE[tab];
  for (const b of $('tabbar').querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('on', b.dataset['tab'] === tab);
    if (b.dataset['tab'] === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (tab === 'settings') void drawRingSetup();
}

/** Settings: its own tab on a phone, a side panel on a computer. */
function openSettings(): void {
  if (!wide.matches) return setTab('settings');
  $('home').classList.add('drawer-open');
  void drawRingSetup();
}

function closeSettings(): void {
  $('home').classList.remove('drawer-open');
}

/** The round letter at the top and the name row in Settings. */
function drawMe(): void {
  const name = savedName();
  $('me-btn').textContent = name ? initial(name) : '?';
  $('me-avatar').textContent = name ? initial(name) : '?';
  $('me-name').textContent = name || 'Add your name';
}

/** Asked once, before the first call: others should see who is calling, not "Someone". */
let afterName: (() => void) | null = null;
function openNameSheet(then: (() => void) | null = null): void {
  afterName = then;
  $<HTMLInputElement>('name').value = savedName();
  $('name-save').textContent = then ? 'Continue' : 'Save';
  $('name-sheet').hidden = false;
  $('name').focus();
}

function withName(action: () => void): void {
  if (savedName()) return action();
  openNameSheet(action);
}

function saveNameSheet(): void {
  const then = afterName;
  afterName = null;
  saveName($<HTMLInputElement>('name').value.trim().slice(0, 30));
  $('name-sheet').hidden = true;
  drawMe();
  then?.();
}

/* More options: protected call, hide my IP — the summary says which are on. */
function drawOptions(): void {
  const on = [
    size ? `Up to ${size} people` : '',
    IN_APP && $<HTMLInputElement>('protect').checked ? 'Protected' : '',
    HAS_TURN && hideIp() ? 'IP hidden' : '',
  ].filter(Boolean);
  $('options-sum').textContent = on.join(' · ') || 'Off';
}

function route(): void {
  const hash = location.hash.slice(1);
  if (!hash) return show('home');
  const parsed = parseInvite(hash);
  if (!parsed) return message('🔗', 'This link is broken', 'Ask for the link again — part of it may be missing.');
  if (expired(parsed)) {
    return message('⏰', 'This link has expired', `Links work for ${LINK_HOURS} hours, so an old link can't open a call. Ask for a new one — or save a channel and just tap to call.`);
  }
  invite = parsed;
  // A protected call is never joined from a browser, where extensions could watch it.
  if (parsed.appOnly && !IN_APP) return show('protected');
  $('join-sub').textContent = `You're invited to a ${parsed.appOnly ? 'protected' : 'private'} ${callWord(parsed)} — ${peopleText(parsed.limit)}.`;
  $('join-shield').hidden = !parsed.appOnly;
  $('join-btn').textContent = parsed.voice ? 'Join voice call' : 'Join call';
  showWhy('join-why', parsed.reason);
  $<HTMLInputElement>('join-name').value = savedName();
  show('join');
}

/** A new channel brings its own people limit and protection; otherwise the home screen's are used. */
function startNew(limit: number | null = size, appOnly = IN_APP && $<HTMLInputElement>('protect').checked,
  reason = cleanReason($<HTMLInputElement>('reason').value)): void {
  const name = savedName();
  invite = newInvite(limit, appOnly, voice, Date.now(), reason);
  // A reason belongs to one call: the next call starts with an empty box.
  $<HTMLInputElement>('reason').value = '';
  history.replaceState(null, '', `#${inviteToHash(invite)}`);
  void enterCall(name);
}

/* ---------- Call ---------- */

/** How a call was reached from a saved channel: rang it, answered it, or joined one already on. */
interface ChannelVia {
  ch: Channel;
  caller: boolean;
  joinedLive?: boolean;
  /** Why the caller is calling, if they said ("Dinner plans?"). */
  reason?: string | null;
}

/** `via`: the call was made or answered from a saved channel. `camera` overrides the call's own choice. */
async function enterCall(name: string, via?: ChannelVia, camera?: boolean): Promise<void> {
  if (!invite) return;
  try {
    stream = await openCamera(facing, camera ?? !invite.voice);
  } catch (e) {
    return message(invite.voice ? '🎙️' : '🎥', invite.voice ? 'Microphone not available' : 'Camera or mic not available',
      `${e instanceof MediaProblem ? e.message : 'Please try again.'} ${WHERE_TO_ALLOW}`);
  }
  show('call');
  stage.reset();
  meter.watch('me', stream);
  updateMe(name);
  $('waiting-sub').textContent = 'Nobody has joined yet. Send them the link.';
  $('waiting-detail').textContent = newChannelName !== null
    ? `When they join, both phones save each other${newChannelName ? ` as “${newChannelName}”` : ''} — after that, just tap to call.`
    : `This ${callWord(invite)} allows ${peopleText(invite.limit)}${invite.appOnly ? ' and only the Ekanto app can join' : ''}. The link works for ${LINK_HOURS} hours.`;
  $('waiting-detail').hidden = false;
  $('waiting-share').hidden = !!via;
  $<HTMLAnchorElement>('whatsapp').href = `https://wa.me/?text=${encodeURIComponent(`${inviteText()}\n${link()}`)}`;
  showWhy('waiting-why', via ? via.reason ?? null : invite.reason);
  warnedBlocked = false;

  session = new CallSession({
    invite,
    name: name || 'Guest',
    relayOnly: HAS_TURN && hideIp(),
    local: () => stream!,
    onChange: render,
    platform: IN_APP ? 'app' : 'web',
    media: { cam: !!stream.getVideoTracks()[0], screen: false, mic: stream.getAudioTracks()[0]?.enabled !== false },
    deviceKey: deviceKey(),
    lowData: lowDataOn(),
  });
  // The browser's Back button asks first instead of leaving (see 'popstate' below).
  if (!IN_APP) history.pushState({ hushCall: true }, '', location.href);
  session.onControl = onControl;
  chat = new Chat(session, () => panel?.render());
  panel = new ChatPanel(chat, () => lastState?.people ?? [], toast);
  drawControls();
  // Sound first: the speaker/earpiece choice is there from the call's first moment.
  void startAudio(!stream.getVideoTracks()[0]);
  await session.start();
  if (via) startChannelCall(via);
  void keepAwake();
  clock = setInterval(() => lastState && drawStatus(lastState), 1000);
}

/** How many others were on screen at the last render. */
let shownPeople = 0;

function render(state: CallState): void {
  const talking = lastState?.liveSince ?? null;
  lastState = state;
  if (state.phase === 'full') {
    finish();
    message('👥', 'This call is full', invite?.limit
      ? `It allows ${invite.limit} people and they are all in. Ask them for a new link.`
      : 'Ask them for a new link.');
    return;
  }
  const alone = state.people.length === 0;
  // A two-person channel is a phone call: when they hang up, it's over for you too.
  if (alone && state.hungUp && channelCall?.connected && channelCall.ch.size <= 2) return endCall(state.hungUp, talking);
  // Someone came or went: show the buttons again (they may have been tapped away), so hanging up
  // is always one tap.
  if (state.people.length !== shownPeople) $('call').classList.remove('clean');
  shownPeople = state.people.length;
  $('waiting').hidden = !alone;
  $('waiting-title').textContent = state.phase === 'offline'
    ? 'Weak network — trying again. Keep this screen open.'
    : channelCall?.caller && !channelCall.connected ? `Calling ${channelCall.ch.name}…` : 'Waiting for others';
  if (channelCall && !channelCall.connected && state.people.some((p) => p.connected)) {
    channelCall.connected = true;
    channelCall.stopTone?.();
    channelCall.stopTone = undefined;
    void ringing.send(channelCall.ch, { t: 'live', call: channelCall.hash, from: myName() });
  }
  // Started from "New channel": everyone who joins is offered the channel.
  if (newChannelName !== null) {
    const fresh = state.people.filter((p) => p.connected && p.channelOpen && !offer?.asked.has(p.id));
    if (fresh.length) offerChannel(newChannelName || listNames(fresh.map((p) => p.name)), fresh);
  }
  if (asked && !state.people.some((p) => p.id === asked!.from.id)) {
    asked = null;
    $('ask-sheet').hidden = true;
  }
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
  stage.setMyBars(state.myBars);
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
  const reconnecting = state.people.some((p) => p.reconnecting);
  chip.classList.toggle('secure', connected > 0 && !reconnecting);
  chip.classList.toggle('warn', reconnecting);
  const low = $('lowdata-chip');
  low.hidden = state.lowData === 'normal' || state.people.length === 0;
  low.textContent = state.lowData === 'voice' ? 'Voice only — tap to send video' : 'Low data — tap for normal';
  if (reconnecting) {
    chip.textContent = 'Reconnecting…';
  } else if (connected > 0 && state.liveSince) {
    const s = Math.floor((Date.now() - state.liveSince) / 1000);
    const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const count = connected + 1;
    // A protected call wears its shield; a tap opens the safety sheet, which says what it means.
    chip.textContent = `${invite?.appOnly ? '🛡️ Protected' : '🔒 Private'}\u00a0·\u00a0${count === 2 ? time : `${count}\u00a0people · ${time}`}`;
  } else {
    chip.textContent = state.phase === 'offline'
      ? 'Offline'
      : state.people.length ? 'Connecting… usually under 10 seconds' : channelCall?.caller ? 'Ringing…' : 'Waiting…';
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
    const text = document.getElementById(`${id}-label`);
    if (text) text.textContent = label;
  };
  set('mic', audio?.enabled === false ? ICON.micOff : ICON.mic, audio?.enabled === false, audio?.enabled === false ? 'Muted' : 'Mute', !audio);
  set('cam', camOn ? ICON.cam : ICON.camOff, !camOn, camOn ? 'Camera' : 'Camera off');
  set('chat-btn', ICON.chat, false, 'Chat');
  set('more', ICON.more, false, 'More');
  set('end', ICON.end, false, 'End');
  $('flip').querySelector('.mi')!.innerHTML = ICON.flip;
  $('screen').querySelector('.mi')!.innerHTML = ICON.screen;
  $('invite').querySelector('.mi')!.innerHTML = ICON.invite;
  $('save-channel').querySelector('.mi')!.innerHTML = ICON.star;
  // A call made from a channel is already saved.
  $('save-channel').hidden = !!channelCall;
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
      blockedNote(`The camera is blocked. ${WHERE_TO_ALLOW}`);
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
  toast(IN_APP ? 'Sharing your screen. Ekanto itself shows as black — open the app you want to show.' : 'Sharing your screen.');
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

/** A clear message around the link: what it is, why (if said), and how long it works. */
function inviteText(): string {
  const why = invite?.reason ? `“${invite.reason}”` : '';
  // A protected link says what makes it one: that line is what gets the app passed around.
  if (invite?.appOnly) return [PROTECTED_INVITE[0], why, PROTECTED_INVITE[1]].filter(Boolean).join('\n');
  const kind = invite?.voice ? 'Join my private voice call on Ekanto' : 'Join my private video call on Ekanto';
  return [`🔒 ${kind}`, why, `Works for ${LINK_HOURS} hours · encrypted · no login`]
    .filter(Boolean).join('\n');
}

async function shareLink(): Promise<void> {
  $('more-sheet').hidden = true;
  const url = link();
  const text = inviteText();
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
  endChannelCall();
  newChannelName = null;
  offer = null;
  asked = null;
  void sharing?.stop();
  sharing = null;
  session?.leave();
  session = null;
  // A note about this call does not belong on the next one.
  $('rec-note').hidden = true;
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
  for (const id of ['sheet', 'more-sheet', 'send-sheet', 'leave-sheet', 'audio-sheet', 'save-sheet', 'ask-sheet']) $(id).hidden = true;
  lastState = null;
  shownPeople = 0;
  history.replaceState(null, '', location.pathname);
  return since ? Date.now() - since : 0;
}

/** Hang up. `who` = the other person hung up first ("Priya hung up."), `since` = when talking began. */
function endCall(who?: string, since?: number | null): void {
  const ms = finish() || (since ? Date.now() - since : 0);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  message('👋', 'Call ended', (who ? `${who.slice(0, 30)} hung up. ` : '')
    + (ms ? `You talked for ${min ? `${min} min ` : ''}${sec} sec. Nothing was saved — the chat and files are gone too.` : 'Nothing was saved.'));
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
  $('safety-shield').hidden = !invite?.appOnly;
  $('sheet').hidden = false;
}

/* ---------- Saved channels: tap to call, and it rings like a phone ---------- */

/** The caller rings for this long, like a phone. */
const RING_FOR_MS = 45 * 1000;
/** Rings repeat every 4 s; nothing heard for this long = the caller gave up (missed call). */
const RING_GAP_MS = 12 * 1000;
/** A "call is on" signal counts for this long (members repeat it every 20 s). */
const LIVE_MS = 50 * 1000;
const TITLE = document.title;

let channels: Channel[] = loadChannels();
/** Calls on now in a channel: channel id → call link, and who said they're in it (and when). */
const liveCalls = new Map<string, { call: string; people: Map<string, number> }>();
/** This call was made or answered from a channel. */
let channelCall: {
  ch: Channel;
  hash: string;
  /** Why this call: rides in every ring, so their phone shows it. */
  reason: string | null;
  caller: boolean;
  connected: boolean;
  started: number;
  ringTimer?: ReturnType<typeof setInterval>;
  liveTimer?: ReturnType<typeof setInterval>;
  stopTone?: () => void;
} | null = null;
/** A ring on screen now. */
let ringingNow: { ch: Channel; ring: Ring; timer: ReturnType<typeof setTimeout>; stopTone?: () => void } | null = null;
/** Calls this phone answered, declined or was busy for: their repeated rings don't ring again. */
const answeredRings = new Set<string>();
const busyRings = new Set<string>();
/** "Save as channel" offered in this call: one secret for everyone who accepts. */
let offer: { secret: string; name: string; saved: boolean; asked: Set<string> } | null = null;
/** The call was started from "New channel" (null = a normal call; '' = name it after who joins). */
let newChannelName: string | null = null;
/** Someone in the call offered a channel; waiting for this phone's answer. */
let asked: { from: Person; secret: string; appOnly: boolean; size: number } | null = null;

const ringing = new Ringing(deviceKey(), IN_APP, onRing);
const myName = () => savedName() || 'Someone';

function storeChannels(list: Channel[]): void {
  channels = list;
  saveChannels(list);
  void syncChannels();
  drawChannels();
}

/** The ring listener — this page's, and in the app the background one — follows the saved list. */
async function syncChannels(): Promise<void> {
  await ringing.setChannels(channels);
  await nativeRing.setChannels(myName(), await ringing.forNative());
}

function isLive(ch: Channel): boolean {
  const live = liveCalls.get(ch.id);
  return !!live && [...live.people.values()].some((at) => Date.now() - at < LIVE_MS);
}

function drawChannels(): void {
  const any = channels.length > 0;
  $('tab-calls').classList.toggle('is-empty', !any);
  $('calls-empty').hidden = any;
  $('channel-list').hidden = !any;
  $('new-channel-fab').hidden = !any;
  $('web-ring-note').hidden = IN_APP || !any;
  $('channel-list').replaceChildren(...channels.map((ch) => channelRow(ch, isLive(ch), { voice: ICON.earpiece, video: ICON.cam }, {
    open: openChannelSheet,
    call: askWhy,
  })));
}

/* Saying why before calling a channel (optional) */

let whyFor: { ch: Channel; voice: boolean } | null = null;

/** Tapped call on a channel: ask why first — unless a call is already on there, then just join it. */
function askWhy(ch: Channel, voiceCall: boolean): void {
  if (session || ch.gone) return;
  if (!savedName()) return openNameSheet(() => askWhy(ch, voiceCall));
  if (isLive(ch)) return void callChannel(ch, voiceCall);
  whyFor = { ch, voice: voiceCall };
  $('callwhy-title').textContent = `Call ${ch.name}`;
  $<HTMLInputElement>('callwhy').value = '';
  for (const b of $('callwhy-picks').querySelectorAll('button')) b.classList.remove('on');
  $('callwhy-go').innerHTML = `${voiceCall ? ICON.earpiece : ICON.cam}<span>${voiceCall ? 'Voice call' : 'Video call'}</span>`;
  $('callwhy-sheet').hidden = false;
}

function callWithWhy(): void {
  const w = whyFor;
  whyFor = null;
  $('callwhy-sheet').hidden = true;
  if (w) void callChannel(w.ch, w.voice, cleanReason($<HTMLInputElement>('callwhy').value));
}

/** Writes "“Dinner plans?”" into a line, or hides it when there is no reason. */
function showWhy(id: string, reason: string | null | undefined): void {
  const clean = cleanReason(reason);
  $(id).textContent = clean ? `“${clean}”` : '';
  $(id).hidden = !clean;
}

async function callChannel(ch: Channel, voiceCall: boolean, reason: string | null = null): Promise<void> {
  if (session || ch.gone) return;
  const name = savedName();
  const live = liveCalls.get(ch.id);
  const joining = live && isLive(ch) ? parseInvite(live.call) : null;
  const next = joining && !expired(joining) ? joining : newInvite(null, ch.appOnly, voiceCall);
  if (next.appOnly && !IN_APP) return toast('Calls with them are protected — call from the Ekanto app.');
  invite = next;
  clearMissed(ch);
  history.replaceState(null, '', `#${inviteToHash(invite)}`);
  await enterCall(name, { ch, caller: next !== joining, joinedLive: next === joining, reason: next === joining ? null : reason }, !voiceCall);
}

function clearMissed(ch: Channel): void {
  if (ch.missed) storeChannels(channels.map((c) => (c.id === ch.id ? { ...c, missed: undefined, missedWhy: undefined } : c)));
}

/** In a channel's call: the caller rings the members; everyone tells them the call is on. */
function startChannelCall(via: ChannelVia): void {
  if (!invite) return;
  const call = inviteToHash(invite);
  const cc: NonNullable<typeof channelCall> = { ch: via.ch, hash: call, reason: cleanReason(via.reason), caller: false, connected: false, started: Date.now() };
  channelCall = cc;
  // The controls were drawn before this call knew its channel: hide "Save as channel" now.
  drawControls();
  ringing.hold(cc.ch.id);
  if (via.caller) startRinging(cc);
  else $('waiting-sub').textContent = 'Connecting… usually under 10 seconds';
  // Joined a call that was on a moment ago, but everyone has gone: ring them instead.
  if (via.joinedLive) {
    setTimeout(() => {
      if (channelCall === cc && !cc.connected && !lastState?.people.length) startRinging(cc);
    }, 10000);
  }
  cc.liveTimer = setInterval(() => {
    if (channelCall === cc && cc.connected) void ringing.send(cc.ch, { t: 'live', call, from: myName() });
  }, 20000);
}

function startRinging(cc: NonNullable<typeof channelCall>): void {
  cc.caller = true;
  cc.started = Date.now();
  $('waiting-title').textContent = `Calling ${cc.ch.name}…`;
  $('waiting-sub').textContent = 'Their phone is ringing.';
  $('status').textContent = 'Ringing…';
  const ringOnce = () => void ringing.send(cc.ch, { t: 'ring', call: cc.hash, from: myName(), v: invite?.voice, ...(cc.reason ? { r: cc.reason } : {}) });
  ringOnce();
  cc.stopTone = startTone('back');
  cc.ringTimer = setInterval(() => {
    if (channelCall !== cc) return clearInterval(cc.ringTimer);
    const answered = lastState?.people.filter((p) => p.connected).length ?? 0;
    // Everyone picked up: stop ringing. In a group, keep ringing the rest until time is up.
    if (answered >= Math.max(1, cc.ch.size - 1)) return clearInterval(cc.ringTimer);
    if (Date.now() - cc.started > RING_FOR_MS) {
      clearInterval(cc.ringTimer);
      if (!cc.connected) {
        finish();
        message('📵', 'No answer', `${cc.ch.name} didn't pick up. Try again in a little while.`);
      }
      return;
    }
    ringOnce();
  }, 4000);
}

function endChannelCall(): void {
  const cc = channelCall;
  if (!cc) return;
  channelCall = null;
  clearInterval(cc.ringTimer);
  clearInterval(cc.liveTimer);
  cc.stopTone?.();
  // Hung up before anyone answered: stop their phones ringing (they see a missed call). Or the last
  // one out: the call is over, so nobody's phone offers to join it any more.
  const over = (cc.caller && !cc.connected) || (cc.connected && !lastState?.people.some((p) => p.connected));
  // Everyone who was in it says "left" too: if two hang up at once, neither knows it was the last.
  const done = Promise.all([
    over ? ringing.send(cc.ch, { t: 'cancel', call: cc.hash, from: myName() }) : null,
    cc.connected ? ringing.send(cc.ch, { t: 'left', call: cc.hash, from: myName() }) : null,
  ]);
  void done.finally(() => ringing.release(cc.ch.id));
}

/** Everything heard on the channels' ring topics. */
function onRing(ch: Channel, ring: Ring): void {
  switch (ring.t) {
    case 'ring':
      return incomingRing(ch, ring);
    case 'cancel':
      if (liveCalls.get(ch.id)?.call === ring.call) liveCalls.delete(ch.id);
      if (ringingNow?.ring.call === ring.call) missedCall();
      // Answered just as they hung up: nobody is coming.
      if (channelCall && channelCall.hash === ring.call && !channelCall.connected && !lastState?.people.length) {
        finish();
        message('📵', 'Call ended', `${ring.from.slice(0, 30)} hung up.`);
      }
      drawChannels();
      return;
    case 'live': {
      if (!ring.call || channelCall?.hash === ring.call) return;
      const known = liveCalls.get(ch.id);
      const live = known?.call === ring.call ? known : { call: ring.call, people: new Map<string, number>() };
      live.people.set(ring.by, Date.now());
      liveCalls.set(ch.id, live);
      drawChannels();
      setTimeout(drawChannels, LIVE_MS + 500);
      return;
    }
    case 'left': {
      const live = liveCalls.get(ch.id);
      if (!live || live.call !== ring.call) return;
      live.people.delete(ring.by);
      if (!live.people.size) liveCalls.delete(ch.id);
      drawChannels();
      return;
    }
    case 'decline':
    case 'busy': {
      if (!channelCall?.caller || channelCall.hash !== ring.call) return;
      const who = ring.from.slice(0, 30);
      if (channelCall.ch.size <= 2 && !channelCall.connected) {
        finish();
        message('📵', ring.t === 'busy' ? `${who} is on another call` : `${who} can't talk right now`, 'Try again in a little while.');
      } else {
        toast(ring.t === 'busy' ? `${who} is on another call.` : `${who} declined.`);
      }
      return;
    }
    case 'gone':
      if (ringingNow?.ch.id === ch.id) endRinging();
      storeChannels(channels.map((c) => (c.id === ch.id ? { ...c, gone: ring.from.slice(0, 30) || 'Someone' } : c)));
      return;
  }
}

function incomingRing(ch: Channel, ring: Ring): void {
  const call = ring.call && parseInvite(ring.call) ? ring.call : null;
  if (ch.gone || !call) return;
  if (answeredRings.has(call)) {
    // Still ringing after "busy": the answer may have been lost on the way, so say it again.
    if (busyRings.has(call)) void ringing.send(ch, { t: 'busy', call, from: myName() });
    return;
  }
  if (session) {
    // Already in this very call.
    if (invite && inviteToHash(invite) === call) return;
    // Both called each other at the same moment: the smaller link wins and the other phone joins it.
    if (channelCall?.caller && channelCall.ch.id === ch.id && !channelCall.connected) {
      if (call < channelCall.hash) {
        const name = savedName();
        const camera = !!stream?.getVideoTracks()[0];
        finish();
        invite = parseInvite(call);
        history.replaceState(null, '', `#${call}`);
        void enterCall(name, { ch, caller: false }, camera);
      }
      return;
    }
    answeredRings.add(call);
    busyRings.add(call);
    const from = ring.from.slice(0, 30);
    toast(`📞 ${from} is calling${ch.name.toLowerCase() === from.toLowerCase() ? '' : ` (${ch.name})`} — you're on a call.`);
    void nativeRing.stop(call, true);
    void ringing.send(ch, { t: 'busy', call, from: myName() });
    return;
  }
  if (ringingNow?.ring.call === call) {
    // The caller repeats the ring every few seconds: keep ringing.
    clearTimeout(ringingNow.timer);
    ringingNow.timer = setTimeout(missedCall, RING_GAP_MS);
    if (!IN_APP) navigator.vibrate?.([400, 300, 400]);
    return;
  }
  if (!ringingNow) showIncoming(ch, ring);
}

function showIncoming(ch: Channel, ring: Ring): void {
  const from = ring.from.slice(0, 30) || ch.name;
  // In the app the notification rings (with the phone's own ringtone); the website rings itself.
  ringingNow = { ch, ring, timer: setTimeout(missedCall, RING_GAP_MS), stopTone: IN_APP ? undefined : startTone('ring') };
  $('in-kind').textContent = ring.v ? 'Voice call' : 'Video call — your camera will turn on';
  $('in-avatar').textContent = initial(from);
  $('in-name').textContent = from;
  $('in-sub').textContent = ch.name.toLowerCase() === from.toLowerCase() ? 'is calling…' : `is calling · ${ch.name}`;
  showWhy('in-why', ring.r);
  $('in-answer').innerHTML = ring.v ? ICON.earpiece : ICON.cam;
  $('in-decline').innerHTML = ICON.end;
  document.title = `📞 ${from} is calling — Ekanto`;
  show('incoming');
  if (!IN_APP) navigator.vibrate?.([400, 300, 400, 300, 400]);
}

function endRinging(): void {
  if (!ringingNow) return;
  clearTimeout(ringingNow.timer);
  ringingNow.stopTone?.();
  ringingNow = null;
  document.title = TITLE;
  if (!session && !$('incoming').hidden) show('home');
}

function missedCall(): void {
  const ch = ringingNow?.ch;
  const why = cleanReason(ringingNow?.ring.r) ?? undefined;
  endRinging();
  // The app's notification turns into "Missed call" by itself.
  if (ch) storeChannels(channels.map((c) => (c.id === ch.id ? { ...c, missed: Date.now(), missedWhy: why } : c)));
}

function answerRing(): void {
  if (!ringingNow?.ring.call) return;
  const { ch, ring } = ringingNow;
  const call = ring.call!;
  answeredRings.add(call);
  endRinging();
  void nativeRing.stop(call, true);
  const chosen = parseInvite(call);
  if (!chosen || session) return;
  invite = chosen;
  history.replaceState(null, '', `#${call}`);
  if (chosen.appOnly && !IN_APP) return show('protected');
  clearMissed(ch);
  // The reason stays in view while it connects.
  void enterCall(savedName(), { ch, caller: false, reason: ring.r });
}

function declineRing(): void {
  if (!ringingNow?.ring.call) return;
  const { ch, ring } = ringingNow;
  answeredRings.add(ring.call!);
  endRinging();
  void nativeRing.stop(ring.call!);
  const no = { t: 'decline' as const, call: ring.call, from: myName() };
  // Twice, a moment apart: a lost "no" would leave them ringing until time runs out.
  void ringing.send(ch, no);
  setTimeout(() => void ringing.send(ch, no), 2000);
}

/** The app was opened from the ring notification: show the call, or answer it at once. */
async function handleLaunch(): Promise<void> {
  const launch = await nativeRing.takeLaunch();
  // While Ekanto was closed: missed calls, and channels the others deleted.
  const missed = new Map((launch.missed ?? []).map((m) => [m.channel, m]));
  const gone = new Map((launch.gone ?? []).map((g) => [g.channel, g.from]));
  if (missed.size || gone.size) {
    storeChannels(channels.map((c) => ({
      ...c,
      ...(missed.has(c.id) && missed.get(c.id)!.at > (c.missed ?? 0)
        ? { missed: missed.get(c.id)!.at, missedWhy: cleanReason(missed.get(c.id)!.why) ?? undefined }
        : {}),
      gone: gone.has(c.id) ? String(gone.get(c.id)).slice(0, 30) || 'Someone' : c.gone,
    })));
  }
  const ch = channels.find((c) => c.id === launch.channel);
  if (!launch.action || !launch.call || !ch || session) return;
  const ring: Ring = { t: 'ring', call: launch.call, from: launch.from || ch.name, by: '', ts: Date.now(), v: launch.voice, r: cleanReason(launch.why) ?? undefined };
  if (ringingNow?.ring.call !== launch.call) {
    endRinging();
    showIncoming(ch, ring);
  }
  if (launch.action === 'answer') answerRing();
}

/* Saving a call as a channel: the secret goes phone to phone inside the call, never in a link. */

function openSaveSheet(): void {
  $('more-sheet').hidden = true;
  const others = (lastState?.people ?? []).filter((p) => p.connected && p.channelOpen);
  if (!others.length) return toast('You can save them once someone has joined.');
  $<HTMLInputElement>('save-name').value = listNames(others.map((p) => p.name));
  $('save-sheet').hidden = false;
}

function offerChannel(name: string, people: Person[]): void {
  if (!invite || !session) return;
  offer ??= { secret: newChannelSecret(), name, saved: false, asked: new Set() };
  offer.name = name;
  const message = JSON.stringify({ k: 'chan', cs: offer.secret, app: invite.appOnly, size: (lastState?.people.length ?? 0) + 1 });
  for (const p of people) {
    if (!offer.asked.has(p.id) && session.sendTo(p.id, message)) offer.asked.add(p.id);
  }
}

async function keepChannel(secret: string, name: string, appOnly: boolean, size: number): Promise<void> {
  const members = (lastState?.people ?? []).filter((p) => p.connected).map((p) => p.name);
  const id = await channelId(secret);
  const existing = channels.find((c) => c.id === id);
  storeChannels(upsertChannel(channels, {
    id, secret, name: name.slice(0, 30) || listNames(members) || 'Channel', appOnly,
    size: Math.min(20, Math.max(2, size)), members, created: existing?.created ?? Date.now(),
  }));
}

function onControl(from: Person, m: Record<string, unknown>): void {
  const rec = parseRecording(m);
  if (rec !== null) {
    // Only a protected call promises this; in any other call the signal means nothing.
    if (rec && invite?.appOnly) recordingNote(recordingNotice(from.name));
    return;
  }
  if (m.k === 'chan') {
    if (typeof m.cs !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.cs)) return;
    asked = { from, secret: m.cs, appOnly: m.app === true, size: Number(m.size) || 2 };
    $('ask-title').textContent = `Save ${from.name}?`;
    $('ask-sub').textContent = `Save ${from.name} so you can call each other with one tap?`;
    $<HTMLInputElement>('ask-name').value = listNames((lastState?.people ?? []).map((p) => p.name));
    $('ask-sheet').hidden = false;
    return;
  }
  if (!offer) return;
  if (m.k === 'chan-ok') {
    if (!offer.saved) {
      offer.saved = true;
      void keepChannel(offer.secret, offer.name, invite?.appOnly ?? false, (lastState?.people.length ?? 1) + 1);
      toast(`⭐ Saved “${offer.name}”. ${from.name} saved it too.`);
    } else {
      toast(`${from.name} saved it too.`);
    }
  } else if (m.k === 'chan-no') {
    toast(`${from.name} didn't save it.`);
  }
}

/* One channel: rename, delete */

let sheetChannel: Channel | null = null;

function openChannelSheet(ch: Channel): void {
  sheetChannel = ch;
  $('ch-title').textContent = ch.name;
  const who = ch.members.length ? `You and ${listNames(ch.members)}` : 'Saved';
  $('ch-info').textContent = ch.gone
    ? `${ch.gone} removed you, so calls are off. Remove them here too.`
    : `${who}${ch.appOnly ? ' · protected' : ''}. Only your phones know its key.${IN_APP ? '' : ' On the website it rings only while Ekanto is open.'}`;
  $<HTMLInputElement>('ch-name').value = ch.name;
  $('ch-name').closest('.field')!.toggleAttribute('hidden', !!ch.gone);
  $('ch-delete').textContent = 'Remove this person';
  delete $('ch-delete').dataset['armed'];
  $('ch-sheet').hidden = false;
}

function deleteChannel(): void {
  const ch = sheetChannel;
  if (!ch) return;
  const btn = $('ch-delete');
  // Two taps, so a channel is never deleted by accident.
  if (!btn.dataset['armed']) {
    btn.dataset['armed'] = '1';
    btn.textContent = `Tap again to remove “${ch.name}”`;
    return;
  }
  $('ch-sheet').hidden = true;
  sheetChannel = null;
  // Tell the others (if their phone is on), then forget it here.
  const told = ch.gone ? Promise.resolve() : ringing.send(ch, { t: 'gone', from: myName() });
  void told.finally(() => storeChannels(channels.filter((c) => c.id !== ch.id)));
  toast(`Removed “${ch.name}”.`);
}

/* App: what Android needs so a closed Ekanto still rings */

const RING_ROWS: { which: RingSetting; title: string; why: string }[] = [
  { which: 'notifications', title: 'Notifications', why: 'To show who is calling' },
  { which: 'fullScreen', title: 'Full-screen calls', why: 'To ring on the lock screen' },
  { which: 'battery', title: 'No battery limit', why: "So Android doesn't put Ekanto to sleep" },
  { which: 'exactAlarms', title: 'Exact alarms', why: 'So a sleeping phone still rings' },
  { which: 'autostart', title: 'Autostart', why: 'So this phone lets Ekanto wake up' },
];

async function drawRingSetup(auto = false): Promise<void> {
  if (!IN_APP) return;
  const health = await nativeRing.health().catch(() => null);
  if (!health) return;
  const missing = !health.ready;
  const problems = new Map(health.problems.map((p) => [p.code, p]));
  // One quiet line on the Calls tab: green when it can ring, amber with "fix" when it may not.
  const line = $('ring-health');
  line.hidden = !channels.length;
  line.className = `ring-health ${missing ? 'warn' : 'ok'}`;
  line.textContent = missing ? 'May miss calls — fix' : 'Ready to ring';
  $('ringing-row').hidden = false;
  $('ringing-state').textContent = missing ? 'May miss calls ›' : '✓ Ready';
  $('ringing-state').className = missing ? 'warn-text' : 'ok';
  // Shown by itself once, the first time a channel is saved; after that from the Calls line or Settings.
  if (auto && missing && channels.length) {
    try {
      if (!localStorage.getItem('hush.ringAsked')) {
        localStorage.setItem('hush.ringAsked', '1');
        $('ring-sheet').hidden = false;
      }
    } catch {
      // Not remembered: the amber line stays.
    }
  }
  // Autostart is only a row on phones that have the switch (Xiaomi, Oppo, …).
  const rows = RING_ROWS.filter((r) => r.which !== 'autostart' || health.maker);
  $('ring-list').replaceChildren(...rows.map((r) => {
    const problem = problems.get(r.which);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `menu-item${problem ? '' : ' on'}`;
    b.disabled = !problem;
    b.innerHTML = `<span class="mi">${problem ? '⚠️' : '✅'}</span>`;
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = problem ? problem.title : r.title;
    // Wrong: say what is wrong and which switch fixes it. Fine: say why it matters.
    text.append(strong, document.createElement('br'), r.which === 'autostart' && problem && !health.autostartKnown
      ? `${health.maker} hides this switch: Settings → Apps → Ekanto → Autostart`
      : problem ? `Turn on: ${r.title}` : r.why);
    b.append(text);
    if (problem) {
      const fix = document.createElement('small');
      fix.className = 'ring-fix';
      fix.textContent = problem.fix;
      b.append(fix);
    }
    b.addEventListener('click', () => void nativeRing.allow(r.which).then(() => drawRingSetup()).catch(() => undefined));
    return b;
  }));
  $('ring-hint').hidden = !health.maker || !problems.has('autostart');
}

/** "Test ring": in a minute the phone rings by itself, so they can lock it and see it work. */
function startTestRing(): void {
  nativeRing.test(60000).then(() => {
    $('ring-sheet').hidden = true;
    toast('Lock your phone. It rings in 1 minute.');
  }).catch(() => toast("Couldn't start the test ring."));
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

/* ---------- Sound: remove background noise (applied to a live mic at once) ---------- */

function addNoiseToggle(): void {
  const box = $('noise') as HTMLInputElement;
  box.checked = noiseOn();
  box.addEventListener('change', () => {
    try {
      localStorage.setItem(NOISE_KEY, box.checked ? '1' : '0');
    } catch {
      // Not remembered, still applied to this call.
    }
    stream?.getAudioTracks()[0]?.applyConstraints(micCleanup(box.checked)).catch(() => {});
  });
}

/** "Use less data": calls start with a small picture (the low-data chip in the call restores). */
function addLowDataToggle(): void {
  const box = $('lowdata') as HTMLInputElement;
  box.checked = lowDataOn();
  box.addEventListener('change', () => {
    try {
      localStorage.setItem(LOWDATA_KEY, box.checked ? '1' : '0');
    } catch {
      // Not remembered, still applied to this call.
    }
    session?.setLowData(box.checked ? 'low' : 'normal', true);
  });
}

function addHideIpToggles(): void {
  if (!HAS_TURN) return;
  for (const before of ['join-btn', 'newch-start']) {
    const label = document.createElement('label');
    label.className = 'toggle hide-ip';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'switch';
    const text = document.createElement('span');
    text.innerHTML = '<strong>Hide where I am (IP address)</strong><br>Sends the call through a middle computer, so the other side can\'t see your city. A bit slower.';
    label.append(box, text);
    // On the Join screen the switch hides under "More options": first-timers only need Join.
    const more = before === 'join-btn' ? $('join-more') : null;
    if (more) {
      more.append(label);
      more.hidden = false;
    } else $(before).before(label);
  }
  $('hide-ip-row').hidden = false;
  $('options-hide-ip').hidden = false;
  for (const box of document.querySelectorAll<HTMLInputElement>('.hide-ip input')) {
    box.checked = hideIp();
    box.addEventListener('change', () => {
      try {
        localStorage.setItem(HIDE_KEY, box.checked ? '1' : '0');
      } catch {
        // Not remembered, still applied to this call.
      }
      document.querySelectorAll<HTMLInputElement>('.hide-ip input').forEach((b) => (b.checked = box.checked));
      drawOptions();
    });
  }
}

/* ---------- Wiring ---------- */

for (const b of $('kinds').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => setKind(b.dataset['kind'] === 'voice'));
}
for (const b of $('sizes').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    $<HTMLInputElement>('size-custom').value = '';
    setSize(b.dataset['n'] ? Number(b.dataset['n']) : null);
  });
}
/** Typed above the most a call can hold: show the most at once, and say why (not a silent change). */
function capPeople(input: HTMLInputElement): void {
  if (Math.round(Number(input.value)) <= MAX_PEOPLE) return;
  input.value = String(MAX_PEOPLE);
  toast(`${MAX_PEOPLE} is the most. With no server, every phone sends video to every other — more can't keep up.`);
}

$('size-custom').addEventListener('input', () => {
  const input = $<HTMLInputElement>('size-custom');
  capPeople(input);
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
addNoiseToggle();
addLowDataToggle();

// Protected calls are created in the app; the website points people to the app instead.
$('protect-row').hidden = !IN_APP;
$('newch-protect-row').hidden = !IN_APP;
$('protect').addEventListener('change', drawOptions);
drawOptions();
$('options-btn').addEventListener('click', () => ($('options-sheet').hidden = false));
$('options-done').addEventListener('click', () => ($('options-sheet').hidden = true));
for (const b of $('tabbar').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => setTab(b.dataset['tab'] as Tab));
}
$('go-link').addEventListener('click', () => setTab('link'));
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('drawer-shade').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});
// Turning a computer window narrow (or a tablet around) moves Settings back into its tab.
wide.addEventListener('change', () => {
  const tab = $('home').dataset['tab'] as Tab;
  if (wide.matches && tab === 'settings') {
    setTab('calls');
    openSettings();
  } else if (!wide.matches && $('home').classList.contains('drawer-open')) {
    closeSettings();
    setTab('settings');
  } else {
    setTab(tab);
  }
});
$('me-btn').addEventListener('click', () => openNameSheet());
$('name-row').addEventListener('click', () => openNameSheet());
$('name-save').addEventListener('click', saveNameSheet);
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveNameSheet();
});
$('name-cancel').addEventListener('click', () => {
  afterName = null;
  $('name-sheet').hidden = true;
});
$('privacy-btn').addEventListener('click', () => ($('privacy-sheet').hidden = false));
$('privacy-close').addEventListener('click', () => ($('privacy-sheet').hidden = true));
$('paste-btn').addEventListener('click', () => {
  $('paste-sheet').hidden = false;
  $('paste-input').focus();
});
$('paste-cancel').addEventListener('click', () => ($('paste-sheet').hidden = true));
$('ringing-row').addEventListener('click', () => {
  $('ring-sheet').hidden = false;
  void drawRingSetup();
});
for (const el of document.querySelectorAll<HTMLElement>('.web-only')) el.hidden = IN_APP;
setTab('calls');
drawMe();
if (!IN_APP && APP_DOWNLOAD_URL) {
  for (const id of ['get-app', 'get-app-row', 'get-app-card', 'download-app']) {
    $<HTMLAnchorElement>(id).href = APP_DOWNLOAD_URL;
    $(id).hidden = false;
  }
}
$('open-app').addEventListener('click', () => {
  if (invite) location.href = `${APP_SCHEME}://join#${inviteToHash(invite)}`;
});
$('copy-protected').addEventListener('click', () => void copyLink());

$('create').addEventListener('click', () => withName(() => {
  newChannelName = null;
  startNew();
}));
$('again').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  setTab('link');
  show('home');
});
$('home-btn').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  setTab('calls');
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
  if (!parsed) return toast("That doesn't look like an Ekanto call link.");
  $('paste-sheet').hidden = true;
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
  if (t) session?.setMic(t.enabled);
  drawControls();
});
$('lowdata-chip').addEventListener('click', () => {
  session?.setLowData('normal', true);
  // "Tap for normal" also turns the setting off, or the next call would start low again by surprise.
  const box = $('lowdata') as HTMLInputElement;
  if (box.checked) {
    box.checked = false;
    try {
      localStorage.setItem(LOWDATA_KEY, '0');
    } catch {
      // Not remembered; this call is normal anyway.
    }
  }
});
$('cam').addEventListener('click', () => void toggleCamera());
$('end').addEventListener('click', () => endCall());
$('more').addEventListener('click', () => ($('more-sheet').hidden = false));
$('more-close').addEventListener('click', () => ($('more-sheet').hidden = true));
$('flip').addEventListener('click', () => {
  $('more-sheet').hidden = true;
  void flipCamera();
});
$('screen').addEventListener('click', () => void toggleScreen());
$('audio-btn').addEventListener('click', () => {
  if (!IN_APP && webOutputs.length < 2) return toast("Use your phone's volume buttons.");
  drawAudioSheet();
  $('audio-sheet').hidden = false;
});
$('audio-close').addEventListener('click', () => ($('audio-sheet').hidden = true));
$('blocked-close').addEventListener('click', () => ($('blocked').hidden = true));
$('rec-close').addEventListener('click', () => ($('rec-note').hidden = true));
$('safety-shield').textContent = `${PROTECTED_PROMISE} ${PROTECTED_LIMIT}`;
$('join-shield').textContent = PROTECTED_PROMISE;
void nativeProtect.onRecording(onRecording);
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
for (const id of ['sheet', 'more-sheet', 'send-sheet', 'audio-sheet', 'leave-sheet', 'save-sheet', 'ask-sheet', 'newch-sheet', 'ch-sheet', 'ring-sheet', 'callwhy-sheet', ...HOME_SHEETS]) {
  $(id).addEventListener('click', (e) => {
    if (e.target !== $(id)) return;
    $(id).hidden = true;
    if (id === 'name-sheet') afterName = null;
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

// Saved channels
/** Who can be in a new channel: the call that saves it lets in only this many, so nobody extra gets it. */
let newChannelSize: number | null = null;
function setChannelSize(n: number | null): void {
  newChannelSize = n;
  const custom = $<HTMLInputElement>('newch-custom');
  for (const b of $('newch-sizes').querySelectorAll<HTMLButtonElement>('button')) {
    const on = (b.dataset['n'] ? Number(b.dataset['n']) : null) === n && custom.value === '';
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  custom.classList.toggle('on', custom.value !== '');
  $('newch-note').textContent = n === 2
    ? 'Just the two of you. Nobody else can join and get it.'
    : n ? `Up to ${n} people, including you. Nobody else can join and get it.${n > SMOOTH_PEOPLE ? ` Above ${SMOOTH_PEOPLE}, video may lag on phones.` : ''}`
      : 'Anyone you send the link to can join and get it.';
}
for (const b of $('newch-sizes').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    $<HTMLInputElement>('newch-custom').value = '';
    setChannelSize(b.dataset['n'] ? Number(b.dataset['n']) : null);
  });
}
// Your own number, 2–20 — the same as the home screen's "#".
$('newch-custom').addEventListener('input', () => {
  const input = $<HTMLInputElement>('newch-custom');
  capPeople(input);
  const n = Math.round(Number(input.value));
  if (input.value === '') return setChannelSize(null);
  setChannelSize(Number.isFinite(n) ? Math.min(MAX_PEOPLE, Math.max(MIN_PEOPLE, n)) : null);
});
$('newch-custom').addEventListener('change', () => {
  const input = $<HTMLInputElement>('newch-custom');
  if (input.value !== '' && newChannelSize !== null) input.value = String(newChannelSize);
});
for (const id of ['new-channel', 'new-channel-fab']) {
  $(id).addEventListener('click', () => withName(() => {
    $<HTMLInputElement>('newch-name').value = '';
    $<HTMLInputElement>('newch-custom').value = '';
    $<HTMLInputElement>('newch-protect').checked = false;
    setChannelSize(null);
    $('newch-sheet').hidden = false;
    $('newch-name').focus();
  }));
}
$('newch-cancel').addEventListener('click', () => ($('newch-sheet').hidden = true));
$('newch-start').addEventListener('click', () => {
  $('newch-sheet').hidden = true;
  newChannelName = $<HTMLInputElement>('newch-name').value.trim().slice(0, 30);
  startNew(newChannelSize, IN_APP && $<HTMLInputElement>('newch-protect').checked, null);
});
$('ch-done').addEventListener('click', () => {
  const name = $<HTMLInputElement>('ch-name').value.trim().slice(0, 30);
  const ch = sheetChannel;
  $('ch-sheet').hidden = true;
  if (ch && name && name !== ch.name) storeChannels(channels.map((c) => (c.id === ch.id ? { ...c, name } : c)));
});
$('ch-delete').addEventListener('click', deleteChannel);
$('ring-health').addEventListener('click', () => {
  $('ring-sheet').hidden = false;
  void drawRingSetup();
});
$('ring-test').addEventListener('click', startTestRing);
$('ring-close').addEventListener('click', () => ($('ring-sheet').hidden = true));
$('save-channel').addEventListener('click', openSaveSheet);
$('save-no').addEventListener('click', () => ($('save-sheet').hidden = true));
$('save-yes').addEventListener('click', () => {
  $('save-sheet').hidden = true;
  const people = (lastState?.people ?? []).filter((p) => p.connected && p.channelOpen);
  const name = $<HTMLInputElement>('save-name').value.trim().slice(0, 30) || listNames(people.map((p) => p.name));
  offerChannel(name, people);
  toast(`Asked ${listNames(people.map((p) => p.name))} to save it too…`);
});
$('ask-yes').addEventListener('click', () => {
  const a = asked;
  asked = null;
  $('ask-sheet').hidden = true;
  if (!a) return;
  const name = $<HTMLInputElement>('ask-name').value.trim().slice(0, 30);
  void keepChannel(a.secret, name, a.appOnly, a.size);
  session?.sendTo(a.from.id, '{"k":"chan-ok"}');
  toast(`⭐ Saved${name ? ` “${name}”` : ''}. Tap it on the home screen to call.`);
});
$('ask-no').addEventListener('click', () => {
  const a = asked;
  asked = null;
  $('ask-sheet').hidden = true;
  if (a) session?.sendTo(a.from.id, '{"k":"chan-no"}');
});
$('in-answer').addEventListener('click', answerRing);
$('callwhy-go').addEventListener('click', callWithWhy);
$('callwhy-cancel').addEventListener('click', () => ($('callwhy-sheet').hidden = true));
$('callwhy').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') callWithWhy();
});
for (const b of $('callwhy-picks').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    $<HTMLInputElement>('callwhy').value = b.textContent ?? '';
    for (const o of $('callwhy-picks').querySelectorAll('button')) o.classList.toggle('on', o === b);
  });
}
$('in-decline').addEventListener('click', declineRing);
drawChannels();
void syncChannels();

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
  void nativeRing.onData((topic, data) => ringing.feed(topic, data));
  void nativeRing.onLaunch(() => void handleLaunch());
  void handleLaunch();
  // Back from Android's settings: show what is allowed now.
  void NativeApp.addListener('resume', () => void drawRingSetup());
  void NativeApp.getLaunchUrl().then((r) => openFromOutside(r?.url));
  void NativeApp.addListener('backButton', () => {
    // Back closes whatever is open on top; in the call itself it keeps the call going in the
    // background (it never hangs up by accident).
    if (!$('viewer').hidden) return panel?.hideViewer();
    for (const id of ['send-sheet', 'more-sheet', 'audio-sheet', 'sheet', 'save-sheet', 'ask-sheet', 'newch-sheet', 'ch-sheet', 'ring-sheet', 'callwhy-sheet', ...HOME_SHEETS]) {
      if (!$(id).hidden) return void ($(id).hidden = true);
    }
    // A ringing call keeps ringing (in the notification) — Back never declines by accident.
    if (!$('incoming').hidden) return void NativeApp.minimizeApp();
    if (!$('chat').hidden) return panel?.closePanel();
    // In a call, Back never hangs up: a video call floats in a small window, a voice call keeps
    // going in the background (the notification brings it back).
    if (session) {
      void nativeFloat.enter().then((floated) => {
        if (!floated) void NativeApp.minimizeApp();
      });
      return;
    }
    if (!$('home').hidden) {
      // Back from Link or Settings goes to Calls first, like a phone app.
      if ($('home').dataset['tab'] !== 'calls') return setTab('calls');
      return void NativeApp.exitApp();
    }
    show('home');
  });
}

route();
