/* Plays spoken replies that arrive long after the click that asked for them. */

export type PlayResult = 'played' | 'blocked' | 'failed' | 'stopped';

const WAV_BYTES_PER_S = 48_000; // 24 kHz, 16-bit, mono
const GRACE_MS = 3000;

/** A tenth of a second of silence, as a WAV file. */
function silence(): string {
  const samples = 2400;
  const v = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true);
  v.setUint32(28, WAV_BYTES_PER_S, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([v.buffer], { type: 'audio/wav' }));
}

/**
 * One audio element for the whole call. Browsers let an element play later if it first played during a click, so
 * unlock() runs inside the click and play() can wait for the model. play() always settles, even if the audio hangs.
 */
export class ReplyPlayer {
  private el: HTMLAudioElement | null = null;
  private unlocked = false;
  private finish: ((r: PlayResult) => void) | null = null;

  /** Call this synchronously inside a click or key press. */
  unlock(): void {
    this.el ??= new Audio();
    if (this.unlocked || this.finish) return;
    this.el.src = silence();
    this.el.play().then(
      () => {
        this.unlocked = true;
      },
      () => undefined,
    );
  }

  play(wav: ArrayBuffer): Promise<PlayResult> {
    this.stop();
    const el = (this.el ??= new Audio());
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    return new Promise<PlayResult>((resolve) => {
      const timer = window.setTimeout(() => done('failed'), (wav.byteLength / WAV_BYTES_PER_S) * 1000 + GRACE_MS);
      const done = (result: PlayResult) => {
        if (!this.finish) return;
        this.finish = null;
        window.clearTimeout(timer);
        el.onended = el.onerror = null;
        el.pause();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      this.finish = done;
      el.onended = () => done('played');
      el.onerror = () => done('failed');
      el.src = url;
      el.play().catch((err: Error) => done(err.name === 'NotAllowedError' ? 'blocked' : 'failed'));
    });
  }

  /** Stops whatever is playing. Its play() settles as 'stopped'. */
  stop(): void {
    this.finish?.('stopped');
  }
}
