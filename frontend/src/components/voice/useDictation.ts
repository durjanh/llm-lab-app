import { useEffect, useRef, useState } from 'react';
import { Speech } from '@/pages/tutor/speech';

/* Speaking instead of typing. Azure Speech first (the tutor's helper: a token from the backend, so no key in the
   browser, and it keeps listening through pauses until Done). If Azure Speech is not set up, the browser's own speech
   recognition, where the browser has one (Chrome and Edge send the audio to their own service to do it). */

interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionClass = new () => BrowserRecognition;

function browserRecognition(): RecognitionClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type DictationSource = 'azure' | 'browser';
/** How listening ends: keep the words in the box, keep them and send, or throw them away. */
type Ending = 'keep' | 'send' | 'cancel';

const join = (base: string, heard: string) => [base.trim(), heard.trim()].filter(Boolean).join(' ');

/**
 * Dictation into a text box. start(base) listens and calls onText with the base text plus what has been heard so far.
 * finish('keep') stops and leaves the words in the box; finish('send') stops and calls onSend with the full text;
 * finish('cancel') stops and puts the box back to the base text.
 */
export function useDictation(
  onText: (text: string) => void,
  onSend: (text: string) => void,
  onError: (message: string) => void,
) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState(''); // what has been heard so far, for the listening bar
  const speech = useRef<Speech | null>(null);
  const browser = useRef<BrowserRecognition | null>(null);
  const source = useRef<DictationSource | null>(null);
  const azureFailed = useRef(false);
  const base = useRef('');
  const latest = useRef('');
  const ending = useRef<Ending>('keep');

  useEffect(
    () => () => {
      speech.current?.stopListening(false);
      browser.current?.abort();
    },
    [],
  );

  const update = (text: string) => {
    latest.current = text;
    setHeard(text);
    onText(join(base.current, text));
  };

  // Called once listening has stopped, however it stopped.
  const ended = () => {
    setListening(false);
    setHeard('');
    const full = join(base.current, latest.current);
    if (ending.current === 'cancel') onText(base.current);
    else {
      onText(full);
      if (ending.current === 'send' && full) onSend(full);
    }
  };

  function startBrowser(): boolean {
    const Recognition = browserRecognition();
    if (!Recognition) return false;
    const r = new Recognition();
    r.lang = 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => update(Array.from(e.results, (res) => res[0]?.transcript ?? '').join(' '));
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') onError(`Speech recognition: ${e.error}.`);
    };
    r.onend = () => {
      browser.current = null;
      ended();
    };
    browser.current = r;
    source.current = 'browser';
    setListening(true);
    r.start();
    return true;
  }

  async function start(text: string) {
    if (listening) return;
    base.current = text;
    latest.current = '';
    ending.current = 'keep';
    if (azureFailed.current) {
      if (!startBrowser())
        onError('Speaking needs Azure Speech set up in the lab, or a browser with speech recognition.');
      return;
    }
    speech.current ??= new Speech();
    source.current = 'azure';
    setListening(true);
    try {
      const result = await speech.current.listen({ language: 'en-GB', onPartial: update });
      // finish() may have changed the ending while we were listening
      if ((ending.current as Ending) !== 'cancel') latest.current = result.text || latest.current;
      ended();
    } catch (err) {
      setListening(false);
      azureFailed.current = true; // not set up, or refused: use the browser from now on
      if (!startBrowser()) onError(`Could not listen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function finish(how: Ending) {
    ending.current = how;
    if (source.current === 'azure') speech.current?.stopListening(how !== 'cancel');
    else if (how === 'cancel') browser.current?.abort();
    else browser.current?.stop();
  }

  return { listening, heard, start, finish };
}
