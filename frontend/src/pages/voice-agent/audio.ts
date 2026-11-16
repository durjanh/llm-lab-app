import type * as SDK from 'microsoft-cognitiveservices-speech-sdk';
import { tutorService } from '@/services';

/*
 * Audio for the voice agent: the microphone (with echo cancellation, so the agent does not hear itself), a voice
 * activity detector, Azure's streaming recogniser on that same audio, and a player that knows how many milliseconds
 * of audio it has really played. The recogniser uses the tutor's token route and the SDK the tutor already loads;
 * the key stays on the server.
 */

const RATE = 16000;
const FRAME = 320; // 20 ms
const TOKEN_REUSE_MS = 8 * 60 * 1000;

let sdkLoad: Promise<typeof SDK> | null = null;
const loadSdk = () => (sdkLoad ??= import('microsoft-cognitiveservices-speech-sdk'));

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export interface VadHandlers {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onLevel?: (rms: number) => void;
}

/**
 * Energy-based voice activity. It tracks the room's noise floor, calls it speech when a frame is well above the floor
 * for `startMs`, and ends it after `hangMs` of quiet. Echo cancellation in the browser keeps the agent's own voice
 * from counting; headphones remove the problem.
 */
class Vad {
  private floor = 0.005;
  private loud = 0;
  private quiet = 0;
  speaking = false;
  constructor(
    private readonly h: VadHandlers,
    private readonly startMs = 120,
    private readonly hangMs = 400,
  ) {}

  frame(rms: number): void {
    this.h.onLevel?.(rms);
    const threshold = Math.max(0.018, this.floor * 3.5);
    if (rms > threshold) {
      this.loud += 20;
      this.quiet = 0;
      if (!this.speaking && this.loud >= this.startMs) {
        this.speaking = true;
        this.h.onSpeechStart();
      }
    } else {
      this.loud = 0;
      this.quiet += 20;
      if (!this.speaking) this.floor = this.floor * 0.95 + rms * 0.05;
      if (this.speaking && this.quiet >= this.hangMs) {
        this.speaking = false;
        this.h.onSpeechEnd();
      }
    }
  }

  reset(): void {
    this.loud = this.quiet = 0;
    if (this.speaking) {
      this.speaking = false;
      this.h.onSpeechEnd();
    }
  }
}

export interface RecogniserHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string, audioMs: number) => void;
  onError: (message: string) => void;
}

/** The microphone, the detector and the streaming recogniser, started together. */
export class Listener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private push: SDK.PushAudioInputStream | null = null;
  private recogniser: SDK.SpeechRecognizer | null = null;
  private vad: Vad;
  private pending: number[] = [];
  private tokenTimer = 0;
  /** When false, frames are dropped: push-to-talk holds this closed between presses. */
  open = true;

  constructor(
    vad: VadHandlers,
    private readonly rec: RecogniserHandlers,
    private readonly segmentationMs: number,
  ) {
    this.vad = new Vad(vad);
  }

  /** Call inside a click, so the browser lets audio start. */
  async start(): Promise<void> {
    const sdk = await loadSdk();
    const token = await tutorService.speechToken(false);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext({ sampleRate: RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(this.ctx, 'tap');
    this.ctx.createMediaStreamSource(this.stream).connect(tap);
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.samples(e.data);

    this.push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(RATE, 16, 1));
    const config = sdk.SpeechConfig.fromAuthorizationToken(token.token, token.region);
    config.speechRecognitionLanguage = 'en-GB';
    // The recogniser's own pause before it finalises a sentence. Shorter finals arrive sooner, which is what the
    // turn detector wants; the turn detector, not this, decides when the turn ends.
    config.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(this.segmentationMs));
    const recogniser = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(this.push));
    this.recogniser = recogniser;
    recogniser.recognizing = (_s, e) => e.result.text && this.rec.onPartial(e.result.text);
    recogniser.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        this.rec.onFinal(e.result.text, e.result.duration / 10_000);
      }
    };
    recogniser.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) this.rec.onError(e.errorDetails || 'Speech recognition failed.');
    };
    await new Promise<void>((resolve, reject) =>
      recogniser.startContinuousRecognitionAsync(resolve, (err) => reject(new Error(err))),
    );
    // A token lasts ten minutes: give the recogniser a fresh one before it runs out.
    this.tokenTimer = window.setInterval(() => {
      void tutorService.speechToken(false).then((t) => {
        if (this.recogniser) this.recogniser.authorizationToken = t.token;
      });
    }, TOKEN_REUSE_MS);
  }

  private samples(data: Float32Array): void {
    for (const s of data) this.pending.push(s);
    while (this.pending.length >= FRAME) {
      const frame = this.pending.splice(0, FRAME);
      if (!this.open) continue;
      let sum = 0;
      const pcm = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i++) {
        sum += frame[i] * frame[i];
        pcm[i] = Math.max(-1, Math.min(1, frame[i])) * 0x7fff;
      }
      this.vad.frame(Math.sqrt(sum / FRAME));
      this.push?.write(pcm.buffer);
    }
  }

  /** Quiet audio for the recogniser, so it finalises what it heard when push-to-talk is released. */
  flushSilence(ms = 800): void {
    this.push?.write(new Int16Array((RATE * ms) / 1000).buffer);
  }

  endSpeech(): void {
    this.vad.reset();
  }

  get speaking(): boolean {
    return this.vad.speaking;
  }

  stop(): void {
    window.clearInterval(this.tokenTimer);
    const recogniser = this.recogniser;
    this.recogniser = null;
    try {
      recogniser?.stopContinuousRecognitionAsync(
        () => recogniser.close(),
        () => recogniser.close(),
      );
    } catch {
      /* already closed */
    }
    this.push?.close();
    this.push = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
  }
}

interface Scheduled {
  reply: string;
  source: AudioBufferSourceNode;
  start: number;
  duration: number;
}

/**
 * Plays a reply's pieces back to back as they arrive, and counts the audio it really played: pieces that have not
 * started do not count, and neither do the gaps between pieces while the next one was being made.
 */
export class Player {
  private ctx: AudioContext | null = null;
  private queue: Scheduled[] = [];
  private next = 0;
  private startedFor = new Set<string>();
  private doneFor = new Set<string>();
  private complete = new Set<string>();
  private timer = 0;
  onStarted: (reply: string) => void = () => undefined;
  onFinished: (reply: string) => void = () => undefined;

  /** Call inside a click. */
  unlock(): void {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.timer ||= window.setInterval(() => this.watch(), 25);
  }

  async enqueue(reply: string, wav: ArrayBuffer): Promise<void> {
    if (!this.ctx) return;
    const buffer = await this.ctx.decodeAudioData(wav.slice(0));
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime + 0.02, this.next);
    source.start(start);
    this.next = start + buffer.duration;
    this.queue.push({ reply, source, start, duration: buffer.duration });
  }

  /** The reply's last piece has been queued: once it ends, the reply is finished. */
  markComplete(reply: string): void {
    this.complete.add(reply);
  }

  /** Milliseconds of this reply's audio played so far. */
  playedMs(reply: string): number {
    const now = this.ctx?.currentTime ?? 0;
    return (
      1000 *
      this.queue
        .filter((s) => s.reply === reply)
        .reduce((sum, s) => sum + Math.min(s.duration, Math.max(0, now - s.start)), 0)
    );
  }

  /** Whether anything is playing or waiting to play. */
  get busy(): boolean {
    const now = this.ctx?.currentTime ?? 0;
    return this.queue.some((s) => s.start + s.duration > now);
  }

  get activeReply(): string | null {
    const now = this.ctx?.currentTime ?? 0;
    return this.queue.find((s) => s.start + s.duration > now)?.reply ?? null;
  }

  /** Stops everything at once and returns the milliseconds that had played, for the reply that was active. */
  stop(): { reply: string | null; playedMs: number } {
    const reply = this.activeReply;
    const playedMs = reply ? this.playedMs(reply) : 0;
    for (const s of this.queue) {
      try {
        s.source.stop();
      } catch {
        /* it had not started */
      }
    }
    this.queue = [];
    this.next = 0;
    return { reply, playedMs };
  }

  private watch(): void {
    const now = this.ctx?.currentTime ?? 0;
    for (const s of this.queue) {
      if (now >= s.start && !this.startedFor.has(s.reply)) {
        this.startedFor.add(s.reply);
        this.onStarted(s.reply);
      }
    }
    for (const reply of this.complete) {
      const mine = this.queue.filter((s) => s.reply === reply);
      if (mine.length && mine.every((s) => now >= s.start + s.duration) && !this.doneFor.has(reply)) {
        this.doneFor.add(reply);
        this.onFinished(reply);
      }
    }
  }

  close(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

export function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
