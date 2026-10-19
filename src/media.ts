export type Facing = 'user' | 'environment';

export class MediaProblem extends Error {}

const VIDEO = (facing: Facing): MediaTrackConstraints => ({
  facingMode: facing,
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
});
const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/**
 * Microphone, plus the camera for a video call. A voice call never touches the camera, so its
 * light stays off. A video call falls back to voice only when there is no usable camera.
 */
export async function openCamera(facing: Facing = 'user', video = true): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MediaProblem('This browser cannot make calls. Open the link in Chrome or Safari.');
  }
  if (!video) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    } catch (e) {
      const name = (e as DOMException)?.name;
      throw new MediaProblem(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'The microphone is blocked. Allow it for this site in your browser settings, then try again.'
        : 'No microphone was found, or another app is using it.');
    }
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: VIDEO(facing), audio: AUDIO });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MediaProblem('Camera and microphone are blocked. Allow them for this site in your browser settings, then try again.');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    } catch {
      throw new MediaProblem('No camera or microphone was found, or another app is using them.');
    }
  }
}

/** A fresh video track from the other camera, for flipping front/back mid-call. */
export async function cameraTrack(facing: Facing): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO(facing) });
  return stream.getVideoTracks()[0];
}

/** Phone browsers can't share their screen at all; computers and the Ekanto app can. */
export function canShareScreenInBrowser(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** The screen (a window, a tab or the whole screen — the browser asks which). */
export async function screenTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
  const track = stream.getVideoTracks()[0];
  // Text on a shared screen should stay sharp rather than smooth.
  track.contentHint = 'detail';
  return track;
}
