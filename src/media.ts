export type Facing = 'user' | 'environment';

export class MediaProblem extends Error {}

const VIDEO = (facing: Facing): MediaTrackConstraints => ({
  facingMode: facing,
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
});
const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** Camera + microphone; falls back to voice only when there is no usable camera. */
export async function openCamera(facing: Facing = 'user'): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MediaProblem('This browser cannot make video calls. Open the link in Chrome or Safari.');
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
