import type { Person } from './call';
import { viewable, type Chat, type ChatItem, type FileMode } from './chat';
import { saveFile, showFile, sizeText } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The chat panel: messages, files with their Download / View-only choice, and the viewer.
 * Every name, message and file name is put on screen as plain text, never as HTML.
 */
export class ChatPanel {
  private readonly chat: Chat;
  private readonly people: () => Person[];
  private readonly toast: (text: string) => void;
  private pending: File | null = null;
  private closeViewer: (() => void) | null = null;
  private lastCount = 0;

  constructor(chat: Chat, people: () => Person[], toast: (text: string) => void) {
    this.chat = chat;
    this.people = people;
    this.toast = toast;
  }

  /** Re-draws the list and the unread badge; called on every chat change. */
  render(): void {
    const badge = $('chat-badge');
    badge.hidden = this.chat.unread === 0;
    badge.textContent = this.chat.unread > 9 ? '9+' : String(this.chat.unread);
    const last = this.chat.items[this.chat.items.length - 1];
    if (this.chat.items.length > this.lastCount && last?.from && !this.chat.open) {
      this.toast(last.text ? `${last.from.name}: ${last.text.slice(0, 60)}` : `${last.from.name} sent a file`);
      navigator.vibrate?.(40);
    }
    this.lastCount = this.chat.items.length;
    if (this.chat.open) this.drawList();
  }

  openPanel(): void {
    $('chat').hidden = false;
    this.chat.setOpen(true);
    this.drawList();
    setTimeout(() => $('chat-input').focus(), 50);
  }

  closePanel(): void {
    $('chat').hidden = true;
    this.chat.setOpen(false);
  }

  sendText(): void {
    const input = $<HTMLInputElement>('chat-input');
    if (!input.value.trim()) return;
    if (!this.chat.sendText(input.value, this.people())) {
      this.toast('Nobody is connected yet.');
      return;
    }
    input.value = '';
  }

  /** A file was picked: ask how to send it. */
  pick(file: File): void {
    this.pending = file;
    $('send-name').textContent = `"${file.name}" (${sizeText(file.size)})`;
    const canView = viewable(file.type);
    $<HTMLButtonElement>('send-view').disabled = !canView;
    const onWeb = this.chat.recipients(this.people()).filter((p) => p.platform !== 'app').map((p) => p.name);
    const warning = !canView
      ? "View only works for photos, videos, audio, text and PDFs. This file can only be sent as Download."
      : onWeb.length
        ? `${onWeb.join(', ')} ${onWeb.length === 1 ? 'is' : 'are'} on the website, where a screenshot of a view-only file is possible. The Ekanto app blocks screenshots.`
        : '';
    $('send-warning').textContent = warning;
    $('send-warning').hidden = !warning;
    $('send-sheet').hidden = false;
  }

  send(mode: FileMode): void {
    const file = this.pending;
    this.pending = null;
    $('send-sheet').hidden = true;
    if (!file) return;
    const problem = this.chat.sendFile(file, mode, this.people());
    if (problem) this.toast(problem);
  }

  cancelSend(): void {
    this.pending = null;
    $('send-sheet').hidden = true;
  }

  async view(item: ChatItem): Promise<void> {
    const file = item.file;
    if (!file?.blob) return;
    this.closeViewer?.();
    $('viewer-name').textContent = file.name;
    $('viewer-mode').textContent = file.mode === 'view' ? '👁️ View only · gone when the call ends' : `📥 ${sizeText(file.size)}`;
    // Your own file: you already have it, no need to offer a save.
    const canSave = file.mode === 'download' && item.from !== null;
    $('viewer-save').hidden = !canSave;
    $('viewer-save').onclick = () => void this.save(item);
    $('viewer').hidden = false;
    $('viewer').classList.toggle('protected', file.mode === 'view');
    try {
      this.closeViewer = await showFile($('viewer-body'), file);
    } catch {
      this.toast("This file couldn't be shown.");
    }
  }

  hideViewer(): void {
    this.closeViewer?.();
    this.closeViewer = null;
    $('viewer').hidden = true;
  }

  /** Call over: close everything and forget it. */
  reset(): void {
    this.hideViewer();
    this.cancelSend();
    $('chat').hidden = true;
    $('chat-list').replaceChildren();
    this.lastCount = 0;
  }

  private async save(item: ChatItem): Promise<void> {
    if (item.file?.mode !== 'download' || !item.file.blob) return;
    try {
      await saveFile(item.file);
    } catch {
      this.toast("Couldn't save the file.");
    }
  }

  private drawList(): void {
    const list = $('chat-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren(...this.chat.items.map((item) => this.bubble(item)));
    if (!this.chat.items.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet. Say hi, or send a photo with 📎.';
      list.append(empty);
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  private bubble(item: ChatItem): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `bubble ${item.from ? 'theirs' : 'mine'}`;
    if (item.from) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = item.from.name;
      li.append(who);
    }
    if (item.text !== undefined) {
      const p = document.createElement('p');
      p.textContent = item.text;
      li.append(p);
    }
    const file = item.file;
    if (file) {
      const card = document.createElement('div');
      card.className = 'file';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = file.mode === 'view' ? '👁️' : file.mime.startsWith('image/') ? '🖼️' : file.mime.startsWith('video/') ? '🎬' : '📄';
      const info = document.createElement('div');
      info.className = 'file-info';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const meta = document.createElement('span');
      meta.className = 'hint';
      meta.textContent = file.failed
        ? 'Not delivered'
        : !file.done
          ? `${item.from ? 'Receiving' : 'Sending'}… ${Math.round(file.progress * 100)}%`
          : `${sizeText(file.size)} · ${file.mode === 'view' ? 'View only' : 'Download'}`;
      info.append(name, meta);
      card.append(icon, info);
      if (file.done && !file.failed && file.blob) {
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        if (viewable(file.mime)) {
          const view = document.createElement('button');
          view.className = 'btn small';
          view.textContent = 'View';
          view.onclick = () => void this.view(item);
          actions.append(view);
        }
        if (file.mode === 'download' && item.from) {
          const save = document.createElement('button');
          save.className = 'btn small';
          save.textContent = 'Save';
          save.onclick = () => void this.save(item);
          actions.append(save);
        }
        card.append(actions);
      }
      if (!file.done) {
        const bar = document.createElement('div');
        bar.className = 'progress';
        const fill = document.createElement('span');
        fill.style.width = `${Math.round(file.progress * 100)}%`;
        bar.append(fill);
        card.append(bar);
      }
      li.append(card);
    }
    const time = document.createElement('time');
    time.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.append(time);
    return li;
  }
}
