import type { Note, Voice } from './songs';

/**
 * A two-voice syrinx synth in Web Audio, following the bird's own signal path:
 *
 *   breath (air sacs) → left and right voices (each side's vibrating folds) → throat chamber (a resonance that follows
 *   the note) → windpipe (a tube with fixed resonances) → beak (opens wider for higher notes, letting them out)
 *
 * Each voice is a pure tone plus a harmonic-rich tone sharing one frequency, so "harmonics" blends from whistle to
 * buzz. Scores are scheduled ahead on the audio clock; the keyboard sets the same parameters live.
 */

export interface Controls {
  breath: number; // air-sac pressure, 0 to 1: loudness and a little breath noise
  glideMs: number; // how long a played note slides from the last one
  detuneCents: number; // the right voice against the left, when both sing one key
  grit: number; // 0 to 1: harmonics added to played notes
  tubeMm: number; // windpipe length: sets its resonances
  wah: number; // 0 to 1: how much the throat chamber shapes the sound
  lfoRate: number; // warble rate, Hz
  lfoDepth: number; // warble depth, fraction of the frequency
}

export type PlayMode = 'duo' | 'left' | 'right' | 'both';

export const DEFAULT_CONTROLS: Controls = {
  breath: 0.7,
  glideMs: 30,
  detuneCents: 4,
  grit: 0.15,
  tubeMm: 36,
  wah: 0.6,
  lfoRate: 6,
  lfoDepth: 0.01,
};

/** Where duo mode hands a played note from the left side to the right. */
export const SPLIT_HZ = 2600;
const SOUND_SPEED = 343; // m/s

/** A tube closed at the syrinx and open at the beak resonates at odd quarter wavelengths. */
export const tubeResonances = (mm: number) => [1, 3].map((k) => (k * SOUND_SPEED) / (4 * (mm / 1000)));

export interface VoiceState {
  freq: number;
  amp: number;
}

class VoiceChain {
  readonly freq: ConstantSourceNode;
  readonly pure: GainNode;
  readonly rich: GainNode;
  readonly lfo: OscillatorNode;
  readonly lfoAmount: GainNode;
  readonly dry: GainNode;
  readonly wet: GainNode;
  readonly amp: GainNode;
  private readonly sources: AudioScheduledSourceNode[];

  constructor(ctx: AudioContext, wave: PeriodicWave, out: AudioNode) {
    this.freq = new ConstantSourceNode(ctx, { offset: 2000 });
    const sine = new OscillatorNode(ctx, { type: 'sine', frequency: 0 });
    const buzz = new OscillatorNode(ctx, { frequency: 0 });
    buzz.setPeriodicWave(wave);
    this.freq.connect(sine.frequency);
    this.freq.connect(buzz.frequency);
    this.lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 6 });
    this.lfoAmount = new GainNode(ctx, { gain: 0 });
    this.lfo.connect(this.lfoAmount);
    this.lfoAmount.connect(sine.frequency);
    this.lfoAmount.connect(buzz.frequency);
    this.pure = new GainNode(ctx, { gain: 1 });
    this.rich = new GainNode(ctx, { gain: 0 });
    sine.connect(this.pure);
    buzz.connect(this.rich);
    const mix = new GainNode(ctx);
    this.pure.connect(mix);
    this.rich.connect(mix);
    // The throat chamber: a band-pass whose centre follows the note.
    const throat = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 0, Q: 2.2 });
    this.freq.connect(throat.frequency);
    this.dry = new GainNode(ctx, { gain: 0.4 });
    this.wet = new GainNode(ctx, { gain: 1.4 });
    mix.connect(this.dry);
    mix.connect(throat);
    throat.connect(this.wet);
    this.amp = new GainNode(ctx, { gain: 0 });
    this.dry.connect(this.amp);
    this.wet.connect(this.amp);
    this.amp.connect(out);
    this.sources = [this.freq, sine, buzz, this.lfo];
    this.sources.forEach((s) => s.start());
  }

  params(): AudioParam[] {
    return [this.freq.offset, this.pure.gain, this.rich.gain, this.lfo.frequency, this.lfoAmount.gain, this.amp.gain];
  }

  stop() {
    this.sources.forEach((s) => s.stop());
  }
}

export class SyrinxSynth {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private readonly voices: Record<Voice, VoiceChain>;
  private readonly tube: BiquadFilterNode[];
  private readonly beak: BiquadFilterNode;
  private readonly gape: ConstantSourceNode;
  private readonly breathNoise: GainNode;
  private readonly master: GainNode;
  private controls: Controls = { ...DEFAULT_CONTROLS };
  // What is playing, for the drawing: a score and when it started, or the live keyboard's targets.
  private score: { notes: Note[]; start: number } | null = null;
  private live: Record<Voice, VoiceState> = { L: { freq: 0, amp: 0 }, R: { freq: 0, amp: 0 } };

  constructor() {
    this.ctx = new AudioContext();
    const ctx = this.ctx;
    // A buzzy wave: every harmonic, falling off gently, like folds that slap shut each cycle.
    const n = 28;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.1);
    const wave = ctx.createPeriodicWave(real, imag);

    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    this.master = new GainNode(ctx, { gain: 0.5 });
    const compressor = new DynamicsCompressorNode(ctx, { threshold: -14, ratio: 6 });
    this.master.connect(compressor);
    compressor.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // The beak: a low-pass whose cutoff rises as the beak opens.
    this.gape = new ConstantSourceNode(ctx, { offset: 6000 });
    this.beak = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 0, Q: 0.7 });
    this.gape.connect(this.beak.frequency);
    this.gape.start();
    this.beak.connect(this.master);

    // The windpipe: two peaks at the tube's resonances.
    this.tube = tubeResonances(this.controls.tubeMm).map(
      (f) => new BiquadFilterNode(ctx, { type: 'peaking', frequency: f, Q: 3, gain: 7 }),
    );
    this.tube[0].connect(this.tube[1]);
    this.tube[1].connect(this.beak);
    const merge = new GainNode(ctx);
    merge.connect(this.tube[0]);

    this.voices = { L: new VoiceChain(ctx, wave, merge), R: new VoiceChain(ctx, wave, merge) };

    // Breath: a little filtered noise while air flows.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = new AudioBufferSourceNode(ctx, { buffer, loop: true });
    const hiss = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3000, Q: 0.6 });
    this.breathNoise = new GainNode(ctx, { gain: 0 });
    noise.connect(hiss);
    hiss.connect(this.breathNoise);
    this.breathNoise.connect(merge);
    noise.start();
  }

  setControls(next: Partial<Controls>) {
    this.controls = { ...this.controls, ...next };
    const c = this.controls;
    const now = this.ctx.currentTime;
    tubeResonances(c.tubeMm).forEach((f, i) => this.tube[i].frequency.setTargetAtTime(f, now, 0.02));
    for (const v of Object.values(this.voices)) {
      v.dry.gain.setTargetAtTime(1 - c.wah * 0.75, now, 0.02);
      v.wet.gain.setTargetAtTime(c.wah * 1.6, now, 0.02);
    }
    this.master.gain.setTargetAtTime(0.25 + c.breath * 0.45, now, 0.02);
  }

  getControls(): Controls {
    return { ...this.controls };
  }

  resume() {
    return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
  }

  /** Silences everything and clears any scheduled score. */
  stop() {
    const now = this.ctx.currentTime;
    for (const v of Object.values(this.voices)) {
      for (const p of v.params()) p.cancelScheduledValues(now);
      v.amp.gain.setTargetAtTime(0, now, 0.01);
      v.lfoAmount.gain.setValueAtTime(0, now);
    }
    this.breathNoise.gain.cancelScheduledValues(now);
    this.breathNoise.gain.setTargetAtTime(0, now, 0.01);
    this.score = null;
    this.live = { L: { freq: 0, amp: 0 }, R: { freq: 0, amp: 0 } };
  }

  /** Schedules a score from now. Returns its length in seconds. */
  play(notes: Note[]): number {
    this.stop();
    const start = this.ctx.currentTime + 0.08;
    const breathLevel = 0.004 + this.controls.breath * 0.01;
    for (const n of [...notes].sort((a, b) => a.t - b.t)) {
      const v = this.voices[n.voice];
      const t0 = start + n.t;
      const t1 = t0 + n.d;
      const attack = Math.min(0.012, n.d / 4);
      const release = Math.min(0.018, n.d / 3);
      v.freq.offset.setValueAtTime(n.f0, t0);
      v.freq.offset.exponentialRampToValueAtTime(Math.max(50, n.f1), t1);
      v.pure.gain.setValueAtTime(1 - n.harm * 0.85, t0);
      v.rich.gain.setValueAtTime(n.harm * 0.55, t0);
      v.amp.gain.setValueAtTime(0, t0);
      v.amp.gain.linearRampToValueAtTime(n.amp * 0.6, t0 + attack);
      v.amp.gain.setValueAtTime(n.amp * 0.6, t1 - release);
      v.amp.gain.linearRampToValueAtTime(0, t1);
      if (n.trill) {
        v.lfo.frequency.setValueAtTime(n.trill, t0);
        v.lfoAmount.gain.setValueAtTime(n.f0 * (n.trillDepth ?? 0.03), t0);
        v.lfoAmount.gain.setValueAtTime(0, t1);
      }
      // The beak opens for high notes; a puff of breath noise rides each note.
      this.gape.offset.setValueAtTime(Math.min(12000, Math.max(n.f0, n.f1) * 2.4 + 800), t0);
      this.breathNoise.gain.setValueAtTime(breathLevel * n.amp, t0);
      this.breathNoise.gain.setValueAtTime(0, t1);
    }
    const length = notes.reduce((end, n) => Math.max(end, n.t + n.d), 0);
    this.score = { notes, start };
    return length;
  }

  /** Starts or moves a held note from the keyboard. Duo mode sends low notes left and high notes right. */
  noteOn(freq: number, mode: PlayMode) {
    const c = this.controls;
    const now = this.ctx.currentTime;
    const glide = Math.max(0.002, c.glideMs / 1000 / 3);
    const sides: Voice[] =
      mode === 'both' ? ['L', 'R'] : mode === 'left' ? ['L'] : mode === 'right' ? ['R'] : [freq < SPLIT_HZ ? 'L' : 'R'];
    this.score = null;
    for (const side of ['L', 'R'] as Voice[]) {
      const v = this.voices[side];
      for (const p of v.params()) p.cancelScheduledValues(now);
      if (!sides.includes(side)) {
        v.amp.gain.setTargetAtTime(0, now, 0.015);
        this.live[side] = { freq: this.live[side].freq, amp: 0 };
        continue;
      }
      const f = side === 'R' && mode === 'both' ? freq * Math.pow(2, c.detuneCents / 1200) : freq;
      v.freq.offset.setTargetAtTime(f, now, this.live[side].amp > 0 ? glide : 0.001);
      v.pure.gain.setTargetAtTime(1 - c.grit * 0.85, now, 0.01);
      v.rich.gain.setTargetAtTime(c.grit * 0.55, now, 0.01);
      v.lfo.frequency.setTargetAtTime(c.lfoRate, now, 0.01);
      v.lfoAmount.gain.setTargetAtTime(f * c.lfoDepth, now, 0.05);
      const amp = 0.3 + c.breath * 0.35;
      v.amp.gain.setTargetAtTime(amp, now, 0.012);
      this.live[side] = { freq: f, amp };
    }
    this.gape.offset.setTargetAtTime(Math.min(12000, freq * 2.4 + 800), now, 0.02);
    this.breathNoise.gain.setTargetAtTime(0.003 + c.breath * 0.008, now, 0.02);
  }

  noteOff() {
    const now = this.ctx.currentTime;
    for (const side of ['L', 'R'] as Voice[]) {
      this.voices[side].amp.gain.setTargetAtTime(0, now, 0.03);
      this.live[side] = { ...this.live[side], amp: 0 };
    }
    this.breathNoise.gain.setTargetAtTime(0, now, 0.03);
  }

  /** What each side is singing right now, for the drawing. */
  state(): { L: VoiceState; R: VoiceState; playing: boolean; progress: number } {
    if (!this.score) {
      const on = this.live.L.amp > 0 || this.live.R.amp > 0;
      return { L: this.live.L, R: this.live.R, playing: on, progress: 0 };
    }
    const t = this.ctx.currentTime - this.score.start;
    const out: Record<Voice, VoiceState> = { L: { freq: 0, amp: 0 }, R: { freq: 0, amp: 0 } };
    let length = 0;
    for (const n of this.score.notes) {
      length = Math.max(length, n.t + n.d);
      if (t >= n.t && t <= n.t + n.d) {
        const k = (t - n.t) / n.d;
        out[n.voice] = { freq: n.f0 * Math.pow(n.f1 / n.f0, k), amp: n.amp };
      }
    }
    if (t > length + 0.2) {
      this.score = null;
      return { ...out, playing: false, progress: 1 };
    }
    return { ...out, playing: t >= 0, progress: Math.max(0, Math.min(1, t / length)) };
  }

  close() {
    this.stop();
    Object.values(this.voices).forEach((v) => v.stop());
    void this.ctx.close();
  }
}
