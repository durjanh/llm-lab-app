import type * as SDK from 'microsoft-cognitiveservices-speech-sdk';
import { tutorService, type PronunciationScores } from '@/services';

/**
 * Azure Speech in the browser: the tutor's voice with the timing of every mouth shape, and the
 * learner's speech as text with pronunciation scores. It signs in with a token from the backend,
 * so the Azure key stays on the server. The SDK is loaded the first time it is needed.
 */

/** What the avatar needs to say one sentence: the audio, and when each word and mouth shape starts. */
export interface Spoken {
  audio: ArrayBuffer;
  words: string[];
  wtimes: number[];
  wdurations: number[];
  visemes: string[];
  vtimes: number[];
  vdurations: number[];
}

export interface ListenOptions {
  reference?: string;
  onPartial?: (text: string) => void;
  endOnPause?: boolean;
  /** Called once Azure is connected and hearing the microphone; words spoken before this are lost. */
  onStarted?: () => void;
  /** Recognition language, such as en-GB or es-ES. Pronunciation is scored only for the default, en-US. */
  language?: string;
}

export interface Heard {
  text: string;
  pronunciation: PronunciationScores | null;
}

// Azure's 22 viseme ids as the avatar's 15 Oculus mouth shapes (from TalkingHead's Azure example).
const VISEMES = ['sil', 'aa', 'aa', 'O', 'E', 'RR', 'I', 'U', 'O', 'O', 'O', 'I', 'kk', 'RR', 'nn', 'SS', 'CH', 'TH', 'FF', 'DD', 'kk', 'PP'];
const TICKS_PER_MS = 10_000; // Azure times are in 100-nanosecond ticks
const TOKEN_REUSE_MS = 8 * 60 * 1000;

/** The tutors: each is one person, with their own face and voice. */
export const VOICES = [
  { id: 'en-GB-SoniaNeural', name: 'Sonia', label: 'Sonia (British)', avatar: 'sonia' },
  { id: 'en-US-AvaNeural', name: 'Ava', label: 'Ava (American)', avatar: 'ava' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', label: 'Ryan (British)', avatar: 'ryan' },
] as const;

/** The tutor who speaks with this voice; the first one for a voice that is no longer offered. */
export const tutorFor = (voice: string) => VOICES.find((v) => v.id === voice) ?? VOICES[0];

let sdkLoad: Promise<typeof SDK> | null = null;
const loadSdk = () => (sdkLoad ??= import('microsoft-cognitiveservices-speech-sdk'));

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);

// Azure's answers when a free-tier resource has used its monthly allowance or its requests per minute.
const REFUSED = /quota|429|too many|throttl|exceed|limit/i;

export class Speech {
  private token: { value: string; region: string; at: number; fallback: boolean } | null = null;
  private active: { recognizer: SDK.SpeechRecognizer; stop: (send: boolean) => void } | null = null;
  private fallback = false; // switched on for the rest of the session once the free resource refuses
  private hasFallback = false;
  /** Called once, when the free resource refuses and the paid one takes over. */
  onFallback: (() => void) | null = null;

  private async config(): Promise<{ sdk: typeof SDK; config: SDK.SpeechConfig }> {
    const sdk = await loadSdk();
    if (!this.token || this.token.fallback !== this.fallback || Date.now() - this.token.at > TOKEN_REUSE_MS) {
      const t = await tutorService.speechToken(this.fallback);
      this.token = { value: t.token, region: t.region, at: Date.now(), fallback: this.fallback };
      this.hasFallback = t.has_fallback;
    }
    return { sdk, config: sdk.SpeechConfig.fromAuthorizationToken(this.token.value, this.token.region) };
  }

  /**
   * Loads the speech SDK and fetches a token ahead of the first use, so pressing the microphone does not wait for
   * them. Failures are ignored here: listen() reports them when it is called.
   */
  prepare(): void {
    void this.config().catch(() => undefined);
  }

  /** Runs an Azure call; if the free resource refuses it, switches to the paid one and runs it again. */
  private async withFallback<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (this.fallback || !this.hasFallback || !REFUSED.test((err as Error).message)) throw err;
      this.fallback = true;
      this.onFallback?.();
      return call();
    }
  }

  /** Synthesises one sentence without playing it: the avatar plays the audio and moves its lips in time. */
  synthesize(text: string, voice: string, rate: number): Promise<Spoken> {
    return this.withFallback(() => this.synthesizeOnce(text, voice, rate));
  }

  private async synthesizeOnce(text: string, voice: string, rate: number): Promise<Spoken> {
    const { sdk, config } = await this.config();
    config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
    const synthesizer = new sdk.SpeechSynthesizer(config, null as unknown as SDK.AudioConfig); // null: keep the audio, don't play it
    const out: Spoken = { audio: new ArrayBuffer(0), words: [], wtimes: [], wdurations: [], visemes: [], vtimes: [], vdurations: [] };
    synthesizer.visemeReceived = (_s, e) => {
      out.visemes.push(VISEMES[e.visemeId] ?? 'sil');
      out.vtimes.push(e.audioOffset / TICKS_PER_MS);
    };
    synthesizer.wordBoundary = (_s, e) => {
      if (e.boundaryType !== sdk.SpeechSynthesisBoundaryType.Word) return;
      out.words.push(e.text);
      out.wtimes.push(e.audioOffset / TICKS_PER_MS);
      out.wdurations.push(e.duration / TICKS_PER_MS);
    };
    const percent = Math.round((rate - 1) * 100);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.split('-').slice(0, 2).join('-')}"><voice name="${voice}">` +
      `<prosody rate="${percent >= 0 ? '+' : ''}${percent}%">${escapeXml(text)}</prosody></voice></speak>`;
    try {
      const result = await new Promise<SDK.SpeechSynthesisResult>((resolve, reject) =>
        synthesizer.speakSsmlAsync(ssml, resolve, (err) => reject(new Error(err))),
      );
      if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
        throw new Error(result.errorDetails || 'Azure could not synthesise the speech.');
      }
      out.audio = result.audioData;
    } finally {
      synthesizer.close();
    }
    // Each mouth shape lasts until the next one starts; the last one briefly.
    out.vdurations = out.vtimes.map((t, i) => Math.max(40, (out.vtimes[i + 1] ?? t + 100) - t));
    return out;
  }

  /**
   * Listens to the learner. In a conversation it keeps listening through pauses, sentence after
   * sentence, until stopListening() is called (the Done button), or, with endOnPause (hands-free),
   * until they have been quiet for a moment. With `reference` (say-it-again) it listens for that one
   * sentence and scores it against the reference.
   */
  listen(opts: ListenOptions = {}): Promise<Heard> {
    return this.withFallback(() => this.listenOnce(opts));
  }

  private async listenOnce(opts: ListenOptions): Promise<Heard> {
    this.stopListening(false); // only one microphone listener at a time
    const { sdk, config } = await this.config();
    const language = opts.language ?? 'en-US'; // the tutor's default: prosody scores are given for US English only
    config.speechRecognitionLanguage = language;
    // A pause of this long ends a sentence; the next one is heard as another sentence.
    config.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, opts.reference ? '1500' : '1200');
    const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromDefaultMicrophoneInput());
    if (language === 'en-US') {
      // Pronunciation scores, for the tutor. Other languages (the follow-up agent's) only need the words.
      const assessment = new sdk.PronunciationAssessmentConfig(
        opts.reference ?? '',
        sdk.PronunciationAssessmentGradingSystem.HundredMark,
        sdk.PronunciationAssessmentGranularity.Word,
        !!opts.reference, // miscues: words left out or added, only meaningful against a reference
      );
      assessment.enableProsodyAssessment = true;
      assessment.applyTo(recognizer);
    }
    try {
      return await (opts.reference ? this.once(sdk, recognizer, opts.onPartial) : this.continuous(sdk, recognizer, opts));
    } finally {
      if (this.active?.recognizer === recognizer) this.active = null;
      closeOnce(recognizer);
    }
  }

  /** One sentence, ended by a pause, for say-it-again. */
  private once(sdk: typeof SDK, recognizer: SDK.SpeechRecognizer, onPartial?: (text: string) => void): Promise<Heard> {
    let partial = '';
    recognizer.recognizing = (_s, e) => {
      partial = e.result.text;
      onPartial?.(partial);
    };
    // Stopping early settles this promise; closing the recognizer alone would leave recognizeOnce waiting.
    const stopped = new Promise<Heard>((resolve) => {
      this.active = { recognizer, stop: (send) => resolve({ text: send ? partial : '', pronunciation: null }) };
    });
    const recognised = new Promise<Heard>((resolve, reject) =>
      recognizer.recognizeOnceAsync((result) => {
        if (result.reason === sdk.ResultReason.Canceled) {
          const details = sdk.CancellationDetails.fromResult(result);
          if (details.reason === sdk.CancellationReason.Error) return reject(new Error(details.errorDetails || 'Speech recognition failed.'));
          return resolve({ text: '', pronunciation: null });
        }
        if (result.reason !== sdk.ResultReason.RecognizedSpeech || !result.text) return resolve({ text: '', pronunciation: null });
        resolve({ text: result.text, pronunciation: scores(sdk, result) });
      }, (err) => reject(new Error(err))),
    );
    return Promise.race([recognised, stopped]);
  }

  /** Everything the learner says, sentence by sentence, until they press Done (or pause, hands-free). */
  private continuous(sdk: typeof SDK, recognizer: SDK.SpeechRecognizer, opts: ListenOptions): Promise<Heard> {
    const sentences: { text: string; scores: PronunciationScores | null }[] = [];
    let partial = '';
    let pauseTimer = 0;
    const heardSoFar = () => [...sentences.map((x) => x.text), partial].filter(Boolean).join(' ');
    return new Promise<Heard>((resolve, reject) => {
      let finished = false;
      const finish = (send: boolean) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(pauseTimer);
        const done = () => {
          // Words still being recognised when Done was pressed are kept, without scores.
          if (partial) sentences.push({ text: partial, scores: null });
          resolve(send ? combine(sentences) : { text: '', pronunciation: null });
        };
        // Stopping flushes the sentence in progress as one last recognised event.
        recognizer.stopContinuousRecognitionAsync(done, done);
      };
      // Hands-free: a pause after the learner has said something ends their turn; long silence ends it too.
      const waitForPause = (ms: number) => {
        window.clearTimeout(pauseTimer);
        if (opts.endOnPause) pauseTimer = window.setTimeout(() => finish(true), ms);
      };
      recognizer.recognizing = (_s, e) => {
        partial = e.result.text;
        opts.onPartial?.(heardSoFar());
        waitForPause(4000);
      };
      recognizer.recognized = (_s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          sentences.push({ text: e.result.text, scores: scores(sdk, e.result) });
        }
        partial = '';
        opts.onPartial?.(heardSoFar());
        waitForPause(sentences.length ? 1500 : 8000);
      };
      recognizer.canceled = (_s, e) => {
        if (e.reason === sdk.CancellationReason.Error && !finished) {
          finished = true;
          reject(new Error(e.errorDetails || 'Speech recognition failed.'));
        }
      };
      this.active = { recognizer, stop: finish };
      recognizer.startContinuousRecognitionAsync(
        () => {
          opts.onStarted?.();
          waitForPause(8000);
        },
        (err) => reject(new Error(err)),
      );
    });
  }

  /** Ends listening early. With send, listen() returns what was heard so far; without, nothing. */
  stopListening(send = true): void {
    const active = this.active;
    this.active = null;
    active?.stop(send);
    if (active) closeOnce(active.recognizer);
  }
}

const closed = new WeakSet<SDK.SpeechRecognizer>();

/** The SDK throws "the object is already disposed" when a recognizer is closed twice. */
function closeOnce(recognizer: SDK.SpeechRecognizer): void {
  if (closed.has(recognizer)) return;
  closed.add(recognizer);
  try {
    recognizer.close();
  } catch {
    /* it was already closed */
  }
}

/** Several sentences as one answer: the text joined, the scores averaged by the number of words. */
function combine(sentences: { text: string; scores: PronunciationScores | null }[]): Heard {
  const text = sentences.map((x) => x.text).join(' ').trim();
  const scored = sentences.map((x) => x.scores).filter((x): x is PronunciationScores => !!x);
  if (!scored.length) return { text, pronunciation: null };
  const average = (key: 'accuracy' | 'fluency' | 'prosody' | 'completeness' | 'overall') => {
    const parts = scored.filter((x) => typeof x[key] === 'number').map((x) => ({ v: x[key] as number, w: Math.max(1, x.words.length) }));
    const weight = parts.reduce((n, x) => n + x.w, 0);
    return weight ? parts.reduce((n, x) => n + x.v * x.w, 0) / weight : null;
  };
  return {
    text,
    pronunciation: {
      accuracy: average('accuracy'),
      fluency: average('fluency'),
      prosody: average('prosody'),
      completeness: average('completeness'),
      overall: average('overall'),
      words: scored.flatMap((x) => x.words),
    },
  };
}

function scores(sdk: typeof SDK, result: SDK.SpeechRecognitionResult): PronunciationScores | null {
  try {
    const p = sdk.PronunciationAssessmentResult.fromResult(result);
    const num = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    return {
      accuracy: num(p.accuracyScore),
      fluency: num(p.fluencyScore),
      prosody: num(p.prosodyScore),
      completeness: num(p.completenessScore),
      overall: num(p.pronunciationScore),
      words: (p.detailResult?.Words ?? []).map((w) => ({
        word: w.Word,
        accuracy: num(w.PronunciationAssessment?.AccuracyScore),
        error: w.PronunciationAssessment?.ErrorType ?? null,
      })),
    };
  } catch {
    return null;
  }
}
