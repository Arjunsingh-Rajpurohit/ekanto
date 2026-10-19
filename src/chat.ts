import type { CallSession, Person } from './call';

/**
 * Chat and files inside a call. Everything travels on each person's private side-channel
 * (phone to phone, encrypted) and lives only in this page's memory: it is never written to disk
 * by Ekanto, never sent to a server, and wiped when the call ends. Someone who joins later sees
 * nothing that was sent before they arrived.
 */

export type FileMode = 'download' | 'view';

export interface ChatFile {
  name: string;
  size: number;
  mime: string;
  mode: FileMode;
  /** 0..1 while sending or receiving. */
  progress: number;
  done: boolean;
  failed: boolean;
  /** The file itself, in memory only. */
  blob: Blob | null;
}

export interface ChatItem {
  id: string;
  /** null = sent by me. */
  from: { id: string; name: string } | null;
  at: number;
  text?: string;
  file?: ChatFile;
}

/** Biggest file one phone accepts: it is held in memory for the length of the call. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Most one person can send you in one call, so nobody can fill your phone's memory. */
const MAX_FROM_ONE_PERSON = 300 * 1024 * 1024;
/** Safe size for one side-channel message on every browser. */
const CHUNK = 16 * 1024;
/** Stop queueing above this, resume below LOW: keeps memory flat and chat messages flowing. */
const HIGH = 1024 * 1024;
const LOW = 256 * 1024;

/** View-only files open only inside Ekanto, so only types Ekanto can show itself qualify. */
export function viewable(mime: string): boolean {
  return /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|ogg)|audio\/|text\/plain$|application\/pdf$)/.test(mime);
}

type Wire =
  | { k: 'msg'; id: string; text: string }
  | { k: 'file'; id: string; name: string; size: number; mime: string; mode: FileMode }
  | { k: 'file-done'; id: string };

interface Incoming {
  item: ChatItem;
  parts: ArrayBuffer[];
  received: number;
  /** Too big or broken: chunks are dropped, not kept. */
  discard: boolean;
}

const newId = () => crypto.randomUUID();

export class Chat {
  items: ChatItem[] = [];
  unread = 0;
  open = false;
  private incoming = new Map<string, Incoming>();
  /** Bytes announced by each sender so far in this call. */
  private takenFrom = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private readonly session: CallSession;
  private readonly onChange: () => void;

  constructor(session: CallSession, onChange: () => void) {
    this.session = session;
    this.onChange = onChange;
    session.onChannelData = (from, data) => this.receive(from, data);
  }

  /** People a message would reach right now. */
  recipients(people: Person[]): Person[] {
    return people.filter((p) => p.connected && p.channelOpen);
  }

  sendText(text: string, people: Person[]): boolean {
    const clean = text.trim().slice(0, 2000);
    const to = this.recipients(people);
    if (!clean || !to.length) return false;
    const id = newId();
    const wire = JSON.stringify({ k: 'msg', id, text: clean } satisfies Wire);
    for (const p of to) this.session.sendTo(p.id, wire);
    this.add({ id, from: null, at: Date.now(), text: clean });
    return true;
  }

  /** Sends a file to everyone in the call now. Returns why not, or null when it started. */
  sendFile(file: File, mode: FileMode, people: Person[]): string | null {
    const to = this.recipients(people);
    if (!to.length) return 'Nobody is connected yet.';
    if (file.size > MAX_FILE_BYTES) return 'Files can be up to 100 MB.';
    if (mode === 'view' && !viewable(file.type)) return "This kind of file can't be shown in Ekanto — send it as Download instead.";
    const item: ChatItem = {
      id: newId(), from: null, at: Date.now(),
      file: { name: file.name.slice(0, 120), size: file.size, mime: file.type || 'application/octet-stream', mode, progress: 0, done: false, failed: false, blob: file },
    };
    this.add(item);
    const sent = new Map<string, number>();
    const report = () => {
      const total = [...sent.values()].reduce((a, b) => a + b, 0);
      item.file!.progress = file.size ? total / (file.size * to.length) : 1;
      this.onChange();
    };
    const jobs = to.map((p) => this.enqueue(p.id, async () => {
      const header: Wire = { k: 'file', id: item.id, name: item.file!.name, size: file.size, mime: item.file!.mime, mode };
      if (!this.session.sendTo(p.id, JSON.stringify(header))) throw new Error('gone');
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        if (this.session.buffered(p.id) > HIGH) await this.session.drained(p.id, LOW);
        const chunk = await file.slice(offset, offset + CHUNK).arrayBuffer();
        if (!this.session.sendTo(p.id, chunk)) throw new Error('gone');
        sent.set(p.id, offset + chunk.byteLength);
        if ((offset / CHUNK) % 16 === 0) report();
      }
      this.session.sendTo(p.id, JSON.stringify({ k: 'file-done', id: item.id } satisfies Wire));
      sent.set(p.id, file.size);
      report();
    }));
    void Promise.allSettled(jobs).then((results) => {
      item.file!.done = true;
      item.file!.failed = results.every((r) => r.status === 'rejected');
      item.file!.progress = 1;
      this.onChange();
    });
    return null;
  }

  setOpen(open: boolean): void {
    this.open = open;
    if (open) this.unread = 0;
    this.onChange();
  }

  /** Call over: every message and file is dropped from memory. */
  dispose(): void {
    this.items = [];
    this.incoming.clear();
    this.takenFrom.clear();
    this.queues.clear();
    this.unread = 0;
  }

  /** One file at a time per person, in order; chat messages slip in between chunks. */
  private enqueue(id: string, job: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(job, job);
    this.queues.set(id, next.catch(() => undefined));
    return next;
  }

  private add(item: ChatItem): void {
    this.items.push(item);
    if (item.from && !this.open) this.unread++;
    this.onChange();
  }

  private receive(from: Person, data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      const current = [...this.incoming.values()].find((f) => f.item.from?.id === from.id && !f.item.file!.done);
      if (!current || current.discard) return;
      current.received += data.byteLength;
      if (current.received > current.item.file!.size) {
        // More than announced: someone is misbehaving. Keep nothing.
        current.discard = true;
        current.parts = [];
        current.item.file!.failed = true;
        current.item.file!.done = true;
      } else {
        current.parts.push(data);
        current.item.file!.progress = current.received / Math.max(1, current.item.file!.size);
      }
      this.onChange();
      return;
    }

    let wire: Wire;
    try {
      wire = JSON.parse(data) as Wire;
    } catch {
      return;
    }
    const who = { id: from.id, name: from.name };
    if (wire.k === 'msg' && typeof wire.text === 'string') {
      this.add({ id: wire.id, from: who, at: Date.now(), text: wire.text.slice(0, 2000) });
    } else if (wire.k === 'file') {
      const already = this.takenFrom.get(from.id) ?? 0;
      const tooBig = !(wire.size >= 0) || wire.size > MAX_FILE_BYTES || already + wire.size > MAX_FROM_ONE_PERSON;
      if (!tooBig) this.takenFrom.set(from.id, already + wire.size);
      const mode: FileMode = wire.mode === 'view' ? 'view' : 'download';
      const item: ChatItem = {
        id: wire.id, from: who, at: Date.now(),
        file: {
          name: String(wire.name).slice(0, 120), size: Number(wire.size) || 0, mime: String(wire.mime || 'application/octet-stream'),
          mode, progress: 0, done: tooBig, failed: tooBig, blob: null,
        },
      };
      this.incoming.set(wire.id, { item, parts: [], received: 0, discard: tooBig });
      this.add(item);
    } else if (wire.k === 'file-done') {
      const f = this.incoming.get(wire.id);
      if (!f || f.item.from?.id !== from.id) return;
      this.incoming.delete(wire.id);
      const file = f.item.file!;
      if (!f.discard && f.received === file.size) {
        // A view-only file is kept as plain bytes; Ekanto only ever shows it, never saves it.
        file.blob = new Blob(f.parts, { type: file.mime });
      } else {
        file.failed = true;
      }
      file.done = true;
      file.progress = 1;
      f.parts = [];
      this.onChange();
    }
  }
}
