import Lora from './Lora';
import Memory from './Memory';
import Parallel from './Parallel';
import './scale.css';

const FORMATS: [string, string, string, string, string][] = [
  ['FP32', '8', '23', '≈ 3.4 × 10³⁸', 'Master copy of the weights, optimiser state'],
  ['FP16', '5', '10', '65,504', 'Older mixed precision; small gradients underflow, so it needs loss scaling'],
  ['BF16', '8', '7', '≈ 3.4 × 10³⁸', "Today's default for training: FP32's range with fewer digits, no loss scaling"],
  ['FP8 (E4M3)', '4', '3', '448', 'Newest GPUs train matrix multiplications in FP8, with scaling per tensor or block'],
];

/** Lab 30: what changes when a model is too big for one GPU to train. */
export default function ScalePage() {
  return (
    <main className="page-scale">
      <div className="kicker">Lab 30 · Training at scale</div>
      <h1>Training big models: LoRA, memory and parallelism</h1>
      <p className="lede">
        Fine-tuning a 70B model the ordinary way needs over a terabyte of GPU memory. This lab shows the two ways round it:
        train far fewer parameters (LoRA), or split the training across many GPUs (data, tensor and pipeline parallelism,
        ZeRO). Everything here is calculated, and the LoRA run trains for real in your browser.
      </p>
      <p className="small muted">
        Stanford CME 295, lecture 4 (LLM training). The pipeline as a whole, data cleaning and scaling laws are in{' '}
        <a href="/building">How LLMs are built</a>; a tiny model trains live in the <a href="/training">Training lab</a>.
      </p>

      <Lora />
      <Memory />
      <Parallel />

      <section className="sc-section">
        <h2>4. Two more tricks that make training fit</h2>
        <div className="sc-cards">
          <div className="card">
            <b>Mixed precision</b>
            <p className="small">
              Most maths runs in 16-bit, with a 32-bit master copy of the weights so that tiny updates are not rounded away.
              The format matters: it splits its bits between range (exponent) and precision (mantissa).
            </p>
            <div className="table-wrap">
              <table className="t sc-table">
                <thead>
                  <tr>
                    <th>Format</th>
                    <th className="num">Exponent bits</th>
                    <th className="num">Mantissa bits</th>
                    <th className="num">Largest number</th>
                    <th>Used for</th>
                  </tr>
                </thead>
                <tbody>
                  {FORMATS.map((f) => (
                    <tr key={f[0]}>
                      <td>
                        <b>{f[0]}</b>
                      </td>
                      <td className="num">{f[1]}</td>
                      <td className="num">{f[2]}</td>
                      <td className="num">{f[3]}</td>
                      <td className="small">{f[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <b>Activation checkpointing</b>
            <p className="small">
              The backward pass needs every intermediate result from the forward pass. Keeping them all can take more memory
              than the weights. With checkpointing, each layer keeps only its input; in the backward pass the layer's forward
              is run again to rebuild the rest. Memory for activations falls by an order of magnitude, for about a third more
              compute (one extra forward pass). Section 2 assumes it is on.
            </p>
          </div>
        </div>
      </section>

      <section className="sc-section">
        <h2>Engineering takeaways</h2>
        <ul className="sc-takeaways">
          <li>
            <b>Start with LoRA.</b> For adapting a model to your task or style, LoRA (or QLoRA) usually gets close to full
            fine-tuning at a fraction of the memory, on one or a few GPUs, and adapters can be swapped per customer.
          </li>
          <li>
            <b>Full fine-tuning costs about 16 bytes per parameter</b> plus activations, eight times what inference needs. Plan
            GPUs from that number.
          </li>
          <li>
            <b>Big runs combine all three kinds of parallelism</b>: tensor parallel inside a server, where links are fastest;
            pipeline parallel across servers, where little data moves; data parallel (with ZeRO or FSDP) across everything
            else for throughput.
          </li>
          <li>
            <b>Use enough micro-batches</b> to keep the pipeline bubble small: at least four times the number of stages keeps
            it under about 20%.
          </li>
          <li>
            <b>Through an API, none of this is yours to manage</b>: hosted fine-tuning (Azure OpenAI, Amazon Bedrock, Vertex AI)
            does it for you, mostly with LoRA-style methods.
          </li>
        </ul>
      </section>
    </main>
  );
}
