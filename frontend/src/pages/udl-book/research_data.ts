import type { Frontier, Lever, Source } from './types';

// Sources used by more than one entry. Every number below was checked against the source's abstract or text
// in November 2026; where a source gave no number, the entry says so rather than estimating one.

const CHINCHILLA: Source = {
  title: 'Training Compute-Optimal Large Language Models',
  who: 'Hoffmann et al.',
  year: 2022,
  url: 'https://arxiv.org/abs/2203.15556',
};
const LLAMA3_BLOG: Source = {
  title: 'Introducing Meta Llama 3',
  who: 'Meta AI',
  year: 2024,
  url: 'https://ai.meta.com/blog/meta-llama-3/',
};
const DEEPSEEK_V2: Source = {
  title: 'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model',
  who: 'DeepSeek-AI',
  year: 2024,
  url: 'https://arxiv.org/abs/2405.04434',
};
const DEEPSEEK_V3: Source = {
  title: 'DeepSeek-V3 Technical Report',
  who: 'DeepSeek-AI',
  year: 2024,
  url: 'https://arxiv.org/abs/2412.19437',
};
const DEEPSEEK_V32: Source = {
  title: 'DeepSeek-V3.2: Pushing the Frontier of Open Large Language Models',
  who: 'DeepSeek-AI',
  year: 2025,
  url: 'https://arxiv.org/abs/2512.02556',
};
const DEEPSEEK_R1: Source = {
  title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
  who: 'DeepSeek-AI',
  year: 2025,
  url: 'https://arxiv.org/abs/2501.12948',
};
const KIMI_K2: Source = {
  title: 'Kimi K2: Open Agentic Intelligence',
  who: 'Kimi Team',
  year: 2025,
  url: 'https://arxiv.org/abs/2507.20534',
};
const NVFP4_PRETRAIN: Source = {
  title: 'Pretraining Large Language Models with NVFP4',
  who: 'NVIDIA',
  year: 2025,
  url: 'https://arxiv.org/abs/2509.25149',
};
const NVFP4_INFERENCE: Source = {
  title: 'Introducing NVFP4 for Efficient and Accurate Low-Precision Inference',
  who: 'NVIDIA',
  year: 2025,
  url: 'https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/',
};
const GPT_OSS: Source = {
  title: 'gpt-oss-120b & gpt-oss-20b Model Card',
  who: 'OpenAI',
  year: 2025,
  url: 'https://arxiv.org/abs/2508.10925',
};
const QWEN3_NEXT: Source = {
  title: 'Qwen3-Next: Towards Ultimate Training & Inference Efficiency',
  who: 'Qwen Team, Alibaba Cloud',
  year: 2025,
  url: 'https://www.alibabacloud.com/blog/qwen3-next-towards-ultimate-training-%26-inference-efficiency_602580',
};
const KIMI_LINEAR: Source = {
  title: 'Kimi Linear: An Expressive, Efficient Attention Architecture',
  who: 'Kimi Team',
  year: 2025,
  url: 'https://arxiv.org/abs/2510.26692',
};
const MINIMAX_M2: Source = {
  title: 'Why Did M2 End Up as a Full Attention Model?',
  who: 'MiniMax',
  year: 2025,
  url: 'https://huggingface.co/blog/MiniMax-AI/why-did-m2-end-up-as-a-full-attention-model',
};
const O1_BLOG: Source = {
  title: 'Learning to Reason with LLMs',
  who: 'OpenAI',
  year: 2024,
  url: 'https://openai.com/index/learning-to-reason-with-llms/',
};
const RL_LIMITS: Source = {
  title: 'Does Reinforcement Learning Really Incentivize Reasoning Capacity in LLMs Beyond the Base Model?',
  who: 'Yue et al.',
  year: 2025,
  url: 'https://arxiv.org/abs/2504.13837',
};
const METR_TH11: Source = {
  title: 'Time Horizon 1.1',
  who: 'METR',
  year: 2026,
  url: 'https://metr.org/blog/2026-01-29-time-horizon-1-1/',
};

export const LEVERS: Lever[] = [
  // ---------------------------------------------------------------- training
  {
    id: 'compute-optimal',
    name: 'Compute-optimal scaling',
    stage: 'training',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [6, 8, 20],
    what: 'For a fixed training budget, choose model size and data together. Chinchilla found that parameters and training tokens should grow in equal proportion: double the model, double the data. Earlier large models were too big for the data they saw.',
    gain: 'Chinchilla (70B parameters, four times the data of Gopher, about 20 tokens per parameter) used the same compute as Gopher (280B) and beat it, GPT-3 (175B) and Megatron-Turing NLG (530B) on a wide range of tasks. It reached 67.5% on MMLU, more than 7 points above Gopher.',
    tradeoff:
      'The rule minimises training compute only. It ignores the cost of serving the model afterwards, which for a popular model is far larger, so it is no longer the target for models meant to be deployed (see the next lever). The fitted constants also depend on the data and architecture.',
    sources: [CHINCHILLA],
    labs: [['/building', 'Scaling laws']],
  },
  {
    id: 'over-training',
    name: 'Over-training small models',
    stage: 'training',
    tags: ['cost', 'speed', 'quality'],
    maturity: 'production',
    chapters: [8, 20],
    what: 'Train a smaller model on far more tokens than the compute-optimal amount. Training costs more than it needs to for that size, but every later request is cheaper because the model is small.',
    gain: 'Meta reports that the Chinchilla-optimal data for an 8B model is about 200B tokens, yet both Llama 3 8B and 70B kept improving log-linearly up to 15T tokens: about 1,900 tokens per parameter for the 8B model, two orders of magnitude past the optimum.',
    tradeoff:
      'Each further gain needs exponentially more tokens, and good text is running short, which pushes teams towards filtering and synthetic data. The training bill is higher than a compute-optimal model of the same quality would need.',
    sources: [LLAMA3_BLOG, CHINCHILLA],
    labs: [['/building', 'Scaling laws']],
  },
  {
    id: 'data-quality',
    name: 'Data filtering and deduplication',
    stage: 'training',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [2, 8, 9],
    what: 'Score web documents with a small classifier and keep only the useful ones, and remove repeated text. The model then spends its compute on fewer, better tokens and memorises less.',
    gain: 'FineWeb-Edu (1.3T tokens kept from 15T, using a classifier trained on Llama-3-70B ratings of educational value) raised MMLU from 33% to 37% and ARC from 46% to 57% against unfiltered FineWeb at the same token budget, and matched the MMLU of the Matrix dataset with almost 10× fewer tokens. DCLM-Baseline: a 7B model on 2.6T tokens reached 64% on 5-shot MMLU, 6.6 points above MAP-Neo with 40% less compute. Deduplicating C4 and similar sets made models emit memorised text ten times less often.',
    tradeoff:
      'Aggressive filters throw away most of the web, which leaves fewer unique tokens for long training runs. A classifier tuned for benchmark-like text can narrow what the model knows and bake in the rater’s biases. Deduplication at trillion-token scale needs substantial infrastructure.',
    sources: [
      {
        title: 'The FineWeb Datasets: Decanting the Web for the Finest Text Data at Scale',
        who: 'Penedo et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2406.17557',
      },
      {
        title: 'DataComp-LM: In search of the next generation of training sets for language models',
        who: 'Li et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2406.11794',
      },
      {
        title: 'Deduplicating Training Data Makes Language Models Better',
        who: 'Lee et al.',
        year: 2021,
        url: 'https://arxiv.org/abs/2107.06499',
      },
    ],
    labs: [['/building', 'Data cleaning']],
  },
  {
    id: 'synthetic-data',
    name: 'Synthetic training data',
    stage: 'training',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [9, 14],
    what: 'Use a strong model to write training text, such as textbook-style explanations and exercises, and train a smaller model on it alongside filtered web data.',
    gain: 'phi-1 (1.3B parameters, trained for 4 days on 8 A100s on 6B tokens of filtered web data plus 1B tokens of GPT-3.5-written textbooks and exercises) scored 50.6% pass@1 on HumanEval and 55.5% on MBPP.',
    tradeoff:
      'Synthetic text inherits the writer model’s errors and narrows the data towards what that model produces. Training generation after generation on model output causes "model collapse": the rare tails of the original distribution disappear.',
    sources: [
      {
        title: 'Textbooks Are All You Need',
        who: 'Gunasekar et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2306.11644',
      },
      {
        title: 'The Curse of Recursion: Training on Generated Data Makes Models Forget',
        who: 'Shumailov et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2305.17493',
      },
    ],
  },
  {
    id: 'distillation',
    name: 'Distillation and pruning',
    stage: 'training',
    tags: ['cost', 'speed'],
    maturity: 'production',
    chapters: [5, 9],
    what: 'Train a small student to copy a large teacher: its outputs, its probabilities or its reasoning traces. Pruning first removes layers, heads or channels from the teacher so the student starts close to it.',
    gain: 'DeepSeek-R1-Distill-Qwen-7B, fine-tuned on R1’s reasoning traces, scored 55.5% on AIME 2024, and the 32B student 72.6% (R1 itself: 79.8%). Minitron pruned and distilled Nemotron 15B into 8B and 4B models with up to 40× fewer training tokens per model than training from scratch, 1.8× less compute for the family, and up to 16% better MMLU than the same sizes trained from scratch.',
    tradeoff:
      'The student is capped by the teacher and copies its mistakes. It needs a strong teacher, which someone had to pay for, and model licences sometimes forbid training on the outputs. Distilled reasoning can be brittle away from the teacher’s domains.',
    sources: [
      DEEPSEEK_R1,
      {
        title: 'Compact Language Models via Pruning and Knowledge Distillation',
        who: 'Muralidharan et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2407.14679',
      },
    ],
  },
  {
    id: 'muon',
    name: 'Muon optimiser at scale',
    stage: 'training',
    tags: ['cost', 'quality'],
    maturity: 'emerging',
    chapters: [6, 7],
    what: 'Muon updates each weight matrix with an orthogonalised version of its momentum, so every direction in the matrix moves by a similar amount. It replaces Adam for the hidden layers.',
    gain: 'Moonshot AI report about 2× the computational efficiency of AdamW in compute-optimal training. Kimi K2 (1T total, 32B active parameters) was pre-trained on 15.5T tokens with MuonClip, a Muon variant with QK-clipping, with zero loss spikes.',
    tradeoff:
      'The orthogonalisation adds matrix work at every step and is harder to shard across devices than Adam. At scale it needed extra fixes (weight decay, update scaling, QK-clipping against exploding attention logits). Adam remains the default and has far more evidence behind it.',
    sources: [
      {
        title: 'Muon is Scalable for LLM Training',
        who: 'Liu et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2502.16982',
      },
      KIMI_K2,
    ],
    labs: [['/training-at-scale', 'Training at scale']],
  },
  {
    id: 'mup',
    name: 'μP hyperparameter transfer',
    stage: 'training',
    tags: ['cost', 'quality'],
    maturity: 'emerging',
    chapters: [6, 7],
    what: 'Parameterise the model so that the best learning rate and initialisation stay the same as the width grows. Tune them on a small proxy model, then copy them to the large one without tuning it.',
    gain: 'Hyperparameters tuned on a 40M-parameter proxy and transferred to a 6.7B GPT-3 model beat the published GPT-3 6.7B results, at a tuning cost of 7% of the total pre-training cost. A 13M proxy transferred to BERT-large (350M) also beat its published numbers.',
    tradeoff:
      'It needs changes to initialisation, learning-rate scaling and output multipliers, and mistakes break the transfer silently. Transfer holds across width; depth, batch size and training length need further care. Many open model reports do not say whether they use it.',
    sources: [
      {
        title: 'Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer',
        who: 'Yang et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2203.03466',
      },
    ],
    labs: [['/training-at-scale', 'Training at scale']],
  },
  {
    id: 'low-precision-training',
    name: 'Low-precision training (FP8, FP4)',
    stage: 'training',
    tags: ['cost', 'speed', 'memory'],
    maturity: 'production',
    chapters: [6, 7],
    what: 'Run the large matrix multiplications in 8-bit or 4-bit floating point with fine-grained scaling factors, keeping sensitive parts (optimiser state, some layers) in higher precision.',
    gain: 'DeepSeek-V3 (671B total, 37B active) was trained in FP8 on 14.8T tokens for 2.788M H800 GPU hours, with relative loss error against a BF16 baseline consistently below 0.25%. NVIDIA trained a 12B model on 10T tokens in NVFP4 with training loss and downstream accuracy comparable to an FP8 baseline.',
    tradeoff:
      'Needs hardware with FP8 or FP4 tensor cores (Hopper, Blackwell) and careful recipes: per-block scales, higher-precision accumulation, and some layers left in BF16. FP4 pre-training is shown at 12B scale, not yet at frontier scale in public.',
    sources: [DEEPSEEK_V3, NVFP4_PRETRAIN],
    labs: [['/hardware', 'Number formats and bandwidth']],
  },

  // ---------------------------------------------------------------- architecture
  {
    id: 'moe',
    name: 'Mixture of experts',
    stage: 'architecture',
    tags: ['cost', 'speed', 'quality'],
    maturity: 'production',
    chapters: [4, 12],
    what: 'Replace each feed-forward block with many expert blocks and a router that sends each token to a few of them. The model has many parameters, but each token only uses a small share.',
    gain: 'Mixtral 8×7B uses 13B active of 47B total parameters per token and matches or beats Llama 2 70B and GPT-3.5 on the benchmarks reported. DeepSeek-V3 activates 37B of 671B parameters per token; gpt-oss-120b activates 5.1B of 116.8B.',
    tradeoff:
      'All parameters must sit in memory even though few are used, so serving needs many GPUs or offloading. Routing can collapse onto a few experts without balancing losses or biases, and spreading experts across devices adds all-to-all communication. Fine-tuning is less stable than for dense models.',
    sources: [
      {
        title: 'Mixtral of Experts',
        who: 'Jiang et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2401.04088',
      },
      DEEPSEEK_V3,
      GPT_OSS,
    ],
    labs: [['/transformer-tricks', 'Mixture of experts']],
  },
  {
    id: 'gqa-mqa',
    name: 'Grouped-query and multi-query attention',
    stage: 'architecture',
    tags: ['speed', 'memory'],
    maturity: 'production',
    chapters: [12],
    what: 'Let several query heads share one key head and one value head. The KV cache, which is read in full for every generated token, shrinks by the sharing factor.',
    gain: 'Multi-query attention (one shared key and value head) made incremental decoding much faster with only minor quality loss. GQA, with a few shared groups, kept quality close to full multi-head attention at speed comparable to MQA, and an existing model could be converted with 5% of its original pre-training compute.',
    tradeoff:
      'Fewer key and value heads means less capacity; MQA loses some quality and can be less stable to train. The saving is in memory traffic at decode time, not in training compute.',
    sources: [
      {
        title: 'Fast Transformer Decoding: One Write-Head is All You Need',
        who: 'Shazeer',
        year: 2019,
        url: 'https://arxiv.org/abs/1911.02150',
      },
      {
        title: 'GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints',
        who: 'Ainslie et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2305.13245',
      },
    ],
    labs: [['/transformer-tricks', 'MQA and GQA']],
  },
  {
    id: 'mla',
    name: 'Multi-head latent attention',
    stage: 'architecture',
    tags: ['memory', 'speed'],
    maturity: 'production',
    chapters: [12],
    what: 'Store a small compressed vector per token instead of full keys and values, and expand it back into per-head keys and values when attention needs them. It keeps a separate head for each query, unlike GQA.',
    gain: 'DeepSeek-V2 (236B total, 21B active) cut the KV cache by 93.3% and raised maximum generation throughput 5.76× compared with DeepSeek 67B, which used standard multi-head attention. The throughput figure also reflects the move to a mixture of experts.',
    tradeoff:
      'More complex to implement, and rotary position embeddings need a separate decoupled path because they do not pass through the compression. Kernels and serving support arrived later than for GQA.',
    sources: [DEEPSEEK_V2, DEEPSEEK_V3],
    labs: [['/transformer-tricks', 'KV-cache tricks']],
  },
  {
    id: 'local-global-attention',
    name: 'Sliding-window and local–global attention',
    stage: 'architecture',
    tags: ['memory', 'speed'],
    maturity: 'production',
    chapters: [10, 12],
    what: 'Most layers attend only to a short window of recent tokens, like a convolution’s receptive field; a few layers keep full attention. The local layers need a fixed-size cache however long the text gets.',
    gain: 'Gemma 3 uses five local layers (1,024-token window) per global layer. In its ablations, KV-cache memory overhead fell from about 60% with global-only attention to under 15% with one global layer per three local layers and a 1,024-token window, with minimal effect on perplexity. Mistral 7B used sliding windows with GQA and beat Llama 2 13B on all reported benchmarks.',
    tradeoff:
      'Information from far back must travel through the few global layers. MiniMax reported that a sliding-window hybrid it tried for M2 degraded noticeably as context grew, and returned to full attention for agentic use.',
    sources: [
      {
        title: 'Gemma 3 Technical Report',
        who: 'Gemma Team, Google DeepMind',
        year: 2025,
        url: 'https://arxiv.org/abs/2503.19786',
      },
      {
        title: 'Mistral 7B',
        who: 'Jiang et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2310.06825',
      },
      MINIMAX_M2,
    ],
    labs: [['/transformer-tricks', 'Sliding windows']],
  },
  {
    id: 'sparse-attention',
    name: 'Learned sparse attention',
    stage: 'architecture',
    tags: ['speed', 'cost'],
    maturity: 'production',
    chapters: [12],
    what: 'A small, fast indexer scores every earlier token, and the main attention only reads the top k of them. Unlike a fixed window, the model chooses which far-away tokens to keep.',
    gain: 'DeepSeek Sparse Attention selects 2,048 key-value tokens per query, reducing core attention cost from O(L²) to O(L·k) in sequence length L. DeepSeek report a significant end-to-end speed-up at long context while keeping performance; the paper gives per-token cost curves on H800s but no single headline factor.',
    tradeoff:
      'Added through continued training of an existing dense-attention model, so it depends on that model existing. The indexer still scans every token, so cost is not fully linear. The benefit only appears at long context.',
    sources: [DEEPSEEK_V32],
    labs: [['/transformer-tricks', 'Attention variants']],
  },
  {
    id: 'hybrid-ssm',
    name: 'State-space and hybrid linear-attention models',
    stage: 'architecture',
    tags: ['speed', 'memory'],
    maturity: 'production',
    chapters: [11, 12],
    what: 'Replace most attention layers with layers that carry a fixed-size state forward (Mamba, Gated DeltaNet, Kimi Delta Attention), keeping a few full-attention layers for exact recall. Memory no longer grows with every token in those layers.',
    gain: 'Mamba reported 5× higher inference throughput than Transformers. Nemotron-H (8B and 56B) is up to 3× faster at inference than similar-sized Qwen-2.5 and Llama-3.1 at similar accuracy. Qwen3-Next (80B total, about 3B active, 3:1 Gated DeltaNet to attention) cost 9.3% of Qwen3-32B’s training compute and has over 10× its prefill and decode throughput beyond 32K context. Kimi Linear cut KV cache by up to 75% and raised decoding throughput up to 6× at 1M tokens.',
    tradeoff:
      'MiniMax found a linear/full hybrid matched full attention on common benchmarks but showed clear deficits in multi-hop reasoning at scale, and that linear attention is more sensitive to numerical precision. Prefix caching and speculative decoding are harder to support. Speed-ups depend heavily on kernel quality.',
    sources: [
      {
        title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces',
        who: 'Gu and Dao',
        year: 2023,
        url: 'https://arxiv.org/abs/2312.00752',
      },
      {
        title: 'Nemotron-H: A Family of Accurate and Efficient Hybrid Mamba-Transformer Models',
        who: 'NVIDIA',
        year: 2025,
        url: 'https://arxiv.org/abs/2504.03624',
      },
      {
        title: 'Jamba: A Hybrid Transformer-Mamba Language Model',
        who: 'Lieber et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2403.19887',
      },
      QWEN3_NEXT,
      KIMI_LINEAR,
      MINIMAX_M2,
    ],
  },
  {
    id: 'multi-token-prediction',
    name: 'Multi-token prediction',
    stage: 'architecture',
    tags: ['quality', 'speed'],
    maturity: 'production',
    chapters: [5, 12],
    what: 'Add extra output heads that predict the second, third or fourth next token as well as the next one. Training gets a denser signal, and at inference the extra predictions can be used as cheap draft tokens.',
    gain: '13B models trained to predict 4 tokens solved 12% more HumanEval and 17% more MBPP problems than next-token models, and ran up to 3× faster with self-speculative decoding. In DeepSeek-V3, the second predicted token is accepted 85–90% of the time, giving 1.8× tokens per second.',
    tradeoff:
      'The authors found the benefit grows with model size and is clearest on code; small models gain little. The extra heads add parameters and training compute.',
    sources: [
      {
        title: 'Better & Faster Large Language Models via Multi-token Prediction',
        who: 'Gloeckle et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2404.19737',
      },
      DEEPSEEK_V3,
    ],
  },
  {
    id: 'rope-scaling',
    name: 'Long-context position scaling (YaRN)',
    stage: 'architecture',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [12],
    what: 'Pre-train at a short context, then stretch the rotary position embeddings so the model can read much longer text, with a short fine-tune. YaRN scales different frequencies by different amounts so local word order is kept.',
    gain: 'YaRN needed 10× fewer tokens and 2.5× fewer training steps than earlier extension methods. DeepSeek-V3 used it to go from 4K to 32K and then 128K context in two phases of 1,000 steps each.',
    tradeoff:
      'A model that accepts a long input does not always use all of it; retrieval and reasoning over the middle of very long inputs often lag. The KV cache still grows linearly with context, so long inputs remain costly to serve.',
    sources: [
      {
        title: 'YaRN: Efficient Context Window Extension of Large Language Models',
        who: 'Peng et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2309.00071',
      },
      DEEPSEEK_V3,
    ],
    labs: [
      ['/transformer-tricks', 'RoPE'],
      ['/context', 'Context and cost'],
    ],
  },

  // ---------------------------------------------------------------- inference
  {
    id: 'weight-quantisation',
    name: 'Weight quantisation (int4, FP8, FP4)',
    stage: 'inference',
    tags: ['memory', 'speed', 'cost'],
    maturity: 'production',
    chapters: [4, 12],
    what: 'Store weights in 8 or 4 bits instead of 16, using calibration to decide how to round. Decoding is limited by reading weights from memory, so fewer bytes means faster tokens and fewer GPUs.',
    gain: 'GPTQ quantised a 175B model to 3–4 bits in about four GPU hours with negligible accuracy loss, giving about 3.25× end-to-end speed-up on an A100 and 4.5× on an A6000 over FP16. A study of Llama 3.1 models (over 500,000 evaluations) found FP8 (W8A8) effectively lossless at all sizes and well-tuned INT8 within 1–3%. NVFP4 on DeepSeek-R1-0528 lost 1 point or less against FP8 (MMLU-Pro 85% to 84%) while using about 1.8× less memory than FP8 and 3.5× less than FP16. gpt-oss-120b ships with MXFP4 expert weights so that it fits on one 80GB GPU.',
    tradeoff:
      'Losses are larger at 3 bits and below, for small models, and on long reasoning chains, and averages hide failures on specific tasks. Speed-ups need kernels for the format; FP4 needs Blackwell-class hardware. Each format must be re-evaluated on the tasks that matter.',
    sources: [
      {
        title: 'GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers',
        who: 'Frantar et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2210.17323',
      },
      {
        title: 'AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration',
        who: 'Lin et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2306.00978',
      },
      {
        title: '"Give Me BF16 or Give Me Death"? Accuracy-Performance Trade-Offs in LLM Quantization',
        who: 'Kurtic et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2411.02355',
      },
      NVFP4_INFERENCE,
      GPT_OSS,
    ],
    labs: [['/hardware', 'Quantisation']],
  },
  {
    id: 'kv-quantisation',
    name: 'KV-cache quantisation',
    stage: 'inference',
    tags: ['memory', 'speed'],
    maturity: 'emerging',
    chapters: [12],
    what: 'Store the cached keys and values in fewer bits. At long context and large batch the KV cache, not the weights, is what fills GPU memory.',
    gain: 'KIVI quantised the KV cache to 2 bits with no tuning (keys per channel, values per token), using 2.6× less peak memory including weights, allowing up to 4× larger batches and 2.35–3.47× higher throughput on real inference workloads, with similar quality on Llama, Falcon and Mistral models.',
    tradeoff:
      'Errors in keys change which tokens get attention, so aggressive schemes can hurt long-context retrieval. Needs custom kernels to save time rather than just memory.',
    sources: [
      {
        title: 'KIVI: A Tuning-Free Asymmetric 2bit Quantization for KV Cache',
        who: 'Liu et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2402.02750',
      },
    ],
    labs: [['/hardware', 'Memory and bandwidth']],
  },
  {
    id: 'paged-attention',
    name: 'Paged KV cache (vLLM)',
    stage: 'inference',
    tags: ['memory', 'cost'],
    maturity: 'production',
    chapters: [12],
    what: 'Store each request’s KV cache in fixed-size blocks, like pages of virtual memory, instead of one contiguous slab sized for the longest possible output. Blocks can be shared between requests with a common prefix.',
    gain: 'vLLM’s PagedAttention brought KV-cache waste close to zero and raised throughput 2–4× over FasterTransformer and Orca at the same latency.',
    tradeoff:
      'Attention kernels must gather from scattered blocks, which adds some overhead and engineering. The gain comes from fitting more requests in memory, so it is small when batches are small.',
    sources: [
      {
        title: 'Efficient Memory Management for Large Language Model Serving with PagedAttention',
        who: 'Kwon et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2309.06180',
      },
    ],
    labs: [['/hardware', 'Memory and bandwidth']],
  },
  {
    id: 'flash-attention',
    name: 'FlashAttention 1–3',
    stage: 'inference',
    tags: ['speed', 'memory'],
    maturity: 'production',
    chapters: [12],
    what: 'Compute exact attention in tiles that stay in fast on-chip memory, never writing the full attention matrix to GPU memory. The result is the same; far fewer bytes move.',
    gain: 'FlashAttention gave 3× speed-up training GPT-2 at 1K tokens and 15% on BERT-large against the MLPerf 1.1 record. FlashAttention-2 was about 2× faster again, reaching 50–73% of the A100’s peak and 225 TFLOPs/s per GPU in GPT-style training. FlashAttention-3 is 1.5–2.0× faster than FlashAttention-2 on H100, reaching 740 TFLOPs/s (75% use) in FP16 and close to 1.2 PFLOPs/s in FP8.',
    tradeoff:
      'Each GPU generation needs new hand-written kernels; FlashAttention-3 is specific to Hopper. It speeds up attention but not the feed-forward layers, so end-to-end gains are smaller at short context.',
    sources: [
      {
        title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
        who: 'Dao et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2205.14135',
      },
      {
        title: 'FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning',
        who: 'Dao',
        year: 2023,
        url: 'https://arxiv.org/abs/2307.08691',
      },
      {
        title: 'FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision',
        who: 'Shah et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2407.08608',
      },
    ],
    labs: [['/transformer-tricks', 'FlashAttention']],
  },
  {
    id: 'speculative-decoding',
    name: 'Speculative decoding',
    stage: 'inference',
    tags: ['speed'],
    maturity: 'production',
    chapters: [5, 12],
    what: 'A small draft model proposes several tokens; the large model checks them all in one pass and keeps the ones it agrees with. A rejection-sampling rule makes the output distribution exactly that of the large model.',
    gain: 'Leviathan et al. reported 2–3× faster decoding on T5-XXL with identical outputs. EAGLE-3, which drafts from the target model’s own features, reported up to 6.5× speed-up (about 1.4× over EAGLE-2) and 1.38× higher throughput at batch size 64 in SGLang.',
    tradeoff:
      'Gains shrink at large batch sizes, where the GPU is already busy, and depend on how predictable the text is. The draft model must be trained and served, and kept in step when the target model changes.',
    sources: [
      {
        title: 'Fast Inference from Transformers via Speculative Decoding',
        who: 'Leviathan et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2211.17192',
      },
      {
        title: 'EAGLE-3: Scaling up Inference Acceleration of Large Language Models via Training-Time Test',
        who: 'Li et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2503.01840',
      },
    ],
    labs: [['/transformer-tricks', 'Speculative decoding']],
  },
  {
    id: 'continuous-batching',
    name: 'Continuous batching',
    stage: 'inference',
    tags: ['cost', 'speed'],
    maturity: 'production',
    chapters: [12],
    what: 'Schedule work one decoding step at a time, so a finished request leaves the batch and a new one joins immediately, instead of the whole batch waiting for its longest member.',
    gain: 'Orca reported 36.9× higher throughput than NVIDIA FasterTransformer at the same latency, serving GPT-3 175B.',
    tradeoff:
      'New requests’ prefill competes with running requests’ decoding, which causes latency spikes unless prefill is chunked or moved elsewhere. The scheduler and memory manager are more complex.',
    sources: [
      {
        title: 'Orca: A Distributed Serving System for Transformer-Based Generative Models',
        who: 'Yu et al.',
        year: 2022,
        url: 'https://www.usenix.org/conference/osdi22/presentation/yu',
      },
    ],
    labs: [['/hardware', 'Batching and throughput']],
  },
  {
    id: 'prefix-caching',
    name: 'Prefix and prompt caching',
    stage: 'inference',
    tags: ['cost', 'speed'],
    maturity: 'production',
    chapters: [12],
    what: 'Keep the KV cache of a shared prompt prefix (system prompt, documents, earlier turns) and reuse it for later requests, so only the new tokens need prefill.',
    gain: 'SGLang’s RadixAttention reported up to 6.4× higher throughput on structured LLM programs. Anthropic report up to 90% lower cost and 85% lower latency for long prompts: a 100,000-token cached book cut time to first token from 11.5 s to 2.4 s.',
    tradeoff:
      'Only exact prefixes match, so prompts must put stable content first. Cache entries expire and use memory; Anthropic charge 25% more than the base input price to write the cache and 10% of it to read.',
    sources: [
      {
        title: 'SGLang: Efficient Execution of Structured Language Model Programs',
        who: 'Zheng et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2312.07104',
      },
      {
        title: 'Prompt caching with Claude',
        who: 'Anthropic',
        year: 2024,
        url: 'https://claude.com/blog/prompt-caching',
      },
    ],
    labs: [['/context', 'Context and cost']],
  },
  {
    id: 'disaggregation',
    name: 'Disaggregated prefill and decode',
    stage: 'inference',
    tags: ['cost', 'speed'],
    maturity: 'production',
    chapters: [12],
    what: 'Prefill (reading the prompt) is limited by compute; decoding is limited by memory bandwidth. Run them on separate GPU pools sized and tuned for each, and move the KV cache between them.',
    gain: 'DistServe served 7.4× more requests, or met 12.6× tighter latency targets, than state-of-the-art serving systems. Splitwise reached 1.4× higher throughput at 20% lower cost, or 2.35× throughput at the same cost and power. Mooncake, Kimi’s serving platform, let Kimi handle 75% more requests under real workloads.',
    tradeoff:
      'Moving the KV cache needs fast interconnect and adds latency. Two pools must be balanced as traffic shifts, and the system is harder to run than one pool. Small deployments gain little.',
    sources: [
      {
        title: 'DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving',
        who: 'Zhong et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2401.09670',
      },
      {
        title: 'Splitwise: Efficient generative LLM inference using phase splitting',
        who: 'Patel et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2311.18677',
      },
      {
        title: 'Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving',
        who: 'Qin et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2407.00079',
      },
    ],
    labs: [['/hardware', 'Compute against bandwidth']],
  },

  // ---------------------------------------------------------------- post-training
  {
    id: 'rlhf',
    name: 'RLHF with PPO',
    stage: 'post-training',
    tags: ['quality'],
    maturity: 'production',
    chapters: [5, 19, 21],
    what: 'Collect human comparisons between answers, train a reward model on them, then fine-tune the language model with reinforcement learning (PPO) to score highly while staying close to the original model.',
    gain: 'Labellers preferred outputs of the 1.3B InstructGPT model to those of the 175B GPT-3, despite it having over 100× fewer parameters.',
    tradeoff:
      'Four models in memory at once (policy, reference, reward, value), and PPO is sensitive to settings. The policy learns to exploit the reward model’s blind spots (reward hacking), which can show up as length or flattery. Human labels are slow and costly.',
    sources: [
      {
        title: 'Training language models to follow instructions with human feedback',
        who: 'Ouyang et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2203.02155',
      },
    ],
    labs: [['/preference-tuning', 'Reward models and PPO']],
  },
  {
    id: 'dpo',
    name: 'Direct preference optimisation',
    stage: 'post-training',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [5, 19],
    what: 'Turn the RLHF objective into a classification loss on preference pairs: raise the probability of the preferred answer relative to the rejected one, measured against a frozen reference model. No reward model and no sampling during training.',
    gain: 'DPO matched or improved on PPO-based RLHF in summarisation and single-turn dialogue, controlled sentiment better, and is much simpler to implement and train.',
    tradeoff:
      'Learns only from a fixed set of pairs, so it cannot explore beyond them, and it can over-fit or drift towards longer answers. Online RL methods still lead where answers can be checked automatically.',
    sources: [
      {
        title: 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model',
        who: 'Rafailov et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2305.18290',
      },
    ],
    labs: [['/preference-tuning', 'DPO']],
  },
  {
    id: 'rlvr-grpo',
    name: 'RL from verifiable rewards (GRPO)',
    stage: 'post-training',
    tags: ['quality'],
    maturity: 'production',
    chapters: [19],
    what: 'Reward the model only when a checker confirms the final answer (a maths result, passing tests). GRPO samples a group of answers per prompt and uses each answer’s reward relative to the group as its advantage, so no value network is needed.',
    gain: 'Pure RL took DeepSeek-R1-Zero from 15.6% to 71.0% pass@1 on AIME 2024, and 86.7% with majority voting. DeepSeek-R1, with a small supervised start, reached 79.8% pass@1. GRPO was introduced with DeepSeekMath as a PPO variant that uses less memory.',
    tradeoff:
      'Only works where answers can be checked. Yue et al. found RL-trained models beat their base models at pass@1 but the base models scored higher at large k, suggesting RL sharpens existing abilities more than it adds new ones. Long rollouts make training slow and expensive.',
    sources: [
      DEEPSEEK_R1,
      {
        title: 'DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models',
        who: 'Shao et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2402.03300',
      },
      RL_LIMITS,
    ],
    labs: [['/reasoning-models', 'GRPO and pass@k']],
  },
  {
    id: 'test-time-compute',
    name: 'Test-time compute (thinking)',
    stage: 'post-training',
    tags: ['quality'],
    maturity: 'production',
    chapters: [8, 19],
    what: 'Let the model spend more tokens on a hard question: a long chain of thought, several attempts, or a search guided by a verifier. Quality is bought per request instead of in training.',
    gain: 'OpenAI reported o1 scoring 74% on AIME 2024 with one sample, 83% with consensus over 64 samples and 93% re-ranking 1,000 samples, against 12% for GPT-4o. Snell et al. found that choosing the test-time strategy per question was over 4× more efficient than best-of-N, and that in a FLOPs-matched comparison a small model with extra test-time compute beat a 14× larger model on problems where it had some success.',
    tradeoff:
      'Each answer costs many more tokens and more waiting. Extra thinking helps little on easy questions or where the base model has no chance; Snell et al.’s 14× result held only on problems where the small model already had some success. Long traces can drift or overthink.',
    sources: [
      O1_BLOG,
      {
        title: 'Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters',
        who: 'Snell et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2408.03314',
      },
    ],
    labs: [['/reasoning-models', 'Thinking budgets']],
  },
  {
    id: 'self-consistency',
    name: 'Self-consistency (majority vote)',
    stage: 'post-training',
    tags: ['quality'],
    maturity: 'production',
    chapters: [9],
    what: 'Sample several chains of thought at a non-zero temperature and take the most common final answer. It is an ensemble drawn from one model.',
    gain: 'Over chain-of-thought prompting with one greedy answer, self-consistency added 17.9 points on GSM8K, 11.0 on SVAMP, 12.2 on AQuA, 6.4 on StrategyQA and 3.9 on ARC-Challenge.',
    tradeoff:
      'Cost grows linearly with the number of samples. It only works where answers can be compared exactly, and it cannot fix a mistake the model makes most of the time.',
    sources: [
      {
        title: 'Self-Consistency Improves Chain of Thought Reasoning in Language Models',
        who: 'Wang et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2203.11171',
      },
    ],
    labs: [['/reasoning-models', 'Majority vote']],
  },

  // ---------------------------------------------------------------- system
  {
    id: 'rag-vs-finetuning',
    name: 'Retrieval against fine-tuning for knowledge',
    stage: 'system',
    tags: ['quality', 'cost'],
    maturity: 'production',
    chapters: [12],
    what: 'To give a model facts it does not know, either retrieve relevant passages at question time and put them in the prompt, or fine-tune the model on the documents.',
    gain: 'Ovadia et al. found that retrieval consistently beat unsupervised fine-tuning for injecting knowledge, both for facts seen in pre-training and for entirely new ones. Models struggled to learn new facts by fine-tuning unless they saw many paraphrases of each.',
    tradeoff:
      'Retrieval adds latency, prompt tokens and a search index to keep up to date, and answers are only as good as what is retrieved. Fine-tuning still suits style, format and behaviour rather than facts.',
    sources: [
      {
        title: 'Fine-Tuning or Retrieval? Comparing Knowledge Injection in LLMs',
        who: 'Ovadia et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2312.05934',
      },
    ],
    labs: [
      ['/embeddings', 'Embeddings and retrieval'],
      ['/context', 'Context and cost'],
    ],
  },
  {
    id: 'routing',
    name: 'Routing and cascades',
    stage: 'system',
    tags: ['cost'],
    maturity: 'production',
    chapters: [5, 8],
    what: 'Send each request to the cheapest model likely to answer it well, using a trained router, or try a cheap model first and escalate when its answer looks unreliable.',
    gain: 'RouteLLM routers cut cost by over 85% on MT Bench, 45% on MMLU and 35% on GSM8K against using GPT-4 alone, while keeping 95% of GPT-4’s performance. FrugalGPT matched GPT-4 with up to 98% lower cost, or beat it by 4% accuracy at the same cost, on the tasks it studied.',
    tradeoff:
      'The router can be wrong, and failures cluster on unusual requests. Savings depend on how many queries are easy, and the router needs retraining as models and prices change. Cascades add latency when they escalate.',
    sources: [
      {
        title: 'RouteLLM: Learning to Route LLMs with Preference Data',
        who: 'Ong et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2406.18665',
      },
      {
        title: 'RouteLLM: An Open-Source Framework for Cost-Effective LLM Routing',
        who: 'LMSYS',
        year: 2024,
        url: 'https://lmsys.org/blog/2024-07-01-routellm/',
      },
      {
        title: 'FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance',
        who: 'Chen et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2305.05176',
      },
    ],
    labs: [['/routing', 'Routing']],
  },
  {
    id: 'tool-use',
    name: 'Tool use',
    stage: 'system',
    tags: ['quality'],
    maturity: 'production',
    chapters: [2, 12],
    what: 'Let the model call a calculator, an interpreter, a search engine or an API and read the result, instead of producing everything from its weights.',
    gain: 'PAL, which has the model write Python and runs it for the answer, beat PaLM-540B with chain-of-thought by 15 points top-1 on GSM8K using Codex. Toolformer taught a GPT-J model to call a calculator, Q&A system, search, translator and calendar with a few examples per API; its zero-shot results were often competitive with much larger models.',
    tradeoff:
      'Every call adds latency and a new failure mode. Tool output is untrusted input that can carry prompt injection, and code execution needs a sandbox. The model must also learn when not to call a tool.',
    sources: [
      {
        title: 'PAL: Program-aided Language Models',
        who: 'Gao et al.',
        year: 2022,
        url: 'https://arxiv.org/abs/2211.10435',
      },
      {
        title: 'Toolformer: Language Models Can Teach Themselves to Use Tools',
        who: 'Schick et al.',
        year: 2023,
        url: 'https://arxiv.org/abs/2302.04761',
      },
    ],
    labs: [['/evals', 'Evals']],
  },
];

export const FRONTIER: Frontier[] = [
  {
    name: 'Scaling reinforcement learning and longer reasoning',
    why: 'Most gains in 2025–2026 came from post-training with RL, not bigger pre-training runs. If RL compute scales as predictably as pre-training did, labs can plan for it rather than discover it.',
    evidence:
      'Shown: a 400,000 GPU-hour study fitted sigmoid-shaped compute-performance curves to RL runs and extrapolated a 100,000 GPU-hour run from smaller ones. DeepSeek-V3.2 spent post-training compute above 10% of its pre-training cost. Unresolved: Yue et al. found base models overtake RL-trained ones at large pass@k, so it is not settled how much RL adds new ability rather than reliability. Speculation: that the curves keep holding at much larger budgets.',
    sources: [
      {
        title: 'The Art of Scaling Reinforcement Learning Compute for LLMs',
        who: 'Khatri et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2510.13786',
      },
      DEEPSEEK_V32,
      RL_LIMITS,
    ],
  },
  {
    name: 'Agentic RL in real environments',
    why: 'Training on multi-step tasks with real tools (shells, repositories, browsers) targets the long tasks people want agents to do, which single-answer RL does not reach.',
    evidence:
      'Shown: multi-turn RL raised Qwen2.5-72B-Instruct from 11% to 39% on SWE-bench Verified. DeepSeek-V3.2 trained on over 1,800 synthesised environments and 85,000 prompts. METR’s January 2026 update puts the doubling time of the task length frontier models can finish at about 131 days for models since 2023 (196 days over 2019–2025). Caveats: METR say their suite is near saturation and recent intervals are wide. Speculation: that this rate continues.',
    sources: [
      {
        title: 'Training Long-Context, Multi-Turn Software Engineering Agents with Reinforcement Learning',
        who: 'Golubev et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2508.03501',
      },
      DEEPSEEK_V32,
      METR_TH11,
    ],
  },
  {
    name: 'Hybrid and sparse attention',
    why: 'Long agent sessions make the KV cache the main serving cost. Layers with a fixed-size state, or attention that reads only chosen tokens, cut that cost.',
    evidence:
      'Shown: Qwen3-Next (3:1 Gated DeltaNet to attention) has over 10× the throughput of Qwen3-32B beyond 32K tokens; Kimi Linear reports up to 6× decoding throughput at 1M tokens; DeepSeek-V3.2 ships learned sparse attention. Against: MiniMax returned to full attention for M2 after hybrids showed deficits in multi-hop reasoning that common benchmarks missed. Open question: whether hybrids match full attention on long agentic tasks.',
    sources: [QWEN3_NEXT, KIMI_LINEAR, DEEPSEEK_V32, MINIMAX_M2],
  },
  {
    name: 'Diffusion language models',
    why: 'They refine many tokens in parallel instead of one at a time, so decoding speed is less tied to memory bandwidth, and they can edit or fill in text in any order.',
    evidence:
      'Shown: Gemini Diffusion samples at 1,479 tokens/s averaged over Google’s evals, scoring above Gemini 2.0 Flash-Lite on LiveCodeBench but well below it on GPQA Diamond (40.4% against 56.5%). DiffusionGemma (26B total, 3.8B active, June 2026) runs up to 4× faster on GPUs, over 1,000 tokens/s on one H100, at low batch sizes, but Google say its quality is lower than standard Gemma 4. LLaDA2.1 (100B) reports 892 tokens/s on HumanEval+. Mercury Coder reports 1,109 tokens/s on H100. Open: whether quality catches up with autoregressive models at the frontier, and whether the speed holds at high serving load.',
    sources: [
      {
        title: 'Gemini Diffusion',
        who: 'Google DeepMind',
        year: 2025,
        url: 'https://deepmind.google/models/gemini-diffusion/',
      },
      {
        title: 'DiffusionGemma: 4x faster text generation',
        who: 'Google',
        year: 2026,
        url: 'https://blog.google/innovation-and-ai/technology/developers-tools/diffusion-gemma-faster-text-generation/',
      },
      {
        title: 'LLaDA2.1: Speeding Up Text Diffusion via Token Editing',
        who: 'Bie et al.',
        year: 2026,
        url: 'https://arxiv.org/abs/2602.08676',
      },
      {
        title: 'Large Language Diffusion Models',
        who: 'Nie et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2502.09992',
      },
      {
        title: 'Mercury: Ultra-Fast Language Models Based on Diffusion',
        who: 'Inception Labs',
        year: 2025,
        url: 'https://arxiv.org/abs/2506.17298',
      },
    ],
  },
  {
    name: 'FP4 training and inference',
    why: 'Each halving of bits roughly halves memory traffic and doubles tensor-core throughput on hardware that supports it, which lowers the cost of both training and serving.',
    evidence:
      'Shown: a 12B model pre-trained on 10T tokens in NVFP4 matched an FP8 baseline; NVFP4 inference on DeepSeek-R1-0528 lost 1 point or less against FP8; gpt-oss shipped MXFP4 weights. Not yet shown in public: FP4 pre-training of a frontier-scale model, or FP4 holding up in long RL runs.',
    sources: [NVFP4_PRETRAIN, NVFP4_INFERENCE, GPT_OSS],
  },
  {
    name: 'Memory and continual learning',
    why: 'Models stop learning when training ends. Updating them with new facts or experience without forgetting old skills would reduce retraining and let agents improve from use.',
    evidence:
      'Shown: sparse memory fine-tuning, which updates only the memory slots a new fact uses, reduced forgetting on NaturalQuestions to an 11% drop, against 89% for full fine-tuning and 71% for LoRA, when learning a stream of TriviaQA facts. Titans adds a neural memory updated at test time and reports scaling past 2M tokens of context. Speculation: that these methods work at frontier scale and in deployed products; so far the evidence is from smaller models and controlled tasks.',
    sources: [
      {
        title: 'Continual Learning via Sparse Memory Finetuning',
        who: 'Lin et al.',
        year: 2025,
        url: 'https://arxiv.org/abs/2510.15103',
      },
      {
        title: 'Titans: Learning to Memorize at Test Time',
        who: 'Behrouz et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2501.00663',
      },
    ],
  },
  {
    name: 'Better evaluation',
    why: 'Every lever on this page is judged by benchmarks. When they leak into training data, saturate, or miss weaknesses, research optimises the wrong thing.',
    evidence:
      'Shown: on GSM1k, a fresh set written to match GSM8K, some models scored up to 8% lower than on GSM8K. In February 2026 OpenAI stopped reporting SWE-bench Verified, citing flawed tests in an audit of hard problems and evidence that models had seen the benchmark in training. MiniMax named evaluation, not architecture, as the main bottleneck for efficient attention. METR say their task suite has few tasks the newest models cannot do. Direction: private, refreshed and task-level evaluations, at a higher cost to run.',
    sources: [
      {
        title: 'A Careful Examination of Large Language Model Performance on Grade School Arithmetic',
        who: 'Zhang et al.',
        year: 2024,
        url: 'https://arxiv.org/abs/2405.00332',
      },
      {
        title: 'Why we no longer evaluate SWE-bench Verified',
        who: 'OpenAI',
        year: 2026,
        url: 'https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/',
      },
      MINIMAX_M2,
      METR_TH11,
    ],
  },
];
