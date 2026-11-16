import Bandwidth from './Bandwidth';
import ChipFlows from './ChipFlows';
import CpuGpuBench from './CpuGpuBench';
import DpuOffload from './DpuOffload';
import Kernels from './Kernels';
import Quantize from './Quantize';
import Systolic from './Systolic';
import './hardware.css';

/** Lab 26: the processors behind AI, with things you can run and change rather than a list. */
export default function HardwarePage() {
  return (
    <main className="page-hardware">
      <div className="kicker">Lab 26 · Hardware for AI</div>
      <h1>CPU, GPU, TPU, NPU, LPU, DPU: what each is for</h1>
      <p className="lede">
        Six kinds of processor, and the two ideas that decide which one fits: how much maths can run in parallel, and
        how fast the model's weights can be read from memory. Measure the first on your own computer, then work out the
        second for real chips.
      </p>

      <ChipFlows />
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
              <tr>
                <td>Training a model</td>
                <td>GPU, TPU</td>
                <td>Huge parallel matrix maths, high memory bandwidth, chips linked into clusters</td>
              </tr>
              <tr>
                <td>Serving an LLM to many users</td>
                <td>GPU (or TPU)</td>
                <td>Batching many users together turns memory-bound decoding into efficient parallel work</td>
              </tr>
              <tr>
                <td>The fastest single-user responses</td>
                <td>LPU and other on-chip-memory designs</td>
                <td>Text generation is limited by how fast weights are read; on-chip SRAM is far faster than HBM</td>
              </tr>
              <tr>
                <td>AI on a phone or laptop, offline</td>
                <td>NPU (or the laptop GPU)</td>
                <td>Low power; quantised small models; data stays on the device</td>
              </tr>
              <tr>
                <td>Your API, tokenising, orchestration, agents' tool calls</td>
                <td>CPU</td>
                <td>General-purpose, branching logic; no big matrix maths</td>
              </tr>
              <tr>
                <td>Networking, storage and encryption in an AI cluster</td>
                <td>DPU</td>
                <td>Takes infrastructure work off the CPUs and GPUs</td>
              </tr>
              <tr>
                <td>Calling a model through an API (Azure OpenAI, Claude, Bedrock)</td>
                <td>Not your choice</td>
                <td>The provider picks; you choose models, regions and throughput tiers</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Most real systems use several: CPUs run the application and agents, GPUs or TPUs run the model, DPUs move the
          data.
        </p>
      </section>
    </main>
  );
}
