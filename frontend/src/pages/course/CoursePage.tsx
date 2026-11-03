import './course.css';

/**
 * A path through the lab that follows Stanford's CME 295 (Transformers and Large Language Models) lecture by lecture,
 * starting with Microsoft's "What is a GPT?" as lecture 0. Each lecture lists the labs that teach it, in order.
 */

interface Lab {
  href: string;
  name: string;
  what: string;
  isNew?: boolean;
}
interface Lecture {
  n: number;
  title: string;
  topics: string;
  labs: Lab[];
}

const LECTURES: Lecture[] = [
  {
    n: 0, title: 'What is GPT?', topics: 'Next-token prediction, tokens, attention, pre-training, decoder-only, benefits and challenges',
    labs: [{ href: '/what-is-gpt', name: 'What is GPT', what: 'GPT-2 live: predict the next token, the "cloud" example, history, corrections', isNew: true }],
  },
  {
    n: 1, title: 'Transformers', topics: 'Tokenisation, embeddings, self-attention, the full forward pass',
    labs: [
      { href: '/tokens', name: 'Tokens', what: 'The real GPT-2 tokenizer' },
      { href: '/transformer', name: 'Transformer explainer', what: 'Every internal value of GPT-2, animated' },
      { href: '/deep-learning#nb-12.1', name: 'Deep learning 12.1–12.3', what: 'Self-attention, multi-head attention, byte-pair encoding' },
      { href: '/vision', name: 'Images as tokens', what: 'The same transformer reading a picture' },
    ],
  },
  {
    n: 2, title: 'Transformer tricks', topics: 'RoPE, RMSNorm, multi-query and grouped-query attention, sliding windows, FlashAttention',
    labs: [
      { href: '/transformer-tricks', name: 'Transformer tricks', what: 'Each trick computed: RoPE, norms, GQA, windows, FlashAttention, MoE, speculative decoding', isNew: true },
      { href: '/context', name: 'Context and cost', what: 'KV-cache memory, prefill and decode' },
    ],
  },
  {
    n: 3, title: 'Large language models', topics: 'Decoding, prompting, in-context learning, mixture of experts, inference speed',
    labs: [
      { href: '/sampling', name: 'Sampling', what: 'Greedy, temperature, top-k, top-p, self-consistency' },
      { href: '/prompting', name: 'Prompting', what: 'Few-shot prompting, measured' },
      { href: '/hardware', name: 'Hardware for AI', what: 'Why generation is memory-bound; quantisation' },
      { href: '/transformer-tricks', name: 'Transformer tricks', what: 'Mixture of experts and speculative decoding', isNew: true },
    ],
  },
  {
    n: 4, title: 'LLM training', topics: 'Pre-training data and scaling laws, SFT, LoRA, parallelism',
    labs: [
      { href: '/building', name: 'How LLMs are built', what: 'Data cleaning, scaling laws, SFT, training memory' },
      { href: '/training', name: 'Training lab', what: 'Train a tiny language model live' },
      { href: '/training-at-scale', name: 'Training at scale', what: 'LoRA trained live; data, tensor and pipeline parallelism; ZeRO', isNew: true },
    ],
  },
  {
    n: 5, title: 'LLM tuning', topics: 'RLHF, reward models, PPO, DPO',
    labs: [
      { href: '/building', name: 'How LLMs are built', what: 'From base model to assistant; a reward model' },
      { href: '/preference-tuning', name: 'Preference tuning', what: 'Reward model, PPO clipping, reward hacking and KL, DPO', isNew: true },
    ],
  },
  {
    n: 6, title: 'LLM reasoning', topics: 'Reasoning models, RL with verifiable rewards, GRPO, test-time compute',
    labs: [
      { href: '/reasoning-models', name: 'Reasoning models', what: 'GRPO running live; verifiable rewards; pass@k and majority vote', isNew: true },
      { href: '/sampling', name: 'Sampling', what: 'Self-consistency: ask several times, take the majority' },
    ],
  },
  {
    n: 7, title: 'Agentic LLMs', topics: 'RAG, tool calling, agents, MCP, harnesses, human approval',
    labs: [
      { href: '/embeddings', name: 'Embeddings and RAG', what: 'Retrieval, hybrid search, reranking' },
      { href: '/agents', name: 'Agents and tools', what: 'The tool-use loop step by step' },
      { href: '/context-engineering', name: 'Context engineering', what: 'What to put in each request' },
      { href: '/harness', name: 'Harness engineering', what: 'Autonomous agents and what each harness feature does' },
      { href: '/mcp', name: 'MCP servers', what: 'A real MCP server; tokens, scopes, approval' },
      { href: '/casework', name: 'Case handling on Azure', what: 'Multi-agent, checks, human approval, audit' },
    ],
  },
  {
    n: 8, title: 'LLM evaluation', topics: 'Test sets, LLM-as-a-judge, benchmarks, pass@k, arenas, contamination',
    labs: [
      { href: '/evals', name: 'Evals', what: 'Test sets, graders, LLM judge, intervals, variance' },
      { href: '/confidence', name: 'Confidence and calibration', what: 'When to trust an answer' },
      { href: '/benchmarks', name: 'Benchmarks', what: 'pass@k, significance, contamination, Elo and Bradley–Terry', isNew: true },
    ],
  },
];

export default function CoursePage() {
  return (
    <main className="page-course">
      <div className="kicker">Course</div>
      <h1>The LLM course, lecture by lecture</h1>
      <p className="lede">
        A path through the lab that follows Stanford's <b>CME 295: Transformers and Large Language Models</b>, eight lectures from
        the transformer to agents and evaluation, with Microsoft's{' '}
        <a href="https://azure.microsoft.com/en-us/resources/cloud-computing-dictionary/what-is-gpt" target="_blank" rel="noreferrer">
          What is a GPT?
        </a>{' '}
        as lecture 0. Watch a lecture, then work through its labs: everything in them runs, so you can change it and see what
        happens.
      </p>
      <ol className="co-path">
        {LECTURES.map((l) => (
          <li key={l.n} className="card">
            <div className="co-head">
              <span className="co-n">{l.n === 0 ? 'Start' : `Lecture ${l.n}`}</span>
              <h2>{l.title}</h2>
            </div>
            <p className="small muted">{l.topics}</p>
            <div className="co-labs">
              {l.labs.map((lab) => (
                <a key={lab.href + lab.name} href={lab.href} className="co-lab">
                  <b>
                    {lab.name}
                    {lab.isNew && <span className="co-new">new</span>}
                  </b>
                  <span className="small">{lab.what}</span>
                </a>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <p className="small muted">
        Lectures: Stanford Online, CME 295 (Afshine and Shervine Amidi), on YouTube. The lab is not affiliated with Stanford or
        Microsoft; the mapping of lectures to labs is ours.
      </p>
    </main>
  );
}
