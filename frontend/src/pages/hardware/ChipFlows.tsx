import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import './chipflows.css';

type Chip = {
  id: string;
  name: string;
  tag: string;
  moves: string;
  what: string;
  strong: string;
  weak: string;
  examples: string;
  deeper: { href: string; label: string };
  draw: (tick: number) => ReactNode;
  label: string;
};

/* ----- CPU: a few big cores, each on a different task, handed out in order by the control unit. ----- */

const CPU_TASKS: [string, number][] = [
  ['parse', 2],
  ['DB', 4],
  ['net', 3],
  ['sort', 2],
  ['if/else', 1],
  ['JSON', 2],
  ['auth', 3],
  ['log', 1],
  ['tokenise', 2],
  ['tool call', 3],
];
type CpuSim = { tick: number; next: number; cores: { task: number; left: number; total: number; fresh: boolean }[] };

function cpuStart(): CpuSim {
  return { tick: -1, next: 0, cores: Array.from({ length: 4 }, () => ({ task: 0, left: 0, total: 1, fresh: false })) };
}

/** One tick: busy cores do a unit of work, then each free core takes the next task in the queue. */
function cpuStep(sim: CpuSim) {
  sim.tick++;
  for (const c of sim.cores) {
    c.fresh = false;
    if (c.left > 0) c.left--;
  }
  for (const c of sim.cores) {
    if (c.left > 0) continue;
    const [, len] = CPU_TASKS[sim.next % CPU_TASKS.length];
    Object.assign(c, { task: sim.next, left: len, total: len, fresh: true });
    sim.next++;
  }
}

function Cpu({ tick }: { tick: number }) {
  // The simulation carries on from the last tick drawn, so it never has to restart (and jump) to stay cheap.
  const sim = useRef<CpuSim>(cpuStart());
  if (sim.current.tick > tick) sim.current = cpuStart();
  while (sim.current.tick < tick) cpuStep(sim.current);
  const { cores, next } = sim.current;
  const name = (i: number) => CPU_TASKS[i % CPU_TASKS.length][0];
  return (
    <>
      <text x={10} y={16} className="lbl">
        task queue
      </text>
      {[2, 1, 0].map((q, row) => (
        <g key={next + q} className="mv" style={{ transform: `translate(10px, ${26 + row * 30}px)` }}>
          <rect width={60} height={24} rx={5} className={q === 0 ? 'box hot' : 'box'} />
          <text x={30} y={16} className="mid">
            {name(next + q)}
          </text>
        </g>
      ))}
      <rect x={84} y={52} width={42} height={40} rx={6} className="box strong" />
      <text x={105} y={70} className="mid">
        control
      </text>
      <text x={105} y={82} className="mid sm">
        unit
      </text>
      {cores.map((c, i) => {
        const x = 150;
        const y = 6 + i * 37;
        const done = (c.total - c.left + 1) / c.total;
        return (
          <g key={i}>
            <path d={`M126 72 L${x} ${y + 16}`} className={c.fresh ? 'wire on' : 'wire'} />
            <rect x={x} y={y} width={142} height={32} rx={6} className={c.fresh ? 'box chip on' : 'box chip'} />
            <text x={x + 8} y={y + 13} className="lbl">
              core {i + 1}
            </text>
            <text x={x + 8} y={y + 26} className="big">
              {name(c.task)}
            </text>
            <rect x={x + 78} y={y + 14} width={56} height={5} rx={2.5} className="track" />
            <rect x={x + 78} y={y + 14} width={56 * done} height={5} rx={2.5} className="fill mvw" />
          </g>
        );
      })}
    </>
  );
}

/* ----- GPU: one instruction, every core at once, fed from high-bandwidth memory. ----- */

const GPU_STEPS = ['LOAD tile', 'MUL', 'ADD', 'STORE'];

function Gpu({ tick }: { tick: number }) {
  const step = GPU_STEPS[tick % GPU_STEPS.length];
  const tile = Math.floor(tick / GPU_STEPS.length) % 8;
  return (
    <>
      <text x={10} y={16} className="lbl">
        one instruction → every core: <tspan className="em">{step}</tspan>
      </text>
      <g key={tick} className="flash">
        {Array.from({ length: 128 }, (_, n) => (
          <rect
            key={n}
            x={10 + (n % 16) * 12}
            y={26 + Math.floor(n / 16) * 12}
            width={10}
            height={10}
            rx={2}
            className="core"
          />
        ))}
      </g>
      <text x={10} y={136} className="lbl">
        128 cores shown; a large GPU has over 16,000
      </text>
      <text x={10} y={150} className="lbl">
        output tile {tile + 1} of 8
      </text>
      {[0, 1].map((s) => (
        <g key={s}>
          {[0, 1, 2, 3, 4].map((l) => (
            <rect key={l} x={244} y={30 + s * 50 + l * 7} width={46} height={5} rx={1.5} className="hbm" />
          ))}
          <path d={`M242 ${46 + s * 50} L206 ${46 + s * 50}`} className="stream" />
        </g>
      ))}
      <text x={267} y={22} className="mid sm">
        HBM
      </text>
      <text x={267} y={140} className="mid sm">
        fast memory
      </text>
    </>
  );
}

/* ----- TPU: a weight-stationary systolic array. Inputs move right, partial sums move down. ----- */

const TN = 5;
const TB = 3; // input vectors in one pass
const TPU_PERIOD = TB + 2 * TN + 1;
const TC = 21; // cell pitch
const TX = 96;
const TY = 26;

function Tpu({ tick }: { tick: number }) {
  const p = tick % TPU_PERIOD;
  const cycle = Math.floor(tick / TPU_PERIOD);
  const cells = [];
  const inputs = [];
  for (let r = 0; r < TN; r++) {
    for (let c = 0; c < TN; c++) {
      const k = p - r - c;
      cells.push(
        <g key={`${r}-${c}`}>
          <rect
            x={TX + c * TC}
            y={TY + r * TC}
            width={19}
            height={19}
            rx={3}
            className={k >= 0 && k < TB ? 'box chip on' : 'box chip'}
          />
          <circle cx={TX + c * TC + 13.5} cy={TY + r * TC + 4} r={1.6} className="w" />
        </g>,
      );
    }
    for (let k = 0; k < TB; k++) {
      const c = p - r - k; // the column item k's value for row r is in now
      if (c >= TN) continue;
      const x = c >= 0 ? TX + c * TC + 8.5 : TX - 8 + (c + 1) * 11;
      inputs.push(
        <circle
          key={`${cycle}-${r}-${k}`}
          r={3.2}
          className={`dot k${k} mv`}
          style={{ transform: `translate(${x}px, ${TY + r * TC + 8.5}px)` }}
        />,
      );
    }
  }
  const sums = [];
  for (let c = 0; c < TN; c++) {
    const k = p - TN - c; // the item whose sum leaves column c now
    if (k >= 0 && k < TB)
      sums.push(
        <circle
          key={`${cycle}-${c}-${k}`}
          cx={TX + c * TC + 8.5}
          cy={TY + TN * TC + 6}
          r={3.2}
          className={`dot k${k}`}
        />,
      );
  }
  return (
    <>
      <text x={TX} y={16} className="lbl">
        weights preloaded in each cell
      </text>
      <text x={10} y={TY + 12} className="lbl">
        inputs →
      </text>
      {cells}
      {inputs}
      {sums}
      <text x={TX + TN * TC + 6} y={TY + TN * TC + 9} className="lbl">
        sums ↓
      </text>
      <text x={10} y={150} className="lbl">
        each cell: multiply, add, pass on. Each value is read once.
      </text>
    </>
  );
}

/* ----- NPU: a small quantised model on the phone itself; nothing goes to the cloud. ----- */

const NPU_PERIOD = 6;
const NPU_JOBS = [
  { from: 'camera', result: 'face matched ✓' },
  { from: 'mic', result: 'wake word heard ✓' },
];

function Npu({ tick }: { tick: number }) {
  const p = tick % NPU_PERIOD;
  const cycle = Math.floor(tick / NPU_PERIOD);
  const job = NPU_JOBS[cycle % NPU_JOBS.length];
  const src = job.from === 'camera' ? [26, 56] : [26, 104];
  const path = [src, [78, 70], [150, 72], [150, 72], [150, 118], [150, 118]];
  const [x, y] = path[p];
  const busy = p === 2 || p === 3;
  return (
    <>
      <circle cx={26} cy={56} r={11} className={job.from === 'camera' && p === 0 ? 'box chip on' : 'box'} />
      <circle cx={26} cy={56} r={4} className="w" />
      <text x={26} y={80} className="mid sm">
        camera
      </text>
      <rect
        x={20}
        y={94}
        width={12}
        height={20}
        rx={6}
        className={job.from === 'mic' && p === 0 ? 'box chip on' : 'box'}
      />
      <text x={26} y={128} className="mid sm">
        mic
      </text>
      <rect x={70} y={6} width={160} height={142} rx={16} className="phone" />
      <rect x={112} y={46} width={76} height={52} rx={7} className={busy ? 'box chip on' : 'box chip'} />
      <text x={150} y={68} className="mid big">
        NPU
      </text>
      <text x={150} y={84} className="mid sm">
        INT8 weights
      </text>
      <text x={150} y={132} className={p === 5 ? 'mid em' : 'mid dim'}>
        {p === 5 ? job.result : 'waiting…'}
      </text>
      <circle key={cycle} r={4} className="dot k0 mv" style={{ transform: `translate(${x}px, ${y}px)` }} />
      <g className="nocloud">
        <path d="M252 46 a10 10 0 0 1 18 -6 a8 8 0 0 1 14 6 a6 6 0 0 1 -2 12 h-28 a6 6 0 0 1 -2 -12z" />
        <path d="M248 36 L290 66" className="cross" />
      </g>
      <text x={268} y={80} className="mid sm">
        no cloud
      </text>
      <text x={268} y={92} className="mid sm">
        call
      </text>
      <text x={268} y={130} className="mid sm">
        a few watts
      </text>
    </>
  );
}

/* ----- LPU: weights in on-chip SRAM; the compiler fixes when every step happens. ----- */

const LPU_STAGES = ['L1', 'L2', 'L3', 'L4', 'Head'];
const LPU_PERIOD = LPU_STAGES.length + 1;
const LPU_WORDS = ['The', 'lab', 'runs', 'every', 'token', 'in', 'the', 'same', 'time.'];

function Lpu({ tick }: { tick: number }) {
  const p = tick % LPU_PERIOD;
  const token = Math.floor(tick / LPU_PERIOD);
  const words = LPU_WORDS.slice(0, (token % (LPU_WORDS.length + 1)) + (p === LPU_PERIOD - 1 ? 1 : 0)).join(' ');
  const sx = (i: number) => 10 + i * 57;
  const dotX = p < LPU_STAGES.length ? sx(p) + 23 : 280;
  const dotY = p < LPU_STAGES.length ? 64 : 133;
  return (
    <>
      <text x={10} y={12} className="lbl">
        on-chip SRAM: weights sit next to compute
      </text>
      {Array.from({ length: 28 }, (_, n) => (
        <rect key={n} x={10 + n * 10} y={18} width={8} height={12} rx={1.5} className="sram" />
      ))}
      {LPU_STAGES.map((s, i) => (
        <g key={s}>
          <path d={`M${sx(i) + 23} 31 L${sx(i) + 23} 58`} className="stream" />
          {i > 0 && <path d={`M${sx(i) - 11} 72 L${sx(i)} 72`} className="wire" />}
          <rect x={sx(i)} y={58} width={46} height={28} rx={6} className={p === i ? 'box chip on' : 'box chip'} />
          <text x={sx(i) + 23} y={76} className="mid">
            {s}
          </text>
          <rect x={sx(i) + 13} y={96} width={20} height={6} rx={3} className={p === i ? 'fill' : 'track'} />
        </g>
      ))}
      <text x={10} y={116} className="lbl">
        clock: one stage per tick, the same ticks every run
      </text>
      <text x={10} y={136} className="lbl">
        out: <tspan className="em">{words}</tspan>
      </text>
      <circle key={token} r={4} className="dot k0 mv" style={{ transform: `translate(${dotX}px, ${dotY}px)` }} />
    </>
  );
}

/* ----- DPU: packets are filtered, decrypted and routed on the network card, not on the CPU. ----- */

const DPU_DEST = [
  { name: 'Storage', y: 30 },
  { name: 'CPU', y: 76 },
  { name: 'GPU', y: 122 },
];
const DPU_ORDER = [0, 2, 0, 2, 1]; // mostly data for storage and the GPUs

function Dpu({ tick }: { tick: number }) {
  const stops = [
    [22, 80],
    [77, 89],
    [125, 89],
    [173, 89],
  ];
  const packets = [];
  for (let i = Math.max(0, Math.floor((tick - 4) / 2)); i <= Math.floor(tick / 2); i++) {
    const s = tick - 2 * i;
    if (s < 0 || s > 4) continue;
    const d = DPU_DEST[DPU_ORDER[i % DPU_ORDER.length]];
    const [x, y] = s < 4 ? stops[s] : [244, d.y];
    packets.push(
      <rect
        key={i}
        x={-4}
        y={-4}
        width={8}
        height={8}
        rx={2}
        className="dot k1 mv"
        style={{ transform: `translate(${x}px, ${y}px)` }}
      />,
    );
  }
  const at = (s: number) => s <= tick && (tick - s) % 2 === 0; // a packet starts every 2 ticks and moves one stop a tick
  return (
    <>
      <circle cx={22} cy={80} r={12} className="box" />
      <path d="M10 80 h24 M22 68 c-7 8 -7 16 0 24 M22 68 c7 8 7 16 0 24" className="wire" />
      <text x={22} y={106} className="mid sm">
        network
      </text>
      <rect x={48} y={44} width={152} height={72} rx={9} className="phone" />
      <text x={56} y={58} className="lbl">
        DPU / SmartNIC
      </text>
      {['Firewall', 'Crypto', 'Route'].map((n, i) => (
        <g key={n}>
          <rect
            x={56 + i * 48}
            y={64}
            width={42}
            height={32}
            rx={5}
            className={at(i + 1) ? 'box chip on' : 'box chip'}
          />
          <text x={77 + i * 48} y={77} className="mid sm">
            {n}
          </text>
        </g>
      ))}
      <text x={124} y={108} className="mid sm">
        its own cores and accelerators
      </text>
      {DPU_DEST.map((d) => (
        <g key={d.name}>
          <path d={`M194 80 L234 ${d.y}`} className="wire" />
          <rect
            x={234}
            y={d.y - 12}
            width={58}
            height={24}
            rx={5}
            className={d.name === 'CPU' ? 'box strong' : 'box'}
          />
          <text x={270} y={d.y + 4} className="mid sm">
            {d.name}
          </text>
        </g>
      ))}
      <text x={10} y={150} className="lbl">
        the CPU and GPU keep their cycles for AI work
      </text>
      {packets}
    </>
  );
}

const CHIPS: Chip[] = [
  {
    id: 'cpu',
    name: 'CPU',
    tag: 'the generalist',
    moves: 'A few powerful cores each run a different task, one instruction after another, with branches and waits.',
    what: 'Runs anything: the operating system, your API, tokenisation, data preparation, and the code that orchestrates agents.',
    strong: 'Any task; branching logic; low latency for small jobs',
    weak: 'Little parallel maths, so slow for large matrix work',
    examples: 'Intel Xeon, AMD EPYC, Arm (Graviton, Apple)',
    deeper: { href: '#hw-cpu-gpu', label: 'Race your CPU against your GPU' },
    draw: (t) => <Cpu tick={t} />,
    label:
      'A task queue feeds a control unit, which hands each of four cores a different task with its own progress bar.',
  },
  {
    id: 'gpu',
    name: 'GPU',
    tag: 'massive parallelism',
    moves: 'Thousands of small cores run the same instruction on different data, fed by very fast memory (HBM).',
    what: 'Built for the matrix multiplications at the heart of neural networks. The default for training and serving models.',
    strong: 'Training and inference; huge software ecosystem (CUDA, ROCm)',
    weak: 'Power, price, supply; overkill for small models',
    examples: 'NVIDIA H100, B200; AMD MI300',
    deeper: { href: '#hw-cpu-gpu', label: 'Race your CPU against your GPU' },
    draw: (t) => <Gpu tick={t} />,
    label:
      'A grid of 128 small cores flashes together on each instruction, fed by two stacks of high-bandwidth memory.',
  },
  {
    id: 'tpu',
    name: 'TPU',
    tag: "Google's tensor processor",
    moves:
      'Data pulses through a grid of multiply-add cells: inputs move right, partial sums move down, weights stay put.',
    what: 'A chip built around a systolic array. Chips are linked in pods of thousands for training and serving.',
    strong: 'Performance per watt on large tensor work; scales in pods',
    weak: 'Only on Google Cloud; best with JAX/XLA',
    examples: 'Google TPU v5e, v5p, Trillium, Ironwood',
    deeper: { href: '#hw-systolic', label: 'Step through a systolic array' },
    draw: (t) => <Tpu tick={t} />,
    label:
      'A five by five grid of cells. Input values enter from the left one row later each, and a diagonal wave of busy cells moves across; sums leave at the bottom.',
  },
  {
    id: 'npu',
    name: 'NPU',
    tag: 'AI in your pocket',
    moves:
      'A camera or microphone signal goes straight to a small accelerator running an 8-bit model, and the answer stays on the device.',
    what: 'A small, power-efficient accelerator in phones and laptops for running quantised (8-bit, 4-bit) models locally.',
    strong: 'Very low power; works offline; private',
    weak: 'Small models only; mostly inference',
    examples: 'Apple Neural Engine, Qualcomm Hexagon, Intel and AMD NPUs in "AI PCs"',
    deeper: { href: '#hw-quantize', label: 'Quantise a model' },
    draw: (t) => <Npu tick={t} />,
    label:
      'A signal from the camera or microphone travels into the NPU inside a phone and comes out as a result on the phone. The cloud is crossed out.',
  },
  {
    id: 'lpu',
    name: 'LPU',
    tag: 'low-latency LLM inference',
    moves:
      'Weights sit in on-chip SRAM next to compute, and the compiler fixes when every step happens, so each token takes the same time.',
    what: "Groq's Language Processing Unit. Generating text is limited by memory speed, and SRAM is far faster than HBM.",
    strong: 'Very high tokens per second; predictable latency',
    weak: 'Little memory per chip, so big models need hundreds of chips; inference only',
    examples: 'Groq LPU (similar ideas: Cerebras, SambaNova)',
    deeper: { href: '#hw-bandwidth', label: 'Work out tokens per second from bandwidth' },
    draw: (t) => <Lpu tick={t} />,
    label:
      'A token moves through layers one to four and the head, one stage per clock tick, with weights held in SRAM above; each finished token adds a word to the output.',
  },
  {
    id: 'dpu',
    name: 'DPU',
    tag: 'infrastructure offload',
    moves:
      'Network traffic is filtered, decrypted and routed on the network card itself, then delivered to storage, the CPU or the GPU.',
    what: 'A processor on a smart network card that takes networking, storage and encryption off the CPUs and GPUs in AI clusters.',
    strong: 'Frees host CPUs; isolation and security; fast data movement',
    weak: 'Data-centre only; does not run the model; adds configuration',
    examples: 'NVIDIA BlueField, AMD Pensando, AWS Nitro',
    deeper: { href: '#hw-dpu', label: 'Switch a DPU on and off' },
    draw: (t) => <Dpu tick={t} />,
    label:
      'Packets from the network pass through firewall, crypto and route stages on the DPU, then go to storage, the CPU or the GPU.',
  },
];

const SPEEDS = [
  { ms: 1400, label: 'Slow' },
  { ms: 800, label: 'Normal' },
  { ms: 400, label: 'Fast' },
];

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** The six processors side by side, each drawn moving data its own way, all on one clock so you can pause and step them together. */
export default function ChipFlows() {
  const root = useRef<HTMLElement>(null);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [onScreen, setOnScreen] = useState(true);
  const [speed, setSpeed] = useState(800);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !onScreen) return;
    const id = window.setInterval(() => setTick((t) => t + 1), speed);
    return () => window.clearInterval(id);
  }, [playing, onScreen, speed]);

  const style = { '--hw-step': `${Math.round(speed * 0.6)}ms` } as CSSProperties;

  return (
    <section ref={root} className={`hw-section hw-flows${playing ? ' playing' : ''}`} style={style}>
      <h2>The six at a glance: how each one moves data</h2>
      <p>
        All six run on one clock. Each tick, the CPU moves its tasks on, the GPU runs one instruction on every core,
        data steps one cell through the TPU, the NPU and LPU move their signal one stage, and the DPU passes each packet
        to its next stop. Pause and step through to follow one value.
      </p>
      <div className="hw-controls">
        <button type="button" className="btn" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setPlaying(false);
            setTick((t) => t + 1);
          }}
        >
          Step
        </button>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s.ms} value={s.ms}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="hw-note">tick {tick}</span>
      </div>
      <div className="hw-cards">
        {CHIPS.map((c) => (
          <article key={c.id} className={`card hw-chip hw-${c.id}`}>
            <div className="hw-chip-head">
              <b>{c.name}</b> <span className="small muted">{c.tag}</span>
            </div>
            <p className="small hw-moves">{c.moves}</p>
            <svg className="hw-flow" viewBox="0 0 300 156" role="img" aria-label={c.label}>
              {c.draw(tick)}
            </svg>
            <p className="small">{c.what}</p>
            <p className="small">
              <span className="hw-good">✓</span> {c.strong}
              <br />
              <span className="hw-bad">✕</span> {c.weak}
            </p>
            <p className="small muted">{c.examples}</p>
            <a className="small" href={c.deeper.href}>
              {c.deeper.label} ↓
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
