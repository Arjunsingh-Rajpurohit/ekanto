import { defineConfig, type Plugin } from 'vite';
// relays.ts has no build-time variables, so it loads fine here (config.ts does not).
import { ALL_RELAYS } from './src/relays.ts';

/**
 * A strict Content-Security-Policy in the built page: it may only load its own files and talk to
 * the meeting points. No trackers, fonts or scripts from anywhere else can ever run in it.
 * (GitHub Pages can't send headers, so it goes in a <meta> tag. Build only: the dev server needs more.)
 */
function contentSecurityPolicy(): Plugin {
  const relayOrigins = ALL_RELAYS.map((u) => new URL(u).origin).join(' ');
  const policy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // blob: = photos and screen frames from the chat, held in memory only.
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    // The PDF viewer's helper, from this site only.
    "worker-src 'self'",
    `connect-src 'self' ${relayOrigins}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'hush-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/**
 * The card a chat app shows for a shared link (WhatsApp, Telegram…): title, line and picture.
 * Chat apps need the picture's full address. Only this page's address is ever fetched for it —
 * never the part after the #, so the call's key stays out of every preview.
 */
function shareCard(): Plugin {
  const fromBuild = process.env.VITE_PUBLIC_URL;
  const base = fromBuild ? new URL(fromBuild.endsWith('/') ? fromBuild : `${fromBuild}/`).href : './';
  return {
    name: 'ekanto-share-card',
    transformIndexHtml: (html) => html.replaceAll('%SHARE_URL%', base),
  };
}

export default defineConfig({
  // Relative paths work both on GitHub Pages (/ekanto/) and inside the Android app.
  base: './',
  plugins: [contentSecurityPolicy(), shareCard()],
  build: { target: 'es2022', sourcemap: false },
});
