import { useEffect, useRef, useState } from 'react';
import { GPT2 } from '@/lib/gpt2';
import { Site } from '@/lib/site';
import './whatisgpt.css';

/**
 * Lab 28: Microsoft's "What is a GPT?" explainer, section by section, made hands-on: the next-token prediction runs
 * live on GPT-2 in the browser, and the history, architecture and FAQ are corrected where the source is wrong.
 */

const SOURCE = 'https://azure.microsoft.com/en-us/resources/cloud-computing-dictionary/what-is-gpt';

interface Guess {
  id: number;
  text: string;
  p: number;
}

async function nextTokens(text: string, k = 8): Promise<Guess[]> {
  const ids = GPT2.encode(text).slice(-200);
  const probs = GPT2.softmax(await GPT2.nextLogits(ids), 1);
  return GPT2.topIndices(probs, k).map((id: number) => ({ id, text: GPT2.decode(id), p: probs[id] }));
}

const show = (t: string) => (t.trim() ? t.replace(/\n/g, '↵') : t.replace(/ /g, '␣').replace(/\n/g, '↵'));

const HISTORY: { year: string; name: string; what: string }[] = [
  { year: '2017', name: 'The transformer', what: 'Google\'s "Attention is all you need" paper: an encoder–decoder model for translation, built on self-attention.' },
  { year: '2018', name: 'GPT-1', what: 'OpenAI keeps only the decoder and pre-trains it to predict the next word. About 117 million parameters, trained on about 7,000 books.' },
  { year: '2019', name: 'GPT-2', what: '1.5 billion parameters, trained on 40 GB of web text. Writes coherent paragraphs. The model this page runs.' },
  { year: '2020', name: 'GPT-3', what: '175 billion parameters. Learns tasks from a few examples in the prompt (few-shot), without retraining.' },
  { year: '2022', name: 'InstructGPT, ChatGPT', what: 'Fine-tuned to follow instructions and tuned on human preferences (RLHF): the step from text predictor to assistant.' },
  { year: '2023', name: 'GPT-4', what: 'Much more capable, and accepts images as input. Its size is not published.' },
  { year: '2024', name: 'GPT-4o, GPT-4o mini, o1', what: 'GPT-4o ("omni") handles text, images and audio in one model; GPT-4o mini is a cheaper model taking text and images; o1 is the first "reasoning" model, thinking before it answers.' },
  { year: '2025', name: 'GPT-4.1, GPT-5', what: 'GPT-4.1 (April) for long context and coding; GPT-5 (August).' },
  { year: '2025–26', name: 'GPT-5.x', what: 'A fast series of versions: in Azure AI Foundry\'s catalogue, gpt-5.1 (November 2025), 5.2 (December), 5.4 (March 2026), 5.5 (April), 5.6 (July), with mini and nano sizes. This lab\'s Azure deployment is gpt-5.4-mini.' },
];

const CHALLENGES: { name: string; what: string; lab: [string, string] }[] = [
  { name: 'Bias', what: 'It learns patterns, including unfair ones, from its training text.', lab: ['/evals', 'Test for it like any other behaviour: Evals'] },
  { name: 'Inaccuracies', what: 'It produces fluent text whether or not it is true, so a person should review its work.', lab: ['/casework', 'Checks before a person approves: Case handling'] },
  { name: 'Cybersecurity', what: 'It can be misused for phishing or malware, and can be tricked by instructions hidden in content.', lab: ['/injection', 'Try it: Prompt injection challenge'] },
  { name: 'Intellectual property', what: 'Output can echo its training data; confirm rights and cite sources.', lab: ['/documents', 'Answers with quotes from the source: Document automation'] },
  { name: 'Ineffective prompts', what: 'Vague instructions give vague answers.', lab: ['/prompting', 'Measure prompt changes: Prompting'] },
  { name: 'Impenetrability', what: 'It is hard to see why it produced an answer.', lab: ['/transformer', 'Look inside a real model: Transformer explainer'] },
];

const USES: [string, string, string][] = [
  ['Content creation', '/decks', 'Deck builder'],
  ['Chatbots and conversational agents', '/tutor', 'Tutor'],
  ['Translation', '/tutor', 'Tutor (in your language)'],
  ['Sentiment analysis', '/evals', 'Evals (a sentiment test set)'],
  ['Research and question answering', '/embeddings', 'Embeddings and RAG'],
  ['Meeting and document summarisation', '/documents', 'Document automation'],
  ['Code creation', '/site-builder', 'Site builder'],
  ['Data analysis and decisions', '/casework', 'Case handling on Azure'],
];

export default function WhatIsGptPage() {
  const gate = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(GPT2.isReady());
  const [text, setText] = useState('The cloud is');
  const [guesses, setGuesses] = useState<Guess[]>([]);
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<{ sky: Guess[]; server: Guess[] } | null>(null);

  useEffect(() => {
    if (!gate.current) return;
    Site.modelGate(gate.current, {
      title: 'GPT-2', sizeMB: 128, autoKey: 'gpt2-loaded', isReady: GPT2.isReady,
      what: 'This page uses it to predict the next word, live.',
      loader: (cb) => GPT2.load(cb),
      onReady: () => setReady(true),
    });
  }, []);

  useEffect(() => {
    if (!ready || !text.trim()) return;
    let alive = true;
    const t = window.setTimeout(() => {
      setBusy(true);
      nextTokens(text)
        .then((g) => alive && setGuesses(g))
        .finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [ready, text]);

  useEffect(() => {
    if (!ready) return;
    void (async () => {
      const sky = await nextTokens('Looking up, I saw that the cloud in the sky was', 5);
      const server = await nextTokens('Our website went down because the cloud server was', 5);
      setPair({ sky, server });
    })();
  }, [ready]);

  async function continueText(steps: number) {
    let t = text;
    setBusy(true);
    for (let i = 0; i < steps; i++) {
      const [best] = await nextTokens(t, 1);
      t += best.text;
      setText(t);
    }
    setBusy(false);
  }

  const tokens = ready && text ? GPT2.encode(text).slice(-40) : [];
  const maxP = Math.max(...guesses.map((g) => g.p), 1e-6);
  const sentence = 'The cat sat on the mat .'.split(' ');

  return (
    <main className="page-gpt">
      <div className="kicker">Lab 28 · What is GPT</div>
      <h1>What is GPT? Try it, don't just read it</h1>
      <p className="lede">
        GPT stands for <b>generative pre-trained transformer</b>: a neural network that writes text by predicting what comes
        next, one piece at a time. This lab follows Microsoft's{' '}
        <a href={SOURCE} target="_blank" rel="noreferrer">
          What is a GPT?
        </a>{' '}
        explainer section by section, with a real GPT model running in your browser, and corrects the few places where that page
        is wrong.
      </p>
      <div ref={gate} className="gate" />

      <section>
        <h2>1. The role of GPT: predict the next token</h2>
        <p>
          Everything a GPT does comes from one step, repeated: given the text so far, give a probability for every possible next
          token (a word or part of a word), pick one, add it, and go again. Type below and watch GPT-2's real predictions.
        </p>
        <textarea className="gp-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={!ready} />
        <div className="row gp-actions">
          <button className="btn small" disabled={!ready || busy} onClick={() => void continueText(1)}>
            Add the top token
          </button>
          <button className="btn small" disabled={!ready || busy} onClick={() => void continueText(12)}>
            Repeat 12 times
          </button>
          <button className="btn small" disabled={busy} onClick={() => setText('The cloud is')}>
            Reset
          </button>
          {busy && <span className="small muted">Predicting…</span>}
        </div>
        {ready && guesses.length > 0 && (
          <div className="gp-guesses" aria-label="The most likely next tokens">
            {guesses.map((g) => (
              <button key={g.id} className="gp-guess" onClick={() => setText((t) => t + g.text)} title="Add this token">
                <span className="gp-bar" style={{ width: `${(g.p / maxP) * 100}%` }} />
                <span className="mono">{show(g.text)}</span>
                <span className="small">{(g.p * 100).toFixed(1)}%</span>
              </button>
            ))}
          </div>
        )}
        <p className="small muted">
          Click a token to add it. "Repeat" always adds the most likely one; chatbots usually sample instead (see the Sampling lab),
          which is why the same question can get different answers.
        </p>
      </section>

      <section>
        <h2>2. How it works: tokens, embeddings, attention, probabilities</h2>
        <div className="gp-pipe">
          <div className="card">
            <b>Tokens</b>
            <p className="small">The text is split into tokens, each an id in GPT-2's vocabulary of 50,257.</p>
            <div className="gp-tokens">
              {tokens.length ? (
                tokens.map((id: number, i: number) => (
                  <span key={i} className="gp-tok" title={`id ${id}`}>
                    {show(GPT2.decode(id))}
                    <sub>{id}</sub>
                  </span>
                ))
              ) : (
                <span className="small muted">Load GPT-2 to see the tokens.</span>
              )}
            </div>
          </div>
          <div className="card">
            <b>Embeddings</b>
            <p className="small">
              Each id picks a row of a learned table: a list of 768 numbers in GPT-2, placing tokens with similar meanings near each
              other. See them in the Embeddings and Transformer labs.
            </p>
          </div>
          <div className="card">
            <b>Attention</b>
            <p className="small">
              Through 12 layers in GPT-2 (around 100 in the largest models), each token's numbers are updated by looking at the tokens
              before it, which is how context changes meaning.
            </p>
          </div>
          <div className="card">
            <b>Probabilities</b>
            <p className="small">The last token's numbers become a score for every possible next token: the list in section 1.</p>
          </div>
        </div>
        <h3>Context changes the meaning: the "cloud" example</h3>
        <p className="small">The same word, two contexts, GPT-2's real top five next tokens:</p>
        <div className="gp-two">
          {pair ? (
            (
              [
                ['…the cloud in the sky was', pair.sky],
                ['…the cloud server was', pair.server],
              ] as [string, Guess[]][]
            ).map(([label, list]) => (
              <div key={label} className="card">
                <b className="small">{label}</b>
                <ol className="small">
                  {list.map((g) => (
                    <li key={g.id}>
                      <span className="mono">{show(g.text)}</span> {(g.p * 100).toFixed(1)}%
                    </li>
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <p className="small muted">Load GPT-2 to compare.</p>
          )}
        </div>
      </section>

      <section>
        <h2>3. A short history</h2>
        <ol className="gp-time">
          {HISTORY.map((h) => (
            <li key={h.name}>
              <span className="gp-year">{h.year}</span>
              <b>{h.name}</b>
              <span className="small">{h.what}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>4. Pre-training, then fine-tuning</h2>
        <p>
          <b>Pre-training</b> reads a vast amount of text and learns to predict each next token. No one labels the data: the label is
          simply the word that came next, which is why it is called <b>self-supervised</b>. One sentence already gives many training
          examples:
        </p>
        <div className="gp-pairs mono small">
          {sentence.slice(0, -1).map((_, i) => (
            <div key={i}>
              {sentence.slice(0, i + 1).join(' ')} <span className="muted">→</span> <b>{sentence[i + 1]}</b>
            </div>
          ))}
        </div>
        <p className="small">
          A pre-trained model continues documents; it doesn't follow instructions. <b>Fine-tuning</b> on example conversations, then
          tuning on human preferences (RLHF or DPO), turns it into an assistant. Specialising for banking or law is usually done with
          fine-tuning, or more often with retrieval (RAG) and good prompts. Go deeper: How LLMs are built, Training, Preference
          tuning.
        </p>
      </section>

      <section>
        <h2>5. The architecture: decoder-only</h2>
        <div className="card gp-fix">
          <b>A correction.</b> The Microsoft page describes GPT as having two parts, an encoder and a decoder. That was the original
          2017 transformer, built for translation. GPT models keep only the <b>decoder</b>: one stack of layers that reads the text so
          far and predicts the next token.
        </div>
        <div className="gp-three">
          <div className="card">
            <b>Encoder–decoder</b>
            <p className="small">The 2017 transformer, T5. Reads a whole input, then writes an output. Translation, summarisation.</p>
          </div>
          <div className="card">
            <b>Encoder-only</b>
            <p className="small">BERT. Reads in both directions; no writing. Classification, search embeddings.</p>
          </div>
          <div className="card gp-pick">
            <b>Decoder-only: GPT, Claude, Llama</b>
            <p className="small">Each token can only look back at earlier tokens, never ahead, so it can generate one token at a time.</p>
          </div>
        </div>
        <h3>Each token sees only what came before</h3>
        <div className="gp-mask" role="img" aria-label="A causal attention mask: each token can attend to itself and earlier tokens">
          <span />
          {sentence.map((w, j) => (
            <span key={`h${j}`} className="gp-mh">
              {w}
            </span>
          ))}
          {sentence.map((w, i) => [
            <span key={`r${i}`} className="gp-mh gp-row">
              {w}
            </span>,
            ...sentence.map((_, j) => <span key={`${i}-${j}`} className={j <= i ? 'on' : ''} />),
          ])}
        </div>
      </section>

      <section>
        <h2>6. Benefits and challenges</h2>
        <p className="small">
          The benefits on Microsoft's page (simplify research, write faster, enhance code, reduce busywork, boost creativity,
          customise to your business) are real; the challenges are what engineering is for. Each one, with a lab where you can see it:
        </p>
        <div className="table-wrap">
          <table className="t">
            <tbody>
              {CHALLENGES.map((c) => (
                <tr key={c.name}>
                  <td>
                    <b>{c.name}</b>
                  </td>
                  <td className="small">{c.what}</td>
                  <td className="small">
                    <a href={c.lab[0]}>{c.lab[1]}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>7. Use cases, built here</h2>
        <div className="gp-uses">
          {USES.map(([use, href, lab]) => (
            <a key={use} href={href} className="card gp-use">
              <b>{use}</b>
              <span className="small muted">{lab} →</span>
            </a>
          ))}
        </div>
      </section>

      <section>
        <h2>8. Frequently asked questions</h2>
        <details open>
          <summary>Is GPT generative AI?</summary>
          <p className="small">Yes: it generates new text (and, in newer models, images and audio) rather than only classifying.</p>
        </details>
        <details>
          <summary>What is an AI transformer?</summary>
          <p className="small">
            A neural network architecture built on attention: every token's representation is updated by looking at the other tokens,
            which captures context. GPT models use its decoder half (section 5).
          </p>
        </details>
        <details>
          <summary>What does "pre-trained" mean?</summary>
          <p className="small">
            Trained first on a huge general text corpus to predict the next token, before any fine-tuning for a particular job. Not
            simply "trained before public release", as the Microsoft page puts it.
          </p>
        </details>
      </section>

      <section>
        <h2>Corrections to the source</h2>
        <ul className="small gp-corrections">
          <li>
            <b>"GPT-1 (2018) was trained on over 1.5 billion parameters."</b> GPT-1 had about 117 million; 1.5 billion was GPT-2
            (2019).
          </li>
          <li>
            <b>Encoder and decoder.</b> GPT is decoder-only (section 5).
          </li>
          <li>
            <b>"Unsupervised" training.</b> Usually called self-supervised: the next token is the label (section 4).
          </li>
          <li>
            <b>Computer vision in the training section.</b> Recognising objects in images is a separate field, not how GPT is trained.
          </li>
          <li>
            <b>"GPT-4o mini supports text and audio."</b> At launch it took text and images.
          </li>
        </ul>
        <p className="small muted">Checked against the page on 2 November 2026, which shows no date of its own.</p>
      </section>
    </main>
  );
}
