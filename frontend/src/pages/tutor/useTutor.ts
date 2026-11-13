import { useCallback, useEffect, useRef, useState } from 'react';
import { tutorService, type PronunciationScores, type TutorFeedback, type TutorLevel, type TutorScenario } from '@/services';
import type { Avatar } from './avatar';
import type { SharedImage } from './images';
import { tutorFor } from './people';
import { Speech, type Heard } from './speech';

export interface Line {
  id: number;
  role: 'user' | 'assistant';
  text: string; // what was said (for the tutor, the part spoken aloud)
  written?: string; // a subject tutor's written, line-by-line explanation
  images?: SharedImage[];
  spoken?: boolean;
  pronunciation?: PronunciationScores | null;
  feedback?: TutorFeedback;
  feedbackError?: string;
  state?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  cost?: number;
}

export interface TutorSettings {
  subject: string; // english, maths … or other
  subjectName: string; // when subject is other
  level: TutorLevel; // English
  scenario: TutorScenario; // English
  stage: 'primary' | 'secondary' | 'sixth_form' | 'university' | 'adult'; // other subjects
  style: 'explain' | 'hints';
  native: string;
  voice: string;
  rate: number;
  model: string;
  handsFree: boolean; // listen again as soon as the tutor has finished speaking
  coaching: boolean; // English: after each answer, the tutor says how to make it stronger
  interviewBrief: string; // the job interview scenario: the role and company, such as a job advert
}

export type Status = 'idle' | 'listening' | 'thinking' | 'speaking';

// A sentence is complete at . ! or ? (and any closing quote), followed by a space.
const SENTENCE = /^(.+?[.!?]+["')\]]?)\s+/s;

/**
 * The lesson: the conversation, and the loop of listening, thinking and speaking. The reply is
 * spoken sentence by sentence while it is still being written, so the tutor starts talking quickly.
 */
export function useTutor(settings: TutorSettings, speechReady: boolean) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [heard, setHeard] = useState(''); // what the learner is saying, as it is recognised
  const [caption, setCaption] = useState(''); // the sentence the tutor is saying now
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState(''); // information, such as which Azure resource is speaking
  const avatar = useRef<Avatar | null>(null);
  const speech = useRef(new Speech());
  const controller = useRef<AbortController | null>(null);
  const linesRef = useRef<Line[]>([]);
  const settingsRef = useRef(settings);
  const nextId = useRef(1);
  settingsRef.current = settings;
  linesRef.current = lines;
  speech.current.onFallback = () =>
    setNotice("Azure's free allowance is used up for now, so the paid Speech resource is used for the rest of this session.");

  useEffect(() => () => controller.current?.abort(), []);

  const update = useCallback((id: number, change: (l: Line) => Line) => {
    setLines((ls) => ls.map((l) => (l.id === id ? change(l) : l)));
  }, []);

  /** Speaks sentences in order: each is synthesised while the one before it plays. */
  const speaker = useCallback(() => {
    let chain = Promise.resolve();
    let failed = false;
    return {
      say(sentence: string) {
        const s = settingsRef.current;
        if (!speechReady || !avatar.current || !sentence.trim()) return;
        chain = chain
          .then(() => speech.current.synthesize(sentence.trim(), tutorFor(s.voice).voice, s.rate))
          .then((spoken) => avatar.current?.say(spoken, () => setCaption(sentence.trim())))
          .catch((err: Error) => {
            if (!failed) setProblem(`The voice failed: ${err.message}`);
            failed = true;
          });
      },
      done: () => chain,
    };
  }, [speechReady]);

  const listenRef = useRef<() => Promise<void>>(async () => undefined);
  const cancelled = useRef(false); // the learner pressed Stop: hearing nothing is then not a problem

  const send = useCallback(
    async (message: string, opts: { images?: SharedImage[]; heard?: Heard } = {}) => {
      const s = settingsRef.current;
      const images = opts.images ?? [];
      if (!message.trim() && !images.length) return;
      controller.current?.abort();
      avatar.current?.stop();
      const c = (controller.current = new AbortController());
      const userId = nextId.current++;
      const tutorId = nextId.current++;
      const history = linesRef.current
        .filter((l) => l.text.trim() || l.written)
        .map((l) => ({
          role: l.role,
          text: l.role === 'assistant' && l.written ? `${l.text}\n===\n${l.written}` : l.text || 'Please explain this.',
          ...(l.images?.length ? { images: l.images.map(({ media_type, data }) => ({ media_type, data })) } : {}),
        }));
      setLines((ls) => [
        ...ls,
        { id: userId, role: 'user', text: message, images, spoken: !!opts.heard, pronunciation: opts.heard?.pronunciation ?? null },
        { id: tutorId, role: 'assistant', text: '', written: '', state: 'streaming' },
      ]);
      setProblem('');
      setCaption('');
      setStatus('thinking');
      const voice = speaker();
      let pending = '';
      let speakingStarted = false;
      const speak = (text: string, final: boolean) => {
        pending += text;
        let m: RegExpExecArray | null;
        while ((m = SENTENCE.exec(pending))) {
          voice.say(m[1]);
          pending = pending.slice(m[0].length);
          if (!speakingStarted) {
            speakingStarted = true;
            setStatus('speaking');
          }
        }
        if (final && pending.trim()) {
          voice.say(pending);
          pending = '';
          setStatus('speaking');
        }
      };
      try {
        await tutorService.turn(
          {
            message,
            history,
            images: images.map(({ media_type, data }) => ({ media_type, data })),
            subject: s.subject,
            subject_name: s.subjectName,
            level: s.level,
            scenario: s.scenario,
            stage: s.stage,
            style: s.style,
            native_language: s.native,
            spoken: !!opts.heard,
            pronunciation: forTutor(opts.heard?.pronunciation ?? null),
            model: s.model || undefined,
            tutor_name: tutorFor(s.voice).name,
            coaching: s.coaching,
            interview_brief: s.scenario === 'interview' ? s.interviewBrief.slice(0, 8000) : '',
          },
          (ev) => {
            if (ev.type === 'text') {
              update(tutorId, (l) => ({ ...l, text: l.text + ev.text }));
              speak(ev.text, false);
            } else if (ev.type === 'written') {
              update(tutorId, (l) => ({ ...l, written: (l.written ?? '') + ev.text }));
            } else if (ev.type === 'reply') {
              speak('', true);
              update(tutorId, (l) => ({ ...l, text: ev.text, written: ev.written ?? l.written }));
            } else if (ev.type === 'feedback') {
              const { type: _t, ...feedback } = ev;
              update(userId, (l) => ({ ...l, feedback }));
              if (feedback.praise && !feedback.corrections.length) avatar.current?.gesture('thumbup');
            } else if (ev.type === 'feedback_error') {
              update(userId, (l) => ({ ...l, feedbackError: ev.message }));
            } else if (ev.type === 'error') {
              update(tutorId, (l) => ({ ...l, state: 'error', error: ev.message ?? ev.text }));
            } else if (ev.type === 'done') {
              update(tutorId, (l) => ({ ...l, cost: ev.cost, state: l.state === 'streaming' ? 'done' : l.state }));
            }
          },
          c.signal,
        );
        await voice.done();
        if (avatar.current && speechReady) await avatar.current.finished();
        if (controller.current !== c) return; // a newer message took over
        setCaption('');
        setStatus('idle');
        if (settingsRef.current.handsFree && speechReady) void listenRef.current();
      } catch (err) {
        const e = err as Error;
        update(tutorId, (l) => (e.name === 'AbortError' ? { ...l, state: 'stopped' } : { ...l, state: 'error', error: e.message }));
        if (controller.current === c) setStatus('idle');
      }
    },
    [speaker, speechReady, update],
  );

  /** Listens for one thing the learner says, then sends it with its pronunciation scores. */
  const listen = useCallback(async () => {
    if (!speechReady) return;
    controller.current?.abort();
    avatar.current?.stop();
    avatar.current?.attend(4000);
    setCaption('');
    setHeard('');
    setProblem('');
    setStatus('listening');
    cancelled.current = false;
    try {
      // Keep listening until the learner presses Done; hands-free, until they pause.
      const result = await speech.current.listen({ onPartial: setHeard, endOnPause: settingsRef.current.handsFree });
      setHeard('');
      if (!result.text) {
        setStatus('idle');
        if (!cancelled.current) setProblem("I didn't catch that. Press the microphone and try again.");
        return;
      }
      await send(result.text, { heard: result });
    } catch (err) {
      setStatus('idle');
      setProblem(micProblem(err as Error));
    }
  }, [send, speechReady]);
  listenRef.current = listen;

  /** The tutor says a sentence, then the learner says it and gets scored against it. */
  /** The tutor reads something aloud, such as a stronger answer, without listening afterwards. */
  const hear = useCallback(async (text: string) => {
    const s = settingsRef.current;
    if (!avatar.current || !speechReady) return;
    controller.current?.abort();
    avatar.current.stop();
    setProblem('');
    setStatus('speaking');
    try {
      const sentences = text.match(/[^.!?]+[.!?]*["')\]]?\s*/g) ?? [text];
      for (const sentence of sentences.map((x) => x.trim()).filter(Boolean)) {
        await avatar.current.say(await speech.current.synthesize(sentence, tutorFor(s.voice).voice, s.rate), () => setCaption(sentence));
      }
      await avatar.current.finished();
    } catch (err) {
      setProblem(`The voice failed: ${(err as Error).message}`);
    } finally {
      setCaption('');
      setStatus('idle');
    }
  }, [speechReady]);

  const practise = useCallback(
    async (sentence: string): Promise<Heard | null> => {
      const s = settingsRef.current;
      controller.current?.abort();
      setProblem('');
      try {
        if (avatar.current) {
          avatar.current.stop();
          setStatus('speaking');
          await avatar.current.say(await speech.current.synthesize(sentence, tutorFor(s.voice).voice, Math.min(s.rate, 0.9)), () =>
            setCaption(sentence),
          );
          await avatar.current.finished();
        }
        setCaption('');
        setStatus('listening');
        setHeard('');
        return await speech.current.listen({ reference: sentence, onPartial: setHeard });
      } catch (err) {
        setProblem(micProblem(err as Error));
        return null;
      } finally {
        setHeard('');
        setStatus('idle');
      }
    },
    [],
  );

  /** The learner has finished speaking: send what was heard so far. */
  const finishSpeaking = useCallback(() => speech.current.stopListening(true), []);

  /** Stops everything: listening (nothing is sent), the reply, and the voice. */
  const stop = useCallback(() => {
    cancelled.current = true;
    controller.current?.abort();
    speech.current.stopListening(false);
    avatar.current?.stop();
    setCaption('');
    setStatus('idle');
  }, []);

  const clear = useCallback(() => {
    stop();
    setLines([]);
  }, [stop]);

  return { lines, status, heard, caption, problem, notice, avatar, send, listen, practise, hear, stop, finishSpeaking, clear };
}

/** The scores the tutor needs: the totals, and only the words that need attention (all are shown on the page). */
function forTutor(p: PronunciationScores | null): PronunciationScores | null {
  if (!p) return null;
  const weak = p.words.filter((w) => (w.accuracy !== null && w.accuracy < 80) || (w.error && w.error !== 'None'));
  return { ...p, words: weak.slice(0, 200) };
}

function micProblem(err: Error): string {
  if (/permission|denied|NotAllowed/i.test(err.message)) return 'The browser was not allowed to use the microphone. Allow it in the address bar and try again.';
  if (/NotFound|device/i.test(err.message)) return 'No microphone was found.';
  return err.message;
}
