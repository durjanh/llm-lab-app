import type { VideoSegment } from '@/services/videoTranslateService';

/**
 * Plays the translated phrases in step with a video. Each phrase is decoded once, then started by Web Audio at the
 * moment the video reaches it. A seek or a pause stops whatever is playing; playing again schedules from the video's
 * new position. The video's clock leads; this follows it.
 */
export class SpeechTrack {
  private ctx: AudioContext | null = null;
  private buffers: (AudioBuffer | null)[] = [];
  private playing: { source: AudioBufferSourceNode; index: number }[] = [];
  private started = new Set<number>();
  private timer = 0;
  private gain: GainNode | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly segments: VideoSegment[],
  ) {}

  /** Fetches and decodes every phrase. Calls onProgress(done, total) as it goes. */
  async load(onProgress: (done: number, total: number) => void): Promise<void> {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    const ctx = this.ctx;
    let done = 0;
    this.buffers = await Promise.all(
      this.segments.map(async (s) => {
        if (!s.audio) return null;
        try {
          const data = await (await fetch(s.audio)).arrayBuffer();
          return await ctx.decodeAudioData(data);
        } catch {
          return null; // a phrase that will not load stays silent; the rest still play
        } finally {
          onProgress(++done, this.segments.length);
        }
      }),
    );
  }

  setVolume(v: number): void {
    if (this.gain) this.gain.gain.value = v;
  }

  /** Starts following the video. Call stop() when the page or the result changes. */
  start(): void {
    const v = this.video;
    const halt = () => this.silence();
    v.addEventListener('pause', halt);
    v.addEventListener('seeking', halt);
    v.addEventListener('ended', halt);
    const tick = () => {
      if (!v.paused && !v.seeking) this.schedule();
    };
    this.timer = window.setInterval(tick, 100);
    this.detach = () => {
      v.removeEventListener('pause', halt);
      v.removeEventListener('seeking', halt);
      v.removeEventListener('ended', halt);
    };
  }

  private detach: () => void = () => {};

  stop(): void {
    window.clearInterval(this.timer);
    this.detach();
    this.silence();
    void this.ctx?.close();
    this.ctx = null;
  }

  private silence(): void {
    for (const p of this.playing) {
      try {
        p.source.stop();
      } catch {
        /* already finished */
      }
    }
    this.playing = [];
    this.started.clear();
  }

  /** Starts each phrase due in the next fraction of a second, or one the video is already partway through. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = this.video.currentTime;
    const speed = this.video.playbackRate || 1;
    this.segments.forEach((s, i) => {
      const buffer = this.buffers[i];
      if (!buffer || this.started.has(i)) return;
      const ahead = s.start - now;
      const into = now - s.start; // how far into this phrase the video already is
      if (ahead > 0.3 || into * speed >= buffer.duration - 0.05) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = speed;
      source.connect(this.gain!);
      if (ahead > 0) source.start(ctx.currentTime + ahead / speed);
      else source.start(0, into * speed);
      source.onended = () => {
        this.playing = this.playing.filter((p) => p.source !== source);
      };
      // A new phrase cuts off one still speaking, so two never overlap.
      for (const p of this.playing) {
        try {
          p.source.stop(ctx.currentTime + Math.max(0, ahead / speed));
        } catch {
          /* already finished */
        }
      }
      this.playing.push({ source, index: i });
      this.started.add(i);
    });
  }
}

/** The phrases as a WebVTT file, for download or another player. */
export function toVtt(segments: VideoSegment[], original = false): string {
  const t = (s: number) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  return (
    'WEBVTT\n\n' +
    segments.map((s, i) => `${i + 1}\n${t(s.start)} --> ${t(s.end)}\n${original ? s.source_text : s.text}\n`).join('\n')
  );
}
