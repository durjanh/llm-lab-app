import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import './claude-code-inside.css';

export default function ClaudeCodeInsidePage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-claude-code-inside">
      <div className="intro">
        <div className="kicker">Lab 18 · Claude Code behind the scenes</div>
        <h1>What really happens when you use Claude Code</h1>
        <p className="lede">
          Thirteen short chapters, from <code>/init</code> to rewind. Each one plays out a real session three ways at
          once: what you see in the terminal, the messages moving between Claude Code, the model and your tools, and
          exactly what is in the context window that gets sent with every request.
        </p>
        <p className="hint">
          Presenting? Press <span className="kbd">→</span> or <span className="kbd">Space</span> for the next step and{' '}
          <span className="kbd">←</span> to go back. It runs on into the next chapter. <span className="kbd">P</span>{' '}
          switches to presenter mode with bigger text and no menus. <span className="kbd">Esc</span> leaves it.
        </p>
        <p className="small">
          Official overview:{' '}
          <a href="https://code.claude.com/docs/en/how-claude-code-works.md" target="_blank" rel="noopener">
            How Claude Code works
          </a>{' '}
          in the Claude Code documentation.
        </p>
      </div>
      <nav className="agenda" id="agenda" aria-label="Chapters" />
      <section id="stageWrap">
        <div className="stage-head">
          <div style={{ flex: '1 1 380px' }}>
            <h2 id="chTitle" />
            <p className="sub" id="chSub" />
          </div>
          <div className="ctrls">
            <div className="dots" id="dots" aria-hidden="true" />
            <span className="stepno" id="stepNo" />{' '}
            <button className="btn" id="back" title="Previous step (←)">
              ‹ Back
            </button>{' '}
            <button className="btn primary" id="next" title="Next step (→ or Space)">
              Next ›
            </button>{' '}
            <button className="btn" id="play">
              Play
            </button>{' '}
            <button className="btn" id="present" title="Presenter mode (P)">
              Present
            </button>
          </div>
        </div>
        <div className="stage" id="stage">
          <div>
            <div className="plabel">
              <span>What you see</span>
              <span>simplified terminal</span>
            </div>
            <div className="term" id="term" aria-live="polite" />
          </div>
          <div>
            <div className="plabel">
              <span>Behind the scenes</span>
              <span id="mapNote" />
            </div>
            <svg
              id="map"
              viewBox="0 0 640 380"
              role="img"
              aria-label="Diagram of Claude Code, the model and your tools"
            />
          </div>
        </div>
        <div className="narr" id="narr" aria-live="polite" />
        <div className="ctx" id="ctx">
          <div className="ctx-top">
            <div className="plabel" style={{ margin: '0' }}>
              The context window: what the model receives
            </div>
            <div className="ctx-sum" id="ctxSum" />
          </div>
          <div className="reqline" id="reqline" />
          <div id="lanes" />
          <div className="blocks" id="blocks" />
          <div className="legend" id="legend" />
        </div>
      </section>
      <section className="after" id="after" />
    </main>
  );
}
