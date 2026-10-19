import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { ChatFile } from './chat';

/**
 * Shows a file from the chat inside Ekanto. Nothing is ever navigated to or opened by the browser:
 * pictures are painted onto a canvas (no "save image" menu), videos and audio play with downloads
 * turned off, text is shown as plain text, PDFs are drawn page by page. A view-only file has no
 * way out of the app except a photo of the screen — or a screenshot on the website.
 */
export async function showFile(host: HTMLElement, file: ChatFile): Promise<() => void> {
  const urls: string[] = [];
  const blob = file.blob!;
  host.replaceChildren();
  host.oncontextmenu = (e) => e.preventDefault();

  if (file.mime.startsWith('image/')) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    host.append(canvas);
  } else if (file.mime.startsWith('video/') || file.mime.startsWith('audio/')) {
    const media = document.createElement(file.mime.startsWith('video/') ? 'video' : 'audio');
    const url = URL.createObjectURL(blob);
    urls.push(url);
    media.src = url;
    media.controls = true;
    media.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
    media.setAttribute('playsinline', '');
    if (media instanceof HTMLVideoElement) media.disablePictureInPicture = true;
    host.append(media);
  } else if (file.mime === 'text/plain') {
    const pre = document.createElement('pre');
    pre.textContent = new TextDecoder().decode(await blob.slice(0, 1024 * 1024).arrayBuffer());
    host.append(pre);
  } else if (file.mime === 'application/pdf') {
    await showPdf(host, blob);
  } else {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = "This kind of file can't be shown here. Save it to open it with another app.";
    host.append(p);
  }

  return () => {
    for (const url of urls) URL.revokeObjectURL(url);
    host.replaceChildren();
  };
}

async function showPdf(host: HTMLElement, blob: Blob): Promise<void> {
  // Loaded only when a PDF is opened: most calls never need it.
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = Math.min(doc.numPages, 50);
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: Math.min(2, (host.clientWidth || 800) * devicePixelRatio / page.getViewport({ scale: 1 }).width) });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    host.append(canvas);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
  }
  if (doc.numPages > pages) {
    const more = document.createElement('p');
    more.className = 'sub';
    more.textContent = `Showing the first ${pages} of ${doc.numPages} pages.`;
    host.append(more);
  }
}

/** Only for "Download" files. The copy then stays wherever the person saves it. */
export async function saveFile(file: ChatFile): Promise<void> {
  const name = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';
  if (!Capacitor.isNativePlatform()) {
    // Always as a plain download, never opened in the browser (a sender could label an HTML
    // page as a "photo"; opened here, it would run inside Ekanto).
    const url = URL.createObjectURL(new Blob([file.blob!], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  // In the app: the phone's own "Save to…" sheet (Gallery, Files, Drive…).
  const path = `shared/${Date.now()}-${name}`;
  const blob = file.blob!;
  const step = 3 * 256 * 1024;
  for (let offset = 0; offset < blob.size || offset === 0; offset += step) {
    const data = await toBase64(blob.slice(offset, offset + step));
    if (offset === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    if (blob.size === 0) break;
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  // The target app may read the file after the sheet closes; the copy is removed when the call ends.
  await Share.share({ title: name, files: [uri] });
}

/** Removes the temporary copies made for "Save" in the app. */
export async function clearSaved(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Filesystem.rmdir({ path: 'shared', directory: Directory.Cache, recursive: true }).catch(() => undefined);
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
