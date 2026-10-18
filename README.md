# Hush — private video calls

Video calls for 2 or more people. No login, no account, nothing saved. Just a name and a link.

## How it works

1. Type your name, pick how many people can join (2, 3, 4… or "Any"), tap **Create call link**.
2. Send the link (WhatsApp, SMS…). Others tap it, type a name, tap **Join call**.
3. Tap the green 🔒 chip to compare **safety emojis**. Same 5 on both phones = nobody is in between.

## Why it's private

| | |
|---|---|
| Video and voice | Go straight from phone to phone, encrypted end to end (WebRTC DTLS-SRTP). |
| The key | Lives only in the link, after the `#`. Browsers never send that part to any server. |
| Meeting points | Public relays (MQTT + Nostr) only pass sealed messages (AES-256-GCM). They can't read, change or fake them, so they can't join or listen. Each call uses 4 of them, picked from the link's secret. |
| People limit | Mixed into the key: editing `.4` into `.40` in a link leads to an empty, different call. When the call is full, everyone agrees who stays (earliest joiners). |
| Website | Strict security policy: it may load only its own files and talk only to the meeting points. No trackers, no fonts, no analytics. |
| Nothing saved | No account, no history, no recordings. The link is wiped from the address bar when you hang up. Only your name is remembered, on your own phone. |
| **Protected call** (app only) | Others can join only from the Android app, which blocks screenshots and screen recording (FLAG_SECURE) and has no browser extensions. |

**What no app can stop:** someone filming the screen with another phone. On the website (not the app), browser extensions the person installed can see the page.

## Limits

- Smooth for up to ~6 people. Every phone sends video to every other phone (no server), so bigger calls lag on phones.
- On some mobile networks (Jio/Airtel) a direct path is blocked; then the call needs the backup relay (TURN). Set it up once — see below.

## Free forever

| Part | Free plan | If it gets busy |
|---|---|---|
| Website — GitHub Pages | ~100 GB/month (the site is ~130 KB) | Still free |
| Meeting points — public relays | Free | 8 of them on 2 networks; a call needs just one |
| Backup relay — ExpressTURN | Monthly free quota | When used up, calls that need it fail until next month. Never billed (no card). |

## Backup relay (TURN) — optional, recommended

1. Sign up free at expressturn.com, copy the TURN server, username and password.
2. GitHub repo → Settings → Secrets → Actions → add `TURN_URLS` (e.g. `turn:xx.expressturn.com:3478`), `TURN_USERNAME`, `TURN_CREDENTIAL`.
3. For the app, put the same values in a git-ignored `.env.turn` file:
   ```sh
   VITE_TURN_URLS=turn:xx.expressturn.com:3478
   VITE_TURN_USERNAME=...
   VITE_TURN_CREDENTIAL=...
   ```

## Develop

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # 9 checks on the lock, links and safety emojis
./release-apk.sh     # build the signed Android app and publish it as a GitHub release
```

Pushing to `main` publishes the website automatically (`.github/workflows/pages.yml`).

The Android signing key lives in `~/arjun/hush-keys` — **back it up**. Every app update must be signed
with it, or Android refuses to install the update over the old app.

Troubleshooting a call: in the browser console run `localStorage.setItem('hush.debug','1')` and reload.
It logs message kinds and short ids only — never names or content.
