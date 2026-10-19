/**
 * Who is talking right now, from the sound levels of each stream — all measured on this phone,
 * nothing sent anywhere. Drives the speaking ripple and the "speaker" layout.
 */
export class SpeakingMeter {
  private ctx: AudioContext | null = null;
  private watched = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; trackId: string; level: number; until: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly onChange: (speaking: Set<string>, loudest: string | null) => void;
  private last = '';

  constructor(onChange: (speaking: Set<string>, loudest: string | null) => void) {
    this.onChange = onChange;
  }

  /** Start (or keep) listening to one person's sound. Safe to call on every update. */
  watch(id: string, stream: MediaStream | null): void {
    const track = stream?.getAudioTracks()[0];
    const current = this.watched.get(id);
    if (!track) return this.unwatch(id);
    if (current?.trackId === track.id) return;
    this.unwatch(id);
    try {
      this.ctx ??= new AudioContext();
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      // ~40 ms of sound per look, looked at ten times a second.
      analyser.fftSize = 2048;
      // Measured only: never connected to the speakers, so nothing is played twice.
      source.connect(analyser);
      this.watched.set(id, { source, analyser, trackId: track.id, level: 0, until: 0 });
      this.timer ??= setInterval(() => this.measure(), 100);
    } catch {
      // No audio analysis available: no rings, the call is unaffected.
    }
  }

  unwatch(id: string): void {
    const w = this.watched.get(id);
    if (!w) return;
    w.source.disconnect();
    this.watched.delete(id);
  }

  /** Keep only these people (everyone else left). */
  keep(ids: Set<string>): void {
    for (const id of [...this.watched.keys()]) if (!ids.has(id)) this.unwatch(id);
  }

  stop(): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    clearInterval(this.timer);
    this.timer = undefined;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private measure(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
    const buf = new Float32Array(2048);
    const speaking = new Set<string>();
    let loudest: string | null = null;
    let max = 0;
    const now = Date.now();
    for (const [id, w] of this.watched) {
      w.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      // Smoothed, and the ring stays on briefly after a sound, so it doesn't flicker between words.
      w.level = w.level * 0.6 + Math.sqrt(sum / buf.length) * 0.4;
      if (w.level > 0.012) w.until = now + 700;
      if (now < w.until) {
        speaking.add(id);
        if (w.level > max) {
          max = w.level;
          loudest = id;
        }
      }
    }
    const key = [...speaking].sort().join() + '|' + loudest;
    if (key !== this.last) {
      this.last = key;
      this.onChange(speaking, loudest);
    }
  }
}
