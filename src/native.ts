import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { NativeChannel } from './ringing';

/** The Android side of Ekanto (android/app/src/main/java/app/hush/call). */
interface HushNative {
  /** Keeps the call alive (mic, camera) while you use other apps; shows "Ekanto call in progress". */
  startCall(options: { voice: boolean }): Promise<void>;
  endCall(): Promise<void>;
  /** Asks Android for screen-capture permission, then streams the screen as frames. */
  startScreen(): Promise<void>;
  stopScreen(): Promise<void>;
  addListener(event: 'frame', fn: (f: { data: string; width: number; height: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'screenStopped', fn: () => void): Promise<PluginListenerHandle>;
  getAudioRoutes(): Promise<AudioRoutes>;
  setAudioRoute(options: { route: AudioRoute }): Promise<AudioRoutes>;
  setVoiceCall(options: { voice: boolean }): Promise<void>;
  addListener(event: 'audioRoutes', fn: (r: AudioRoutes) => void): Promise<PluginListenerHandle>;
  setFloating(options: { allowed: boolean }): Promise<void>;
  enterFloating(): Promise<{ floating: boolean }>;
  addListener(event: 'floating', fn: (e: { floating: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'hangUp', fn: () => void): Promise<PluginListenerHandle>;
  /** Saved channels for the background listener that rings the phone while Ekanto is closed. */
  setChannels(options: { name: string; channels: NativeChannel[] }): Promise<void>;
  ringStatus(): Promise<RingStatus>;
  ringSetting(options: { which: RingSetting }): Promise<RingStatus>;
  /** "Can Ekanto ring right now?" — every reason it may not, each with its fix. */
  ringHealth(): Promise<RingHealth>;
  /** Rings this phone in about a minute from the background listener, no relay: lock it and watch. */
  testRing(options: { delayMs: number }): Promise<void>;
  /** The ring was answered or declined inside the app: stop the ringing notification. */
  stopRinging(options: { call: string; keepOverLock: boolean }): Promise<void>;
  /** What the app was opened for: an incoming call's screen, or "Answer" in the notification. */
  takeLaunch(): Promise<Launch>;
  addListener(event: 'ringData', fn: (e: { topic: string; data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'launch', fn: () => void): Promise<PluginListenerHandle>;
}

/** Each is true once allowed. */
export interface RingStatus {
  notifications: boolean;
  fullScreen: boolean;
  battery: boolean;
  /** Android 12+: "Alarms & reminders", so a sleeping phone still wakes for a call. */
  exactAlarms: boolean;
}
export type RingSetting = 'notifications' | 'fullScreen' | 'battery' | 'exactAlarms' | 'autostart';
export interface RingProblem {
  code: RingSetting;
  title: string;
  /** The button's word: "Allow", "Open" or "Settings". */
  fix: string;
}
export interface RingHealth {
  ready: boolean;
  problems: RingProblem[];
  /** Xiaomi, Oppo, …: a maker with an Autostart switch Android cannot read; null for the rest. */
  maker: string | null;
  /** True when its Autostart page was found on this phone. */
  autostartKnown: boolean;
}

export interface Launch {
  action?: 'incoming' | 'answer';
  call?: string;
  channel?: string;
  from?: string;
  voice?: boolean;
  /** Why they are calling, if they said. */
  why?: string;
  /** Heard while the page wasn't running. */
  missed?: { channel: string; at: number; why?: string }[];
  gone?: { channel: string; from: string }[];
}

export type AudioRoute = 'speaker' | 'earpiece' | 'bluetooth' | 'wired';
export interface AudioRoutes {
  routes: AudioRoute[];
  current: AudioRoute;
}

export const IN_APP = Capacitor.isNativePlatform();
const plugin = registerPlugin<HushNative>('HushNative');

export const nativeCall = {
  /** Voice calls start on the earpiece, video calls on the speaker (headsets always win). */
  start: (voice: boolean) => (IN_APP ? plugin.startCall({ voice }).catch(() => undefined) : Promise.resolve()),
  end: () => (IN_APP ? plugin.endCall().catch(() => undefined) : Promise.resolve()),
};

/** Where the call's sound comes out, in the app. */
export const nativeAudio = {
  routes: () => plugin.getAudioRoutes(),
  set: (route: AudioRoute) => plugin.setAudioRoute({ route }),
  setVoice: (voice: boolean) => (IN_APP ? plugin.setVoiceCall({ voice }).catch(() => undefined) : Promise.resolve()),
  onChange: (fn: (r: AudioRoutes) => void) => plugin.addListener('audioRoutes', fn),
};

/**
 * The app's screen share. Android hands over screen frames; they are painted onto a canvas whose
 * video stream goes into the call exactly like a camera would. Frames never leave the phone
 * except inside the encrypted call.
 */
export async function nativeScreenTrack(onStopped: () => void): Promise<{ track: MediaStreamTrack; stop: () => Promise<void> }> {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d')!;
  let busy = false;
  const frames = await plugin.addListener('frame', ({ data, width, height }) => {
    // Drop a frame rather than queue them up: the newest picture is the only one that matters.
    if (busy) return;
    busy = true;
    const img = new Image();
    img.onload = () => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(img, 0, 0);
      busy = false;
    };
    img.onerror = () => (busy = false);
    img.src = `data:image/jpeg;base64,${data}`;
  });
  const stopped = await plugin.addListener('screenStopped', () => onStopped());
  try {
    await plugin.startScreen();
  } catch (e) {
    await frames.remove();
    await stopped.remove();
    throw e;
  }
  const track = canvas.captureStream(10).getVideoTracks()[0];
  track.contentHint = 'detail';
  return {
    track,
    stop: async () => {
      track.stop();
      await frames.remove();
      await stopped.remove();
      await plugin.stopScreen().catch(() => undefined);
    },
  };
}

/** The app's floating video window (Android picture-in-picture) and the notification's Hang up. */
export const nativeFloat = {
  allow: (allowed: boolean) => (IN_APP ? plugin.setFloating({ allowed }).catch(() => undefined) : Promise.resolve()),
  enter: () => plugin.enterFloating().then((r) => r.floating).catch(() => false),
  onChange: (fn: (floating: boolean) => void) => plugin.addListener('floating', (e) => fn(e.floating)),
  onHangUp: (fn: () => void) => plugin.addListener('hangUp', fn),
};

/** Ringing while Ekanto is closed (Android): a quiet background listener, and the call screen. */
export const nativeRing = {
  setChannels: (name: string, channels: NativeChannel[]) => (IN_APP ? plugin.setChannels({ name, channels }).catch(() => undefined) : Promise.resolve()),
  status: () => plugin.ringStatus(),
  health: () => plugin.ringHealth(),
  allow: (which: RingSetting) => plugin.ringSetting({ which }),
  test: (delayMs = 60000) => plugin.testRing({ delayMs }),
  /** keepOverLock: answered, so the call may stay over the lock screen. */
  stop: (call: string, keepOverLock = false) => (IN_APP ? plugin.stopRinging({ call, keepOverLock }).catch(() => undefined) : Promise.resolve()),
  takeLaunch: () => plugin.takeLaunch().catch(() => ({}) as Launch),
  onData: (fn: (topic: string, data: string) => void) => plugin.addListener('ringData', (e) => fn(e.topic, e.data)),
  onLaunch: (fn: () => void) => plugin.addListener('launch', fn),
};
