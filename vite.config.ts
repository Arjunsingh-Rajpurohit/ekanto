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
    "img-src 'self' data:",
    "media-src 'self' blob: mediastream:",
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

export default defineConfig({
  // Relative paths work both on GitHub Pages (/hush/) and inside the Android app.
  base: './',
  plugins: [contentSecurityPolicy()],
  build: { target: 'es2022', sourcemap: false },
});
