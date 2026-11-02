# Ekanto — private calls

Video and voice calls for 2 or more people. No login, no account, nothing saved. Just a name and a link.

Website: https://arjunsingh-rajpurohit.github.io/ekanto/ · Android app: [ekanto.apk](https://github.com/Arjunsingh-Rajpurohit/ekanto/releases/latest/download/ekanto.apk)

*Ekanto* (Bengali একান্ত, Hindi एकांत) — private, just us. Formerly "Hush"; links made before the rename still open.

## How it works

Three tabs on a phone — **Calls** (saved channels), **Link** (a one-time call link), **Settings**
(your name, Hide my IP). On a computer, Calls and Link sit side by side and ⚙️ opens Settings.

1. **Link** tab: pick **Video** or **Voice**, how many people can join (2, 3, 4… or "Any"), an optional
   reason, tap **Create call link**. The first time, it asks your name.
2. Send the link (WhatsApp, SMS…). Others tap it, type a name, tap **Join call**.
3. Tap the green 🔒 chip to compare **safety emojis**. Same 5 on both phones = nobody is in between.

A link works for **24 hours**. After that it opens nothing — an old link found in a chat can't start a call.

## Saved channels — tap to call, it rings

For people you call often (e.g. you and your wife): save a channel once, then just tap it. No new links.

1. Tap **＋**. **My code** shows your QR and code (like `K7PM-4QXD`). They tap **＋ → Their code** on their
   phone: the camera is already on — point it at your QR, or type the code. Both phones save each other.
   No link, no call. The camera picture is read on the phone and never leaves it.
   (Share sends the code in a chat if you're apart; the people icon makes it for a group. Or in any call:
   **⋯ → Save as channel**.)
2. Next time: tap 📞 or 🎥 on the channel. Their phone **rings** like WhatsApp — **Answer** / **Decline**.
   Missed calls show on the channel. If a call is already on, the channel says **In a call now** — tap to join.
3. **Delete**: long-press a person (right-click on a computer), or **⋮** in their chat → **Delete**. It tells the others' phones.

Adding the same person again never saves them twice: each phone has its own random "this is me",
shared only with the people it adds, so the second time they get the same entry back.

Why a code or link can't get a stranger in later: the channel's key is never in it. A code **works once
(one person; a group code for as many as you picked) and for 24 hours**. From it the two phones work out —
slowly on purpose, so guessing a code from what a relay sees takes far longer than a day — a meeting point
and a key. The channel's key then goes inside a box only those two phones can open (a fresh X25519 key
pair each), so even a code worked out later opens nothing. Whoever has the code first takes the place, as
with any invite — so you see who joined, and a second person is told "already used".
The two phones don't have to be open at the same time: each leaves its sealed note with the relays,
which keep it for at most a day (it expires by itself) and is taken off as soon as it has done its job.
Each call still gets a brand-new secret, and the ring's meeting name changes every day.

Ringing while Ekanto is closed works in the **Android app** (a quiet "Ekanto is ready for calls" notification
keeps it listening — no Google push, no server). Allow **notifications**, **full-screen calls** and
**no battery limit** once (Ekanto asks). On Xiaomi/Oppo/Vivo/Realme/OnePlus also turn on **Autostart**.
The website rings only while it is open.

## Messages — chat with a saved person, like WhatsApp

Tap a person on **Calls** to open your chat with them; 📞 and 🎥 in the chat call them.

- **Phone to phone, no server.** A message is sealed with the channel's key and goes over the same
  relays the rings use; they forward it and keep nothing. Only the channel's members can read it.
- **✓ sent · ✓✓ delivered · blue ✓✓ read.** If the other phone is off, yours sends it again (soon
  after, then every few minutes, and at once when their phone comes back) until it arrives — for up
  to 7 days. Read receipts can be turned off in Settings.
- **Kept only on the members' phones**, and it disappears after **7 days** by default. Change it in
  the person's sheet (24 hours · 7 days · Never) — the setting is the same for everyone in the chat,
  and the chat says who changed it. Removing a person deletes the chat from your phone.
- **The app hears messages while closed** and shows a chat notification; the lock screen only says
  "New message". A protected person's chat is app-only, like their calls.
- On the website, messages arrive while Ekanto is open; ones sent meanwhile arrive when you open it.

**Photos, videos, voice, files, stickers** — ➕ next to the box, 🙂 inside it, 🎤 when it's empty.

| | |
|---|---|
| 📷 **Photos & videos** | A look before sending, a caption, several at once. Sent as **the original** — no squeezing, any size up to 2 GB. |
| ⬇️ / 👁 **Can save · View only** | Picked before sending. View only: shown inside Ekanto, never saved or shared; screenshots blocked in the app, and on the website the viewer's name is printed faintly over it. **Take it back any time** — it goes from their phone too. |
| 📄 **Any file** | Every type (PDF, zip, docx, apk…). PDFs, text, pictures and videos open inside Ekanto. |
| 🎤 **Voice messages** | Tap the mic, talk, send. Plays in the chat. |
| 🙂 **Stickers & GIFs** | Big emoji stickers; **your own** from any photo (round or square, words on it); **make a GIF** with the camera (a loop, there and back). No GIF search — it would tell a GIF company what you type. |
| ↩️ ❤️ 🗑 | Long-press a message: reply, react, copy, save, make a sticker, delete for everyone (no time limit) or for you. |
| 🎁 **Surprise** | Arrives now, wrapped, with a countdown — **opens at the time you pick, even if your phone is off then**. Nothing inside shows before (not in the list, not in the notification). |

How a file travels: the message (sealed, like any message) says what it is and carries a tiny blurred
preview; the file itself goes **straight from the sender's phone to the other phone** over an
encrypted WebRTC line set up with sealed offer/answer rings — no server holds it, not even
encrypted. It's saved as it arrives, so a broken transfer goes on where it stopped. If the sender's
phone is off, it waits there and comes when both are on (the app tells the sender someone is
waiting). Files go with their messages — when the chat's time is up, or a message is deleted.

## In a call

| | |
|---|---|
| 💬 **Chat** | Messages, photos and files — only for people in the call now. Gone when the call ends. |
| 📥 / 👁️ **Files** | Sender picks **Download** (they can save it; a saved copy stays on their phone) or **View only** (shown inside Ekanto only, never saved, gone after the call). Up to 100 MB per file. |
| 🖥️ **Share screen** | From a computer browser, or the Android app. Phone browsers can't share their screen (no website can). |
| 🎥 **Camera** | On/off any time — off really switches the camera off. A voice call can turn video on later. |
| 🔔 **Alerts** | "Ravi joined", and a warning if someone without the key tries to get in. |

## Why it's private

| | |
|---|---|
| Video and voice | Go straight from phone to phone, encrypted end to end (WebRTC DTLS-SRTP). |
| The key | Lives only in the link, after the `#`. Browsers never send that part to any server. |
| Meeting points | Public relays (MQTT + Nostr) only pass sealed messages (AES-256-GCM). They can't read, change or fake them, so they can't join or listen. Each call uses 4 of them, picked from the link's secret. The one thing they ever keep: an invite's sealed note, for a day at most. |
| People limit | Mixed into the key: editing `.4` into `.40` in a link leads to an empty, different call. When the call is full, everyone agrees who stays (earliest joiners). |
| Website | Strict security policy: it may load only its own files and talk only to the meeting points. No trackers, no fonts, no analytics. |
| Nothing saved | No account, no history, no recordings. The link is wiped from the address bar when you hang up. Only your name (and any channels you save) stay, on your own phone — never backed up or copied to another phone. |
| **Protected call** (app only) | Others can join only from the Android app, which blocks screenshots and screen recording (FLAG_SECURE) and has no browser extensions. On Android 15+, a phone that starts a screen recorder is named to everyone in the call: "Ravi's phone tried to record — blocked." |
| Chat and files | Go on a private data channel inside the same encrypted connection — never through any relay. Held in memory only. |

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
