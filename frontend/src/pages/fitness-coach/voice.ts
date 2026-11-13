/* The coach's voice and ears. It speaks with Azure Speech (a token from the backend, so no key in the browser) and
   falls back to the browser's own voice when Azure Speech is not set up. It listens the same way, for a question such
   as "How's my form?", so nobody has to take a hand off the floor to ask. While the coach is speaking it stops
   listening, so it does not hear itself. */
import { ReplyPlayer } from '@/lib/replyPlayer';
import { Speech } from '@/pages/tutor/speech';

const VOICE = 'en-GB-SoniaNeural';
/** What counts as asking the coach. */
const ASKED = /\b(form|how am i doing|how'?s (it|this|that|my)|check me|coach)\b/i;

interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

function browserRecognition(): (new () => BrowserRecognition) | null {
  const w = window as unknown as Record<string, (new () => BrowserRecognition) | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class CoachVoice {
  private speech = new Speech();
  private player = new ReplyPlayer();
  private azureVoice = true;
  private azureEars = true;
  private listening = false; // the person wants to be heard
  private paused = 0; // while above 0, the microphone is off (the coach is speaking or thinking)
  private running = false;
  private browser: BrowserRecognition | null = null;
  private speakingNow = 0;

  /** The question heard, once it sounds like asking the coach. */
  onAsk: ((question: string) => void) | null = null;
  /** Everything heard so far, for the page to show. */
  onHeard: ((text: string) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  /** Call inside a click: browsers only let a page play sound it was clicked into playing. */
  unlock(): void {
    this.player.unlock();
    this.speech.prepare();
  }

  get speaking(): boolean {
    return this.speakingNow > 0;
  }

  /** Says one line. A newer line cuts off an older one. */
  async say(text: string): Promise<void> {
    this.speakingNow++;
    this.pause();
    try {
      if (this.azureVoice) {
        try {
          const spoken = await this.speech.synthesize(text, VOICE, 1);
          await this.player.play(spoken.audio);
          return;
        } catch {
          this.azureVoice = false; // not set up, or refused: the browser's voice from now on
        }
      }
      await this.browserSay(text);
    } finally {
      this.speakingNow--;
      this.resume();
    }
  }

  private browserSay(text: string): Promise<void> {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-GB';
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      window.setTimeout(resolve, 2000 + text.length * 90); // some browsers never send onend
    });
  }

  stopSpeaking(): void {
    this.player.stop();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /** Starts listening for questions, until stopListening(). */
  listen(): void {
    this.listening = true;
    void this.run();
  }

  stopListening(): void {
    this.listening = false;
    this.halt();
  }

  /** Turns the microphone off while the coach thinks or speaks. Each pause() needs a resume(). */
  pause(): void {
    this.paused++;
    this.halt();
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    if (!this.paused) window.setTimeout(() => void this.run(), 250);
  }

  private halt(): void {
    this.speech.stopListening(false);
    this.browser?.abort();
    this.browser = null;
  }

  /** One listening session at a time; it starts again whenever it ends while still wanted. */
  private async run(): Promise<void> {
    if (this.running || !this.listening || this.paused) return;
    this.running = true;
    try {
      if (this.azureEars) {
        try {
          await this.speech.listen({ language: 'en-GB', onPartial: (text) => this.heard(text) });
        } catch {
          this.azureEars = false;
          if (!browserRecognition()) {
            this.listening = false;
            this.onError?.('Voice questions need Azure Speech or a browser with speech recognition (Chrome or Edge).');
            return;
          }
        }
      } else {
        await this.browserListen();
      }
    } finally {
      this.running = false;
    }
    if (this.listening && !this.paused) window.setTimeout(() => void this.run(), 300);
  }

  private browserListen(): Promise<void> {
    const Recognition = browserRecognition();
    if (!Recognition) return Promise.resolve();
    return new Promise((resolve) => {
      const r = new Recognition();
      r.lang = 'en-GB';
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
        this.heard(text);
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed') {
          this.listening = false;
          this.onError?.('The browser refused the microphone.');
        }
      };
      r.onend = () => resolve();
      this.browser = r;
      r.start();
    });
  }

  private heard(text: string): void {
    this.onHeard?.(text);
    if (!ASKED.test(text)) return;
    this.halt(); // stop before asking, so the coach's answer is not heard as another question
    this.onAsk?.(text.trim());
  }
}
