import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VoiceComposer } from '@/components/voice/VoiceComposer';
import { statusService } from '@/services/statusService';
import {
  whiteboardService,
  type BoardReading,
  type ReadResult,
  type WhiteboardInfo,
} from '@/services/whiteboardService';
import { isLocalModel } from '@/lib/models';
import { Board, type BoardHandle, type Stroke } from './Board';
import { Graph } from './Graph';
import { GuessGame, LifePanel, PicturePanel, type GuessRecord, type PictureRecord, type SceneRecord } from './Modes';
import { Physics } from './Physics';
import { reach, section as cut, sectionName, type Vec } from './geometry';
import { Solid3D } from './Solid3D';
import './whiteboard.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const SAMPLES = [
  'Plot y = x^2 − 3',
  'y = A sin(x) + B, with sliders for A and B',
  'Turn my drawing into a 3D cube',
  'Cut the cube to make a regular hexagon',
  'Make it a square pyramid and cut it halfway up',
];

type Mode = 'maths' | 'guess' | 'life' | 'picture';
const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'maths', label: '∑ Maths', blurb: 'Sketch a graph or a solid; the board makes it real' },
  { id: 'guess', label: '🎲 Guess my drawing', blurb: 'Draw the word before the clock runs out' },
  { id: 'life', label: '⚽ Bring it to life', blurb: 'Draw balls, boxes and ramps, then press play' },
  { id: 'picture', label: '🎨 Sketch to picture', blurb: 'Your sketch, redrawn as a picture' },
];

/** One board in the history: as drawn, and what came of it in its mode. Entries saved before modes are maths. */
interface Entry {
  id: string;
  at: number;
  mode?: Mode;
  prompt: string;
  thumb: string;
  strokes: Stroke[];
  result?: ReadResult;
  answers: { q: string; a: string }[];
  game?: GuessRecord;
  scene?: SceneRecord;
  picture?: PictureRecord;
}

const titleOf = (e: Entry) => {
  if (e.game)
    return e.game.word ? `${e.game.won ? '✓' : '✗'} ${e.game.word}` : `A guess: ${e.game.guesses[0]?.label ?? '?'}`;
  if (e.scene) return `Scene: ${e.scene.bodies.length} bodies`;
  if (e.picture) return `Picture: ${e.picture.style}`;
  return e.result?.board.title || e.result?.board.read_as || 'Board';
};

const HISTORY_KEY = 'llm-lab.whiteboard.history';
const HISTORY_MAX = 20;

// The history lives in this browser only. Storage can be missing or full, so every access is guarded.
function loadHistory(): Entry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as Entry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: Entry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 5))); // full: keep the newest few
    } catch {
      /* no storage: the history lasts until the page closes */
    }
  }
}

const when = (t: number) =>
  new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const PLANES: { label: string; normal: Vec }[] = [
  { label: 'Horizontal', normal: [0, 1, 0] },
  { label: 'Vertical', normal: [1, 0, 0] },
  { label: 'Diagonal', normal: [1, 1, 0] },
  { label: 'Through three faces', normal: [1, 1, 1] },
];

/** A blank board, for a request made in words alone. */
function blankPng(): string {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c.toDataURL('image/png').split(',')[1];
}

/** The section controls and measurements for a solid. */
function SolidView({ board }: { board: BoardReading }) {
  const solid = board.solid;
  const [normal, setNormal] = useState<Vec>(board.section.enabled ? board.section.normal : [0, 1, 0]);
  const [offset, setOffset] = useState(board.section.enabled ? board.section.offset : 0);
  const [showCut, setShowCut] = useState(board.section.enabled);
  useEffect(() => {
    setNormal(board.section.enabled ? board.section.normal : [0, 1, 0]);
    setOffset(board.section.enabled ? board.section.offset : 0);
    setShowCut(board.section.enabled);
  }, [board]);
  const max = useMemo(() => reach(solid, normal), [solid, normal]);
  const sec = useMemo(() => (showCut ? cut(solid, normal, offset) : null), [solid, normal, offset, showCut]);

  return (
    <>
      <Solid3D solid={solid} normal={normal} offset={offset} section={sec} showPlane={showCut} />
      <div className="wb-cut">
        <label className="small">
          <input type="checkbox" checked={showCut} onChange={(e) => setShowCut(e.target.checked)} /> Cut it with a plane
        </label>
        {showCut && (
          <>
            <div className="wb-planes">
              {PLANES.map((p) => (
                <button
                  key={p.label}
                  className={`btn small${p.normal.join() === normal.join() ? ' primary' : ''}`}
                  onClick={() => {
                    setNormal(p.normal);
                    setOffset(0);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <label className="wb-slider">
              <b>Move</b>
              <input
                type="range"
                min={-max * 0.999}
                max={max * 0.999}
                step={max / 200}
                value={offset}
                onChange={(e) => setOffset(+e.target.value)}
              />
              <span className="mono">{offset.toFixed(2)}</span>
            </label>
            {sec ? (
              <p className="small">
                The section is <b>{sectionName(sec)}</b>
                {!sec.curved && sec.angles.length > 0 && (
                  <> with angles {sec.angles.map((a) => `${Math.round(a)}°`).join(', ')}</>
                )}
                . Area {sec.area.toFixed(2)}, perimeter {sec.perimeter.toFixed(2)} (the solid’s units).
              </p>
            ) : (
              <p className="small muted">The plane misses the solid here.</p>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** An AI whiteboard: sketch a graph or a shape, and the board redraws it as something you can explore. */
export default function WhiteboardPage() {
  const board = useRef<BoardHandle>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ReadResult | null>(null);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const [history, setHistory] = useState<Entry[]>(loadHistory);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('maths');
  const [info, setInfo] = useState<WhiteboardInfo | null>(null);
  const [restoredGame, setRestoredGame] = useState<GuessRecord | null>(null);
  const [scene, setScene] = useState<SceneRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [gravity, setGravity] = useState(1);
  const [bounce, setBounce] = useState(0.4);
  const [resetKey, setResetKey] = useState(0);
  const [picture, setPicture] = useState<PictureRecord | null>(null);

  const remember = (
    entry: Omit<Entry, 'id' | 'at' | 'thumb' | 'strokes' | 'answers' | 'prompt'> & { prompt?: string },
  ) => {
    const full: Entry = {
      id: crypto.randomUUID(),
      at: Date.now(),
      prompt: '',
      thumb: board.current?.thumbnail() ?? '',
      strokes: board.current?.strokes() ?? [],
      answers: [],
      ...entry,
    };
    setHistory((h) => [full, ...h].slice(0, HISTORY_MAX));
    setCurrent(full.id);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setRunning(false);
    setScene(null);
    setRestoredGame(null);
    setCurrent(null);
    setError('');
  };

  useEffect(() => saveHistory(history), [history]);

  useEffect(() => {
    whiteboardService
      .info()
      .then(setInfo)
      .catch((err) => setError(errorText(err)));
    statusService
      .status()
      .then((s) => {
        const offered = s.models || [];
        setModels(offered);
        setModel(s.claude_model || offered[0] || '');
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  async function read(text: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const image = board.current?.snapshot() ?? blankPng();
      const r = await whiteboardService.read(image, text, model || undefined);
      setResult(r);
      setAnswers([]);
      remember({ mode: 'maths', prompt: text, result: r });
      setCost((c) => c + r.cost_usd);
      setPrompt('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function ask(text: string) {
    if (!result || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await whiteboardService.ask(text, result.board, model || undefined);
      setAnswers((a) => [...a, { q: text, a: r.answer }]);
      setHistory((h) =>
        h.map((e) => (e.id === current ? { ...e, answers: [...e.answers, { q: text, a: r.answer }] } : e)),
      );
      setCost((c) => c + r.cost_usd);
      setQuestion('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function open(e: Entry) {
    if (busy) return;
    const m: Mode = e.mode ?? 'maths';
    setMode(m);
    setRunning(false);
    board.current?.load(e.strokes);
    setResult(e.result ?? null);
    setAnswers(e.answers);
    setRestoredGame(e.game ?? null);
    setScene(e.scene ?? null);
    setPicture(e.picture ?? null);
    setResetKey((k) => k + 1);
    setCurrent(e.id);
    setError('');
  }

  function fresh() {
    board.current?.load([]);
    setResult(null);
    setAnswers([]);
    setRestoredGame(null);
    setScene(null);
    setRunning(false);
    setPicture(null);
    setCurrent(null);
  }

  const b = result?.board;

  return (
    <main className="page-whiteboard">
      <div className="kicker">Building · AI whiteboard</div>
      <h1>Sketch it, and the board makes it real</h1>
      <p className="lede">
        Four ways to play. Maths: draw an equation, a graph or a shape, and the board turns it into a graph whose
        constants you can slide, or a 3D solid you can turn and cut. Guess my drawing: draw a word against the clock
        while the model guesses. Bring it to life: draw balls, boxes and ramps, and a physics engine sets them moving.
        Sketch to picture: the image model paints your sketch. In every mode the model reads the drawing; code does the
        maths, the physics and the scoring.
      </p>

      <div className="wb-bar">
        <label className="small">
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
                {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="small muted">Spent here: {usd(cost)}</span>
      </div>
      <div className="wb-modes" role="tablist" aria-label="Modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            className={`wb-mode${mode === m.id ? ' on' : ''}`}
            onClick={() => switchMode(m.id)}
            disabled={busy}
          >
            <b>{m.label}</b>
            <span>{m.blurb}</span>
          </button>
        ))}
      </div>
      {error && <p className="wb-bad small">{error}</p>}

      <div className="wb-shell">
        <aside className="card wb-history" aria-label="History">
          <div className="wb-history-head">
            <b>History</b>
            <button className="btn small" onClick={fresh} disabled={busy}>
              + New board
            </button>
          </div>
          {history.length === 0 && <p className="small muted">Each board you send to the AI is kept here.</p>}
          <ol className="wb-history-list">
            {history.map((e) => (
              <li key={e.id}>
                <button className={`wb-history-item${e.id === current ? ' on' : ''}`} onClick={() => open(e)}>
                  {e.thumb && <img src={e.thumb} alt="" />}
                  <span className="wb-history-title">{titleOf(e)}</span>
                  <span className="wb-history-meta">
                    {MODES.find((m) => m.id === (e.mode ?? 'maths'))?.label.split(' ')[0]} {when(e.at)}
                    {e.answers.length > 0 && ` · ${e.answers.length} question${e.answers.length > 1 ? 's' : ''}`}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {history.length > 0 && (
            <button
              className="btn small wb-history-clear"
              onClick={() => {
                setHistory([]);
                setCurrent(null);
              }}
            >
              Clear history
            </button>
          )}
        </aside>

        <div className="wb-layout">
          <section className="card wb-left" aria-label="Board">
            <Board
              ref={board}
              tidy
              hint={
                mode === 'guess'
                  ? 'Press Start a round, then draw the word here'
                  : mode === 'life'
                    ? 'Draw a ball, a ramp and some boxes'
                    : mode === 'picture'
                      ? 'Sketch anything: a house, a cat, a boat'
                      : undefined
              }
              covered={mode === 'life' && !!scene}
            >
              {mode === 'life' && scene && (
                <Physics
                  bodies={scene.bodies}
                  width={scene.width}
                  height={scene.height}
                  running={running}
                  gravity={gravity}
                  bounce={bounce}
                  resetKey={resetKey}
                />
              )}
            </Board>
            {mode === 'maths' && (
              <>
                <VoiceComposer
                  value={prompt}
                  onChange={setPrompt}
                  onSend={(t) => void read(t)}
                  onError={setError}
                  busy={busy}
                  placeholder="What should the AI do? (optional)"
                />
                <div className="wb-actions">
                  <button className="btn primary" disabled={busy} onClick={() => void read(prompt)}>
                    {busy ? 'Reading…' : '✨ AI: read my board'}
                  </button>
                  {SAMPLES.map((s) => (
                    <button key={s} className="btn small" disabled={busy} onClick={() => void read(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="card wb-right" aria-label="What the board made">
            {mode === 'guess' && (
              <GuessGame
                board={board}
                info={info}
                model={model}
                restored={restoredGame}
                onCost={(c) => setCost((x) => x + c)}
                onError={setError}
                onRoundEnd={(game) => remember({ mode: 'guess', game })}
              />
            )}
            {mode === 'life' && (
              <LifePanel
                board={board}
                model={model}
                scene={scene}
                running={running}
                gravity={gravity}
                bounce={bounce}
                onScene={(s) => {
                  setScene(s);
                  setResetKey((k) => k + 1);
                  if (s) remember({ mode: 'life', scene: s });
                }}
                onRunning={setRunning}
                onGravity={setGravity}
                onBounce={setBounce}
                onReset={() => setResetKey((k) => k + 1)}
                onCost={(c) => setCost((x) => x + c)}
                onError={setError}
              />
            )}
            {mode === 'picture' && (
              <PicturePanel
                board={board}
                info={info}
                picture={picture}
                onPicture={(pic) => {
                  setPicture(pic);
                  remember({ mode: 'picture', picture: pic });
                }}
                onCost={(c) => setCost((x) => x + c)}
                onError={setError}
              />
            )}
            {mode === 'maths' && !b && (
              <div className="wb-empty small muted">
                <p>What you draw appears here, made properly.</p>
                <p>
                  Try writing y = x² − 3, or y = A sin x + B, or drawing a box and asking for a cube cut into a hexagon.
                </p>
              </div>
            )}
            {mode === 'maths' && b && (
              <>
                <h2 className="wb-title">{b.title || 'Your board'}</h2>
                <p className="small muted">
                  Read as: {b.read_as}
                  {result && result.tries.length > 1 && (
                    <> · fixed on a second try after code found: {result.tries[0].problems.join('; ')}</>
                  )}
                </p>
                {b.kind === 'function' && <Graph functions={b.functions} params={b.parameters} xRange={b.x_range} />}
                {b.kind === 'solid' && <SolidView board={b} />}
                {b.kind === 'unknown' && <p className="small">The model could not tell what this is.</p>}
                <div className="wb-explain">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.explanation}</ReactMarkdown>
                </div>
                {answers.map((x, i) => (
                  <div key={i} className="wb-qa">
                    <p className="small">
                      <b>You:</b> {x.q}
                    </p>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{x.a}</ReactMarkdown>
                  </div>
                ))}
                <VoiceComposer
                  value={question}
                  onChange={setQuestion}
                  onSend={(t) => void ask(t)}
                  onError={setError}
                  busy={busy}
                  placeholder="Ask about it: what does B do? why a hexagon?"
                />
              </>
            )}
          </section>
        </div>
      </div>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read the sketch: “this is y = A sin x + B”, “this is a cube”</td>
              <td>The model (Claude, GPT or the local model), as JSON in a fixed schema</td>
              <td>Reading handwriting and rough drawings is what models are good at</td>
            </tr>
            <tr>
              <td>Turn a wobbly circle, line or box into a perfect one as you draw</td>
              <td>Code, in the page: fits each finished stroke to a line, circle, ellipse or polygon</td>
              <td>Geometry is exact and instant, and needs no model call; handwriting is left alone</td>
            </tr>
            <tr>
              <td>Check the reading</td>
              <td>Code: expressions against a whitelist, ranges, sizes; one retry with the problems</td>
              <td>The page must never run what the model wrote</td>
            </tr>
            <tr>
              <td>Plot the function and move the sliders</td>
              <td>Code: the page’s own expression parser</td>
              <td>Exact, instant, and free on every slider move</td>
            </tr>
            <tr>
              <td>Turn the solid, cut it, name the section, measure angles and area</td>
              <td>Code: three.js and the geometry module</td>
              <td>A model guessing angles would be wrong some of the time; arithmetic never is</td>
            </tr>
            <tr>
              <td>Guess my drawing: guess what the sketch is</td>
              <td>The model (Haiku by default), never told the word</td>
              <td>Recognising a rough drawing is a vision model’s job</td>
            </tr>
            <tr>
              <td>Decide whether a guess is the word, run the clock, keep the score</td>
              <td>Code: plain words and a short synonym list per word</td>
              <td>A model asked “is this right?” could be talked into yes; a rule cannot</td>
            </tr>
            <tr>
              <td>Bring it to life: say which shapes are balls, boxes and ramps, and which move</td>
              <td>The model, as JSON, with the exact shapes the page recognised given to it as hints</td>
              <td>Telling a ramp from a shelf needs understanding the drawing</td>
            </tr>
            <tr>
              <td>Check the scene, then gravity, collisions, bounce, friction and throwing</td>
              <td>Code: sizes and positions checked, then matter-js, a 2D physics engine</td>
              <td>Physics must be the same every time and run sixty times a second</td>
            </tr>
            <tr>
              <td>Sketch to picture</td>
              <td>gpt-image-2, given the sketch itself as its reference image</td>
              <td>Making a picture is the image model’s job; the sketch keeps the layout yours</td>
            </tr>
            <tr>
              <td>Explain it, and answer questions</td>
              <td>The model, given what the board shows</td>
              <td>Explaining in words is the model’s job</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
