import { MAX_STICKER } from './messages';

/*
 * Stickers. The ready ones are big emoji drawn as die-cut stickers (a white edge and a shadow),
 * so they cost nothing to send ("e:😂") and look native on every phone. Your own are made here from
 * any photo — cut round or square, with words on them if you like — and kept on this phone only.
 * A sticker you made rides inside the message (a small picture), so it arrives even while your
 * phone is off.
 */

export const EMOJI_STICKERS = [
  '😂', '🥹', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😭', '😤', '🤯', '😴',
  '🤔', '🙄', '😬', '🫠', '🤗', '🫡', '🙏', '👏', '💪', '👍', '👋', '🤝',
  '❤️', '🔥', '✨', '🎉', '💯', '🌹', '☕', '🍕', '🎂', '🌙', '☀️', '🚀',
];

const MINE_KEY = 'hush.stickers';
const MAX_MINE = 48;

export function myStickers(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && s.startsWith('i:')) : [];
  } catch {
    return [];
  }
}

export function keepSticker(s: string): void {
  const list = [s, ...myStickers().filter((o) => o !== s)].slice(0, MAX_MINE);
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(list));
  } catch {
    // Storage full: the sticker is still sent, just not kept.
  }
}

export function forgetSticker(s: string): void {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(myStickers().filter((o) => o !== s)));
  } catch {
    // Nothing kept anyway.
  }
}

export interface StickerDraft {
  image: ImageBitmap;
  /** Where the square sits on the photo: centre (0..1) and zoom (1 = the whole short side). */
  cx: number;
  cy: number;
  zoom: number;
  shape: 'round' | 'square';
  text: string;
}

/** Draws the sticker at a given size (the preview uses the same drawing as the one sent). */
export function drawSticker(canvas: HTMLCanvasElement, d: StickerDraft, size: number): void {
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  const edge = Math.round(size * 0.035);
  const inner = size - edge * 2;
  const side = Math.min(d.image.width, d.image.height) / d.zoom;
  const sx = Math.min(Math.max(0, d.cx * d.image.width - side / 2), d.image.width - side);
  const sy = Math.min(Math.max(0, d.cy * d.image.height - side / 2), d.image.height - side);
  const path = new Path2D();
  if (d.shape === 'round') path.arc(size / 2, size / 2, inner / 2, 0, Math.PI * 2);
  else path.roundRect(edge, edge, inner, inner, inner * 0.18);
  // The white die-cut edge, then the photo inside it.
  g.save();
  g.lineWidth = edge * 2;
  g.strokeStyle = '#fff';
  g.stroke(path);
  g.clip(path);
  g.drawImage(d.image, sx, sy, side, side, edge, edge, inner, inner);
  g.restore();
  const text = d.text.trim().toUpperCase().slice(0, 24);
  if (text) {
    let font = size * 0.15;
    g.font = `900 ${font}px system-ui, sans-serif`;
    while (g.measureText(text).width > inner * 0.9 && font > size * 0.07) {
      font -= 2;
      g.font = `900 ${font}px system-ui, sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = font * 0.22;
    g.strokeStyle = '#000';
    const y = size - edge - inner * (d.shape === 'round' ? 0.16 : 0.07);
    g.strokeText(text, size / 2, y);
    g.fillStyle = '#fff';
    g.fillText(text, size / 2, y);
  }
}

/** The finished sticker, small enough to ride inside a message ("i:data:…"). */
export function exportSticker(d: StickerDraft): string | null {
  const canvas = document.createElement('canvas');
  for (const size of [320, 256, 200, 160]) {
    drawSticker(canvas, d, size);
    for (const q of [0.85, 0.7, 0.55]) {
      const url = canvas.toDataURL('image/webp', q);
      // A browser that can't make WebP gives PNG instead; either is fine if it is small enough.
      if (`i:${url}`.length <= MAX_STICKER) return `i:${url}`;
      if (!url.startsWith('data:image/webp')) break;
    }
  }
  return null;
}
