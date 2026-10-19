import type { Person } from './call';

const ME = 'me';

/** What the stage needs to know about your own picture. */
export interface Me {
  stream: MediaStream | null;
  name: string;
  /** Camera on (or a screen being shared): show video, else your initial. */
  video: boolean;
  /** Front camera: shown mirrored, like a mirror. Never a shared screen. */
  mirror: boolean;
  screen: boolean;
}

export type LayoutMode = 'grid' | 'speaker';

/**
 * Lays out the call, WhatsApp-style on phones and Meet-style on computers:
 * - one other person: they fill the screen, you float in a corner you can drag; tap to swap;
 * - groups: a grid; tap someone to make them big (the others go to a strip); tap again for the grid;
 * - "speaker" mode: whoever is talking goes big by themselves; a shared screen always does.
 * Tiles are created once and moved around, so video never restarts when the layout changes.
 */
export class Stage {
  private tiles = new Map<string, HTMLElement>();
  private people: Person[] = [];
  private me: Me = { stream: null, name: 'You', video: false, mirror: true, screen: false };
  /** Who the user tapped to make big. Null = automatic. */
  private pinned: string | null = null;
  private mode: LayoutMode = 'grid';
  private speaking = new Set<string>();
  private loudest: string | null = null;
  private loudestSince = 0;
  private corner: 'tl' | 'tr' | 'bl' | 'br' = 'tr';
  /** Output device for everyone else's sound (computers only; '' = default). */
  private sink = '';
  private readonly root: HTMLElement;
  private readonly main: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly float: HTMLElement;
  private readonly onTapMain: () => void;

  constructor(root: HTMLElement, onTapMain: () => void) {
    this.root = root;
    this.onTapMain = onTapMain;
    this.main = root.querySelector('.main')!;
    this.grid = root.querySelector('.grid')!;
    this.strip = root.querySelector('.strip')!;
    this.float = root.querySelector('.float')!;
    this.makeDraggable();
    window.addEventListener('resize', () => this.fitGrid());
  }

  setMe(me: Me): void {
    this.me = me;
    this.layout();
  }

  setPeople(people: Person[]): void {
    this.people = people;
    if (this.pinned && this.pinned !== ME && !people.some((p) => p.id === this.pinned)) this.pinned = null;
    this.layout();
  }

  setSpeaking(speaking: Set<string>, loudest: string | null): void {
    this.speaking = speaking;
    // In speaker mode the big picture follows the talker, but not more than every 2 seconds.
    if (loudest && loudest !== this.loudest && Date.now() - this.loudestSince > 2000) {
      this.loudest = loudest;
      this.loudestSince = Date.now();
    }
    this.layout();
  }

  setMode(mode: LayoutMode): void {
    this.mode = mode;
    this.pinned = null;
    this.layout();
  }

  getMode(): LayoutMode {
    return this.mode;
  }

  /** Plays everyone's sound on this output (speakers, headset…). Computers only. */
  setSink(deviceId: string): void {
    this.sink = deviceId;
    for (const [id, tile] of this.tiles) if (id !== ME) this.applySink(tile.querySelector('audio')!);
  }

  private applySink(audio: HTMLAudioElement): void {
    const a = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (a.setSinkId && a.sinkId !== this.sink) void a.setSinkId(this.sink).catch(() => undefined);
  }

  reset(): void {
    for (const tile of this.tiles.values()) tile.remove();
    this.tiles.clear();
    this.people = [];
    this.pinned = null;
    this.loudest = null;
  }

  /** The big picture right now, if there is one (used for picture-in-picture). */
  mainVideo(): HTMLVideoElement | null {
    return this.main.querySelector('video');
  }

  private layout(): void {
    const others = this.people;
    const ids = [ME, ...others.map((p) => p.id)];
    for (const [id, tile] of this.tiles) if (!ids.includes(id)) {
      tile.remove();
      this.tiles.delete(id);
    }
    this.drawTile(ME);
    for (const p of others) this.drawTile(p.id);

    const sharer = others.find((p) => p.screen)?.id ?? null;
    let big: string | null = null;
    if (others.length === 1) big = this.pinned ?? others[0].id;
    else if (others.length > 1) {
      big = this.pinned
        ?? sharer
        ?? (this.mode === 'speaker' ? (this.loudest && ids.includes(this.loudest) && this.loudest !== ME ? this.loudest : others[0].id) : null);
    }

    let layout: 'alone' | 'duo' | 'grid' | 'focus';
    if (!others.length) layout = 'alone';
    else if (others.length === 1) layout = 'duo';
    else layout = big ? 'focus' : 'grid';
    this.root.dataset['layout'] = layout;

    // Only move a picture when its place really changes: moving a video pauses it for a moment.
    const arrange = (where: HTMLElement, order: string[]) => {
      const now = [...where.children].map((c) => (c as HTMLElement).dataset['id']);
      if (now.length === order.length && now.every((id, i) => id === order[i])) return;
      for (const id of order) where.append(this.tiles.get(id)!);
    };
    const wanted: Record<'main' | 'grid' | 'strip' | 'float', string[]> = { main: [], grid: [], strip: [], float: [] };
    if (layout === 'alone') {
      wanted.float = [ME];
    } else if (layout === 'duo') {
      wanted.main = [big!];
      wanted.float = [big === ME ? others[0].id : ME];
    } else if (layout === 'grid') {
      wanted.grid = others.map((p) => p.id);
      wanted.float = [ME];
    } else {
      wanted.main = [big!];
      wanted.strip = ids.filter((id) => id !== big);
    }
    arrange(this.main, wanted.main);
    arrange(this.grid, wanted.grid);
    arrange(this.strip, wanted.strip);
    arrange(this.float, wanted.float);
    for (const tile of this.tiles.values()) {
      for (const media of tile.querySelectorAll<HTMLMediaElement>('video, audio')) {
        if (media.paused && media.srcObject) void media.play().catch(() => undefined);
      }
    }
    this.float.hidden = !this.float.firstElementChild;
    this.float.dataset['corner'] = this.corner;
    this.fitGrid();
  }

  private drawTile(id: string): void {
    let tile = this.tiles.get(id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset['id'] = id;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      // Pictures are silent: each person's sound has its own player (below). In a voice call no
      // picture ever arrives, and a video player waiting for one never starts the sound either.
      video.muted = true;
      if (id === ME) video.id = 'local';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      const label = document.createElement('span');
      label.className = 'name';
      const wait = document.createElement('div');
      wait.className = 'tile-wait';
      wait.innerHTML = '<div class="spinner"></div><p>Connecting securely…</p>';
      tile.append(video, avatar, label, wait);
      if (id !== ME) {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        tile.append(audio);
        if (this.sink) this.applySink(audio);
      }
      tile.addEventListener('click', () => this.tap(id));
      this.tiles.set(id, tile);
    }
    const video = tile.querySelector('video')!;
    if (id === ME) {
      const me = this.me;
      if (video.srcObject !== me.stream) video.srcObject = me.stream;
      // textContent, never innerHTML: names are whatever people typed.
      tile.querySelector('.name')!.textContent = me.screen ? 'You · sharing screen' : 'You';
      tile.querySelector('.avatar')!.textContent = (me.name.trim()[0] ?? 'Y').toUpperCase();
      tile.classList.toggle('no-video', !me.video);
      tile.classList.toggle('mirror', me.mirror);
      tile.classList.toggle('screen', me.screen);
      tile.classList.toggle('waiting', false);
    } else {
      const p = this.people.find((x) => x.id === id)!;
      if (video.srcObject !== p.stream) video.srcObject = p.stream;
      // Their sound: a stream of just their audio, rebuilt only when that audio really changes.
      const audio = tile.querySelector('audio')!;
      const sound = p.stream?.getAudioTracks() ?? [];
      const key = sound.map((t) => t.id).join();
      if (audio.dataset['tracks'] !== key) {
        audio.dataset['tracks'] = key;
        audio.srcObject = sound.length ? new MediaStream(sound) : null;
        if (sound.length) void audio.play().catch(() => undefined);
      }
      tile.querySelector('.name')!.textContent = p.screen ? `${p.name} · sharing screen` : p.name;
      tile.querySelector('.avatar')!.textContent = (p.name.trim()[0] ?? '?').toUpperCase();
      tile.classList.toggle('waiting', !p.connected);
      tile.classList.toggle('no-video', p.cam === false && !p.screen);
      tile.classList.toggle('screen', p.screen);
    }
    tile.classList.toggle('speaking', this.speaking.has(id));
    tile.classList.toggle('pinned', this.pinned === id);
  }

  private tap(id: string): void {
    if (this.dragged) return;
    const inMain = this.tiles.get(id)?.parentElement === this.main;
    if (inMain) {
      // Tapping the big picture: in a group, back to the grid; one-to-one, hide/show the buttons.
      if (this.people.length > 1) {
        this.pinned = null;
        this.layout();
      } else {
        this.onTapMain();
      }
      return;
    }
    this.pinned = id;
    this.layout();
  }

  /** Columns for the grid that give each picture the most room, on any screen shape. */
  private fitGrid(): void {
    const n = this.grid.children.length;
    if (!n) return;
    const w = this.grid.clientWidth || window.innerWidth;
    const h = this.grid.clientHeight || window.innerHeight;
    let best = 1;
    let bestSize = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const tileW = w / cols;
      const tileH = h / rows;
      const size = Math.min(tileW, tileH * (4 / 3));
      if (size > bestSize) {
        bestSize = size;
        best = cols;
      }
    }
    this.grid.style.gridTemplateColumns = `repeat(${best}, 1fr)`;
  }

  /* ---------- The floating picture: drag it anywhere, it settles in the nearest corner ---------- */

  private dragged = false;

  private makeDraggable(): void {
    const el = this.float;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let active = false;
    el.addEventListener('pointerdown', (e) => {
      active = true;
      this.dragged = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      originX = r.left;
      originY = r.top;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!this.dragged && Math.hypot(dx, dy) < 8) return;
      this.dragged = true;
      el.classList.add('dragging');
      el.style.left = `${originX + dx}px`;
      el.style.top = `${originY + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      if (!this.dragged) {
        // A tap, not a drag. (While held, the touch belongs to this box, so the picture
        // inside never gets its own click: handle the tap here.)
        const id = (el.firstElementChild as HTMLElement | null)?.dataset['id'];
        if (e.type === 'pointerup' && id) this.tap(id);
        return;
      }
      const r = el.getBoundingClientRect();
      const midX = r.left + r.width / 2;
      const midY = r.top + r.height / 2;
      this.corner = `${midY < window.innerHeight / 2 ? 't' : 'b'}${midX < window.innerWidth / 2 ? 'l' : 'r'}` as typeof this.corner;
      el.classList.remove('dragging');
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
      el.dataset['corner'] = this.corner;
      el.releasePointerCapture(e.pointerId);
      // The click that follows a drag must not count as a tap.
      setTimeout(() => (this.dragged = false), 50);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
