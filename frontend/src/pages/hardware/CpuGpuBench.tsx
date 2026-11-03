import { useEffect, useRef, useState } from 'react';
import './cpugpu.css';

// WebGPU flag values (the WebGPU spec's constants; this TypeScript build has the types but not these globals).
const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const MAP_READ = 0x0001;

const CPU_SIZES = [64, 128, 256, 512, 1024];
const GPU_SIZES = [64, 128, 256, 512, 1024, 2048];
const CHECK_SIZE = 256; // the size whose GPU answer is compared with the CPU's, number by number
const TILE = 16;

/** The same seeded numbers on both sides, so the CPU and GPU multiply identical matrices. Self-contained:
 * the worker below gets this function's own source. */
function fill(n: number, seed: number): Float32Array {
  const m = new Float32Array(n * n);
  let a = seed >>> 0;
  for (let i = 0; i < m.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    m[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return m;
}

/** The CPU side runs in a Web Worker, so the page stays responsive: one thread, a plain i-k-j loop. */
const WORKER = `const fill = ${fill.toString()};
function matmul(a, b, n) {
  const c = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k];
      const row = k * n, out = i * n;
      for (let j = 0; j < n; j++) c[out + j] += aik * b[row + j];
    }
  }
  return c;
}
onmessage = (e) => {
  const { n, reps, keep } = e.data;
  const a = fill(n, 1), b = fill(n, 2);
  matmul(fill(32, 3), fill(32, 4), 32); // warm-up, so the JIT compiler has done its work
  const times = [];
  let c;
  for (let r = 0; r < reps; r++) { const t0 = performance.now(); c = matmul(a, b, n); times.push(performance.now() - t0); }
  times.sort((x, y) => x - y);
  postMessage({ n, ms: times[Math.floor(times.length / 2)], result: keep ? c : null });
};`;

const SHADER = /* wgsl */ `
struct Params { n: u32 };
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> p: Params;
var<workgroup> ta: array<array<f32, ${TILE}>, ${TILE}>;
var<workgroup> tb: array<array<f32, ${TILE}>, ${TILE}>;

// Each workgroup computes one ${TILE}x${TILE} tile of C. Tiles of A and B are loaded into fast
// workgroup memory once and reused ${TILE} times each, instead of every thread reading main memory.
@compute @workgroup_size(${TILE}, ${TILE})
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let n = p.n;
  var sum = 0.0;
  for (var t = 0u; t < n / ${TILE}u; t++) {
    ta[l.y][l.x] = a[g.y * n + t * ${TILE}u + l.x];
    tb[l.y][l.x] = b[(t * ${TILE}u + l.y) * n + g.x];
    workgroupBarrier();
    for (var k = 0u; k < ${TILE}u; k++) { sum += ta[l.y][k] * tb[k][l.x]; }
    workgroupBarrier();
  }
  c[g.y * n + g.x] = sum;
}`;

interface Row {
  n: number;
  cpuMs?: number;
  gpuMs?: number;
  uploadMs?: number;
  readMs?: number;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gflops = (n: number, ms?: number) => (ms ? (2 * n ** 3) / (ms * 1e6) : undefined);
const fmt = (v?: number, digits = 1) => (v === undefined ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(digits));
const yieldToPage = () => new Promise((r) => setTimeout(r, 0));

export default function CpuGpuBench() {
  const [rows, setRows] = useState<Row[]>(GPU_SIZES.map((n) => ({ n })));
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [gpuInfo, setGpuInfo] = useState<string>('');
  const [gpuProblem, setGpuProblem] = useState<string>('');
  const [check, setCheck] = useState<{ n: number; maxDiff: number } | null>(null);
  const stop = useRef(false);
  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    if (!('gpu' in navigator) || !navigator.gpu) {
      setGpuProblem('This browser has no WebGPU, so only the CPU will run. Use a recent Chrome or Edge (WebGPU is on by default), or Safari 26 / Firefox with WebGPU enabled.');
      return;
    }
    navigator.gpu
      .requestAdapter({ powerPreference: 'high-performance' })
      .then((adapter) => {
        if (!adapter) {
          setGpuProblem('WebGPU is present but found no usable GPU (it may be blocked or disabled), so only the CPU will run.');
          return;
        }
        const info = adapter.info;
        setGpuInfo([info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' · ') || 'a WebGPU adapter');
      })
      .catch(() => setGpuProblem('WebGPU could not start, so only the CPU will run.'));
    return () => worker.current?.terminate();
  }, []);

  const update = (n: number, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.n === n ? { ...r, ...change } : r)));

  function cpuRun(n: number, keep: boolean): Promise<{ ms: number; result: Float32Array | null }> {
    if (!worker.current) worker.current = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
    const w = worker.current;
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => resolve({ ms: e.data.ms, result: e.data.result });
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ n, reps: n <= 256 ? 5 : n === 512 ? 3 : 1, keep });
    });
  }

  async function run() {
    stop.current = false;
    setRunning(true);
    setRows(GPU_SIZES.map((n) => ({ n })));
    setCheck(null);
    let cpuCheck: Float32Array | null = null;
    try {
      // CPU first, in the worker.
      for (const n of CPU_SIZES) {
        if (stop.current) return;
        setStatus(`CPU: multiplying two ${n}×${n} matrices…`);
        const r = await cpuRun(n, n === CHECK_SIZE);
        if (n === CHECK_SIZE) cpuCheck = r.result;
        update(n, { cpuMs: r.ms });
      }
      if (gpuProblem || !navigator.gpu) return;

      // GPU: one device and pipeline, then each size.
      setStatus('GPU: compiling the shader…');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter.');
      const device = await adapter.requestDevice();
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: 'main' },
      });
      for (const n of GPU_SIZES) {
        if (stop.current) break;
        setStatus(`GPU: multiplying two ${n}×${n} matrices…`);
        await yieldToPage();
        const bytes = n * n * 4;
        const a = device.createBuffer({ size: bytes, usage: USAGE.STORAGE | USAGE.COPY_DST });
        const b = device.createBuffer({ size: bytes, usage: USAGE.STORAGE | USAGE.COPY_DST });
        const c = device.createBuffer({ size: bytes, usage: USAGE.STORAGE | USAGE.COPY_SRC });
        const out = device.createBuffer({ size: bytes, usage: USAGE.MAP_READ | USAGE.COPY_DST });
        const params = device.createBuffer({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });

        let t0 = performance.now();
        device.queue.writeBuffer(a, 0, fill(n, 1));
        device.queue.writeBuffer(b, 0, fill(n, 2));
        device.queue.writeBuffer(params, 0, new Uint32Array([n, 0, 0, 0]));
        await device.queue.onSubmittedWorkDone();
        const uploadMs = performance.now() - t0;

        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [a, b, c, params].map((buffer, binding) => ({ binding, resource: { buffer } })),
        });
        const dispatch = async () => {
          const enc = device.createCommandEncoder();
          const pass = enc.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(n / TILE, n / TILE);
          pass.end();
          const start = performance.now();
          device.queue.submit([enc.finish()]);
          await device.queue.onSubmittedWorkDone();
          return performance.now() - start;
        };
        await dispatch(); // warm-up
        const times: number[] = [];
        for (let r = 0; r < (n <= 512 ? 7 : 3); r++) times.push(await dispatch());

        t0 = performance.now();
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(c, 0, out, 0, bytes);
        device.queue.submit([enc.finish()]);
        await out.mapAsync(MAP_READ);
        const result = new Float32Array(out.getMappedRange().slice(0));
        out.unmap();
        const readMs = performance.now() - t0;

        if (n === CHECK_SIZE && cpuCheck) {
          let maxDiff = 0;
          for (let i = 0; i < result.length; i++) maxDiff = Math.max(maxDiff, Math.abs(result[i] - cpuCheck[i]));
          setCheck({ n, maxDiff });
        }
        update(n, { gpuMs: median(times), uploadMs, readMs });
        [a, b, c, out, params].forEach((buf) => buf.destroy());
      }
      device.destroy();
    } catch (err) {
      setGpuProblem(`The GPU run failed: ${(err as Error).message}`);
    } finally {
      setStatus(stop.current ? 'Stopped.' : 'Done.');
      setRunning(false);
    }
  }

  function halt() {
    stop.current = true;
    worker.current?.terminate(); // stops a long CPU multiply at once
    worker.current = null;
  }

  const crossover = rows.find((r) => r.cpuMs !== undefined && r.gpuMs !== undefined && r.gpuMs < r.cpuMs)?.n;

  return (
    <section className="hw-section">
      <h2>CPU vs GPU, measured in your browser</h2>
      <p>
        Neural networks are mostly matrix multiplication. This multiplies two square matrices of random numbers on your
        computer's CPU and then on its GPU, and times both. Multiplying two n×n matrices takes 2n³ arithmetic operations: about
        half a million at 64×64, and 17 billion at 2048×2048.
      </p>
      <div className="hw-controls">
        <button className="btn primary" disabled={running} onClick={() => void run()}>
          Run the race
        </button>
        <button className="btn" disabled={!running} onClick={halt}>
          Stop
        </button>
        <span className="small muted">{status}</span>
      </div>
      <p className="hw-note">
        <b>CPU:</b> plain JavaScript, one thread (in a Web Worker so the page stays usable), the straightforward i-k-j loop. A
        tuned library using every core and vector instructions would be 10 to 100 times faster, but the shape of the result is
        the same. Skipped at 2048×2048, where it would take tens of seconds. <b>GPU:</b> a WebGPU compute shader with 16×16
        tiles in fast shared memory.{' '}
        {gpuInfo && (
          <>
            Your GPU: <b>{gpuInfo}</b>.
          </>
        )}{' '}
        GPU times are from submitting the work until the GPU reports it done, the median of several runs after a warm-up;
        copying the matrices to the GPU and the answer back are timed separately.
      </p>
      {gpuProblem && <p className="hw-warn small">{gpuProblem}</p>}

      <div className="hw-bench">
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Size</th>
                <th className="num">CPU ms</th>
                <th className="num">GPU ms</th>
                <th className="num">CPU GFLOP/s</th>
                <th className="num">GPU GFLOP/s</th>
                <th className="num">GPU faster by</th>
                <th className="num">Upload / read back ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.n} className={r.n === crossover ? 'hw-cross' : ''}>
                  <td>
                    {r.n}×{r.n}
                  </td>
                  <td className="num">{r.n > 1024 ? 'skipped' : fmt(r.cpuMs, 2)}</td>
                  <td className="num">{fmt(r.gpuMs, 2)}</td>
                  <td className="num">{fmt(gflops(r.n, r.cpuMs))}</td>
                  <td className="num">{fmt(gflops(r.n, r.gpuMs))}</td>
                  <td className="num">
                    {r.cpuMs && r.gpuMs ? `${r.cpuMs / r.gpuMs >= 10 ? (r.cpuMs / r.gpuMs).toFixed(0) : (r.cpuMs / r.gpuMs).toFixed(1)}×` : '—'}
                  </td>
                  <td className="num">{r.uploadMs !== undefined ? `${fmt(r.uploadMs)} / ${fmt(r.readMs)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Chart rows={rows} crossover={crossover} />
      </div>
      {check && (
        <p className={`small ${check.maxDiff < 1e-2 ? 'hw-good' : 'hw-bad'}`}>
          Checked: at {check.n}×{check.n} the GPU's answer{' '}
          {check.maxDiff === 0
            ? 'matches the CPU\'s exactly, every one of the 65,536 numbers (both add the products in the same order).'
            : `matches the CPU's to within ${check.maxDiff.toExponential(1)} (floating-point rounding when sums are added in a different order).`}
        </p>
      )}
      <p className="small">
        <b>Why the GPU loses at first and then wins.</b> Every GPU job has a fixed cost: the work has to be sent, scheduled and
        reported back, which takes a fraction of a millisecond whatever the size. Small matrices finish in less time than that
        overhead, so the CPU wins. As the matrices grow, the arithmetic grows with n³ and the GPU's thousands of cores working in
        parallel take over.{crossover ? ` On this computer the GPU pulls ahead from ${crossover}×${crossover}.` : ''} The same
        logic decides real AI systems: tiny models or single short requests can be fine on a CPU, while big models and batches
        need a GPU, TPU or other accelerator.
      </p>
    </section>
  );
}

/** Time against size on log scales, CPU and GPU, with the crossover marked. */
function Chart({ rows, crossover }: { rows: Row[]; crossover?: number }) {
  const W = 420, H = 240, L = 46, R = 24, T = 12, B = 34;
  const all = rows.flatMap((r) => [r.cpuMs, r.gpuMs]).filter((v): v is number => v !== undefined && v > 0);
  if (!all.length) return <div className="hw-chart hw-chart-empty small muted">The chart appears as results come in.</div>;
  const yMin = Math.floor(Math.log10(Math.min(...all))), yMax = Math.ceil(Math.log10(Math.max(...all)));
  const xs = GPU_SIZES.map((n) => Math.log2(n));
  const x = (n: number) => L + ((Math.log2(n) - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - L - R);
  const y = (ms: number) => T + (1 - (Math.log10(ms) - yMin) / Math.max(1, yMax - yMin)) * (H - T - B);
  const line = (key: 'cpuMs' | 'gpuMs') =>
    rows.filter((r) => r[key] !== undefined).map((r) => `${x(r.n)},${y(r[key]!)}`).join(' ');
  const decades = Array.from({ length: yMax - yMin + 1 }, (_, i) => yMin + i);
  return (
    <svg className="hw-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Milliseconds against matrix size for CPU and GPU, log scales">
      {decades.map((d) => (
        <g key={d}>
          <line x1={L} x2={W - R} y1={y(10 ** d)} y2={y(10 ** d)} className="hw-grid" />
          <text x={L - 6} y={y(10 ** d) + 4} textAnchor="end" className="hw-axis">
            {10 ** d >= 1 ? 10 ** d : (10 ** d).toString()}
          </text>
        </g>
      ))}
      {GPU_SIZES.map((n) => (
        <text key={n} x={x(n)} y={H - B + 16} textAnchor="middle" className="hw-axis">
          {n}
        </text>
      ))}
      <text x={L} y={H - 4} className="hw-axis">
        matrix size (n×n) →
      </text>
      <text x={L + 4} y={T + 10} className="hw-axis">
        ms, log scale
      </text>
      {crossover && <line x1={x(crossover)} x2={x(crossover)} y1={T} y2={H - B} className="hw-crossline" />}
      <polyline points={line('cpuMs')} className="hw-line" style={{ stroke: 'var(--s1)' }} />
      <polyline points={line('gpuMs')} className="hw-line" style={{ stroke: 'var(--s3)' }} />
      {rows.map((r) => (
        <g key={r.n}>
          {r.cpuMs !== undefined && <circle cx={x(r.n)} cy={y(r.cpuMs)} r={3.5} style={{ fill: 'var(--s1)' }} />}
          {r.gpuMs !== undefined && <circle cx={x(r.n)} cy={y(r.gpuMs)} r={3.5} style={{ fill: 'var(--s3)' }} />}
        </g>
      ))}
      <g className="hw-legend-svg">
        <circle cx={W - 120} cy={T + 6} r={4} style={{ fill: 'var(--s1)' }} />
        <text x={W - 112} y={T + 10} className="hw-axis">CPU</text>
        <circle cx={W - 70} cy={T + 6} r={4} style={{ fill: 'var(--s3)' }} />
        <text x={W - 62} y={T + 10} className="hw-axis">GPU</text>
      </g>
    </svg>
  );
}
