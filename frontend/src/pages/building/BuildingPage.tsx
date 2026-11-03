import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './building.css';

export default function BuildingPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-building">
      <div className="kicker">Lab 13 · How LLMs are built</div>
      <h1>From web pages to an assistant</h1>
      <p className="lede">
        Every chat model goes through the same stages: collect and clean an enormous amount of text, pretrain a model to
        predict the next token, teach it to follow instructions, tune it towards answers people prefer, then evaluate
        and serve it. This lab follows the same path as Stanford's{' '}
        <a href="https://www.youtube.com/watch?v=9vM4p9NN0Ts" target="_blank" rel="noopener">
          CS229 lecture on building large language models
        </a>
        , with something to try at each stage.
      </p>
      <h2>1. The whole pipeline</h2>
      <p>
        Click a stage. Each one explains what goes in, what comes out, and why it matters when you build on top of a
        model.
      </p>
      <div className="pipe" id="pipe" />
      <div className="card" id="stageCard" />
      <h2 id="data">2. Cleaning the web</h2>
      <p>
        Pretraining data mostly comes from crawled web pages, and most of the crawl is not worth training on. Below are
        thirteen made-up pages run through the kinds of filters real pipelines use. Switch steps off to see what each
        one catches, and click a page to see its text before and after.
      </p>
      <div className="card">
        <div className="steps-row" id="stepToggles" />
        <div className="form">
          <label>
            Near-duplicate threshold <span className="mono" id="vNear" />
            <input type="range" id="near" min="0.3" max="0.95" step="0.05" defaultValue="0.5" />
          </label>{' '}
          <label>
            Minimum quality score <span className="mono" id="vQual" />
            <input type="range" id="qual" min="0" max="1" step="0.05" defaultValue="0.5" />
          </label>
        </div>
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Try raising the minimum quality score above 0.6. The forum post goes too: chatty first-person writing scores
          low, which is how quality filters can quietly remove useful conversational text.
        </p>
        <svg
          className="chart"
          id="funnel"
          viewBox="0 0 720 230"
          role="img"
          aria-label="Pages remaining after each step"
        />
        <p className="small muted" id="funnelNote" />
      </div>
      <div className="docs" id="docs" style={{ marginTop: '12px' }} />
      <div id="docDetail" />
      <div className="note">
        <b>How real pipelines differ.</b> They run on billions of pages, so near-duplicates are found with MinHash, an
        approximation of the overlap measured here. Language and quality are judged by trained classifiers rather than
        word lists, and further classifiers remove toxic and adult content. Code is usually routed to its own pipeline,
        because filters tuned for prose throw it away, as you can see here.
      </div>
      <h2>3. Scaling laws: how big, how much data, how much money</h2>
      <p>
        Training cost is close to <b>6 × parameters × tokens</b> floating-point operations: about 2 for the forward pass
        and 4 for the backward pass, per parameter per token. Loss falls predictably as you add parameters and data. For
        a fixed compute budget there is a best split between the two, which works out at roughly{' '}
        <b>20 training tokens per parameter</b>.
      </p>
      <div className="card">
        <div className="form">
          <label>
            Preset <span />
            <select id="preset" />
          </label>{' '}
          <label>
            Parameters <span className="mono" id="vN" />
            <input type="range" id="logN" min="8" max="12" step="0.001" />
          </label>{' '}
          <label>
            Training tokens <span className="mono" id="vD" />
            <input type="range" id="logD" min="9" max="14" step="0.001" />
          </label>{' '}
          <label>
            GPU peak, TFLOPS <span />
            <input type="number" id="tflops" defaultValue="989" min="1" />
          </label>{' '}
          <label>
            Utilisation <span className="mono" id="vMfu" />
            <input type="range" id="mfu" min="10" max="60" defaultValue="40" />
          </label>{' '}
          <label>
            GPUs <span />
            <input type="number" id="gpus" defaultValue="2048" min="1" />
          </label>{' '}
          <label>
            Price per GPU-hour, $ <span />
            <input type="number" id="gpuPrice" defaultValue="2.5" step="0.1" min="0" />
          </label>
        </div>
        <div className="stats" id="scaleStats" />
        <p id="scaleVerdict" />
        <svg
          className="chart"
          id="scaleChart"
          viewBox="0 0 720 320"
          role="img"
          aria-label="Predicted loss against training compute for four model sizes"
        />
        <div className="legend" id="scaleLegend" />
        <p className="small muted">
          Loss curves use a 2024 re-fit of DeepMind's Chinchilla results by Epoch AI: loss = 1.82 + 482 / N
          <sup>0.348</sup> + 2,085 / D<sup>0.366</sup>, where N is parameters and D is tokens. The original Chinchilla
          paper's own fit implied about 70 tokens per parameter, inconsistent with its headline 20; the re-fit gives
          about 20. Absolute loss values belong to Chinchilla's data and tokenizer, so read the shape, not the numbers.
          The default GPU figure is an NVIDIA H100's dense BF16 peak. Utilisation is the share of that peak a real
          training run achieves, and the GPU price is an assumption.
        </p>
      </div>
      <h2>4. From base model to assistant</h2>
      <div id="gate" />
      <section className="needs-model locked" id="gptLab">
        <h3>A base model continues documents; it does not follow instructions</h3>
        <p>
          GPT-2 is a base model: pretraining only, no instruction tuning. Give it an instruction and it carries on
          writing whatever document it thinks the text came from. Phrase the same request as the start of a document and
          it does much better. Instruction tuning removes the need for that trick.
        </p>
        <div className="chips" id="basePresets" style={{ marginBottom: '8px' }} />
        <div className="pair-out">
          <div>
            <div className="small muted">Asked as an instruction</div>
            <div className="gen" id="genInstr" />
          </div>
          <div>
            <div className="small muted">Written as the start of a document</div>
            <div className="gen" id="genDoc" />
          </div>
        </div>
        <p className="small muted">Greedy decoding with a mild repetition penalty, 30 new tokens each.</p>
        <h3 id="sft">Supervised fine-tuning: learn from example answers</h3>
        <p>
          Fine-tuning data is a set of conversations. The model is trained with the same next-token loss as in
          pretraining, but only on the assistant's tokens: the user's part is context, not something to imitate. Below,
          the grey tokens get no loss. Each coloured token shows how surprised base GPT-2 is by it. Fine-tuning on many
          examples like this makes those tokens more likely.
        </p>
        <div className="form">
          <label>
            User turn
            <span />
            <input type="text" id="sftUser" defaultValue="Give me a synonym for happy." />
          </label>{' '}
          <label>
            Assistant turn
            <span />
            <input type="text" id="sftAsst" defaultValue="Joyful. Other options are cheerful and content." />
          </label>
        </div>
        <button className="btn primary" id="sftRun">
          Score this example
        </button>
        <div id="sftOut" style={{ marginTop: '10px' }} />
      </section>
      <h3 id="pref">Preference tuning: learn which answer people prefer</h3>
      <p>
        Next, people compare pairs of answers. A <b>reward model</b> learns to score answers so that preferred ones
        score higher, using the Bradley–Terry model: the chance that A beats B is a logistic function of reward(A) −
        reward(B). Here the "reward model" is a tiny one that only sees five simple features of each answer. Pick the
        better answer in each pair yourself, or fill them in like one of two kinds of rater, then see what the reward
        model learned.
      </p>
      <div className="row" style={{ margin: '6px 0' }}>
        <button className="btn" id="raterCareful">
          Fill like a careful rater
        </button>
        <button className="btn" id="raterLong">
          Fill like a rater who likes long answers
        </button>
        <button className="btn" id="raterClear">
          Clear
        </button>
      </div>
      <div id="prefPairs" />
      <div className="grid2" style={{ marginTop: '12px' }}>
        <div className="card">
          <h3 style={{ marginTop: '0' }}>What the reward model learned</h3>
          <div id="weights">
            <p className="muted small">Answer at least three pairs.</p>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: '0' }}>How it now ranks three new answers</h3>
          <p className="small muted" id="newQ" />
          <ol className="rank" id="ranked" />
        </div>
      </div>
      <p>
        <b>RLHF</b> then trains the language model to produce answers this reward model scores highly, with a penalty
        for drifting too far from the original model, measured as KL divergence. <b>DPO</b> skips the separate reward
        model: it adjusts the language model directly so that, relative to the original, preferred answers become more
        likely than rejected ones. Either way, the model learns whatever the raters rewarded, including habits nobody
        intended, such as padding answers with words.
      </p>
      <h2>5. Evaluation</h2>
      <p>
        Pretraining is tracked with <b>perplexity</b> on held-out text: e raised to the loss, or how many tokens the
        model is effectively choosing between. The <a href="/training">Training lab</a> now shows it live. Finished
        models are compared on benchmark suites and in head-to-head comparisons, where people or models pick the better
        of two answers and a Bradley–Terry or Elo rating ranks the models, using the same maths as the reward model
        above. Benchmarks can leak into training data, which inflates scores. The <a href="/evals">Evals lab</a> covers
        building your own.
      </p>
      <h2>6. Training needs far more memory than serving</h2>
      <p>
        Serving a model needs its weights in memory. Training needs the weights, a gradient for every weight, and the
        optimiser's running averages, about 16 bytes per parameter with standard mixed-precision Adam.
        Parameter-efficient methods such as LoRA freeze the original weights and train small added matrices instead,
        which is why fine-tuning can fit on one GPU when full training cannot.
      </p>
      <div className="card">
        <div className="form">
          <label>
            Model size <span />
            <select id="memN" defaultValue="8e9">
              <option value="1e9">1B parameters</option>
              <option value="8e9">8B parameters</option>
              <option value="13e9">13B parameters</option>
              <option value="70e9">70B parameters</option>
              <option value="405e9">405B parameters</option>
            </select>
          </label>{' '}
          <label>
            Job <span />
            <select id="memMode" defaultValue="full">
              <option value="inf16">Serving, 16-bit weights</option>
              <option value="inf8">Serving, 8-bit weights</option>
              <option value="inf4">Serving, 4-bit weights</option>
              <option value="full">Full training or fine-tuning, mixed-precision Adam</option>
              <option value="lora">LoRA fine-tuning, 16-bit frozen weights</option>
              <option value="qlora">QLoRA fine-tuning, 4-bit frozen weights</option>
            </select>
          </label>{' '}
          <label>
            Trainable adapter size <span className="mono" id="vAd" />
            <input type="range" id="adPct" min="0.1" max="3" step="0.1" defaultValue="0.5" />
          </label>{' '}
          <label>
            GPU memory <span />
            <select id="gpuMem" defaultValue="80">
              <option value="24">24 GB</option>
              <option value="48">48 GB</option>
              <option value="80">80 GB</option>
            </select>
          </label>
        </div>
        <div className="membar" id="memBar" role="img" aria-label="Memory needed, by part" />
        <div className="legend" id="memLegend" />
        <div className="stats" id="memStats" />
        <p className="small muted">
          Counts weights, gradients and optimiser state only. Activations, which depend on batch size and sequence
          length, and the KV cache for serving come on top; the <a href="/context">Context &amp; cost lab</a> sizes the
          KV cache. Large jobs split all of this across many GPUs with techniques such as ZeRO and FSDP.
        </p>
      </div>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>The data explains the gaps.</b> A model knows what was common in its training data up to its cutoff date.
            Rare facts, recent events and your private data are exactly where it guesses, so retrieve them instead.
          </li>
          <li>
            <b>Assistant behaviour is a thin layer on a document predictor.</b> Instruction and preference tuning use
            far less data than pretraining. That is why a few examples in a prompt steer a model so strongly, and why
            unusual inputs can make it fall back to plain continuation.
          </li>
          <li>
            <b>Style comes from what raters rewarded.</b> Length, tone, hedging and refusals are shaped in preference
            tuning. If you need a different style, ask for it explicitly or show examples.
          </li>
          <li>
            <b>Size the job before you train anything.</b> Six times parameters times tokens gives the compute, and
            about 16 bytes per parameter gives full-training memory. For most teams, prompting, retrieval or LoRA
            fine-tuning is the realistic option; pretraining is not.
          </li>
          <li>
            <b>Bigger is not automatically better per pound.</b> Small models trained on far more than 20 tokens per
            parameter, like Llama 3 8B on over 15 trillion tokens, cost more to train but less to serve, which is what
            most products pay for.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
