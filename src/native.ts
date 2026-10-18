import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** The Android side of Hush (android/app/src/main/java/app/hush/call). */
interface HushNative {
  /** Keeps the call alive (mic, camera) while you use other apps; shows "Hush call in progress". */
  startCall(): Promise<void>;
  endCall(): Promise<void>;
  /** Asks Android for screen-capture permission, then streams the screen as frames. */
  startScreen(): Promise<void>;
  stopScreen(): Promise<void>;
  addListener(event: 'frame', fn: (f: { data: string; width: number; height: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'screenStopped', fn: () => void): Promise<PluginListenerHandle>;
}

export const IN_APP = Capacitor.isNativePlatform();
const plugin = registerPlugin<HushNative>('HushNative');

export const nativeCall = {
  start: () => (IN_APP ? plugin.startCall().catch(() => undefined) : Promise.resolve()),
  end: () => (IN_APP ? plugin.endCall().catch(() => undefined) : Promise.resolve()),
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
