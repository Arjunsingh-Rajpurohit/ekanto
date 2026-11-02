import { encode } from 'uqr';

/**
 * A QR, black on white whatever the theme, with the quiet border scanners need. `mark`: a letter in
 * a round badge in the middle (your initial, like a profile picture) — the strongest error
 * correction reads straight through it.
 */
export function qrSvg(text: string, mark?: string): string {
  const { data, size } = encode(text, { ecc: mark ? 'H' : 'M', border: 0 });
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size;) {
      if (!data[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && data[y][x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const q = 3;
  const all = size + 2 * q;
  const c = size / 2;
  const r = size * 0.11;
  const badge = mark
    ? `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="#fff"/><circle cx="${c}" cy="${c}" r="${r}" fill="#141a24"/>`
      + `<text x="${c}" y="${c}" fill="#fff" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-weight="700" `
      + `font-size="${r * 1.15}" text-anchor="middle" dominant-baseline="central">${escapeXml(mark)}</text>`
    : '';
  return `<svg viewBox="${-q} ${-q} ${all} ${all}" aria-hidden="true">`
    + `<rect x="${-q}" y="${-q}" width="${all}" height="${all}" fill="#fff"/><path d="${d}" fill="#000" shape-rendering="crispEdges"/>${badge}</svg>`;
}

const escapeXml = (t: string) => t.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** The phone's own QR reader where there is one (Chrome on Android, Safari); else jsQR, loaded only then. */
async function reader(): Promise<(video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>> {
  const Native = (globalThis as { BarcodeDetector?: { new(o: { formats: string[] }): Detector; getSupportedFormats?(): Promise<string[]> } }).BarcodeDetector;
  try {
    if (Native && (await Native.getSupportedFormats?.())?.includes('qr_code')) {
      const detector = new Native({ formats: ['qr_code'] });
      return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
    }
  } catch {
    // Not really there: jsQR below.
  }
  const jsQR = (await import('jsqr')).default;
  return async (video, canvas) => {
    // A smaller picture reads just as well and much faster.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g || !canvas.width) return null;
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

/**
 * The camera, looking for a QR. Nothing leaves the phone: every picture is read here and dropped.
 * `found` gets what the QR says; return true to stop, false to keep looking (not an Ekanto code).
 */
export class Scanner {
  private stream: MediaStream | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private readonly video: HTMLVideoElement;
  private readonly canvas = document.createElement('canvas');

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(found: (text: string) => boolean): Promise<void> {
    this.stop();
    this.running = true;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (!this.running) return stream.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    const read = await reader();
    const look = async () => {
      if (!this.running) return;
      let text: string | null = null;
      try {
        if (this.video.readyState >= 2) text = await read(this.video, this.canvas);
      } catch {
        // One unreadable frame: the next one.
      }
      if (!this.running) return;
      if (text && found(text)) return this.stop();
      this.timer = setTimeout(() => void look(), 180);
    };
    void look();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
