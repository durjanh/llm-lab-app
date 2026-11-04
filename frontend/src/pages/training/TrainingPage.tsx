import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { mount as mountAttention } from './attentionLab';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './training.css';

export default function TrainingPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  useEngine(root, mountAttention);
  return (
    <main ref={root} className="page-training">
      <div className="kicker">Lab 9 · Training</div>
      <h1>Watch a language model learn</h1>
      <p className="lede">
        Every language model starts as random numbers. Training shows it text, scores how badly it predicts what comes
        next, and nudges every weight to do a little better. Train a small one here and see what it learns, what it
        memorises, and what that means for fine-tuning.
      </p>
      <h2>1. How one training step works</h2>
      <p>
        The model on this page reads the last few characters and predicts the next one. Large language models predict
        tokens instead of characters and use a transformer instead of this small network. They are trained with the same
        loop, repeated over trillions of tokens.
      </p>
      <div className="flow">
        <div>
          <span className="n">1</span>
          <b>Predict</b>Take a batch of positions in the text. For each one, the model gives every possible next
          character a probability.
        </div>
        <div>
          <span className="n">2</span>
          <b>Score</b>The loss is minus the log of the probability given to the character that really came next. Lower
          is better.
        </div>
        <div>
          <span className="n">3</span>
          <b>Assign blame</b>Backpropagation works out how much each weight pushed the loss up or down. That is the
          gradient.
        </div>
        <div>
          <span className="n">4</span>
          <b>Nudge</b>The optimiser moves every weight a small step against its gradient. The learning rate sets the
          size of that step.
        </div>
      </div>
      <p className="small muted">
        Under the hood: each character has a learned list of numbers called an embedding. The embeddings of the last few
        characters go through one hidden layer, which scores every character in the vocabulary. A softmax turns the
        scores into probabilities. The optimiser is Adam. Everything runs in your browser in plain JavaScript.
      </p>
      <h2>2. Choose the data and the model</h2>
      <p>
        The last 10% of the text is held out as validation data. The model never trains on it, so its loss there shows
        how well it copes with text it has not seen. That is the number that predicts real-world quality.
      </p>
      <div className="grid2">
        <div className="card data-card">
          <h3>Training data</h3>
          <div className="chips" id="presets">
            <button className="chip-btn on" data-p="austen">
              Jane Austen
            </button>{' '}
            <button className="chip-btn" data-p="faq">
              FAQ answers
            </button>{' '}
            <button className="chip-btn" data-p="code">
              Python code
            </button>{' '}
            <button className="chip-btn" data-p="own">
              Your own text
            </button>
          </div>
          <textarea
            id="text"
            rows={7}
            spellCheck="false"
            aria-label="Training text"
            placeholder="Paste a few thousand characters of plain text, such as your own writing, documentation or code."
          />{' '}
          <label className="nrow">
            Use only the first N characters <span className="mono" id="vN" />
            <input type="range" id="nChars" min="200" max="9000" defaultValue="9000" />
          </label>
          <p className="small" id="dataInfo" aria-live="polite" />
          <p className="small muted">
            The Austen text is the first two chapters of Pride and Prejudice, taken from Project Gutenberg's
            public-domain edition. Text you paste stays in your browser.
          </p>
        </div>
        <div className="card">
          <h3>Model</h3>
          <div className="sliders">
            <label>
              Context length <span className="mono" id="vk" />
              <input type="range" id="k" min="1" max="8" defaultValue="5" />
            </label>{' '}
            <label>
              Embedding size <span className="mono" id="vd" />
              <input type="range" id="d" min="2" max="24" defaultValue="10" />
            </label>{' '}
            <label>
              Hidden units <span className="mono" id="vH" />
              <input type="range" id="H" min="16" max="256" step="16" defaultValue="96" />
            </label>{' '}
            <label>
              Learning rate <span className="mono" id="vlr" />
              <input type="range" id="lr" min="-4" max="-1" step="0.1" defaultValue="-2.5" />
            </label>{' '}
            <label>
              Batch size <span />
              <select id="B" defaultValue="32">
                <option>8</option>
                <option>16</option>
                <option>32</option>
                <option>64</option>
                <option>128</option>
              </select>
            </label>{' '}
            <label>
              Steps per run <span className="mono" id="vSteps" />
              <input type="range" id="steps" min="250" max="20000" step="250" defaultValue="3000" />
            </label>{' '}
            <label>
              Random seed <span />
              <input type="number" id="seed" defaultValue="42" />
            </label>
          </div>
          <div className="params">
            <div className="stat">
              <div className="v" id="pTotal">
                –
              </div>
              <div className="k">parameters, the weights training adjusts</div>
            </div>
            <div className="stat">
              <div className="v" id="pRatio">
                –
              </div>
              <div className="k">
                parameters per training character. <span id="pHint" />
              </div>
            </div>
          </div>
          <div id="pBreak" />
          <p className="small muted" style={{ marginTop: '12px' }}>
            Context length is how many characters the model sees. Embedding size is how many numbers describe each
            character. Hidden units set the size of the middle layer. Batch size is how many positions each step
            averages over. Changing the data or the shape of the model starts a fresh model; learning rate and batch
            size apply straight away.
          </p>
        </div>
      </div>
      <h2>3. Train it and watch the loss</h2>
      <p>
        The blue line is the loss on the training text. The orange line is the loss on the held-out text. Both start on
        the dashed line, the score of a model that gives every character the same probability. A good run pulls both
        lines down together.
      </p>
      <div className="card" id="trainCard">
        <div className="controls">
          <span className="small muted">Presets:</span>
          <div className="chips">
            <button className="chip-btn scen" data-s="healthy">
              Healthy run
            </button>
            <button className="chip-btn scen" data-s="overfit">
              Overfitting demo
            </button>
          </div>
          <span className="spacer" />{' '}
          <button className="btn primary" id="train">
            Train
          </button>{' '}
          <button className="btn" id="pause" disabled>
            Pause
          </button>{' '}
          <button className="btn" id="reset">
            Reset
          </button>
          <div className="progress" aria-hidden="true" id="progress">
            <i />
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="sStep">
              0
            </div>
            <div className="k" id="sStepK">
              steps
            </div>
          </div>
          <div className="stat">
            <div className="v" id="sTrain">
              –
            </div>
            <div className="k">training loss, on text it has seen</div>
          </div>
          <div className="stat">
            <div className="v" id="sVal">
              –
            </div>
            <div className="k" id="sValK">
              validation loss
            </div>
          </div>
          <div className="stat">
            <div className="v" id="sBest">
              –
            </div>
            <div className="k" id="sBestK">
              lowest validation loss
            </div>
          </div>
          <div className="stat">
            <div className="v" id="sPpl">
              –
            </div>
            <div className="k" id="sPplK">
              validation perplexity
            </div>
          </div>
          <div className="stat">
            <div className="v" id="sEpoch">
              –
            </div>
            <div className="k">epochs, full passes over the training text</div>
          </div>
        </div>
        <p className="small muted" id="pplNote" style={{ margin: '-4px 0 10px' }}>
          Perplexity is e raised to the loss. It reads as "the model is as unsure as if it were choosing evenly between
          this many characters". A uniform guess scores the full vocabulary size, and lower is better. Labs that train
          large models report it on held-out text.
        </p>
        <div className="verdict" id="verdict" aria-live="polite" />
        <div className="key-row" aria-hidden="true">
          <span>
            <i className="lk" style={{ '--c': 'var(--s1)' } as CSSProperties} />
            Training loss
          </span>{' '}
          <span>
            <i className="lk" style={{ '--c': 'var(--s2)' } as CSSProperties} />
            Validation loss
          </span>{' '}
          <span>
            <i className="lk dash" />
            <span id="baseKey">Uniform guess</span>
          </span>
        </div>
        <div id="chartWrap">
          <svg
            className="chart"
            id="lossChart"
            role="img"
            aria-label="Training and validation loss over training steps. The table below has the same numbers."
          />
        </div>
        <details id="tbl">
          <summary>Show the numbers as a table</summary>
          <div className="table-wrap">
            <table className="t" id="lossTable" />
          </div>
        </details>
        <p className="small muted" style={{ marginTop: '10px' }}>
          Losses are measured every few steps on up to 400 training positions and 600 validation positions. A loss of 2
          means the right character got about 14% probability on average, since e to the power of minus 2 is 0.14.
        </p>
      </div>
      <h2>4. Read what it writes</h2>
      <p>
        Every few hundred steps the model writes 200 characters, starting from the first few characters of the training
        text, shown in grey. Each sample uses the same random seed, so the only thing that changes between them is the
        weights. Watch spaces and word-sized chunks appear first, then common short words, then names, quotation marks
        and paragraph breaks.
      </p>
      <div className="card">
        <div className="sliders">
          <label>
            Temperature <span className="mono" id="vTemp" />
            <input type="range" id="temp" min="0.1" max="1.5" step="0.05" defaultValue="0.8" />
          </label>{' '}
          <label>
            Sample every <span />
            <select id="every" defaultValue="250">
              <option value="100">100 steps</option>
              <option value="250">250 steps</option>
              <option value="500">500 steps</option>
              <option value="1000">1,000 steps</option>
            </select>
          </label>{' '}
          <label style={{ alignSelf: 'end' }}>
            <span />
            <span />
            <button className="btn" id="sampleNow" style={{ gridColumn: '1/-1' }}>
              Sample now
            </button>
          </label>
        </div>
        <h3>Memorisation meter</h3>
        <div className="meter-row">
          <span className="v" id="memoVal">
            –
          </span>
          <div className="meter" role="img" aria-label="Share of the latest sample copied from the training text">
            <i id="memoFill" />
          </div>
          <div id="memoNote" />
        </div>
        <p className="small muted" style={{ margin: '0' }}>
          The meter checks every 20-character stretch of the latest sample against the training text.{' '}
          <span className="mk">Highlighted</span> text appears there word for word. On repetitive data such as the FAQ
          preset, some copying is normal, because many answers share the same opening words.
        </p>
        <div className="timeline" id="timeline" aria-live="polite" />
      </div>
      <h2>5. Train a tiny transformer and watch attention form</h2>
      <p>
        The model above sees a fixed window of characters through one hidden layer. Language models use a transformer
        instead. Every position can look back at any earlier position through attention, and training decides where each
        one looks. Here a very small transformer trains with the same loop, and you can watch its attention change as it
        learns.
      </p>
      <p className="small muted">
        Under the hood: each token has an embedding and each position has another, and the two are added. Each layer
        runs causal self-attention, where a position can look only at itself and earlier positions, then an optional
        small MLP. Each result is added back into a running total, the residual stream, and a layer norm comes before
        each step. A final layer scores every token in the vocabulary. Each token is 32 numbers and the context is 16
        tokens. Backpropagation is written out by hand in TypeScript and checked against finite differences.
      </p>
      <ul className="fixes">
        <li>
          <b>Repeated pattern.</b> Each sequence is a few random letters, then a run of random letters, then the same
          run again. The run is 4 to 8 letters long, so the repeat starts in a different place each time and the model
          cannot learn &ldquo;look back 6 places&rdquo;. In the second copy the next letter can be predicted exactly:
          find where the current letter appeared before and read the letter that came after it. Nothing else predicts
          it, because every letter is random.
        </li>
        <li>
          <b>Short text.</b> Next-character prediction on four tongue-twisters, which repeat words such as
          &ldquo;pickled peppers&rdquo; and &ldquo;woodchuck&rdquo; within a few characters.
        </li>
      </ul>
      <div className="card" id="atCard">
        <div className="controls">
          <div className="chips" id="atTask">
            <button className="chip-btn on" data-t="induction">
              Repeated pattern
            </button>
            <button className="chip-btn" data-t="text">
              Short text
            </button>
          </div>
          <label className="small">
            Layers{' '}
            <select id="atLayers" defaultValue="2">
              <option>1</option>
              <option>2</option>
            </select>
          </label>
          <label className="small">
            Heads per layer{' '}
            <select id="atHeads" defaultValue="1">
              <option>1</option>
              <option>2</option>
            </select>
          </label>
          <label className="small">
            <input type="checkbox" id="atMlp" /> MLP
          </label>
          <label className="small at-lr">
            Learning rate <span className="mono" id="atLrV" />
            <input type="range" id="atLr" min="-3.5" max="-1.5" step="0.1" defaultValue="-2.5" />
          </label>
          <span className="spacer" />
          <button className="btn primary" id="atGo">
            Train
          </button>
          <button className="btn" id="atPause" disabled>
            Pause
          </button>
          <button className="btn" id="atReset">
            Reset
          </button>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="atStep">
              0
            </div>
            <div className="k" id="atStepK">
              steps
            </div>
          </div>
          <div className="stat">
            <div className="v" id="atLoss">
              –
            </div>
            <div className="k">loss, averaged over every position</div>
          </div>
          <div className="stat" id="atRepBox">
            <div className="v" id="atRep">
              –
            </div>
            <div className="k">loss on the second copy</div>
          </div>
          <div className="stat" id="atAccBox">
            <div className="v" id="atAcc">
              –
            </div>
            <div className="k">of the second copy predicted right</div>
          </div>
          <div className="stat" id="atIndBox">
            <div className="v" id="atInd">
              –
            </div>
            <div className="k">induction score, best head in the last layer</div>
          </div>
          <div className="stat">
            <div className="v" id="atPrev">
              –
            </div>
            <div className="k">previous-token score, best head in layer 1</div>
          </div>
        </div>
        <div className="verdict" id="atNote" aria-live="polite" />
        <div className="grid2">
          <div>
            <div className="key-row" aria-hidden="true">
              <span>
                <i className="lk" style={{ '--c': 'var(--s1)' } as CSSProperties} />
                Every position
              </span>{' '}
              <span id="atLossKey2">
                <i className="lk" style={{ '--c': 'var(--s2)' } as CSSProperties} />
                Second copy
              </span>{' '}
              <span>
                <i className="lk dash" />
                Uniform guess
              </span>
            </div>
            <div id="atLossWrap">
              <svg className="chart" id="atLossChart" role="img" aria-label="Loss over training steps" />
            </div>
          </div>
          <div>
            <div className="key-row" aria-hidden="true">
              <span id="atScoreKeyInd">
                <i className="lk" style={{ '--c': 'var(--s1)' } as CSSProperties} />
                Induction score
              </span>{' '}
              <span>
                <i className="lk" style={{ '--c': 'var(--s3)' } as CSSProperties} />
                Previous-token score
              </span>{' '}
              <span id="atScoreKeyAcc">
                <i className="lk" style={{ '--c': 'var(--s2)' } as CSSProperties} />
                Accuracy, second copy
              </span>
            </div>
            <div id="atScoreWrap">
              <svg
                className="chart"
                id="atScoreChart"
                role="img"
                aria-label="Induction score, previous-token score and accuracy over training steps"
              />
            </div>
          </div>
        </div>
        <h3>Where one head looks</h3>
        <div className="controls">
          <div className="chips" id="atView" />
          <span className="spacer" />
          <button className="btn small" id="atNew">
            New sequence
          </button>
        </div>
        <div className="at-attn">
          <svg
            className="at-grid"
            id="atGrid"
            role="img"
            aria-label="Attention weights of the chosen head on one sequence"
          />
          <div className="small">
            <p id="atGridCap" className="muted" />
            <p>
              Each row is a position, and the shading shows how its attention is shared among itself and the positions
              before it. Rows add up to 100%. The empty squares above the diagonal are masked: no position may look
              ahead.
            </p>
            <p>
              <span className="at-key" /> Outlined squares are where an induction head should look: one place after the
              earlier copy of the current letter.
            </p>
          </div>
        </div>
        <div id="atSampleBox" hidden>
          <h3>What it writes</h3>
          <p className="small muted">
            Every 250 steps the model continues the opening of the text, shown in grey, at temperature 0.7.
          </p>
          <div className="tl-text" id="atSample" />
        </div>
        <div id="atHistoryBox" hidden>
          <h3>Earlier runs</h3>
          <div className="table-wrap" id="atHistory" />
        </div>
      </div>
      <h3>What to watch for</h3>
      <ul className="fixes">
        <li>
          <b>A plateau, then a drop.</b> With 2 layers, the loss on the second copy sits near the uniform guess for a
          few hundred steps, then falls steeply within about a hundred. Accuracy on the second copy jumps at the same
          moment. The line on the charts marks it.
        </li>
        <li>
          <b>Layer 1 learns to look one place back.</b> Pick layer 1: a stripe forms just below the diagonal. That head
          copies &ldquo;the letter before me&rdquo; into each position. It is a previous-token head, and the
          previous-token score is the average attention on that stripe.
        </li>
        <li>
          <b>Layer 2 learns to look after the earlier copy.</b> Pick layer 2: in the rows of the second copy, the
          attention moves onto the outlined squares. That head is an induction head. The induction score is the average
          attention it gives the outlined squares.
        </li>
        <li>
          <b>The MLP can get in the way.</b> Tick MLP and train the repeated pattern again. The model often finds a
          partial shortcut first and the induction head forms later, or not within the run. The text task needs the MLP
          to learn which letters usually follow which.
        </li>
      </ul>
      <h3>Why one layer cannot do it</h3>
      <p>
        In one layer, the key at each position is built only from that position&rsquo;s own letter and place. The
        current letter can find its earlier copy, because the copy has the same letter. But the answer sits one place
        later, at a position whose key says nothing about the letter before it. To find it, the model needs keys that
        say &ldquo;the letter before me was c&rdquo;, and that information only exists after an earlier layer has moved
        it there. With 2 layers, the previous-token head in layer 1 writes it and the induction head in layer 2 searches
        for it. Train 1 layer and it gets part of the way by guessing among letters it has seen recently, then stalls at
        about a third right.
      </p>
      <p>
        This two-head circuit was described by researchers at Anthropic in 2022 (Olsson and others, &ldquo;In-context
        learning and induction heads&rdquo;). They found that induction heads form in a sudden step in large language
        models too, and that they account for much of in-context learning: a model&rsquo;s ability to continue a pattern
        it saw earlier in the prompt. The <a href="/transformer">Transformer lab</a> shows the attention heads of a real
        model, GPT-2.
      </p>
      <h2>6. Memorising is not learning</h2>
      <p>
        Give a large model a small dataset and train it for long enough, and it stops learning general patterns. It
        starts storing the training text itself. Training loss keeps falling towards zero. Validation loss turns round
        and climbs, because the model grows confident about continuations that only exist in its training text.
      </p>
      <p>
        The overfitting demo keeps only the first 1,500 characters and gives the model about 35,000 weights, roughly 26
        for every training character. Within a few hundred steps the samples turn into long passages copied from the
        training text, and the memorisation meter climbs.
      </p>
      <div className="row" style={{ margin: '6px 0 10px' }}>
        <button className="btn primary" id="overfitGo">
          Run the overfitting demo
        </button>
        <span className="small muted">Takes a few seconds.</span>
      </div>
      <h3>What fixes it</h3>
      <ul className="fixes">
        <li>
          <b>Stop at the lowest validation loss.</b> This is called early stopping. Keep the weights from the best step,
          not the last one.
        </li>
        <li>
          <b>Use more, and more varied, data.</b> Slide the character limit back up and the same model stops memorising.
        </li>
        <li>
          <b>Train fewer weights.</b> A smaller model has less room to store the text. Fine-tuning methods that train
          only small adapter layers do the same.
        </li>
        <li>
          <b>Make fewer passes.</b> The epochs counter shows how many times the model has seen each character. Dozens of
          passes over a small dataset is a recipe for memorising.
        </li>
        <li>
          <b>Add regularisation.</b> Techniques such as dropout and weight decay penalise the model for leaning on any
          one detail. This lab leaves them out so the effect is easy to see.
        </li>
      </ul>
      <h2>7. What this means for fine-tuning</h2>
      <p>
        Fine-tuning is this same loop, run on a model that is already trained, with your examples as the data.
        Everything above applies. Three results from this lab carry straight over.
      </p>
      <ul className="fixes">
        <li>
          <b>Patterns that repeat are learned first.</b> Train on the FAQ preset. Within a few hundred steps every
          sample opens with “Q: How do I”, and by the end the answers follow the same “Open Settings, choose, then
          select” pattern. Format, tone and labelling schemes are what fine-tuning does well.
        </li>
        <li>
          <b>Facts are learned poorly.</b> Read the later FAQ samples again. The format is right, but the answers often
          send you to the wrong menu. A fact seen once or twice is either not learned or memorised word for word, and
          the model cannot tell you where it came from.
        </li>
        <li>
          <b>Small datasets memorise, and memorised text comes back out.</b> Watch validation loss, keep the number of
          passes low, and never train on anything you would not want the model to repeat to a user.
        </li>
      </ul>
      <h3>Prompting, retrieval or fine-tuning?</h3>
      <div className="table-wrap">
        <table className="t cmp">
          <thead>
            <tr>
              <th />
              <th>Prompting</th>
              <th>Retrieval, or RAG</th>
              <th>Fine-tuning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>What it changes</td>
              <td>The input. Instructions and examples go into every request. The weights stay the same.</td>
              <td>The input. Passages from your documents are found at request time and added to the prompt.</td>
              <td>The weights. The model trains further on your examples, so the behaviour is built in.</td>
            </tr>
            <tr>
              <td>Data you need</td>
              <td>None, or a handful of good examples.</td>
              <td>Your documents, split into chunks and indexed. No labelled pairs.</td>
              <td>
                Hundreds to thousands of high-quality input and output examples that look like production, plus a
                held-out set.
              </td>
            </tr>
            <tr>
              <td>Cost and effort</td>
              <td>Lowest. You pay per token, and a long prompt costs more on every call.</td>
              <td>Moderate. An index, a retrieval pipeline and its upkeep, and longer prompts.</td>
              <td>
                Highest. Collecting and cleaning data, training runs, evaluation, and serving the tuned model. You may
                need to repeat it when you move to a newer base model.
              </td>
            </tr>
            <tr>
              <td>How fast you iterate</td>
              <td>Minutes. Edit the prompt and rerun your tests.</td>
              <td>Hours. Change documents or chunking and re-index.</td>
              <td>Days per cycle. Change the data, retrain and re-evaluate.</td>
            </tr>
            <tr>
              <td>Updating knowledge</td>
              <td>Edit the prompt.</td>
              <td>Update the documents. Answers change at once and can cite their source.</td>
              <td>Needs another training run. Facts learned this way are hard to trace or remove.</td>
            </tr>
            <tr>
              <td>Main risk</td>
              <td>Long prompts add cost and latency, and instructions can still be missed.</td>
              <td>Poor retrieval gives confident answers built on the wrong passage.</td>
              <td>Overfitting and memorising, as above. It can also weaken skills the base model had.</td>
            </tr>
            <tr>
              <td>Choose it when</td>
              <td>
                Always start here. Clear instructions and a few examples solve most format, tone and task problems.
              </td>
              <td>
                The model needs facts it does not have: private, recent or changing information, or answers that must
                cite a source.
              </td>
              <td>
                Prompting already works but you need it more consistent, shorter or cheaper at volume. Typical cases are
                a fixed output style, a classification scheme, or a smaller model doing one narrow task.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: '10px' }}>
        The options combine. A common pattern is retrieval for knowledge plus a short prompt for behaviour, with
        fine-tuning added later only if tests show a gap that prompting cannot close.
      </p>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Judge training by validation loss.</b> Training loss almost always falls. Only held-out data that looks
            like production tells you whether the model learned something useful.
          </li>
          <li>
            <b>Small data plus a big model means memorising.</b> Watch the gap between the two losses and the number of
            passes. Stop at the best validation step, not the last one.
          </li>
          <li>
            <b>Fine-tune for behaviour, retrieve for knowledge.</b> Repeated patterns such as format and tone train
            well. Facts train badly and cannot be cited or updated without retraining.
          </li>
          <li>
            <b>Assume training data can come back out.</b> Remove secrets, personal data and anything licensed before
            you fine-tune on it.
          </li>
          <li>
            <b>Build the test set first.</b> You need it to compare prompting, retrieval and fine-tuning fairly, and to
            know when to stop training.
          </li>
          <li>
            <b>Sanity-check the first loss.</b> An untrained model should score close to ln of the vocabulary size. A
            first loss far above that usually means a bug in the data or the set-up.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
