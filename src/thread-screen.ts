import type { Channel, FileMeta } from './channels';
import type { Chats } from './chats';
import { MAX_FILE, REACTIONS, labelOf, reactionsOf, wrapped, type Msg } from './messages';
import { VoiceRecorder, clock, describe, kindOf, recordLoop, sizeText, viewable } from './prepare';
import { EMOJI_STICKERS, drawSticker, exportSticker, forgetSticker, keepSticker, myStickers, type StickerDraft } from './stickers';
import { drawProgress, drawThread, tickCountdowns, whenText, type ThreadView } from './thread-ui';
import { saveFile, showFile } from './viewer';
import type { ChatFile } from './chat';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ThreadScreenDeps {
  chats: Chats;
  current(): Channel | null;
  toast(text: string): void;
  myName(): string;
  inApp: boolean;
}

interface Pick {
  file: Blob;
  name: string;
  url: string;
  meta: Promise<FileMeta>;
}

/** The overlays of a chat, in the order Back closes them. */
const LAYERS = ['media-view', 'loop-view', 'stk-maker', 'surprise-sheet', 'send-pane', 'msg-sheet', 'attach-sheet'];

/**
 * Everything on a chat's screen beyond plain text: photos and files (with a look before sending,
 * and "Can save" or "View only"), voice messages, stickers and GIFs, replies and reactions,
 * delete for everyone, and surprises that open at a set time.
 */
export class ThreadScreen {
  private readonly d: ThreadScreenDeps;
  private urls = new Map<string, string>();
  private loading = new Set<string>();
  private audio: HTMLAudioElement | null = null;
  private playingNow: { id: string; at: number } | null = null;
  private replyTo: Msg | null = null;
  private picks: Pick[] = [];
  private pickAt = 0;
  private mode: 'save' | 'view' = 'save';
  private op: number | undefined;
  private surpriseFor: 'message' | 'files' = 'message';
  private surpriseAt: number | undefined;
  private recorder: VoiceRecorder | null = null;
  private sheetMsg: Msg | null = null;
  private draft: StickerDraft | null = null;
  private camera: MediaStream | null = null;
  private facing: 'user' | 'environment' = 'user';
  private frame = 0;
  private closeViewer: (() => void) | null = null;
  private stickerTab: 'emoji' | 'mine' | 'gif' = 'emoji';

  readonly view: ThreadView = {
    url: (m) => this.url(m),
    state: (id) => this.d.chats.transfers.states.get(id),
    playing: () => this.playingNow,
  };

  constructor(deps: ThreadScreenDeps) {
    this.d = deps;
    this.wire();
    setInterval(() => {
      const list = $('thread-list');
      if (!$('thread').hidden && tickCountdowns(list)) this.draw();
    }, 1000);
  }

  draw(): void {
    const ch = this.d.current();
    if (ch) drawThread($('thread-list'), ch, this.d.chats.thread(ch.id), this.view);
  }

  /** A file of theirs moved on: just its ring, at most once a frame. */
  progress(chId: string, id: string): void {
    const ch = this.d.current();
    if (!ch || ch.id !== chId || $('thread').hidden || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const m = this.d.chats.thread(chId).msgs.find((o) => o.id === id);
      if (m && !drawProgress($('thread-list'), m, this.view.state(id))) this.draw();
    });
  }

  opened(): void {
    this.setReply(null);
    $('sticker-panel').hidden = true;
  }

  /** Leaving the chat: stop the voice note, close every layer, let go of the pictures. */
  closed(): void {
    this.stopAudio();
    this.cancelRecording();
    for (const id of LAYERS) $(id).hidden = true;
    this.closeViewer?.();
    this.stopCamera();
    $('sticker-panel').hidden = true;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.loading.clear();
  }

  /** Back (Android) or Escape: closes the top layer. True when something closed. */
  back(): boolean {
    for (const id of LAYERS) {
      if (!$(id).hidden) {
        if (id === 'media-view') this.hideViewer();
        else if (id === 'loop-view') this.closeLoop();
        else if (id === 'send-pane') this.closeSend();
        else $(id).hidden = true;
        return true;
      }
    }
    if (!$('rec-bar').hidden) {
      this.cancelRecording();
      return true;
    }
    if (!$('sticker-panel').hidden) {
      $('sticker-panel').hidden = true;
      return true;
    }
    if (this.replyTo) {
      this.setReply(null);
      return true;
    }
    return false;
  }

  /** What the text box sends with: a reply. */
  sendOptions(): { q?: string } {
    const q = this.replyTo?.id;
    this.setReply(null);
    return q ? { q } : {};
  }

  /** Send arrow when there is text, microphone when not — like every chat app. */
  composerChanged(hasText: boolean): void {
    $('thread-send').hidden = !hasText;
    $('mic-btn').hidden = hasText;
  }

  /* ---------- Files that are here ---------- */

  private url(m: Msg): string | undefined {
    const ch = this.d.current();
    if (!ch) return undefined;
    const key = `${ch.id}/${m.id}`;
    const have = this.urls.get(key);
    if (have || this.loading.has(key)) return have;
    this.loading.add(key);
    void this.d.chats.file(ch, m).then((blob) => {
      this.loading.delete(key);
      if (!blob || this.d.current()?.id !== ch.id) return;
      this.urls.set(key, URL.createObjectURL(blob));
      this.draw();
    });
    return undefined;
  }

  private find(id: string): Msg | undefined {
    const ch = this.d.current();
    return ch ? this.d.chats.thread(ch.id).msgs.find((m) => m.id === id) : undefined;
  }

  /* ---------- Wiring ---------- */

  private wire(): void {
    const list = $('thread-list');
    list.addEventListener('click', (e) => this.tapped(e));
    list.addEventListener('contextmenu', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li.bubble');
      if (!li) return;
      e.preventDefault();
      this.openActions(li.dataset.id!);
    });
    // Long-press opens the same menu on a touch screen.
    let press: ReturnType<typeof setTimeout> | undefined;
    let startY = 0;
    list.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li.bubble');
      if (!li || e.pointerType === 'mouse') return;
      startY = e.clientY;
      press = setTimeout(() => {
        navigator.vibrate?.(15);
        this.openActions(li.dataset.id!);
      }, 480);
    });
    const cancel = () => clearTimeout(press);
    list.addEventListener('pointerup', cancel);
    list.addEventListener('pointercancel', cancel);
    list.addEventListener('pointermove', (e) => Math.abs(e.clientY - startY) > 10 && cancel());

    $('attach-btn').addEventListener('click', () => {
      $('sticker-panel').hidden = true;
      $('attach-sheet').hidden = false;
    });
    $('attach-sheet').addEventListener('click', (e) => {
      if (e.target === $('attach-sheet')) $('attach-sheet').hidden = true;
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
      if (!b) return;
      $('attach-sheet').hidden = true;
      const pick = b.dataset.pick!;
      if (pick === 'surprise') return this.openSurprise('message');
      this.op = undefined;
      $<HTMLInputElement>(`pick-${pick}`).click();
    });
    for (const id of ['pick-media', 'pick-camera', 'pick-file', 'pick-gif']) {
      const input = $<HTMLInputElement>(id);
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.value = '';
        if (files.length) this.openSend(files.map((f) => ({ blob: f, name: f.name })), { gif: id === 'pick-gif' });
      });
    }

    // Before sending: a look, "Can save" or "View only", a caption.
    $('send-close').addEventListener('click', () => this.closeSend());
    $('send-remove').addEventListener('click', () => this.removePick());
    $('send-go').addEventListener('click', () => void this.sendPicks());
    $('send-caption').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.sendPicks();
      }
    });
    $('send-mode').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
      if (!b || b.disabled) return;
      this.mode = b.dataset.mode as 'save' | 'view';
      this.drawSendFoot();
    });
    $('send-surprise').addEventListener('click', () => this.openSurprise('files'));
    $('send-strip').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (b) this.showPick(Number(b.dataset.i));
    });

    // Viewer.
    $('mv-close').addEventListener('click', () => this.hideViewer());
    $('mv-save').addEventListener('click', () => {
      const id = $('media-view').dataset.id;
      const m = id ? this.find(id) : undefined;
      if (m) void this.save(m);
    });

    // Voice messages.
    $('mic-btn').addEventListener('click', () => void this.startRecording());
    $('rec-cancel').addEventListener('click', () => this.cancelRecording());
    $('rec-send').addEventListener('click', () => void this.finishRecording());

    // Stickers and GIFs.
    $('sticker-btn').addEventListener('click', () => {
      const panel = $('sticker-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        $('thread-input').blur();
        this.drawStickers();
      }
    });
    $('stk-tabs').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
      if (!b) return;
      this.stickerTab = b.dataset.tab as 'emoji' | 'mine' | 'gif';
      this.drawStickers();
    });
    $('stk-grid').addEventListener('click', (e) => this.stickerTapped(e));
    $('stk-grid').addEventListener('contextmenu', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mine]');
      if (!b) return;
      e.preventDefault();
      if (confirm('Remove this sticker from your stickers?')) {
        forgetSticker(b.dataset.mine!);
        this.drawStickers();
      }
    });
    $('pick-sticker').addEventListener('change', () => {
      const input = $<HTMLInputElement>('pick-sticker');
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.openMaker(file);
    });
    this.wireMaker();
    $('loop-close').addEventListener('click', () => this.closeLoop());
    $('loop-flip').addEventListener('click', () => {
      this.facing = this.facing === 'user' ? 'environment' : 'user';
      void this.startCamera();
    });
    $('loop-rec').addEventListener('click', () => void this.recordGif());

    // Surprise.
    $('surprise-picks').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-when]');
      if (!b) return;
      for (const o of $('surprise-picks').querySelectorAll('button')) o.classList.toggle('on', o === b);
      const input = $<HTMLInputElement>('surprise-time');
      input.hidden = b.dataset.when !== 'custom';
      if (b.dataset.when === 'custom') {
        input.min = localInput(Date.now() + 60_000);
        if (!input.value) input.value = localInput(Date.now() + 3600_000);
        input.focus();
      }
      this.surpriseAt = b.dataset.when === 'custom' ? fromLocalInput(input.value) : openAt(b.dataset.when!);
      this.drawSurprise();
    });
    $('surprise-time').addEventListener('input', () => {
      this.surpriseAt = fromLocalInput($<HTMLInputElement>('surprise-time').value);
      this.drawSurprise();
    });
    $('surprise-text').addEventListener('input', () => this.drawSurprise());
    $('surprise-cancel').addEventListener('click', () => ($('surprise-sheet').hidden = true));
    $('surprise-photo').addEventListener('click', () => {
      this.op = this.surpriseAt;
      $('surprise-sheet').hidden = true;
      $<HTMLInputElement>('pick-media').click();
    });
    $('surprise-go').addEventListener('click', () => this.sendSurprise());

    // Message actions.
    $('msg-sheet').addEventListener('click', (e) => {
      if (e.target === $('msg-sheet')) $('msg-sheet').hidden = true;
      const r = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-e]');
      const a = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-do]');
      const m = this.sheetMsg;
      const ch = this.d.current();
      if (!m || !ch || (!r && !a)) return;
      $('msg-sheet').hidden = true;
      if (r) return this.d.chats.react(ch, m.id, r.dataset.e!);
      void this.act(a!.dataset.do!, m, ch);
    });
    $('reply-cancel').addEventListener('click', () => this.setReply(null));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('thread').hidden && this.back()) e.preventDefault();
    });
  }

  private tapped(e: Event): void {
    const target = e.target as HTMLElement;
    const actor = target.closest<HTMLElement>('[data-act]');
    const li = target.closest<HTMLElement>('li.bubble');
    const ch = this.d.current();
    if (!actor || !li || !ch) return;
    const m = this.find(li.dataset.id!);
    if (!m) return;
    switch (actor.dataset.act) {
      case 'fetch':
        return this.d.chats.fetch(ch, m.id);
      case 'view':
        return void this.openViewer(m);
      case 'play':
        return void this.togglePlay(m);
      case 'quote':
        return this.jumpTo(actor.dataset.q!);
      case 'gift':
        return this.unwrap(m, actor);
      case 'react-info':
        return this.whoReacted(m);
    }
  }

  /* ---------- Sending photos, videos and files ---------- */

  private openSend(files: { blob: Blob; name: string }[], opts: { gif?: boolean } = {}): void {
    const ch = this.d.current();
    if (!ch) return;
    const tooBig = files.filter((f) => f.blob.size > MAX_FILE);
    if (tooBig.length) this.d.toast(`${tooBig[0].name} is over 2 GB — too big to send.`);
    this.picks = files.filter((f) => f.blob.size <= MAX_FILE).slice(0, 30).map((f) => ({
      file: f.blob, name: f.name || 'file', url: URL.createObjectURL(f.blob),
      meta: describe(f.blob, f.name || 'file', opts.gif && (f.blob.type === 'image/gif' || f.blob.type.startsWith('video/')) ? { g: true } : {}),
    }));
    if (!this.picks.length) return;
    this.mode = 'save';
    this.pickAt = 0;
    $<HTMLInputElement>('send-caption').value = '';
    $('send-title').textContent = `Send to ${ch.name}`;
    $('send-pane').hidden = false;
    this.showPick(0);
  }

  private showPick(i: number): void {
    this.pickAt = Math.max(0, Math.min(i, this.picks.length - 1));
    const p = this.picks[this.pickAt];
    const stage = $('send-stage');
    stage.replaceChildren(preview(p));
    const strip = $('send-strip');
    strip.hidden = this.picks.length < 2;
    strip.replaceChildren(...this.picks.map((o, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.i = String(n);
      b.className = n === this.pickAt ? 'on' : '';
      b.setAttribute('aria-label', o.name);
      if (o.file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = o.url;
        img.alt = '';
        b.append(img);
      } else b.textContent = o.file.type.startsWith('video/') ? '🎬' : (o.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || '📄';
      return b;
    }));
    $('send-remove').hidden = this.picks.length < 2;
    this.drawSendFoot();
  }

  private removePick(): void {
    const [gone] = this.picks.splice(this.pickAt, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    if (!this.picks.length) return this.closeSend();
    this.showPick(this.pickAt);
  }

  private drawSendFoot(): void {
    const total = this.picks.reduce((n, p) => n + p.file.size, 0);
    const canView = this.picks.every((p) => viewable((p.file.type || '').toLowerCase()));
    if (!canView) this.mode = 'save';
    for (const b of $('send-mode').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      const on = b.dataset.mode === this.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      if (b.dataset.mode === 'view') b.disabled = !canView;
    }
    const count = this.picks.length > 1 ? `${this.picks.length} files · ` : '';
    $('send-size').textContent = `${count}${sizeText(total)} · original quality`;
    $('send-note').textContent = this.op
      ? `🎁 Opens ${whenText(this.op)}`
      : this.mode === 'view'
        ? 'They can look, not keep — no saving or sharing. You can take it back any time.'
        : !canView ? 'View only works for photos, videos, PDFs and text.' : 'Sent as the original, phone to phone.';
    $('send-surprise').classList.toggle('on', !!this.op);
  }

  private closeSend(): void {
    for (const p of this.picks) URL.revokeObjectURL(p.url);
    this.picks = [];
    this.op = undefined;
    $('send-stage').replaceChildren();
    $('send-pane').hidden = true;
  }

  private async sendPicks(): Promise<void> {
    const ch = this.d.current();
    if (!ch || !this.picks.length) return;
    const picks = this.picks;
    const view = this.mode === 'view';
    const caption = $<HTMLInputElement>('send-caption').value.trim();
    const op = this.op;
    const q = this.sendOptions().q;
    this.picks = [];
    this.closeSend();
    const big = picks.reduce((n, p) => n + p.file.size, 0) > 50 * 1024 * 1024;
    if (big) this.d.toast('Getting it ready…');
    for (const [i, p] of picks.entries()) {
      const meta = await p.meta;
      URL.revokeObjectURL(p.url);
      await this.d.chats.sendFile(ch, p.file, { ...meta, ...(view ? { v: true } : {}) }, {
        x: i === 0 ? caption : '', ...(i === 0 && q ? { q } : {}), ...(op ? { op } : {}),
      }).catch(() => this.d.toast(`Couldn't keep ${p.name} on this phone — is it full?`));
    }
  }

  /* ---------- Viewer ---------- */

  private async openViewer(m: Msg): Promise<void> {
    const ch = this.d.current();
    if (!ch || !m.f) return;
    const blob = await this.d.chats.file(ch, m);
    if (!blob) return this.d.toast('This file is not on this phone any more.');
    const f = m.f;
    const kind = kindOf(f);
    const canSave = m.mine || !f.v;
    // A file Ekanto can't show (a .zip, a .docx…) goes straight to the phone's "save / open with".
    if (!viewable(f.m) && kind === 'file') {
      if (canSave) return void this.save(m);
      return this.d.toast("This kind of file can't be shown here.");
    }
    const stage = $('mv-stage');
    this.closeViewer?.();
    $('media-view').dataset.id = m.id;
    $('mv-who').textContent = m.mine ? 'You' : m.from;
    $('mv-when').textContent = `${new Date(m.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${f.v ? ' · View only' : ''}`;
    $('mv-save').hidden = !canSave;
    $('mv-caption').hidden = !m.x;
    $('mv-caption').textContent = m.x;
    $('media-view').hidden = false;
    this.stopAudio();
    if ((kind === 'image' || kind === 'gif') && !f.v && !f.m.startsWith('video/')) {
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('dblclick', () => img.classList.toggle('zoom'));
      stage.replaceChildren(img);
      this.closeViewer = () => {
        URL.revokeObjectURL(url);
        stage.replaceChildren();
      };
    } else if (kind === 'gif') {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      Object.assign(v, { src: url, muted: true, loop: true, autoplay: true, playsInline: true });
      v.setAttribute('playsinline', '');
      stage.replaceChildren(v);
      this.closeViewer = () => {
        URL.revokeObjectURL(url);
        stage.replaceChildren();
      };
    } else {
      const file: ChatFile = { name: f.n, size: f.z, mime: f.m, mode: f.v ? 'view' : 'download', progress: 1, done: true, failed: false, blob };
      const close = await showFile(stage, file);
      const v = stage.querySelector('video');
      if (v) v.autoplay = true, void v.play().catch(() => undefined);
      this.closeViewer = close;
    }
    // On the website a screenshot can't be blocked, so a view-only picture carries who is looking.
    if (f.v && !this.d.inApp && !m.mine) stage.append(watermark(this.d.myName()));
  }

  private hideViewer(): void {
    this.closeViewer?.();
    this.closeViewer = null;
    $('media-view').hidden = true;
  }

  private async save(m: Msg): Promise<void> {
    const ch = this.d.current();
    if (!ch || !m.f || (!m.mine && m.f.v)) return;
    const blob = await this.d.chats.file(ch, m);
    if (!blob) return this.d.toast('This file is not on this phone any more.');
    await saveFile({ name: m.f.n, size: m.f.z, mime: m.f.m, mode: 'download', progress: 1, done: true, failed: false, blob })
      .catch(() => this.d.toast("Couldn't save it."));
  }

  /* ---------- Voice messages ---------- */

  private async startRecording(): Promise<void> {
    if (this.recorder || !this.d.current()) return;
    this.stopAudio();
    $('sticker-panel').hidden = true;
    const rec = new VoiceRecorder();
    this.recorder = rec;
    const wave = $('rec-wave');
    wave.replaceChildren();
    try {
      await rec.start((level, ms) => {
        $('rec-time').textContent = clock(ms / 1000);
        const bar = document.createElement('i');
        bar.style.height = `${12 + level * 88}%`;
        wave.append(bar);
        while (wave.children.length > 60) wave.firstElementChild!.remove();
      }, () => void this.finishRecording());
    } catch {
      this.recorder = null;
      this.d.toast('Ekanto needs the microphone for voice messages.');
      return;
    }
    $('rec-time').textContent = '0:00';
    $('thread-form').hidden = true;
    $('rec-bar').hidden = false;
  }

  private cancelRecording(): void {
    this.recorder?.cancel();
    this.recorder = null;
    $('rec-bar').hidden = true;
    const ch = this.d.current();
    if (ch && !$('thread-closed').textContent) $('thread-form').hidden = false;
  }

  private async finishRecording(): Promise<void> {
    const rec = this.recorder;
    const ch = this.d.current();
    if (!rec || !ch) return;
    this.recorder = null;
    $('rec-bar').hidden = true;
    $('thread-form').hidden = false;
    const done = await rec.stop();
    if (!done) return this.d.toast('Too short — tap the microphone, speak, then send.');
    const ext = done.blob.type.includes('mp4') ? 'm4a' : done.blob.type.includes('ogg') ? 'ogg' : 'webm';
    const meta: FileMeta = { n: `Voice message.${ext}`, z: done.blob.size, m: done.blob.type || 'audio/webm', vo: true, d: Math.round(done.seconds * 10) / 10, wf: done.wave };
    await this.d.chats.sendFile(ch, done.blob, meta, this.sendOptions());
  }

  private async togglePlay(m: Msg): Promise<void> {
    if (this.playingNow?.id === m.id && this.audio) {
      this.stopAudio();
      return this.draw();
    }
    this.stopAudio();
    const ch = this.d.current();
    const blob = ch ? await this.d.chats.file(ch, m) : null;
    if (!blob) return;
    const audio = new Audio(URL.createObjectURL(blob));
    this.audio = audio;
    this.playingNow = { id: m.id, at: 0 };
    audio.ontimeupdate = () => {
      const total = Number.isFinite(audio.duration) ? audio.duration : m.f?.d || 1;
      this.playingNow = { id: m.id, at: Math.min(1, audio.currentTime / total) };
      const li = $('thread-list').querySelector(`li[data-id="${CSS.escape(m.id)}"]`);
      const bars = li?.querySelectorAll('.wave i') ?? [];
      const played = Math.round(this.playingNow.at * bars.length);
      bars.forEach((b, i) => b.classList.toggle('on', i < played));
      const t = li?.querySelector('.vtime');
      if (t) t.textContent = clock(audio.currentTime);
    };
    audio.onended = () => {
      this.stopAudio();
      this.draw();
    };
    this.draw();
    await audio.play().catch(() => this.stopAudio());
  }

  private stopAudio(): void {
    if (this.audio) {
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
    }
    this.audio = null;
    this.playingNow = null;
  }

  /* ---------- Stickers and GIFs ---------- */

  private drawStickers(): void {
    for (const b of $('stk-tabs').querySelectorAll<HTMLButtonElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.stickerTab);
    const grid = $('stk-grid');
    grid.className = `stk-grid ${this.stickerTab}`;
    const tile = (cls: string, label: string, data: Record<string, string>, content: string | HTMLElement) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.setAttribute('aria-label', label);
      Object.assign(b.dataset, data);
      if (typeof content === 'string') b.textContent = content;
      else b.append(content);
      return b;
    };
    if (this.stickerTab === 'emoji') {
      grid.replaceChildren(...EMOJI_STICKERS.map((e) => tile('stk', `Sticker ${e}`, { s: `e:${e}` }, e)));
    } else if (this.stickerTab === 'mine') {
      const mine = myStickers().map((s) => {
        const img = document.createElement('img');
        img.src = s.slice(2);
        img.alt = '';
        return tile('stk', 'Your sticker', { s, mine: s }, img);
      });
      grid.replaceChildren(tile('stk make', 'Make a sticker from a photo', { make: 'sticker' }, '+'), ...mine);
      if (!mine.length) grid.append(Object.assign(document.createElement('p'), { className: 'stk-hint', textContent: 'Turn any photo into a sticker.' }));
    } else {
      grid.replaceChildren(
        tile('gif-tile', 'Make a GIF with the camera', { make: 'gif' }, '📷  Make a GIF'),
        tile('gif-tile', 'Send a GIF from this phone', { make: 'pick-gif' }, '🖼  Pick a GIF'),
        Object.assign(document.createElement('p'), { className: 'stk-hint', textContent: 'No GIF search — it would tell a GIF company what you type.' }),
      );
    }
  }

  private stickerTapped(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    const ch = this.d.current();
    if (!b || !ch) return;
    if (b.dataset.make === 'sticker') return void $<HTMLInputElement>('pick-sticker').click();
    if (b.dataset.make === 'pick-gif') return void $<HTMLInputElement>('pick-gif').click();
    if (b.dataset.make === 'gif') return void this.openLoop();
    if (b.dataset.s) {
      this.d.chats.sendSticker(ch, b.dataset.s, this.sendOptions());
      if (b.dataset.s.startsWith('i:')) keepSticker(b.dataset.s);
    }
  }

  private async openMaker(source: Blob): Promise<void> {
    let image: ImageBitmap;
    try {
      image = await createImageBitmap(source);
    } catch {
      return this.d.toast("This picture can't be opened here.");
    }
    this.draft?.image.close();
    this.draft = { image, cx: 0.5, cy: 0.5, zoom: 1, shape: 'round', text: '' };
    $<HTMLInputElement>('stk-zoom').value = '1';
    $<HTMLInputElement>('stk-text').value = '';
    this.drawMakerShape();
    $('stk-maker').hidden = false;
    this.drawMaker();
  }

  private drawMaker(): void {
    if (this.draft) drawSticker($<HTMLCanvasElement>('stk-canvas'), this.draft, 320);
  }

  private drawMakerShape(): void {
    for (const b of $('stk-shape').querySelectorAll<HTMLButtonElement>('[data-shape]')) {
      const on = b.dataset.shape === this.draft?.shape;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  private wireMaker(): void {
    const canvas = $<HTMLCanvasElement>('stk-canvas');
    let last: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const d = this.draft;
      if (!last || !d) return;
      // Dragging moves the photo under the frame, the way it looks.
      const side = Math.min(d.image.width, d.image.height) / d.zoom;
      const per = side / canvas.clientWidth;
      d.cx = clamp(d.cx - ((e.clientX - last.x) * per) / d.image.width);
      d.cy = clamp(d.cy - ((e.clientY - last.y) * per) / d.image.height);
      last = { x: e.clientX, y: e.clientY };
      this.drawMaker();
    });
    canvas.addEventListener('pointerup', () => (last = null));
    $('stk-zoom').addEventListener('input', () => {
      if (!this.draft) return;
      this.draft.zoom = Number($<HTMLInputElement>('stk-zoom').value) || 1;
      this.drawMaker();
    });
    $('stk-shape').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-shape]');
      if (!b || !this.draft) return;
      this.draft.shape = b.dataset.shape as 'round' | 'square';
      this.drawMakerShape();
      this.drawMaker();
    });
    $('stk-text').addEventListener('input', () => {
      if (!this.draft) return;
      this.draft.text = $<HTMLInputElement>('stk-text').value;
      this.drawMaker();
    });
    $('stk-cancel').addEventListener('click', () => ($('stk-maker').hidden = true));
    $('stk-save').addEventListener('click', () => {
      const ch = this.d.current();
      if (!this.draft || !ch) return;
      const s = exportSticker(this.draft);
      if (!s) return this.d.toast("Couldn't make it small enough — try a simpler picture.");
      keepSticker(s);
      $('stk-maker').hidden = true;
      this.d.chats.sendSticker(ch, s, this.sendOptions());
      if (!$('sticker-panel').hidden) this.drawStickers();
    });
  }

  private async openLoop(): Promise<void> {
    $('loop-view').hidden = false;
    await this.startCamera();
  }

  private async startCamera(): Promise<void> {
    this.stopCamera();
    try {
      this.camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.facing, width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
      const v = $<HTMLVideoElement>('loop-cam');
      v.srcObject = this.camera;
      v.classList.toggle('mirror', this.facing === 'user');
      await v.play().catch(() => undefined);
    } catch {
      this.closeLoop();
      this.d.toast('Ekanto needs the camera to make a GIF.');
    }
  }

  private stopCamera(): void {
    this.camera?.getTracks().forEach((t) => t.stop());
    this.camera = null;
    $<HTMLVideoElement>('loop-cam').srcObject = null;
  }

  private closeLoop(): void {
    this.stopCamera();
    $('loop-view').hidden = true;
    $('loop-rec').classList.remove('busy');
  }

  private async recordGif(): Promise<void> {
    const v = $<HTMLVideoElement>('loop-cam');
    const rec = $('loop-rec');
    if (!this.camera || rec.classList.contains('busy')) return;
    rec.classList.add('busy');
    try {
      const blob = await recordLoop(v, (p) => rec.style.setProperty('--p', String(p)));
      this.closeLoop();
      this.openSend([{ blob, name: `GIF.${blob.type.includes('mp4') ? 'mp4' : 'webm'}` }], { gif: true });
    } catch {
      this.closeLoop();
      this.d.toast("Couldn't make the GIF on this phone.");
    }
  }

  /* ---------- Surprise ---------- */

  private openSurprise(forWhat: 'message' | 'files'): void {
    this.surpriseFor = forWhat;
    this.surpriseAt = forWhat === 'files' ? this.op : undefined;
    for (const o of $('surprise-picks').querySelectorAll('button')) o.classList.remove('on');
    $<HTMLInputElement>('surprise-time').hidden = true;
    $<HTMLTextAreaElement>('surprise-text').value = '';
    $('surprise-what').hidden = forWhat === 'files';
    $('surprise-go').textContent = forWhat === 'files' ? 'Done' : 'Send surprise';
    $('surprise-sheet').hidden = false;
    this.drawSurprise();
  }

  private drawSurprise(): void {
    const at = this.surpriseAt;
    const ok = !!at && at > Date.now() + 30_000;
    const text = $<HTMLTextAreaElement>('surprise-text').value.trim();
    $<HTMLButtonElement>('surprise-go').disabled = !ok || (this.surpriseFor === 'message' && !text);
    $<HTMLButtonElement>('surprise-photo').disabled = !ok;
    const sub = $('surprise-sheet').querySelector('.sub')!;
    sub.textContent = ok
      ? `Opens ${whenText(at!)}. It arrives now, wrapped — even if your phone is off then, it opens on time.`
      : 'It arrives now, wrapped, and opens at the time you pick — even if your phone is off by then.';
  }

  private sendSurprise(): void {
    const ch = this.d.current();
    const at = this.surpriseAt;
    if (!ch || !at) return;
    $('surprise-sheet').hidden = true;
    if (this.surpriseFor === 'files') {
      this.op = at;
      return this.drawSendFoot();
    }
    this.d.chats.send(ch, $<HTMLTextAreaElement>('surprise-text').value, { ...this.sendOptions(), op: at });
  }

  private unwrap(m: Msg, from: HTMLElement): void {
    const ch = this.d.current();
    if (!ch || !m.op) return;
    if (m.op > Date.now()) return this.d.toast(`🎁 It opens ${whenText(m.op)}.`);
    const box = from.getBoundingClientRect();
    if (this.d.chats.unwrap(ch, m.id)) confetti(box.left + box.width / 2, box.top + box.height / 2);
  }

  /* ---------- Replies, reactions, the message menu ---------- */

  private setReply(m: Msg | null): void {
    this.replyTo = m;
    $('reply-bar').hidden = !m;
    if (!m) return;
    $('reply-who').textContent = m.mine ? 'You' : m.from;
    $('reply-what').textContent = labelOf(m);
    $('thread-input').focus();
  }

  private jumpTo(id: string): void {
    const li = $('thread-list').querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
    if (!li) return this.d.toast('That message is not here any more.');
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }

  private whoReacted(m: Msg): void {
    const ch = this.d.current();
    if (!ch) return;
    const t = this.d.chats.thread(ch.id);
    const names = new Map(t.msgs.filter((o) => !o.mine).map((o) => [o.by, o.from]));
    const on = reactionsOf(t).get(m.id);
    if (!on?.size) return;
    this.d.toast([...on].map(([by, e]) => `${e} ${by ? names.get(by) ?? ch.name : 'You'}`).join('   '));
  }

  private openActions(id: string): void {
    const m = this.find(id);
    const ch = this.d.current();
    if (!m || !ch || m.note) return;
    this.sheetMsg = m;
    const theirsWrapped = !m.mine && wrapped(m);
    const mineReact = [...this.d.chats.thread(ch.id).msgs].reverse().find((o) => o.note === 'react' && o.mine && o.on === m.id)?.e;
    const row = $('msg-reacts');
    row.hidden = !!m.gone || !!ch.gone;
    row.replaceChildren(...REACTIONS.map((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.e = e;
      b.textContent = e;
      b.className = e === mineReact ? 'on' : '';
      b.setAttribute('aria-label', `React ${e}`);
      return b;
    }));
    const here = !!m.f && (m.mine || m.dl === 'done');
    const show: Record<string, boolean> = {
      reply: !m.gone && !ch.gone && !theirsWrapped,
      copy: !!m.x && !m.gone && !theirsWrapped,
      save: here && !m.gone && (m.mine || !m.f!.v) && !theirsWrapped,
      sticker: here && !m.gone && (m.mine || !m.f!.v) && m.f!.m.startsWith('image/') && !theirsWrapped,
      unsend: m.mine && !m.gone && !ch.gone,
      delete: true,
    };
    for (const b of $('msg-sheet').querySelectorAll<HTMLButtonElement>('[data-do]')) {
      b.hidden = !show[b.dataset.do!];
      if (b.dataset.do === 'unsend') b.textContent = m.f?.v ? 'Take back from everyone' : 'Delete for everyone';
    }
    $('msg-sheet').hidden = false;
  }

  private async act(what: string, m: Msg, ch: Channel): Promise<void> {
    switch (what) {
      case 'reply':
        return this.setReply(m);
      case 'copy':
        await navigator.clipboard?.writeText(m.x).catch(() => undefined);
        return this.d.toast('Copied');
      case 'save':
        return this.save(m);
      case 'sticker': {
        const blob = await this.d.chats.file(ch, m);
        return blob ? this.openMaker(blob) : undefined;
      }
      case 'unsend':
        this.d.chats.deleteForEveryone(ch, m.id);
        return this.d.toast(m.f?.v ? 'Taken back — gone from their phone too.' : 'Deleted for everyone.');
      case 'delete':
        if (m.mine && !m.gone && !confirm('Delete this message on this phone only? They still have it.')) return;
        return this.d.chats.deleteForMe(ch, m.id);
    }
  }
}

/* ---------- Small helpers ---------- */

function preview(p: Pick): HTMLElement {
  const type = (p.file.type || '').toLowerCase();
  if (type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = p.name;
    return img;
  }
  if (type.startsWith('video/')) {
    const v = document.createElement('video');
    Object.assign(v, { src: p.url, controls: true, playsInline: true, muted: true, loop: true, autoplay: true });
    v.setAttribute('playsinline', '');
    return v;
  }
  const card = document.createElement('div');
  card.className = 'doc big';
  const ext = (p.name.includes('.') ? p.name.split('.').pop()! : 'file').slice(0, 4).toUpperCase();
  const icon = document.createElement('span');
  icon.className = 'doc-icon';
  icon.textContent = ext;
  const info = document.createElement('span');
  info.className = 'doc-info';
  const name = document.createElement('strong');
  name.textContent = p.name;
  const size = document.createElement('small');
  size.textContent = sizeText(p.file.size);
  info.append(name, size);
  card.append(icon, info);
  return card;
}

function watermark(name: string): HTMLElement {
  const w = document.createElement('div');
  w.className = 'watermark';
  w.setAttribute('aria-hidden', 'true');
  const text = `${name} · ${new Date().toLocaleDateString()}`;
  for (let i = 0; i < 24; i++) w.append(Object.assign(document.createElement('span'), { textContent: text }));
  return w;
}

function confetti(x: number, y: number): void {
  const bits = ['🎉', '✨', '🎊', '💛', '⭐'];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = bits[i % bits.length];
    const a = (Math.PI * 2 * i) / 26;
    const r = 90 + Math.random() * 120;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--dx', `${Math.cos(a) * r}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * r - 60}px`);
    document.body.append(s);
    setTimeout(() => s.remove(), 1300);
  }
  navigator.vibrate?.([20, 40, 20]);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** The quick choices for when a surprise opens. */
function openAt(when: string): number {
  const now = new Date();
  if (when === 'hour') return Date.now() + 3600_000;
  if (when === 'midnight') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0).getTime();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0).getTime();
}

function localInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): number | undefined {
  const at = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(at) ? at : undefined;
}
