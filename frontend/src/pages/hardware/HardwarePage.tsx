import Bandwidth from './Bandwidth';
import CpuGpuBench from './CpuGpuBench';
import DpuOffload from './DpuOffload';
import Kernels from './Kernels';
import Quantize from './Quantize';
import Systolic from './Systolic';
import './hardware.css';

const CHIPS: { name: string; tag: string; what: string; strong: string; weak: string; examples: string }[] = [
  { name: 'CPU', tag: 'the general-purpose backbone', what: 'A few powerful cores that run anything: the operating system, your API, tokenisation, data preparation, and the code that orchestrates agents.', strong: 'Any task; branching logic; low latency for small jobs', weak: 'Little parallel maths, so slow for large matrix work', examples: 'Intel Xeon, AMD EPYC, Arm (Graviton, Apple)' },
  { name: 'GPU', tag: 'massive parallelism', what: 'Thousands of simple cores and very fast memory (HBM), built for the matrix multiplications at the heart of neural networks. The default for training and serving models.', strong: 'Training and inference; huge software ecosystem (CUDA, ROCm)', weak: 'Power, price, supply; overkill for small models', examples: 'NVIDIA H100, B200; AMD MI300' },
  { name: 'TPU', tag: 'Google\'s tensor processor', what: 'A chip built around a systolic array: a grid of multiply-add cells that matrix data flows through. Connected in pods of thousands for training and serving.', strong: 'Performance per watt on large tensor work; scales in pods', weak: 'Only on Google Cloud; best with JAX/XLA', examples: 'Google TPU v5e, v5p, Trillium, Ironwood' },
  { name: 'NPU', tag: 'AI in your pocket', what: 'A small, power-efficient accelerator in phones and laptops for running quantised (8-bit, 4-bit) models on the device, so data stays local.', strong: 'Very low power; works offline; private', weak: 'Small models only; mostly inference', examples: 'Apple Neural Engine, Qualcomm Hexagon, Intel and AMD NPUs in "AI PCs"' },
  { name: 'LPU', tag: 'low-latency LLM inference', what: 'Groq\'s Language Processing Unit keeps model weights in fast on-chip SRAM instead of external memory, and runs a fixed, compiler-planned schedule. Generating text is limited by memory speed, so this makes it very fast.', strong: 'Very high tokens per second; predictable latency', weak: 'Little memory per chip, so big models need hundreds of chips; inference only', examples: 'Groq LPU (similar ideas: Cerebras, SambaNova)' },
  { name: 'DPU', tag: 'infrastructure offload', what: 'A processor on a smart network card that takes over networking, storage and encryption, freeing the CPUs and GPUs in AI clusters for model work.', strong: 'Frees host CPUs; isolation and security; fast data movement', weak: 'Data-centre only; adds configuration complexity', examples: 'NVIDIA BlueField, AMD Pensando, AWS Nitro' },
];

/** Lab 26: the processors behind AI, with things you can run and change rather than a list. */
export default function HardwarePage() {
  return (
    <main className="page-hardware">
      <div className="kicker">Lab 26 · Hardware for AI</div>
      <h1>CPU, GPU, TPU, NPU, LPU, DPU: what each is for</h1>
      <p className="lede">
        Six kinds of processor, and the two ideas that decide which one fits: how much maths can run in parallel, and how fast
        the model's weights can be read from memory. Measure the first on your own computer, then work out the second for real
        chips.
      </p>

      <section className="hw-section">
        <h2>The six at a glance</h2>
        <div className="hw-cards">
          {CHIPS.map((c) => (
            <div key={c.name} className={`card hw-chip hw-${c.name.toLowerCase()}`}>
              <div className="hw-chip-head">
                <b>{c.name}</b> <span className="small muted">{c.tag}</span>
              </div>
              <p className="small">{c.what}</p>
              <p className="small">
                <span className="hw-good">✓</span> {c.strong}
                <br />
                <span className="hw-bad">✕</span> {c.weak}
              </p>
              <p className="small muted">{c.examples}</p>
            </div>
          ))}
        </div>
      </section>

      <CpuGpuBench />
      <Systolic />
      <Bandwidth />
      <Kernels />
      <Quantize />
      <DpuOffload />

      <section className="hw-section">
        <h2>Which one?</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Workload</th>
                <th>Usually</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Training a model</td><td>GPU, TPU</td><td>Huge parallel matrix maths, high memory bandwidth, chips linked into clusters</td></tr>
              <tr><td>Serving an LLM to many users</td><td>GPU (or TPU)</td><td>Batching many users together turns memory-bound decoding into efficient parallel work</td></tr>
              <tr><td>The fastest single-user responses</td><td>LPU and other on-chip-memory designs</td><td>Text generation is limited by how fast weights are read; on-chip SRAM is far faster than HBM</td></tr>
              <tr><td>AI on a phone or laptop, offline</td><td>NPU (or the laptop GPU)</td><td>Low power; quantised small models; data stays on the device</td></tr>
              <tr><td>Your API, tokenising, orchestration, agents' tool calls</td><td>CPU</td><td>General-purpose, branching logic; no big matrix maths</td></tr>
              <tr><td>Networking, storage and encryption in an AI cluster</td><td>DPU</td><td>Takes infrastructure work off the CPUs and GPUs</td></tr>
              <tr><td>Calling a model through an API (Azure OpenAI, Claude, Bedrock)</td><td>Not your choice</td><td>The provider picks; you choose models, regions and throughput tiers</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small muted">Most real systems use several: CPUs run the application and agents, GPUs or TPUs run the model, DPUs move the data.</p>
      </section>
    </main>
  );
}
