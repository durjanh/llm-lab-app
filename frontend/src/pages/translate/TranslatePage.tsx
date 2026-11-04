import { useEffect, useState } from 'react';
import type * as SDK from 'microsoft-cognitiveservices-speech-sdk';
import {
  translateService as svc,
  tutorService,
  type AudioAnswer,
  type ComplaintEntry,
  type LlmTranslation,
  type TranslateInfo,
  type TranslatorResult,
} from '@/services';
import { Chips, Panel, Problem, useCall, usd } from '@/pages/ai103/shared';

const NAMES: Record<string, string> = {
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pl: 'Polish',
  cy: 'Welsh',
  ar: 'Arabic',
  ur: 'Urdu',
  'zh-Hans': 'Chinese',
  en: 'English',
};
const VOICES: Record<string, string> = {
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  pl: 'pl-PL-AgnieszkaNeural',
  cy: 'cy-GB-NiaNeural',
  en: 'en-GB-SoniaNeural',
};
const PHRASES = ['Harbour Road', 'Harbour Mutual', 'HM-HOME-558120'];

let sdkLoad: Promise<typeof SDK> | null = null;
const loadSdk = () => (sdkLoad ??= import('microsoft-cognitiveservices-speech-sdk'));

/** Audio from the sample narration (a WAV file) or the microphone, for the Speech SDK. */
async function audioInput(sdk: typeof SDK, mic: boolean): Promise<SDK.AudioConfig> {
  if (mic) return sdk.AudioConfig.fromDefaultMicrophoneInput();
  const blob = await (await fetch('/api/understanding/media/audio')).blob();
  return sdk.AudioConfig.fromWavFileInput(new File([blob], 'narration.wav', { type: 'audio/wav' }));
}

/** Continuous recognition until the file ends (or 20 seconds of microphone), collecting each recognised sentence. */
function untilDone<T extends SDK.Recognizer>(
  rec: T,
  mic: boolean,
  onText: (
    e: SDK.RecognitionEventArgs & { result: SDK.SpeechRecognitionResult | SDK.TranslationRecognitionResult },
  ) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const r = rec as unknown as SDK.SpeechRecognizer;
    r.recognized = (_s, e) => onText(e as never);
    r.canceled = (_s, e) => (e.errorDetails ? reject(new Error(e.errorDetails)) : resolve());
    r.sessionStopped = () => resolve();
    r.startContinuousRecognitionAsync(
      () => undefined,
      (err) => reject(new Error(err)),
    );
    if (mic)
      window.setTimeout(
        () =>
          r.stopContinuousRecognitionAsync(
            () => resolve(),
            () => resolve(),
          ),
        20000,
      );
  }).finally(() => rec.close()) as Promise<void>;
}

export default function TranslatePage() {
  const [info, setInfo] = useState<TranslateInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [text, setText] = useState('');
  const [targets, setTargets] = useState(['es', 'cy']);
  const [glossary, setGlossary] = useState(true);
  const [profanity, setProfanity] = useState('NoAction');
  const [tone, setTone] = useState('formal and warm');
  const [complaintText, setComplaintText] = useState('');
  const [translit, setTranslit] = useState('こんにちは、保険の請求です');
  const [word, setWord] = useState('claim');
  const [mic, setMic] = useState(false);
  const [speechTarget, setSpeechTarget] = useState('es');
  const [question, setQuestion] = useState('Where is the plumber’s van?');
  const tr = useCall<TranslatorResult>();
  const llm = useCall<LlmTranslation>();
  const comp = useCall<ComplaintEntry>();
  const tl = useCall<{ text: string; script: string }>();
  const dict = useCall<{ entries: { target: string; pos: string; confidence: number; back: string[] }[] }>();
  const stt = useCall<{ plain: string; boosted: string }>();
  const st = useCall<{ heard: string; translated: string }>();
  const aud = useCall<AudioAnswer>();

  useEffect(() => {
    svc
      .info()
      .then((i) => {
        setInfo(i);
        setText(i.samples[0].text);
        setComplaintText(i.samples[1].text);
      })
      .catch((e: Error) => setProblem(e.message));
  }, []);

  async function speechConfig(sdk: typeof SDK) {
    const t = await tutorService.speechToken();
    return { token: t.token, region: t.region, config: sdk.SpeechConfig.fromAuthorizationToken(t.token, t.region) };
  }

  /** The same audio twice: plain, then with a phrase list of the names it should hear. */
  async function transcribe() {
    const sdk = await loadSdk();
    const once = async (boost: boolean) => {
      const { config } = await speechConfig(sdk);
      config.speechRecognitionLanguage = 'en-GB';
      const rec = new sdk.SpeechRecognizer(config, await audioInput(sdk, mic));
      if (boost) {
        const list = sdk.PhraseListGrammar.fromRecognizer(rec);
        PHRASES.forEach((p) => list.addPhrase(p));
      }
      const parts: string[] = [];
      await untilDone(rec, mic, (e) => {
        if (e.result.text) parts.push(e.result.text);
      });
      return parts.join(' ');
    };
    return { plain: await once(false), boosted: mic ? '' : await once(true) };
  }

  /** Speech in one language to text and speech in another: the TranslationRecognizer, then a neural voice. */
  async function speechTranslate() {
    const sdk = await loadSdk();
    const t = await tutorService.speechToken();
    const config = sdk.SpeechTranslationConfig.fromAuthorizationToken(t.token, t.region);
    config.speechRecognitionLanguage = 'en-GB';
    config.addTargetLanguage(speechTarget);
    const rec = new sdk.TranslationRecognizer(config, await audioInput(sdk, mic));
    const heard: string[] = [];
    const said: string[] = [];
    await untilDone(rec, mic, (e) => {
      const r = e.result as SDK.TranslationRecognitionResult;
      if (r.text) {
        heard.push(r.text);
        said.push(r.translations.get(speechTarget));
      }
    });
    const translated = said.join(' ');
    if (translated && VOICES[speechTarget]) {
      const synth = sdk.SpeechConfig.fromAuthorizationToken(t.token, t.region);
      synth.speechSynthesisVoiceName = VOICES[speechTarget];
      const s = new sdk.SpeechSynthesizer(synth, sdk.AudioConfig.fromDefaultSpeakerOutput());
      await new Promise<void>((resolve) =>
        s.speakTextAsync(
          translated,
          () => {
            s.close();
            resolve();
          },
          () => {
            s.close();
            resolve();
          },
        ),
      );
    }
    return { heard: heard.join(' '), translated };
  }

  return (
    <main className="page-translate">
      <div className="kicker">Lab 42 · AI-103: text analysis and speech</div>
      <h1>Translation, text analysis and speech</h1>
      <p className="lede">
        An insurer writes to customers in their own language and hears from them in any. Azure Translator translates
        with a glossary of approved terms; a language model translates with control over tone. A language model turns a
        complaint in any language into a structured log entry. Azure Speech transcribes, boosts the names it should
        hear, and translates speech into speech.
      </p>
      <div className="az-stack small">
        <span>
          <b>Translator</b> ${info?.price_per_m_chars ?? 10} per million characters, per target language
        </span>
        <span>
          <b>Model</b> {info?.model ?? '…'}
        </span>
        <span>
          <b>Speech</b> Azure Speech in the browser, signed in with a short-lived token from the backend
        </span>
      </div>
      <Problem error={problem} />

      <Panel title="1. Translator or a language model?">
        <Chips items={info?.samples ?? []} label={(s) => s.label} onPick={(s) => setText(s.text)} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to translate" />
        <div className="az-chips">
          {(info?.targets ?? []).map((t) => (
            <button
              key={t}
              className={`az-chip${targets.includes(t) ? ' on' : ''}`}
              onClick={() => setTargets(targets.includes(t) ? targets.filter((x) => x !== t) : [...targets, t])}
            >
              {NAMES[t] ?? t}
            </button>
          ))}
        </div>
        <div className="az-row small">
          <label>
            <input type="checkbox" checked={glossary} onChange={(e) => setGlossary(e.target.checked)} /> Use the
            glossary ({Object.keys(info?.glossary ?? {}).join(', ')})
          </label>
          <label>
            Profanity{' '}
            <select value={profanity} onChange={(e) => setProfanity(e.target.value)}>
              <option>NoAction</option>
              <option>Marked</option>
              <option>Deleted</option>
            </select>
          </label>
          <label>
            Model tone <input type="text" value={tone} onChange={(e) => setTone(e.target.value)} />
          </label>
        </div>
        <button
          className="btn primary"
          disabled={tr.busy || llm.busy || !targets.length}
          onClick={() => {
            void tr.run(() => svc.translate(text, targets, glossary, profanity));
            void llm.run(() => svc.llm(text, targets[0], tone, glossary));
          }}
        >
          {tr.busy || llm.busy
            ? 'Translating…'
            : `Translate (Translator: ${targets.length} languages; model: ${NAMES[targets[0]] ?? targets[0]})`}
        </button>
        <Problem error={tr.error || llm.error} />
        {(tr.result || llm.result) && (
          <div className="az-two az-result">
            <div>
              <b className="small">Azure Translator</b>{' '}
              {tr.result && (
                <span className="small muted">
                  detected {tr.result.detected?.language} ({Math.round((tr.result.detected?.score ?? 0) * 100)}%) ·{' '}
                  {tr.result.ms} ms · {tr.result.chars_billed} characters billed · {usd(tr.result.cost_usd)}
                  {tr.result.glossary_used.length ? ` · glossary: ${tr.result.glossary_used.join(', ')}` : ''}
                </span>
              )}
              {tr.result?.translations.map((t) => (
                <div key={t.to} className="az-quote">
                  <b>{NAMES[t.to] ?? t.to}:</b> {t.text}
                </div>
              ))}
            </div>
            <div>
              <b className="small">
                {info?.model} ({tone})
              </b>{' '}
              {llm.result && (
                <span className="small muted">
                  {llm.result.ms} ms · {llm.result.tokens} tokens · {usd(llm.result.cost_usd)}
                </span>
              )}
              {llm.result && (
                <div className="az-quote">
                  <b>{NAMES[llm.result.to] ?? llm.result.to}:</b> {llm.result.text}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title="2. Scripts and words: transliteration and the dictionary">
        <div className="az-two">
          <div>
            <p className="small muted">
              Transliteration keeps the language and changes the script: Japanese into Latin letters.
            </p>
            <input
              type="text"
              value={translit}
              onChange={(e) => setTranslit(e.target.value)}
              style={{ width: '100%' }}
              aria-label="Japanese text"
            />
            <button
              className="btn"
              disabled={tl.busy}
              onClick={() => void tl.run(() => svc.transliterate(translit, 'ja', 'Jpan', 'Latn'))}
            >
              Transliterate
            </button>
            {tl.result && <div className="az-quote">{tl.result.text}</div>}
          </div>
          <div>
            <p className="small muted">
              The dictionary gives alternatives with back-translations, which show why one word is not enough.
            </p>
            <input type="text" value={word} onChange={(e) => setWord(e.target.value)} aria-label="English word" />{' '}
            <button
              className="btn"
              disabled={dict.busy}
              onClick={() => void dict.run(() => svc.dictionary(word, 'en', 'es'))}
            >
              Look it up in Spanish
            </button>
            {dict.result && (
              <ul className="small">
                {dict.result.entries.map((e) => (
                  <li key={e.target + e.pos}>
                    <b>{e.target}</b> ({e.pos.toLowerCase()}, {Math.round(e.confidence * 100)}%): back to{' '}
                    {e.back.join(', ')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <Problem error={tl.error || dict.error} />
      </Panel>

      <Panel title="3. A domain task: a complaint in any language, as a log entry">
        <p className="small muted">
          A JSON schema fixes the output: category, tone, vulnerability signals and the FCA&apos;s 56-day deadline. The
          summary is always in English.
        </p>
        <textarea value={complaintText} onChange={(e) => setComplaintText(e.target.value)} aria-label="Complaint" />
        <button
          className="btn primary"
          disabled={comp.busy}
          onClick={() => void comp.run(() => svc.complaint(complaintText))}
        >
          {comp.busy ? 'Reading…' : 'Make the log entry'}
        </button>
        <Problem error={comp.error} />
        {comp.result && (
          <div className="az-result">
            <table className="az-table">
              <tbody>
                <tr>
                  <td>Summary</td>
                  <td>{comp.result.entry.summary_english}</td>
                </tr>
                <tr>
                  <td>Language</td>
                  <td>{comp.result.entry.language}</td>
                </tr>
                <tr>
                  <td>Category · tone</td>
                  <td>
                    {comp.result.entry.category} ·{' '}
                    <span className={`az-tag ${comp.result.entry.tone === 'calm' ? 'pass' : 'review'}`}>
                      {comp.result.entry.tone}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Vulnerability</td>
                  <td>{comp.result.entry.vulnerability_signals.join('; ') || 'none stated'}</td>
                </tr>
                <tr>
                  <td>Redress asked for</td>
                  <td>{comp.result.entry.redress_requested}</td>
                </tr>
                <tr>
                  <td>Final response due</td>
                  <td>within {comp.result.entry.deadline_days} days</td>
                </tr>
                <tr>
                  <td>Entities</td>
                  <td className="small">
                    {comp.result.entry.entities.map((e) => `${e.text} (${e.kind})`).join(' · ')}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="small muted">
              {comp.result.ms} ms · {usd(comp.result.cost_usd)}
            </p>
          </div>
        )}
      </Panel>

      <Panel title="4. Speech: transcribe, boost names, translate speech into speech">
        <p className="small muted">
          Uses the claim narration from the Content Understanding lab (a WAV file), so it works without a microphone.
          Tick the box to use yours instead (20 seconds).
        </p>
        <label className="small">
          <input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} /> Use my microphone
        </label>
        {!mic && <audio src="/api/understanding/media/audio" controls style={{ width: '100%', margin: '6px 0' }} />}
        <div className="az-two">
          <div>
            <b className="small">Speech to text, with and without a phrase list</b>
            <p className="small muted">
              A phrase list tells the recogniser which names to expect: {PHRASES.join(', ')}. No training needed; a
              custom speech model is the next step when phrase lists are not enough.
            </p>
            <button className="btn" disabled={stt.busy} onClick={() => void stt.run(transcribe)}>
              {stt.busy ? 'Listening…' : 'Transcribe'}
            </button>
            {stt.result && (
              <>
                <div className="az-quote small">
                  <b>Plain:</b> {stt.result.plain}
                </div>
                {stt.result.boosted && (
                  <div className="az-quote small">
                    <b>With the phrase list:</b> {stt.result.boosted}
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <b className="small">Speech translation</b>
            <p className="small muted">
              The TranslationRecognizer hears English and returns text in the target language; a neural voice speaks it.
            </p>
            <select value={speechTarget} onChange={(e) => setSpeechTarget(e.target.value)}>
              {Object.keys(VOICES)
                .filter((v) => v !== 'en')
                .map((v) => (
                  <option key={v} value={v}>
                    {NAMES[v]}
                  </option>
                ))}
            </select>{' '}
            <button className="btn" disabled={st.busy} onClick={() => void st.run(speechTranslate)}>
              {st.busy ? 'Translating speech…' : 'Translate the speech'}
            </button>
            {st.result && (
              <>
                <div className="az-quote small">
                  <b>Heard:</b> {st.result.heard}
                </div>
                <div className="az-quote small">
                  <b>{NAMES[speechTarget]}:</b> {st.result.translated}
                </div>
              </>
            )}
          </div>
        </div>
        <Problem error={stt.error || st.error} />
      </Panel>

      <Panel title="5. Reasoning over audio">
        <p className="small muted">
          Content Understanding&apos;s audio analyzer gives the transcript, speakers and a summary; {info?.model}{' '}
          answers questions over it.
        </p>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          style={{ width: '100%' }}
          aria-label="Question about the recording"
        />
        <div className="az-row">
          <button className="btn primary" disabled={aud.busy} onClick={() => void aud.run(() => svc.audio(question))}>
            {aud.busy ? 'Listening…' : 'Ask about the recording'}
          </button>
        </div>
        <Problem error={aud.error} />
        {aud.result && (
          <div className="az-result small">
            <div className="az-quote">
              <b>Answer:</b> {aud.result.answer}
            </div>
            <p>
              <b>Summary:</b> {aud.result.summary}
            </p>
            <p className="muted">
              {aud.result.transcript.length} transcript phrases · {aud.result.seconds} s · {usd(aud.result.cost_usd)}
            </p>
          </div>
        )}
      </Panel>

      <h2>What this covers in AI-103</h2>
      <ul className="small">
        <li>
          Translate text with Azure Translator or an LLM-powered flow (section 1), including glossaries, scripts and
          dictionary look-ups (section 2).
        </li>
        <li>
          Extract entities, topics, summaries and structured JSON; detect tone and sensitive signals; customise outputs
          for a domain task (section 3). Sentiment and key phrases are on the review analysis page; personal data and
          harm on the guardrails page.
        </li>
        <li>
          Speech to text and text to speech, with phrase lists as light customisation (section 4); the Aftercare page
          uses speech as an agent&apos;s modality, in English and Spanish.
        </li>
        <li>Translate speech into other languages (section 4) and reason over audio (section 5).</li>
      </ul>
      <h2>What to take away</h2>
      <ul>
        <li>
          Measure translation on your own text. Here gpt-5.4-mini kept the approved terms with correct grammar and a
          consistent formal tone, and cost less than Translator for one language. Translator translates into many
          languages in one call, and its glossary forced the term without fixing the article (&ldquo;el
          franquicia&rdquo;).
        </li>
        <li>
          Translator bills characters per target language: five languages cost five times one. A model bills tokens,
          once.
        </li>
        <li>Profanity handling only covers what Translator classes as profanity: &ldquo;damn&rdquo; was not marked.</li>
        <li>
          A schema makes a model&apos;s analysis usable downstream, but check its words: it summarised
          &ldquo;techo&rdquo; as the kitchen roof, not the ceiling.
        </li>
        <li>
          Recognisers spell names the way they expect. Plain British English recognition wrote &ldquo;Harbour
          Rd.&rdquo;; with the phrase list it wrote &ldquo;Harbour Road&rdquo;, as the claim records it. Content
          Understanding&apos;s audio analyzer, in US English, wrote &ldquo;Harbor Road&rdquo;. A phrase list needs no
          training; a custom speech model is the next step.
        </li>
      </ul>
    </main>
  );
}
