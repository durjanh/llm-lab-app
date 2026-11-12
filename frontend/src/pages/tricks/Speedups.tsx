/** Ways to make LLM inference faster or cheaper: what each one improves, a published figure, the catch, and whether
    someone calling a model through an API can use it. Figures checked against the sources linked, November 2026. */

interface Row {
  name: string;
  improves: string;
  figure: string;
  source: { label: string; href: string };
  catch: string;
  api: string;
}

const ROWS: Row[] = [
  {
    name: 'Quantisation',
    improves: 'Memory and cost; faster decoding, which is limited by memory bandwidth',
    figure: 'GPTQ: 3–4 bit weights with negligible accuracy loss; about 3.25× faster than FP16 on an A100',
    source: { label: 'Frantar et al., GPTQ, 2022', href: 'https://arxiv.org/abs/2210.17323' },
    catch: 'Quality drops as bits fall; the speed needs kernels that support it',
    api: 'No: the provider chooses. Yes for open models you run (GPTQ, AWQ, GGUF)',
  },
  {
    name: 'Knowledge distillation',
    improves: 'A smaller model: less memory, lower latency and cost',
    figure: 'DistilBERT: 40% smaller, 60% faster, keeps 97% of BERT’s language understanding',
    source: { label: 'Sanh et al., DistilBERT, 2019', href: 'https://arxiv.org/abs/1910.01108' },
    catch: 'A training project, not a switch; the student is weaker on hard tasks',
    api: 'Only into your own small model, where the provider’s terms allow',
  },
  {
    name: 'KV cache',
    improves: 'Per-token compute: earlier keys and values are not recomputed',
    figure: 'OPT-13B: about 800 KB per token, up to 1.6 GB for one 2,048-token request',
    source: { label: 'Kwon et al., PagedAttention, 2023', href: 'https://arxiv.org/abs/2309.06180' },
    catch: 'Costs memory that grows with context and batch size; grouped-query attention shrinks it',
    api: 'Automatic on the provider’s side; prompt caching is your lever',
  },
  {
    name: 'Continuous batching',
    improves: 'Throughput and queueing, not one request’s speed',
    figure:
      'About 8× the throughput of naive static batching (OPT-13B, one A100); up to 23× with vLLM’s memory management',
    source: {
      label: 'Anyscale, continuous batching benchmark, 2023',
      href: 'https://www.anyscale.com/blog/continuous-batching-llm-inference',
    },
    catch: 'A more complex scheduler; needs memory for many KV caches',
    api: 'Done for you by the provider; by default in vLLM and TGI',
  },
  {
    name: 'Speculative decoding',
    improves: 'One request’s latency, with the output distribution unchanged',
    figure: '2–3× faster on T5-XXL; 2–2.5× on Chinchilla 70B; EAGLE 2.7–3.5× on Llama 2 Chat 70B',
    source: { label: 'Leviathan et al., 2022', href: 'https://arxiv.org/abs/2211.17192' },
    catch: 'The gain depends on how often the draft is accepted; little gain at large batch sizes',
    api: 'Not directly; available in vLLM when you host',
  },
  {
    name: 'Tensor parallelism',
    improves: 'Fits a model too big for one GPU; can lower per-token latency',
    figure: 'Megatron-LM: 8.3B parameters on 512 GPUs at 76% scaling efficiency',
    source: { label: 'Shoeybi et al., Megatron-LM, 2019', href: 'https://arxiv.org/abs/1909.08053' },
    catch: 'GPUs exchange results at every layer, so it needs NVLink and stays within one server',
    api: 'No; tensor_parallel_size when you host',
  },
  {
    name: 'Pipeline parallelism',
    improves: 'Fits very large models across GPUs or servers; throughput',
    figure: 'Idle “bubble” share (K−1)/(M+K−1); negligible when micro-batches M ≥ 4 × stages K',
    source: { label: 'Huang et al., GPipe, 2019', href: 'https://arxiv.org/abs/1811.06965' },
    catch: 'Does not cut one request’s latency: it passes every stage in turn',
    api: 'No; pipeline_parallel_size when you host',
  },
  {
    name: 'PagedAttention',
    improves: 'KV-cache memory, so bigger batches and more throughput',
    figure:
      'Older systems used only 20–38% of KV memory for real tokens; vLLM 2–4× the throughput of Orca and FasterTransformer',
    source: { label: 'Kwon et al., PagedAttention, 2023', href: 'https://arxiv.org/abs/2309.06180' },
    catch: 'Small overhead from following block tables; less gain for short sequences',
    api: 'No; it is how vLLM works',
  },
  {
    name: 'FlashAttention',
    improves: 'Attention speed and memory; exact, not an approximation',
    figure:
      '3× on GPT-2 at 1K tokens; FlashAttention-2 about 2× faster again; FlashAttention-3 up to 740 TFLOPs/s on H100',
    source: { label: 'Dao et al., FlashAttention, 2022', href: 'https://arxiv.org/abs/2205.14135' },
    catch: 'Needs hardware-specific kernels; biggest gain on long sequences',
    api: 'Built in on the provider’s side and in PyTorch',
  },
  {
    name: 'Prompt caching',
    improves: 'Input cost and time to first token for a repeated prefix',
    figure: 'Claude: cache reads at 0.1× the input price; writes 1.25× (5 minutes) or 2× (1 hour)',
    source: {
      label: 'Anthropic, prompt caching docs',
      href: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
    },
    catch: 'An exact prefix match; does not speed up writing the reply',
    api: 'Yes: mark the prefix with cache_control',
  },
];

const CHECKS: [string, string, string][] = [
  [
    'FP16 3.5 GB → INT4 0.9 GB, about 4× smaller',
    'True',
    'For the weights: 2 bytes to half a byte. Real files are slightly larger (scales are stored too), and the KV cache does not shrink.',
  ],
  [
    'Distillation, e.g. 7B → 1.3B',
    'True as an example',
    'An illustration, not a published result; the classic one is BERT to DistilBERT.',
  ],
  [
    'KV cache: only compute for “mat”, not the whole sentence',
    'Partly',
    'The step computes keys and values for the newest input token (“the”) and reuses the cache; “mat” is what that step predicts.',
  ],
  [
    'Continuous batching: 4 → 8+ users',
    'Partly',
    'The idea is right; the number is invented. Published gains are throughput multiples that depend on the workload.',
  ],
  [
    'Speculative decoding: draft 4 tokens, verify in one step',
    'True',
    'One pass of the big model checks them all and keeps the agreed prefix plus one more token.',
  ],
  [
    'Tensor parallelism: 8,192 × 8,192 split into 4,096 columns each',
    'True',
    'It leaves out the cost: the GPUs must combine results (an all-reduce) at every layer.',
  ],
  [
    'Pipeline: 24 layers, 3 GPUs, 4 micro-batches',
    'True',
    'With 3 stages and 4 micro-batches the GPUs are idle about a third of the time (2 / 6).',
  ],
  [
    '“7 ways to make an LLM faster”',
    'Partly',
    'Quantisation and distillation mainly cut size and cost; the two parallelisms mainly fit big models. FlashAttention and PagedAttention are missing.',
  ],
];

export default function Speedups() {
  return (
    <section className="tr-section">
      <h2>Ways to make a model faster: what each one buys</h2>
      <p>
        “Faster” means three different things: less <b>memory</b>, lower <b>latency</b> for one person, or more{' '}
        <b>throughput</b> for many. Each technique buys a different one, and only a few are in the hands of someone
        calling a model through an API. Figures are from the papers and pages linked.
      </p>
      <div className="table-wrap">
        <table className="t tr-speed">
          <thead>
            <tr>
              <th>Technique</th>
              <th>Improves</th>
              <th>A published figure</th>
              <th>The catch</th>
              <th>Through an API?</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.name}>
                <td>
                  <b>{r.name}</b>
                </td>
                <td>{r.improves}</td>
                <td>
                  {r.figure}{' '}
                  <a href={r.source.href} target="_blank" rel="noreferrer" className="small">
                    ({r.source.label})
                  </a>
                </td>
                <td>{r.catch}</td>
                <td>{r.api}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Checking a popular infographic</h3>
      <div className="table-wrap">
        <table className="t tr-speed">
          <thead>
            <tr>
              <th>Claim</th>
              <th>Verdict</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {CHECKS.map(([claim, verdict, why]) => (
              <tr key={claim}>
                <td>{claim}</td>
                <td>
                  <b>{verdict}</b>
                </td>
                <td>{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tr-note">
        Calling Claude or GPT, your levers are prompt caching, a smaller model, shorter outputs, streaming (the reply
        appears sooner), the Batch API for work that can wait, and parallel requests. The rest happen on the provider’s
        servers, or on yours if you host an open model.
      </p>
    </section>
  );
}
