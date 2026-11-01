import type { FileMeta } from './channels';

/*
 * Getting a file ready to send. The file itself is never changed — no squeezing, no resizing: the
 * exact original goes. All that is made here is what rides in the message: a tiny blurred preview
 * (a few hundred bytes), the size of a picture and the length of a video or voice note.
 */

const THUMB = 40;

/** What the message says about a file. */
export async function describe(file: Blob, name: string, extra: Partial<FileMeta> = {}): Promise<FileMeta> {
  const m = (file.type || guessType(name)).toLowerCase();
  const meta: FileMeta = { n: name.slice(0, 120) || 'file', z: file.size, m, ...extra };
  if (m === 'image/gif') meta.g = true;
  try {
    if (m.startsWith('image/')) Object.assign(meta, await ofImage(file));
    else if (m.startsWith('video/')) Object.assign(meta, await ofVideo(file));
    else if (m.startsWith('audio/') && !meta.d) Object.assign(meta, await ofAudio(file));
  } catch {
    // A picture this browser can't open (HEIC on a computer, say) still goes, just without a preview.
  }
  return meta;
}

/** Only kinds Ekanto can show itself can be "view only". */
export function viewable(mime: string): boolean {
  return /^(image\/(jpeg|png|gif|webp|bmp|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/|text\/plain$|application\/pdf$)/.test(mime);
}

export function kindOf(meta: Pick<FileMeta, 'm' | 'vo' | 'g'>): 'voice' | 'gif' | 'image' | 'video' | 'audio' | 'file' {
  if (meta.vo) return 'voice';
  if (meta.g) return 'gif';
  if (meta.m.startsWith('image/')) return 'image';
  if (meta.m.startsWith('video/')) return 'video';
  if (meta.m.startsWith('audio/')) return 'audio';
  return 'file';
}

async function ofImage(file: Blob): Promise<Partial<FileMeta>> {
  const bitmap = await createImageBitmap(file);
  const out = { w: bitmap.width, h: bitmap.height, th: thumb(bitmap, bitmap.width, bitmap.height) };
  bitmap.close();
  return out;
}

function ofVideo(file: Blob): Promise<Partial<FileMeta>> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const timer = setTimeout(() => finish(null), 5000);
    const finish = (out: Partial<FileMeta> | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      if (out) resolve(out);
      else reject(new Error('no preview'));
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
    };
    video.onseeked = () => {
      const d = Number.isFinite(video.duration) ? video.duration : undefined;
      finish({ w: video.videoWidth, h: video.videoHeight, ...(d ? { d } : {}), th: thumb(video, video.videoWidth, video.videoHeight) });
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function ofAudio(file: Blob): Promise<Partial<FileMeta>> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (d?: number) => {
      URL.revokeObjectURL(url);
      resolve(d && Number.isFinite(d) ? { d } : {});
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done();
    setTimeout(() => done(), 4000);
    audio.src = url;
  });
}

/** A 40-pixel picture: blurred on screen, it shows what is coming before it arrives. */
function thumb(source: CanvasImageSource, w: number, h: number): string | undefined {
  if (!w || !h) return undefined;
  const scale = THUMB / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.5);
  return url.startsWith('data:image/jpeg') ? url : undefined;
}

/** Phones sometimes hand over a file with no type; the name tells most of them. */
function guessType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/ogg',
    pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip', apk: 'application/vnd.android.package-archive',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
  };
  return known[ext] ?? 'application/octet-stream';
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Voice messages ---------- */

const VOICE_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
/** A voice message stops by itself after 15 minutes. */
export const MAX_VOICE_MS = 15 * 60 * 1000;

export class VoiceRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private parts: Blob[] = [];
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private samples: number[] = [];
  private sampler?: ReturnType<typeof setInterval>;
  private started = 0;
  /** 0..1, for the live bar while recording. */
  level = 0;

  async start(onLevel: (level: number, ms: number) => void, onLimit: () => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const type = VOICE_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 48000 });
    this.recorder.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.recorder.start(1000);
    this.started = Date.now();
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    const data = new Uint8Array(this.analyser.fftSize);
    this.sampler = setInterval(() => {
      this.analyser!.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      this.level = Math.min(1, peak / 64);
      this.samples.push(this.level);
      const ms = Date.now() - this.started;
      onLevel(this.level, ms);
      if (ms >= MAX_VOICE_MS) onLimit();
    }, 100);
  }

  /** The recording, its length and its shape (40 bars, 0-9). */
  stop(): Promise<{ blob: Blob; seconds: number; wave: string } | null> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      const seconds = (Date.now() - this.started) / 1000;
      if (!recorder || recorder.state === 'inactive') {
        this.release();
        return resolve(null);
      }
      recorder.onstop = () => {
        const blob = new Blob(this.parts, { type: (recorder.mimeType || 'audio/webm').split(';')[0] });
        const wave = shape(this.samples, 40);
        this.release();
        resolve(seconds < 0.7 || !blob.size ? null : { blob, seconds, wave });
      };
      recorder.stop();
    });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release(): void {
    clearInterval(this.sampler);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.recorder = undefined;
    this.parts = [];
    this.samples = [];
  }
}

/** Squeezes the loudness samples into a fixed number of bars, one digit each. */
export function shape(samples: number[], bars: number): string {
  if (!samples.length) return '0'.repeat(bars);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * samples.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / bars));
    out.push(Math.max(...samples.slice(from, to)));
  }
  const top = Math.max(...out, 0.05);
  return out.map((v) => Math.min(9, Math.round((v / top) * 9))).join('');
}

/* ---------- GIFs made in Ekanto: a loop, there and back ---------- */

const LOOP_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

/**
 * Grabs 1.5 seconds from the camera and plays it forward and back, round and round — a GIF made
 * by you, with no GIF site in between (they would learn what everyone searches). It is a small,
 * silent video, so it stays sharp and light.
 */
export async function recordLoop(video: HTMLVideoElement, onFrame?: (done: number) => void): Promise<Blob> {
  const frames: ImageBitmap[] = [];
  const width = 480;
  const height = Math.round((width * (video.videoHeight || 640)) / (video.videoWidth || 480));
  for (let i = 0; i < 22; i++) {
    frames.push(await createImageBitmap(video, { resizeWidth: width, resizeHeight: height }));
    onFrame?.((i + 1) / 22);
    await new Promise((r) => setTimeout(r, 70));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.drawImage(frames[0], 0, 0);
  const type = LOOP_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const stream = canvas.captureStream(15);
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 1_500_000 });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((r) => (recorder.onstop = () => r()));
  recorder.start();
  const order = [...frames, ...frames.slice(1, -1).reverse()];
  for (let round = 0; round < 2; round++) {
    for (const f of order) {
      g.drawImage(f, 0, 0);
      await new Promise((r) => setTimeout(r, 66));
    }
  }
  recorder.stop();
  await done;
  frames.forEach((f) => f.close());
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(parts, { type: (recorder.mimeType || 'video/webm').split(';')[0] });
}
