/**
 * The two sounds of a phone call, made on the phone (no sound files to download):
 * "ring" for an incoming call and "back" for the caller while the other phone rings.
 */
export type ToneKind = 'ring' | 'back';

export function startTone(kind: ToneKind): () => void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => undefined;
  }
  // Browsers only allow sound after a tap on the page; if there was none, this stays silent.
  void ctx.resume().catch(() => undefined);
  const out = ctx.createGain();
  out.gain.value = kind === 'ring' ? 0.22 : 0.08;
  out.connect(ctx.destination);

  const beep = (freqs: number[], at: number, length: number) => {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + 0.03);
    env.gain.setValueAtTime(1, at + length - 0.06);
    env.gain.linearRampToValueAtTime(0, at + length);
    env.connect(out);
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + length);
    }
  };
  // Ring: a bright three-note chime. Ringback: the familiar soft "tring… tring".
  const cycle = () => {
    const t = ctx.currentTime + 0.05;
    if (kind === 'ring') {
      beep([659], t, 0.18);
      beep([880], t + 0.22, 0.18);
      beep([1047], t + 0.44, 0.3);
      beep([659], t + 1.1, 0.18);
      beep([880], t + 1.32, 0.18);
      beep([1047], t + 1.54, 0.3);
    } else {
      beep([400, 450], t, 0.4);
      beep([400, 450], t + 0.6, 0.4);
    }
  };
  cycle();
  const timer = setInterval(cycle, 3000);
  return () => {
    clearInterval(timer);
    void ctx.close().catch(() => undefined);
  };
}
