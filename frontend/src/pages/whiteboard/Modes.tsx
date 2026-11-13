import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  whiteboardService,
  type GuessResult,
  type PictureResult,
  type SceneBody,
  type WhiteboardInfo,
} from '@/services/whiteboardService';
import type { BoardHandle } from './Board';

/* The whiteboard's three playful modes: a drawing game, a sketch that comes to life, and a sketch redrawn as a
   picture. In each, the model reads the drawing; code decides (the winning guess, whether a scene can run). */

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const ROUND_SECONDS = 40;
const GUESS_EVERY_MS = 3000;
const MAX_CALLS = 12; // per round, so a long scribble cannot run up the bill
const GAME_KEY = 'llm-lab.whiteboard.game';

type Level = 'easy' | 'medium' | 'hard';

interface GameStats {
  rounds: number;
  wins: number;
  points: number;
  streak: number;
  best: number;
}

function loadStats(): GameStats {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (raw) return { rounds: 0, wins: 0, points: 0, streak: 0, best: 0, ...(JSON.parse(raw) as Partial<GameStats>) };
  } catch {
    /* no storage */
  }
  return { rounds: 0, wins: 0, points: 0, streak: 0, best: 0 };
}

function saveStats(stats: GameStats) {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(stats));
  } catch {
    /* no storage: the scores last until the page closes */
  }
}

/** What a finished round leaves in the history. */
export interface GuessRecord {
  word: string | null;
  won: boolean;
  points: number;
  guesses: { label: string; confidence: number; at: number }[];
  /** The guess code accepted as the word. */
  hit?: string | null;
}

interface GuessProps {
  board: RefObject<BoardHandle | null>;
  info: WhiteboardInfo | null;
  model: string;
  onCost: (usd: number) => void;
  onError: (message: string) => void;
  onRoundEnd: (record: GuessRecord) => void;
  restored: GuessRecord | null;
}

/** Guess my drawing: draw the word before the clock runs out, while the model guesses out loud. */
export function GuessGame({ board, info, model, onCost, onError, onRoundEnd, restored }: GuessProps) {
  const [level, setLevel] = useState<Level>('easy');
  const [word, setWord] = useState<string | null>(restored?.word ?? null);
  const [playing, setPlaying] = useState(false);
  const [left, setLeft] = useState(ROUND_SECONDS);
  const [guesses, setGuesses] = useState<GuessRecord['guesses']>(restored?.guesses ?? []);
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<{ won: boolean; points: number } | null>(
    restored ? { won: restored.won, points: restored.points } : null,
  );
  const [stats, setStats] = useState<GameStats>(loadStats);
  const [busy, setBusy] = useState(false);
  const [roundCost, setRoundCost] = useState(0);
  const round = useRef({ started: 0, calls: 0, lastVersion: -1, busy: false, over: true });
  const [hit, setHit] = useState<string | null>(restored?.hit ?? null);
  const hitRef = useRef(hit);
  hitRef.current = hit;

  useEffect(() => {
    if (!restored) return;
    setWord(restored.word);
    setGuesses(restored.guesses);
    setResult({ won: restored.won, points: restored.points });
    setHit(restored.hit ?? null);
    setPlaying(false);
    round.current.over = true;
  }, [restored]);

  const finish = (won: boolean, list: GuessRecord['guesses'], secondsLeft: number) => {
    if (round.current.over) return;
    round.current.over = true;
    setPlaying(false);
    const points = won ? 50 + Math.round(secondsLeft) * 10 : 0;
    setResult({ won, points });
    setStats((s) => {
      const streak = won ? s.streak + 1 : 0;
      const next = {
        rounds: s.rounds + 1,
        wins: s.wins + (won ? 1 : 0),
        points: s.points + points,
        streak,
        best: Math.max(s.best, streak),
      };
      saveStats(next);
      return next;
    });
    onRoundEnd({ word, won, points, guesses: list, hit: hitRef.current });
  };

  const ask = async (forWord: string | null, list: GuessRecord['guesses']) => {
    const image = board.current?.snapshot(512);
    if (!image) return list;
    round.current.busy = true;
    round.current.calls += 1;
    round.current.lastVersion = board.current?.version() ?? 0;
    setBusy(true);
    try {
      const r: GuessResult = await whiteboardService.guess(image, forWord, model || undefined);
      onCost(r.cost_usd);
      setRoundCost((c) => c + r.cost_usd);
      setComment(r.comment);
      const at = forWord ? Math.round((performance.now() - round.current.started) / 1000) : 0;
      const next = [...r.guesses.map((g) => ({ ...g, at })), ...list].slice(0, 30);
      setGuesses(next);
      if (forWord && r.matched) {
        hitRef.current = r.matched;
        setHit(r.matched);
      }
      if (forWord && r.matched) finish(true, next, ROUND_SECONDS - (performance.now() - round.current.started) / 1000);
      return next;
    } catch (err) {
      onError(errorText(err));
      return list;
    } finally {
      round.current.busy = false;
      setBusy(false);
    }
  };

  // The clock and the model's turns while a round runs. The model looks again only when the drawing has changed.
  const listRef = useRef(guesses);
  listRef.current = guesses;
  useEffect(() => {
    if (!playing) return;
    const tick = window.setInterval(() => {
      const elapsed = (performance.now() - round.current.started) / 1000;
      const remaining = Math.max(0, ROUND_SECONDS - elapsed);
      setLeft(remaining);
      if (remaining <= 0 && !round.current.busy) finish(false, listRef.current, 0);
    }, 200);
    const look = window.setInterval(() => {
      const r = round.current;
      if (r.over || r.busy || r.calls >= MAX_CALLS) return;
      if ((board.current?.version() ?? 0) === r.lastVersion || board.current?.isEmpty()) return;
      void ask(word, listRef.current);
    }, GUESS_EVERY_MS);
    return () => {
      clearInterval(tick);
      clearInterval(look);
    };
    // the round's word and model are fixed once it starts
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    const words = info?.words[level] ?? [];
    if (!words.length) return;
    const next = words[Math.floor(Math.random() * words.length)];
    board.current?.load([]);
    setWord(next);
    setGuesses([]);
    setComment('');
    setResult(null);
    setHit(null);
    setRoundCost(0);
    setLeft(ROUND_SECONDS);
    round.current = { started: performance.now(), calls: 0, lastVersion: -1, busy: false, over: false };
    setPlaying(true);
  };

  const pct = (left / ROUND_SECONDS) * 100;
  return (
    <div className="wb-game">
      <div className="wb-row">
        <span className="small">Level</span>
        {(['easy', 'medium', 'hard'] as Level[]).map((l) => (
          <button
            key={l}
            className={`btn small${level === l ? ' primary' : ''}`}
            disabled={playing}
            onClick={() => setLevel(l)}
          >
            {l}
          </button>
        ))}
        <button className="btn primary" disabled={playing || !info} onClick={start}>
          {result ? 'Next word' : 'Start a round'}
        </button>
        {playing && (
          <button className="btn small" onClick={() => finish(false, guesses, 0)}>
            Give up
          </button>
        )}
      </div>

      {word && (
        <div className={`wb-word${playing ? ' live' : ''}`}>
          <span className="small muted">Draw</span>
          <b>{word}</b>
          {playing && (
            <span className="wb-clock">
              <i style={{ width: `${pct}%` }} className={left < 10 ? 'low' : ''} />
              <span className="mono">{Math.ceil(left)} s</span>
            </span>
          )}
        </div>
      )}
      {!word && !playing && (
        <p className="small muted">
          Press Start: you get a word and {ROUND_SECONDS} seconds to draw it. Every few seconds, while you draw, the
          model looks at the board and guesses. Code checks each guess against the word (and a few synonyms); the model
          is never told it.
        </p>
      )}

      {result && (
        <p className={`wb-result ${result.won ? 'won' : 'lost'}`}>
          {result.won ? `Got it: ${result.points} points.` : `Time’s up: the word was “${word}”.`}
        </p>
      )}
      {comment && <p className="small wb-comment">“{comment}”</p>}

      {guesses.length > 0 && (
        <ol className="wb-guesses">
          {guesses.map((g, i) => (
            <li key={`${g.label}-${i}`} className={word && hit === g.label ? 'hit' : ''}>
              <span>{g.label}</span>
              <span className="wb-conf">
                <i style={{ width: `${g.confidence * 100}%` }} />
              </span>
              <span className="mono small muted">{word ? `${g.at} s` : `${Math.round(g.confidence * 100)}%`}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="wb-row">
        <button
          className="btn small"
          disabled={playing || busy}
          onClick={() => {
            setWord(null);
            setResult(null);
            void ask(null, []);
          }}
          title="One guess at whatever is on the board, with no word to find"
        >
          {busy && !playing ? 'Looking…' : '🤔 What is this?'}
        </button>
        <span className="small muted">
          {info?.guess_model ?? 'Haiku'} by default · this round {`$${roundCost.toFixed(4)}`} · at most {MAX_CALLS}{' '}
          looks a round
        </span>
      </div>

      <div className="wb-scores small">
        <span>
          Rounds <b>{stats.rounds}</b>
        </span>
        <span>
          Won <b>{stats.wins}</b>
        </span>
        <span>
          Points <b>{stats.points}</b>
        </span>
        <span>
          Streak <b>{stats.streak}</b>
        </span>
        <span>
          Best streak <b>{stats.best}</b>
        </span>
        <button
          className="wb-link"
          onClick={() => {
            const zero = { rounds: 0, wins: 0, points: 0, streak: 0, best: 0 };
            saveStats(zero);
            setStats(zero);
          }}
        >
          reset
        </button>
      </div>
    </div>
  );
}

export interface SceneRecord {
  bodies: SceneBody[];
  comment: string;
  width: number;
  height: number;
}

interface LifeProps {
  board: RefObject<BoardHandle | null>;
  model: string;
  scene: SceneRecord | null;
  running: boolean;
  gravity: number;
  bounce: number;
  onScene: (scene: SceneRecord | null, tries?: { attempt: number; problems: string[] }[]) => void;
  onRunning: (running: boolean) => void;
  onGravity: (g: number) => void;
  onBounce: (b: number) => void;
  onReset: () => void;
  onCost: (usd: number) => void;
  onError: (message: string) => void;
}

const EXAMPLE = 'Draw a ball at the top, a ramp sloping down under it, and a few boxes stacked at the bottom.';

/** Bring it to life: the model reads the sketch into bodies; the physics engine runs them over the board. */
export function LifePanel(props: LifeProps) {
  const { board, model, scene, running, gravity, bounce } = props;
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [tries, setTries] = useState<{ attempt: number; problems: string[] }[]>([]);

  const read = async () => {
    const image = board.current?.snapshot(1024);
    if (!image) {
      props.onError('Draw something first: a ball, a ramp, some boxes.');
      return;
    }
    setBusy(true);
    try {
      const size = board.current!.size();
      const r = await whiteboardService.scene(image, board.current!.shapes(), size, prompt, model || undefined);
      props.onCost(r.cost_usd);
      setTries(r.tries);
      props.onScene({ bodies: r.bodies, comment: r.comment, ...size }, r.tries);
      props.onRunning(true);
    } catch (err) {
      props.onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const counts = scene
    ? (['ball', 'box', 'line'] as const).map((k) => [k, scene.bodies.filter((b) => b.kind === k).length] as const)
    : [];
  return (
    <div className="wb-life">
      {!scene ? (
        <>
          <p className="small">
            {EXAMPLE} Circles and boxes drawn with Tidy shapes on, or the shape tools, give the model exact positions.
          </p>
          <input
            className="wb-life-prompt"
            value={prompt}
            maxLength={600}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Anything to add? e.g. the top box is fixed"
          />
          <div className="wb-row">
            <button className="btn primary" disabled={busy} onClick={() => void read()}>
              {busy ? 'Reading the scene…' : '▶ Bring it to life'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small">
            <b>The model read:</b>{' '}
            {counts
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${n} ${k === 'box' ? (n > 1 ? 'boxes' : 'box') : k + (n > 1 ? 's' : '')}`)
              .join(', ')}
            . {scene.comment}
          </p>
          {tries.length > 1 && (
            <p className="small muted">Fixed on a second try after code found: {tries[0].problems.join('; ')}</p>
          )}
          <div className="wb-row">
            <button className="btn primary" onClick={() => props.onRunning(!running)}>
              {running ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button className="btn small" onClick={props.onReset}>
              ↺ Reset
            </button>
            <button
              className="btn small"
              onClick={() => {
                props.onRunning(false);
                props.onScene(null);
              }}
            >
              ✎ Back to drawing
            </button>
          </div>
          <label className="wb-slider">
            <b>Gravity</b>
            <input
              type="range"
              min={-1}
              max={3}
              step={0.05}
              value={gravity}
              onChange={(e) => props.onGravity(+e.target.value)}
            />
            <span className="mono">{gravity.toFixed(2)} g</span>
          </label>
          <label className="wb-slider">
            <b>Bounce</b>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={bounce}
              onChange={(e) => props.onBounce(+e.target.value)}
            />
            <span className="mono">{bounce.toFixed(2)}</span>
          </label>
          <p className="small muted">Drag a coloured body and let go to throw it. Grey ones are fixed.</p>
          <details className="small">
            <summary>The scene as data</summary>
            <pre className="wb-json">{JSON.stringify(scene.bodies, null, 1)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

export interface PictureRecord {
  url: string;
  style: string;
  prompt: string;
}

interface PictureProps {
  board: RefObject<BoardHandle | null>;
  info: WhiteboardInfo | null;
  picture: PictureRecord | null;
  onPicture: (p: PictureRecord) => void;
  onCost: (usd: number) => void;
  onError: (message: string) => void;
}

/** Sketch to picture: the image model redraws the sketch in a chosen style. */
export function PicturePanel({ board, info, picture, onPicture, onCost, onError }: PictureProps) {
  const [style, setStyle] = useState(info?.picture_styles[0] ?? 'a soft watercolour painting');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (info?.picture_styles[0]) setStyle((s) => s || info.picture_styles[0]);
  }, [info]);

  if (info && !info.picture) return <p className="small muted">{info.picture_why}</p>;

  const make = async () => {
    const image = board.current?.snapshot(1024);
    if (!image) {
      onError('Draw something first.');
      return;
    }
    setBusy(true);
    const started = performance.now();
    const timer = window.setInterval(() => setSeconds(Math.round((performance.now() - started) / 1000)), 500);
    try {
      const r: PictureResult = await whiteboardService.picture(image, style, subject);
      onCost(r.cost_usd);
      onPicture({ url: r.url, style, prompt: r.prompt });
    } catch (err) {
      onError(errorText(err));
    } finally {
      clearInterval(timer);
      setBusy(false);
    }
  };

  return (
    <div className="wb-picture">
      <div className="wb-row">
        <select value={style} onChange={(e) => setStyle(e.target.value)} disabled={busy}>
          {(info?.picture_styles ?? []).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input
          value={subject}
          maxLength={200}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="What is it? (optional) e.g. a lighthouse at night"
        />
        <button className="btn primary" disabled={busy || !info} onClick={() => void make()}>
          {busy ? `Painting… ${seconds} s` : '🎨 Make it a picture'}
        </button>
      </div>
      <p className="small muted">
        gpt-image-2 gets the sketch itself as its reference image, so the picture follows your layout. It takes up to a
        minute and costs a few cents.
      </p>
      {picture && (
        <figure className="wb-made">
          <img src={picture.url} alt={`The sketch as ${picture.style}`} />
          <figcaption className="small muted">As {picture.style}.</figcaption>
        </figure>
      )}
    </div>
  );
}
