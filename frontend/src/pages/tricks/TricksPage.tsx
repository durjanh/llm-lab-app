import Batching from './Batching';
import Flash from './Flash';
import KvHeads from './KvHeads';
import Moe from './Moe';
import Norms from './Norms';
import Paged from './Paged';
import Rope from './Rope';
import SlidingWindow from './SlidingWindow';
import Speedups from './Speedups';
import Speculative from './Speculative';
import './tricks.css';

/** Lab 29: the improvements to the original transformer that today's models are built on, each one you can change. */
export default function TricksPage() {
  return (
    <main className="page-tricks">
      <div className="kicker">Lab 29 · Transformer tricks</div>
      <h1>The tricks inside today's transformers</h1>
      <p className="lede">
        The 2017 transformer is still the core of every large language model, but almost every part has been improved: how
        position is encoded, how vectors are normalised, how keys and values are stored, how attention fits in memory, how the
        feed-forward layers grow without slowing down, how tokens are generated faster, and how a server fits more people on one GPU. Each trick below is computed live;
        change the numbers and watch why it works.
      </p>
      <p className="small muted">Follows lecture 2 (and parts of lecture 3) of Stanford's CME 295. Seeded random numbers, so each demo starts the same.</p>

      <Rope />
      <Norms />
      <KvHeads />
      <SlidingWindow />
      <Flash />
      <Moe />
      <Speculative />
      <Batching />
      <Paged />
      <Speedups />

      <section className="tr-section">
        <h2>Which models use what</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Model</th>
                <th>Position</th>
                <th>Norm</th>
                <th>Attention</th>
                <th>Feed-forward</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Transformer (2017)</td><td>added sinusoids</td><td>LayerNorm, post-norm</td><td>multi-head, full</td><td>dense</td></tr>
              <tr><td>GPT-2 (2019)</td><td>learned, added</td><td>LayerNorm, pre-norm</td><td>multi-head, full</td><td>dense</td></tr>
              <tr><td>Llama 3.1</td><td>RoPE</td><td>RMSNorm, pre-norm</td><td>grouped-query</td><td>dense (SwiGLU)</td></tr>
              <tr><td>Mistral 7B</td><td>RoPE</td><td>RMSNorm, pre-norm</td><td>grouped-query, sliding window (first version)</td><td>dense</td></tr>
              <tr><td>Mixtral 8x7B</td><td>RoPE</td><td>RMSNorm, pre-norm</td><td>grouped-query</td><td>MoE, 8 experts, top 2</td></tr>
              <tr><td>Gemma 2</td><td>RoPE</td><td>RMSNorm</td><td>grouped-query, alternating sliding-window and full layers</td><td>dense</td></tr>
              <tr><td>DeepSeek-V3</td><td>RoPE</td><td>RMSNorm</td><td>multi-head latent attention (compressed KV)</td><td>MoE, 256 routed + 1 shared, top 8</td></tr>
            </tbody>
          </table>
        </div>
        <p className="tr-note">From the models' published papers and configurations. Nearly every serving stack also uses FlashAttention (or similar fused attention) and a KV cache; many use speculative decoding.</p>
      </section>

      <section className="tr-section">
        <h2>Engineering takeaways</h2>
        <ul className="tr-takeaways">
          <li><b>Long contexts are a memory problem.</b> The KV cache, not the weights, often decides how many users and how long a context a GPU can serve: grouped-query attention, sliding windows and compressed caches all attack it.</li>
          <li><b>FlashAttention changes speed, not answers.</b> It is exact; the online softmax is the same maths in a better order.</li>
          <li><b>MoE trades memory for compute.</b> You pay memory for every expert but compute only for the few each token uses, and an unbalanced router wastes the rest.</li>
          <li><b>Speculative decoding is free quality-wise.</b> With the right acceptance rule the output distribution is unchanged; the gain depends on how often the draft is right.</li>
          <li><b>Serving is a scheduling problem too.</b> Continuous batching and paged KV memory change no maths in the model, yet they decide how many people one GPU can serve: they raise throughput, not one request's speed.</li>
          <li><b>Position handling sets the context limit.</b> RoPE's frequencies can be stretched to extend a model's context after training, which is how many long-context versions are made.</li>
        </ul>
      </section>
    </main>
  );
}
