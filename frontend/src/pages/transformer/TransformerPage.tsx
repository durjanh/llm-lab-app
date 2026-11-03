import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import './transformer.css';

export default function TransformerPage() {
  useEngine(null, mount);
  return (
    <>
      <header className="topbar">
        <div className="brand">TRANSFORMER EXPLAINER</div>
        <div className="input-group">
          <select id="examples" title="Examples">
            <option value="">Examples</option>
            <option>As the spaceship was approaching the</option>
            <option>Data visualization empowers users to</option>
            <option>Artificial intelligence is transforming the</option>
            <option>Once upon a time there was a</option>
            <option>The cat sat on the</option>
          </select>{' '}
          <input
            id="prompt"
            type="text"
            spellCheck="false"
            defaultValue="As the spaceship was approaching the"
            aria-label="Input text"
          />{' '}
          <button id="generate" className="btn">
            Generate
          </button>
        </div>
        <div className="control">
          <div className="sampling-label">
            Model{' '}
            <label>
              <input type="radio" name="engine" defaultValue="tiny" defaultChecked /> Tiny (offline)
            </label>{' '}
            <label>
              <input type="radio" name="engine" defaultValue="gpt2" /> GPT-2 (128 MB)
            </label>{' '}
            <label className="off" title="Checking for the full-internals model…">
              <input type="radio" name="engine" defaultValue="full" disabled /> GPT-2 full internals
            </label>
          </div>
          <div className="engine-status">
            <div id="progress" className="progress" hidden>
              <i />
            </div>
            <span className="spinner" id="engineSpin" hidden aria-hidden="true" />
            <span id="engineStatus" role="status" aria-live="polite">
              Built-in demo model
            </span>
          </div>
          <div id="fullHint" className="engine-hint" hidden />
        </div>
        <div className="control">
          <label htmlFor="temp">Temperature</label>
          <div className="slider-row">
            <input id="temp" type="range" min="0.1" max="2" step="0.05" defaultValue="0.8" />
            <span id="tempVal" className="mono">
              0.8
            </span>
          </div>
        </div>
        <div className="control">
          <div className="sampling-label">
            Sampling{' '}
            <label>
              <input type="radio" name="mode" defaultValue="top-k" defaultChecked /> Top-k
            </label>{' '}
            <label>
              <input type="radio" name="mode" defaultValue="top-p" /> Top-p
            </label>
          </div>
          <div className="slider-row">
            <input id="kp" type="range" min="1" max="20" step="1" defaultValue="5" />
            <span id="kpVal" className="mono">
              k=5
            </span>
          </div>
        </div>
      </header>
      <main className="stage-wrap">
        <svg
          id="stage"
          viewBox="0 0 1280 640"
          preserveAspectRatio="xMidYMin meet"
          aria-label="Transformer visualization"
        />{' '}
        <button id="play" className="play" title="Pause / play data flow" aria-label="Pause or play data flow" />
        <p id="footnote" className="footnote">
          A tiny 12-layer, 12-head GPT-style model (d<sub>model</sub>=48, GPT-2 small uses 768) runs every step in your
          browser. Its weights are untrained, so next-token scores are blended with a small n-gram model. Hover
          anything; click <b>⊕</b> labels to zoom in.
        </p>
      </main>
      <div id="tooltip" className="tooltip" hidden />
      <div id="modal" className="modal" hidden>
        <div className="modal-card">
          <div className="modal-head">
            <h2 id="modalTitle" />
            <button id="modalClose" className="icon-btn" aria-label="Close">
              ✕
            </button>
          </div>
          <div id="modalSteps" className="steps" />
          <div id="modalBody" className="modal-body" />
          <div className="modal-foot">
            <button id="stepPrev" className="btn">
              ‹ Back
            </button>{' '}
            <span id="stepInfo" className="muted" />{' '}
            <button id="stepNext" className="btn primary">
              Next ›
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
