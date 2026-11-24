## Transformer Explainer (`/transformer`)
**In one line:** How a GPT-style decoder turns a prompt into a next-token probability, step by step, from tokens to the sampled token.

**Key terms**
- **Token embedding**: a learned vector per vocabulary id (768 numbers in GPT-2 small) that the model reads instead of the raw id.
- **Positional encoding**: a vector added to each token embedding so the model can tell positions apart; GPT-2 learns one per position (1,024), the 2017 transformer used fixed sinusoids.
- **Self-attention (Q, K, V)**: each token's vector is projected into a query, key and value; the output is softmax(QKᵀ / √d_k) · V, a weighted mix of earlier tokens' values.
- **Multi-head attention**: several attention heads run in parallel on slices of the vector, each free to learn a different pattern, and their outputs are concatenated and projected by W_O.
- **Causal mask**: scores for future positions are set to −∞ before the softmax, so each token only sees itself and earlier tokens.
- **Residual stream**: the running per-token vector that every attention and MLP sub-layer adds to rather than replaces.
- **Pre-norm layer norm**: normalising each token's vector before each sub-layer (GPT-2 onwards), which keeps deep stacks stable to train.
- **Logits and weight tying**: the final hidden state times the transposed embedding matrix gives one score per vocabulary token; GPT-2 reuses the input embedding matrix for this.

**Questions they could ask**
- **Q:** Walk me through one forward pass of a decoder-only transformer.
  **A:** The text is tokenised into ids, each id looks up an embedding and a position vector is added. That goes through N identical blocks, each doing layer norm, masked multi-head self-attention, a residual add, then layer norm, a per-token MLP (768 → 3,072 → 768 with GELU in GPT-2) and another residual add. After a final layer norm, the last position's vector is multiplied by the embedding matrix to give logits over the vocabulary, which softmax turns into next-token probabilities.
- **Q:** Why do we divide attention scores by √d_k?
  **A:** If the query and key components have roughly unit variance, their dot product has variance about d_k, so with 64-dimensional heads the scores spread out by a factor of 8. Large scores push softmax into saturation, where one weight is near 1 and gradients for the rest vanish. Dividing by √d_k keeps the variance near 1 and the softmax trainable.
- **Q:** What is the causal mask for, and why does it matter for training efficiency?
  **A:** It stops position i attending to positions after i, which is what makes left-to-right generation valid. Because every position only sees its past, one forward pass over a 1,024-token sequence gives 1,024 next-token predictions and losses at once, so training is fully parallel even though generation is sequential.
- **Q:** Why does a transformer need position information at all?
  **A:** Without a mask, self-attention is permutation-equivariant: shuffle the tokens and you get the same outputs shuffled, so word order is invisible. Models fix this by adding position vectors (learned or sinusoidal) or, in most current models, by rotating queries and keys with RoPE so scores depend on relative distance. The causal mask does leak some order information, which is why some decoder-only models can be trained with no explicit positions at all.
- **Q:** What do residual connections and layer norm do?
  **A:** Residuals give every layer a direct path for the signal and the gradient, so a 12- or 100-layer stack trains like a series of small edits to one running vector. Layer norm rescales each token's vector to zero mean and unit spread (then a learned scale and shift), so sub-layers see inputs at a steady scale however large the stream grows. Placing it before each sub-layer (pre-norm) removes the need for the careful warm-up post-norm stacks required.

**What I built:** An animated SVG of the whole forward pass that you can hover and zoom into, with step-by-step modals (tokenise, embed, Q/K/V, mask, heads, MLP, logits, temperature, top-k/top-p, sample). It runs three engines in the browser: a tiny untrained 12-layer, 12-head, 48-dimension model blended with an n-gram model, real GPT-2 (124M, via transformers.js) for tokens and probabilities, and a custom 8-bit GPT-2 export that exposes every internal value, including each head's measured habit (first token, previous token, self).

## How LLMs Are Built (`/building`)
**In one line:** The full pipeline from crawled web text to a deployed assistant: data cleaning, pretraining and scaling laws, SFT, preference tuning, evaluation and memory sizing.

**Key terms**
- **Pretraining**: self-supervised next-token training on trillions of tokens of filtered text, producing a base model that continues documents.
- **Near-duplicate removal (MinHash)**: estimating overlap between documents' shingle sets cheaply so near-copies can be dropped at web scale.
- **Scaling laws / Chinchilla**: loss falls as a predictable power law in parameters N and tokens D; for a fixed compute budget the best split is roughly 20 tokens per parameter.
- **Training compute ≈ 6ND**: about 2 FLOPs per parameter per token for the forward pass and 4 for the backward pass.
- **Supervised fine-tuning (SFT)**: next-token training on example conversations, with the loss applied only to the assistant's tokens.
- **Reward model (Bradley–Terry)**: a model scored so that P(A preferred over B) = σ(r(A) − r(B)), trained on human comparisons.
- **Perplexity**: e raised to the average cross-entropy loss (in nats); roughly the number of equally likely tokens the model is choosing between.
- **Training memory, 16 bytes per parameter**: bf16 weights (2) and gradients (2), an fp32 master copy (4) and Adam's two moments (4 + 4).

**Questions they could ask**
- **Q:** How would you estimate the cost of pretraining an 8B model on 15 trillion tokens?
  **A:** Compute is about 6 × 8e9 × 15e12 ≈ 7.2e23 FLOPs. An H100 peaks at about 989 dense BF16 TFLOPS; at 40% utilisation that is about 4e14 FLOP/s, so roughly 500,000 GPU-hours. At an assumed $2.50 per GPU-hour that is around $1.3M, before failed runs, experiments and data work.
- **Q:** What did the Chinchilla result change, and why do teams still train far past 20 tokens per parameter?
  **A:** Chinchilla showed earlier large models were undertrained: for the same compute, a 70B model on 1.4T tokens beat a 280B model on 300B tokens. But 20 tokens per parameter minimises training cost only. Products pay for inference, so it is often cheaper overall to over-train a small model, such as an 8B model on 15T tokens (nearly 2,000 tokens per parameter), which costs more to train but less on every request.
- **Q:** What is the difference between a base model and an instruction-tuned model, and how does SFT work?
  **A:** A base model only continues documents, so an instruction often gets a continuation rather than an answer; you can coax it by framing the prompt as a document, such as a Q&A list. SFT trains on conversations with the same next-token loss, but masks the user's tokens so the model learns to produce answers, not to imitate users. It needs far less data than pretraining, which is why assistant behaviour is a thin layer and unusual inputs can make a model fall back to plain continuation.
- **Q:** Why does the KL penalty appear in RLHF, and how is DPO different?
  **A:** RLHF maximises the reward model's score minus β times the KL divergence from the SFT model, so the policy cannot drift into odd outputs that exploit the reward model's blind spots. DPO skips the separate reward model and RL loop and trains directly on the preference pairs, raising the chosen answer's likelihood relative to a frozen reference and lowering the rejected one's. Both learn whatever the raters rewarded, including biases such as liking long answers.
- **Q:** Why does training need so much more memory than serving?
  **A:** Serving at 16-bit needs about 2 bytes per parameter plus the KV cache. Full training with mixed-precision Adam needs about 16 bytes per parameter plus activations, so a 70B model needs over 1.1 TB just for weights, gradients and optimiser state, spread across many GPUs with ZeRO or FSDP. LoRA freezes the base weights and trains small adapters, which is why fine-tuning can fit on one GPU when full training cannot.

**What I built:** A filter pipeline over thirteen made-up web pages with toggleable steps, a near-duplicate threshold and a quality threshold, drawn as a funnel. A scaling-law and cost calculator using a 2024 re-fit of the Chinchilla loss curve, with GPU peak, utilisation and price inputs; GPT-2 running in the browser to compare an instruction against the same request written as a document; a per-token surprisal view of an SFT example with masked user tokens; a tiny Bradley–Terry reward model trained on the pairs you pick (or a "careful" versus "likes long answers" rater); and a memory calculator for serving, full training, LoRA and QLoRA.

## Training Lab (`/training`)
**In one line:** How a language model learns from text: the training loop, train versus validation loss, overfitting and memorisation, how attention circuits form, and what that means for fine-tuning.

**Key terms**
- **Cross-entropy loss**: minus the log of the probability the model gave to the token that actually came next, averaged over positions.
- **Backpropagation**: the chain rule applied backwards through the network to get the gradient of the loss with respect to every weight.
- **Optimiser (Adam) and learning rate**: Adam steps each weight against its gradient, scaled by running averages of the gradient and its square; the learning rate sets the step size.
- **Validation loss**: loss on held-out text the model never trains on; the number that predicts real-world quality.
- **Overfitting / memorisation**: training loss keeps falling while validation loss rises, because the model stores the training text instead of general patterns.
- **Early stopping**: keeping the weights from the step with the lowest validation loss rather than the last step.
- **Epoch**: one full pass over the training data; many passes over a small dataset invite memorisation.
- **Induction head**: an attention head that finds the earlier occurrence of the current token and copies what followed it, formed with a previous-token head in an earlier layer.

**Questions they could ask**
- **Q:** You start a training run. What should the first loss be, and why check it?
  **A:** An untrained model should be close to uniform, so the loss should be about ln(vocabulary size): ln(65) ≈ 4.2 for a character model, ln(50,257) ≈ 10.8 for GPT-2's vocabulary. A first loss far above that usually means a bug, such as a bad initialisation, mislabelled targets or a data problem, so it is a cheap sanity check before burning compute.
- **Q:** How do you detect and fix overfitting?
  **A:** Watch the gap between training and validation loss: when training keeps falling and validation turns round and climbs, the model is memorising. Fixes are early stopping at the best validation step, more and more varied data, fewer trainable parameters (such as LoRA adapters), fewer epochs, and regularisation such as dropout or weight decay. In my lab the overfitting preset gives a model about 35,000 weights on 1,500 characters, and samples turn into copied passages within a few hundred steps.
- **Q:** What is perplexity and how do you interpret it?
  **A:** Perplexity is e raised to the average cross-entropy loss in nats. A loss of 2 gives a perplexity of about 7.4, meaning the model is as unsure as if it were choosing evenly among about 7 options. It is only comparable between models that share a tokenizer and test set, because it is measured per token.
- **Q:** When would you fine-tune rather than use prompting or RAG?
  **A:** Start with prompting; add retrieval when the model needs private, recent or citable facts. Fine-tune when prompting already works but you need more consistent format, tone or a classification scheme, or a smaller model doing one narrow task cheaply at volume. Fine-tuning teaches repeated patterns well and facts poorly, facts learned that way cannot be cited or easily removed, and training data can come back out, so clean secrets and personal data first.
- **Q:** What is an induction head and why can't a one-layer transformer form one?
  **A:** It is a two-head circuit: a previous-token head in layer 1 writes "the token before me was X" into each position, and a head in layer 2 searches for keys carrying that information to find where the current token appeared before, then copies the next token. In one layer, keys only know their own token and position, so the information needed to find "the position after the earlier copy" does not exist yet. These heads form in a sudden drop in loss and are thought to account for much of in-context learning.

**What I built:** A character-level language model (embeddings, one hidden layer, softmax, Adam) trained live in plain JavaScript on Austen, FAQ answers, Python or your own text, with training and validation loss charts, perplexity, epochs, fixed-seed samples every few hundred steps and a memorisation meter that highlights 20-character stretches copied from the training text. A second section trains a tiny transformer (32-dimensional tokens, 16-token context, 1–2 layers and heads) with hand-written backpropagation checked against finite differences, and shows the previous-token and induction scores and attention grids as the circuit forms.

## Tokens Lab (`/tokens`)
**In one line:** Models read tokens from a fixed vocabulary, not words or characters, and that drives cost, context limits and some odd failures.

**Key terms**
- **Token**: a piece of text from the model's fixed vocabulary, often a sub-word, that the model reads and generates one at a time.
- **Byte-pair encoding (BPE)**: a tokenizer built by starting from bytes and repeatedly merging the most frequent adjacent pair until the vocabulary reaches a target size.
- **Vocabulary and token id**: the fixed list of tokens (50,257 for GPT-2) and the integer index each one maps to.
- **Characters per token**: about 4 for English prose; code, numbers, rare words and non-English text take more tokens for the same length.
- **Context window**: the maximum number of tokens one request can hold, shared by the system prompt, tools, history, retrieved text and the reserved output.
- **max_tokens**: the cap on tokens the model may generate, which also reserves that room in the context window.
- **Token counting endpoint**: a provider API that counts tokens with the model's own tokenizer, the only reliable count for billing.

**Questions they could ask**
- **Q:** Why do LLMs struggle to count the letters in a word or reverse a string?
  **A:** The model never sees letters: a word like "strawberry" arrives as a couple of sub-word tokens, so the individual characters are not directly in its input. It can only know the spelling of a token if training happened to teach it. Character-level work, exact string manipulation and long arithmetic should go to a tool call.
- **Q:** How does BPE work, and why do tokenizers include a leading space in tokens?
  **A:** Byte-level BPE starts with the 256 byte values and repeatedly merges the most frequent adjacent pair in the training corpus; GPT-2's vocabulary is 256 bytes plus 50,000 merges plus an end-of-text token. Frequent words become single tokens and rare ones split into pieces, and any text can be encoded because bytes are the fallback. A word mid-sentence usually appears after a space, so " the" with its space is the common unit and gets its own token.
- **Q:** How would you reduce the token cost of sending bulk structured data?
  **A:** Measure, then pick a compact format: minified JSON or CSV can carry the same records in far fewer tokens than pretty-printed JSON, because indentation and repeated keys cost tokens. Output tokens are typically priced several times higher than input (5× on current Claude models), so asking for shorter answers is often the biggest saving. Check the model can still read the structure reliably after compacting.
- **Q:** Can you use one model's tokenizer to estimate another model's costs?
  **A:** Only roughly. Every model family has its own vocabulary, and counts can differ a lot on code and non-English text, so a third-party tokenizer can undercount. Use the provider's own token counting endpoint for budgeting.
- **Q:** How do you plan a context budget for a RAG or agent request?
  **A:** Add up the system prompt, tool definitions, conversation history and retrieved passages, then reserve output room with max_tokens, and keep the total under the model's input limit with headroom. History and tool results grow every turn, so you need a policy for trimming, summarising or dropping old turns. Long prompts also cost more on every call and add latency.

**What I built:** A playground running GPT-2's real BPE tokenizer in the browser, showing each token with its id, leading spaces and the characters-per-token ratio; a table of six formats of the same six employee records with their token counts; examples showing why spelling and arithmetic are hard; and a context-budget calculator. The lesson script `python/01_count_tokens.py` counts tokens through Claude's count_tokens endpoint.

## Sampling Lab (`/sampling`)
**In one line:** The model only outputs a probability for every next token; decoding settings decide which one you get.

**Key terms**
- **Logits**: the raw, unnormalised scores the model produces for every token in the vocabulary.
- **Softmax**: turns logits into probabilities, p_i = exp(z_i) / Σ exp(z_j).
- **Temperature**: divides the logits by T before the softmax; T < 1 sharpens the distribution, T > 1 flattens it, and T → 0 becomes greedy.
- **Greedy decoding**: always picking the single most likely token.
- **Top-k**: keep only the k most likely tokens, renormalise and sample.
- **Top-p (nucleus)**: keep the smallest set of tokens whose probabilities add up to p, renormalise and sample, so the set shrinks when the model is confident.
- **Repetition penalty**: lowers the scores of tokens already generated, to break loops.
- **Self-consistency**: sample several answers to the same question and take the majority answer.

**Questions they could ask**
- **Q:** What does temperature do mathematically? Give an example.
  **A:** It divides every logit by T before the softmax, so p_i ∝ exp(z_i / T). With two logits of 2 and 1, T = 1 gives 73% and 27%; T = 0.5 doubles the gap and gives 88% and 12%; T = 2 halves it and gives 62% and 38%. It never changes the ranking, only how much the favourite dominates.
- **Q:** Top-k or top-p: what is the difference and which would you choose?
  **A:** Top-k keeps a fixed number of candidates, say 40, whether the model is sure or not, so it can keep junk when the model is confident and cut good options when it is uncertain. Top-p 0.9 keeps the smallest set whose probabilities add up to 0.9, which might be 2 tokens after "The capital of France is" and hundreds in an open creative sentence. Top-p adapts better; change one knob at a time, because temperature and top-p both widen or narrow the choice.
- **Q:** You set temperature to 0 on a hosted API and still get different outputs. Why?
  **A:** Greedy is close to repeatable, not guaranteed. Floating-point addition is not associative, and servers batch your request with others, so kernels can sum in a different order and flip a near-tie between two tokens; once one token differs, the rest of the text diverges. Mixture-of-experts routing and changes on the provider's side add more variation, so design and test for some variance.
- **Q:** What settings would you start from for extraction versus brainstorming?
  **A:** For extraction, classification and code edits, greedy or temperature 0 to 0.3, because you want the single most likely answer. For a chat assistant, around 0.5–0.8 with top-p 0.9; for brainstorming, 0.9–1.2 with top-p 0.95, and review the output. Some newer models restrict or ignore sampling parameters, and there you steer with instructions, examples, structured outputs and the reasoning effort setting instead.
- **Q:** What is self-consistency and when does it help?
  **A:** Ask the same question several times at a moderate temperature, often 5 to 10 samples, and take the most common final answer. It helps when the right answer is the single most likely one and errors are scattered, as in maths word problems. It costs k times as much, and it fails when the model's errors are correlated and agree on the same wrong answer.

**What I built:** GPT-2 running in the browser generates from the same prompt under three side-by-side setting cards (presets or custom temperature, top-k, top-p and repetition penalty), several samples each with an optional fixed seed. Each token is coloured by the model's confidence and shows the alternatives it beat on hover, and each card reports average confidence, diversity (unique word pairs) and loops (repeated three-token phrases). The lesson script `python/02_self_consistency.py` majority-votes five Claude answers.

## Machine Learning Algorithms (`/ml`)
**In one line:** Seventeen classic and modern ML algorithms running live, with when to use each and where they turn up inside today's AI systems.

**Key terms**
- **Supervised vs unsupervised learning**: learning from labelled examples to predict a target, versus finding structure (groups, directions, anomalies) in unlabelled data.
- **Held-out (test) accuracy**: performance on data the model did not train on; a large gap to training accuracy means memorising.
- **Logistic regression**: a linear model whose score goes through a sigmoid (or softmax for many classes) to give class probabilities.
- **Random forest**: many decision trees trained on bootstrap samples and random feature subsets, averaged to cut variance.
- **Gradient boosting**: trees added one at a time, each fitting the errors of the ensemble so far, usually the strongest choice on tabular data.
- **Support vector machine**: finds the boundary with the widest margin between classes; kernels let it draw curved boundaries.
- **k-means**: assigns points to the nearest of k centres and moves each centre to the mean of its points, repeating until stable.
- **Principal component analysis (PCA)**: projects data onto the few directions of greatest variance to compress or visualise it.

**Questions they could ask**
- **Q:** You get a spreadsheet-style dataset and a classification problem. What do you try first?
  **A:** A quick baseline such as logistic regression, then gradient-boosted trees (for example a histogram gradient-boosting classifier), which usually win on tabular data with little tuning. Compare on a held-out split or with cross-validation, and keep the simple model as a baseline to judge whether anything fancier earns its cost. Deep networks rarely beat boosted trees on small tabular datasets.
- **Q:** What is the difference between bagging and boosting?
  **A:** Bagging, as in random forests, trains many deep trees independently on bootstrap samples and averages them, which mainly reduces variance. Boosting trains shallow trees sequentially, each correcting the current ensemble's errors, which mainly reduces bias. Boosting needs a learning rate and early stopping, because adding rounds eventually overfits.
- **Q:** How do you choose k in k-means, and when would you use something else?
  **A:** Plot the total squared distance to the nearest centre for each k and look for the elbow, or use a silhouette score, then check the clusters make sense for the business. k-means assumes roughly round, similar-sized clusters and assigns every point to one. For odd shapes or noisy data, DBSCAN finds dense regions of any shape and labels outliers; hierarchical clustering gives a tree you can cut at any level.
- **Q:** Where does classic ML show up inside LLM systems?
  **A:** Retrieval is approximate nearest-neighbour search over embeddings, and IVF-style vector indexes use k-means to partition the space. Routers and guardrails are often small classifiers, and an LLM's final layer is a softmax (multinomial logistic) regression over the vocabulary. For a fixed label set with plenty of examples, a small classifier is cheaper, faster and easier to test than an LLM.

**What I built:** All seventeen algorithms (from linear regression and trees through k-means, DBSCAN, PCA and autoencoders to CNN, RNN and transformer) run in the browser on toy 2D datasets such as two moons, circles, XOR and spirals, shading decision regions and reporting training versus held-out accuracy. Extras include accuracy by boosting round, a k-means elbow chart and an RNN chart of how fast an early input's influence vanishes, plus a four-question picker that shortlists algorithms.

## LLM Course (`/course`)
**In one line:** A lecture-by-lecture path through the lab that follows Stanford's CME 295 (Transformers and Large Language Models), from what a GPT is to agents and evaluation.

**Key terms**
- **Decoder-only transformer**: a single stack of causally masked attention layers that predicts the next token; the architecture of GPT-style models.
- **Pre-training and post-training**: self-supervised next-token training on huge text, followed by SFT and preference or RL tuning that turn the base model into an assistant.
- **RLHF and DPO**: tuning on human comparisons, either through a reward model and RL with a KL penalty, or directly with a supervised loss on the pairs.
- **RL with verifiable rewards (RLVR)**: reinforcement learning where the reward comes from a checker, such as unit tests or a known maths answer, used to train reasoning models.
- **Test-time compute**: spending more computation when answering, by thinking longer or sampling several answers and choosing one.
- **Retrieval-augmented generation (RAG)**: retrieving relevant passages at request time and adding them to the prompt so the model answers from them.
- **LLM-as-a-judge**: using a model to grade outputs against a rubric, calibrated against human labels.
- **Benchmark contamination**: test items leaking into training data, which inflates scores.

**Questions they could ask**
- **Q:** Walk me through how a chat model goes from raw data to production.
  **A:** Collect and filter web-scale text (deduplication, language and quality classifiers), then pretrain a decoder-only transformer to predict the next token, sized with scaling laws. Post-train with SFT on example conversations, then preference tuning (RLHF or DPO), and for reasoning models RL with verifiable rewards. Evaluate on benchmarks, head-to-head comparisons and task-specific test sets, then serve with a KV cache, batching, quantisation and often speculative decoding.
- **Q:** How would you evaluate an LLM feature before shipping it?
  **A:** Build a test set from production-like inputs first, with expected outputs or rubrics. Use code-based graders where possible (exact match, schema checks, unit tests) and an LLM judge for open-ended quality, checked against a sample of human labels. Run each case several times because outputs vary, report confidence intervals, and keep it in CI so prompt or model changes cannot regress silently.
- **Q:** What is benchmark contamination and how do you guard against it?
  **A:** It is when benchmark questions or answers appear in training data, so the model recalls rather than solves. Signs are a much higher score on the original items than on paraphrased or freshly written equivalents. Guard against it with n-gram overlap checks, canary strings, private held-out sets and evaluating on data created after the model's training cutoff.
- **Q:** When do you use RAG, fine-tuning or an agent with tools?
  **A:** RAG when the model needs facts it lacks, especially private, recent or citable ones. Fine-tuning when you need consistent behaviour, format or a cheaper specialised model, not new knowledge. Tools and an agent loop when the task needs actions or exact computation, such as querying a database or running code; MCP is an open protocol for exposing such tools and data to models through standard servers.

**What I built:** A static curriculum page driven by a typed list of lectures (0 to 8), each with its topics and links to the labs that teach it in order, with newer labs marked. Lecture 0 is a popular "What is a GPT?" explainer; there is no live model call on this page.

## What Is GPT (`/what-is-gpt`)
**In one line:** What a generative pre-trained transformer is, made hands-on with live next-token predictions, and corrected where a popular explainer gets it wrong.

**Key terms**
- **GPT (generative pre-trained transformer)**: a decoder-only transformer pre-trained to predict the next token, then generating text one token at a time.
- **Next-token prediction**: given the text so far, output a probability for every possible next token, pick one, append it and repeat.
- **Self-supervised learning**: training where the label comes from the data itself; here the label is simply the next token.
- **Decoder-only**: each token attends only to earlier tokens, which suits generation (GPT, Claude, Llama).
- **Encoder-only**: tokens attend in both directions, which suits classification and embeddings (BERT).
- **Encoder–decoder**: an encoder reads the whole input and a decoder writes the output while attending to it (the 2017 transformer, T5).
- **In-context (few-shot) learning**: learning a task from examples in the prompt without changing the weights, which became striking at GPT-3's scale.

**Questions they could ask**
- **Q:** What is the difference between decoder-only, encoder-only and encoder–decoder transformers?
  **A:** Encoder-only models like BERT let every token see every other token, which gives strong representations for classification and search embeddings but no natural way to generate. Encoder–decoders like T5 read the whole input bidirectionally and then generate an output, a good fit for translation and summarisation. Decoder-only models use a causal mask so each token sees only the past; that one objective scales well and covers generation, which is why GPT-style models dominate.
- **Q:** Why is pre-training called self-supervised rather than unsupervised?
  **A:** Nobody labels the data, but every position still has an exact target: the token that came next. One sentence like "The cat sat on the mat" gives five training examples ("The" → "cat", "The cat" → "sat", and so on). That makes it supervised learning with labels the data supplies itself.
- **Q:** How does the model know that "cloud" means weather in one sentence and computing in another?
  **A:** The token embedding for "cloud" is the same in both cases. Attention layers then update each token's vector using the tokens around it, so after a few layers "cloud" next to "sky" and "cloud" next to "server" have quite different representations. That is why the next-token predictions differ, which the page shows live with GPT-2.
- **Q:** Give a short history of the GPT line and what changed at each step.
  **A:** GPT-1 (2018, about 117M parameters) showed that pre-training a decoder and then fine-tuning works. GPT-2 (2019, up to 1.5B, 40 GB of web text) wrote coherent paragraphs, and GPT-3 (2020, 175B) learned tasks from a few examples in the prompt. InstructGPT and ChatGPT (2022) added instruction tuning and RLHF, turning a text predictor into an assistant, and later models added images, audio and reasoning before answering.
- **Q:** If chatbots predict the most likely token, why does the same question get different answers?
  **A:** Chat products usually sample from the probabilities, with a temperature and top-p, rather than always taking the top token. Greedy decoding is more repeatable but tends to be dull and can loop. Small numerical differences on servers also add variation even at low temperature.

**What I built:** GPT-2 running in the browser shows its top eight next tokens with probabilities as you type; you can click one to append it or repeat the top choice twelve times. It also shows token ids, the "cloud in the sky" versus "cloud server" top-five comparison, a causal-mask grid, a timeline from 2017 to today, the challenges each linked to a lab, and a list of corrections to the source explainer (GPT-1's size, decoder-only, self-supervised).

## Transformer Tricks (`/transformer-tricks`)
**In one line:** The improvements on the 2017 transformer that current models rely on: RoPE, RMSNorm, grouped-query attention, sliding windows, FlashAttention, mixture of experts and speculative decoding.

**Key terms**
- **RoPE (rotary position embedding)**: rotates each pair of query and key dimensions by position × frequency, so their dot product depends only on the distance between tokens.
- **RMSNorm**: divides a vector by its root mean square without subtracting the mean; cheaper than LayerNorm and just as good in practice.
- **KV cache**: stored keys and values of all earlier tokens, so each new token only computes its own.
- **Grouped-query attention (GQA)**: several query heads share one key/value head, shrinking the KV cache with little quality loss (multi-query is the extreme of one shared head).
- **Sliding-window attention**: each token attends only to the last W tokens, so cost and cache grow linearly with length.
- **FlashAttention**: computes exact attention in tiles in on-chip memory with an online softmax, never writing the N × N score matrix to main memory.
- **Mixture of experts (MoE)**: many feed-forward experts with a router that sends each token to the top k, so total parameters grow without growing compute per token.
- **Speculative decoding**: a small draft model proposes k tokens and the big model checks them in one pass, keeping the output distribution unchanged.

**Questions they could ask**
- **Q:** How big is the KV cache for an 8B model at 128K context, and how does GQA help?
  **A:** Per token it is 2 (keys and values) × layers × KV heads × head dimension × bytes. For a Llama 3.1 8B shape (32 layers, 8 KV heads, head dimension 128, 16-bit) that is 128 KiB per token, so about 16 GiB for 131,072 tokens, as much as the weights. With full multi-head attention (32 KV heads) it would be 64 GiB; GQA cuts it by four, which directly raises how many users or how long a context one GPU can serve.
- **Q:** How does RoPE encode position, and how do models extend their context after training?
  **A:** RoPE rotates each two-dimensional slice of the query and key by an angle of position × θ_i, with frequencies from 1 down to about 1/10,000. Rotating both and taking the dot product leaves only the angle difference, so scores depend on relative distance. Fast-turning pairs separate near neighbours and slow ones carry long range; context extension methods such as position interpolation or NTK/YaRN scaling stretch these frequencies and then fine-tune briefly on long text.
- **Q:** Is FlashAttention an approximation? Why is it faster?
  **A:** It is exact. Standard attention writes an N × N score matrix to HBM and reads it back; at 32K tokens that is 2 GiB per head per layer in 16-bit. FlashAttention tiles Q, K and V into on-chip SRAM and uses an online softmax that keeps a running max and sum, rescaling earlier partial sums when the max rises. It does the same maths in a better order, so memory is linear in sequence length and it is faster because it moves far less data.
- **Q:** What are the trade-offs of mixture of experts?
  **A:** Memory scales with total parameters but compute per token scales with active parameters: Mixtral 8x7B has 46.7B total and about 12.9B active (top 2 of 8); DeepSeek-V3 has 671B total and 37B active. So it generates about as fast as a dense model of its active size but needs the memory of its full size. Routers tend to collapse onto a few experts, so training adds a load-balancing loss or, as in DeepSeek-V3, a bias adjustment; otherwise the busiest expert sets the pace.
- **Q:** How does speculative decoding speed things up without changing the output?
  **A:** Decoding is memory-bound, so checking k drafted tokens in one big-model pass costs about the same as generating one. Each draft token x is accepted with probability min(1, p(x)/q(x)), and on rejection you sample from the normalised max(0, p − q), which makes the output exactly the big model's distribution. With acceptance rate α the expected tokens per pass are (1 − α^(k+1)) / (1 − α); α = 0.8 and k = 4 gives about 3.4.

**What I built:** Seven live React demos with seeded numbers: RoPE scores that stay flat as you move a pair with a fixed gap; an editable vector through LayerNorm and RMSNorm plus pre-norm versus post-norm; a KV-cache calculator on real model shapes with an adjustable number of KV heads; a sliding-window mask with global tokens and a reach calculator; an online-softmax table that matches the ordinary softmax block by block; an MoE router load simulation over 1,000 tokens with optional bias balancing; and a speculative decoding simulator that checks the acceptance rule on 40,000 samples. A table summarises which models use which tricks.

## Training at Scale (`/training-at-scale`)
**In one line:** What changes when a model is too big for one GPU: LoRA and QLoRA, training memory, mixed precision, checkpointing and data, tensor and pipeline parallelism with ZeRO.

**Key terms**
- **LoRA**: freezes the pretrained matrix W and learns a low-rank update B·A beside it, so a d × d matrix trains only 2·d·r weights.
- **QLoRA**: LoRA on a base model stored in 4-bit, with adapters trained in 16-bit, so very large models fit on one or two GPUs.
- **Mixed precision (BF16)**: running most maths in 16-bit with an fp32 master copy of the weights; BF16 keeps FP32's 8-bit exponent range, so it needs no loss scaling, unlike FP16 (max 65,504).
- **Activation checkpointing**: keeping only each layer's input and recomputing the rest in the backward pass, trading about a third more compute for much less activation memory.
- **Data parallelism**: each GPU holds a full model copy and trains on different examples, with gradients averaged by an all-reduce.
- **ZeRO / FSDP**: sharding optimiser state (stage 1), gradients (stage 2) and weights (stage 3, which is what FSDP does) across data-parallel GPUs.
- **Tensor parallelism**: splitting each layer's matrices across GPUs; heavy communication, so it stays inside one NVLink server.
- **Pipeline parallelism and the bubble**: splitting layers into stages on different GPUs; idle time is (p − 1)/(m + p − 1) for p stages and m micro-batches.

**Questions they could ask**
- **Q:** How much GPU memory do you need to fully fine-tune a 70B model, and what are the alternatives?
  **A:** Mixed-precision Adam needs about 16 bytes per parameter, so 70.6B × 16 ≈ 1.13 TB before activations, which means at least 15 80 GB GPUs with ZeRO-3 or FSDP. LoRA keeps a frozen 16-bit base (about 141 GB) and trains only adapters, and QLoRA shrinks the frozen base to about 35 GB at 4-bit. For most adaptation tasks LoRA or QLoRA gets close to full fine-tuning at a fraction of the cost.
- **Q:** Explain LoRA. Why does it work and what does it cost at inference?
  **A:** You replace W with W + B·A, where B is d × r and A is r × d, initialise B to zero so training starts from the original model, and train only A and B. For a 4,096 × 4,096 projection at r = 16 that is 131,072 trainable weights instead of 16.8M, under 1%. It works because the change fine-tuning needs is usually low-rank; after training you can merge B·A into W for zero extra latency, or keep adapters separate and swap them per customer on one base model.
- **Q:** What are the ZeRO stages?
  **A:** Plain data parallelism replicates weights, gradients and optimiser state on every GPU. ZeRO stage 1 shards the optimiser state (the largest part, 12 bytes per parameter with Adam), stage 2 also shards gradients, and stage 3 also shards the weights, gathering each layer just before it is used. Stage 3 saves the most memory at the cost of more communication; PyTorch FSDP is the same idea.
- **Q:** How would you combine tensor, pipeline and data parallelism for a large run?
  **A:** Tensor parallelism moves the most data, combining partial results several times per layer, so keep it inside one server on NVLink, usually up to 8 GPUs. Pipeline parallelism passes only activations between stages, so it can cross servers. Data parallelism (with ZeRO or FSDP) wraps around both for throughput, with its gradient all-reduce overlapped with the backward pass.
- **Q:** What is the pipeline bubble and how do you shrink it?
  **A:** In a pipeline, later stages wait for the first micro-batch to arrive and earlier stages wait in the backward pass, so GPUs sit idle. The idle share is (p − 1)/(m + p − 1); with 4 stages and 16 micro-batches that is 3/19, about 16%. Using at least four times as many micro-batches as stages keeps it under about 20%. One-forward-one-backward schedules limit the activations each stage holds, and interleaved schedules shrink the bubble further.

**What I built:** A LoRA parameter calculator on Llama 3.1 shapes (query/value or all four projections, rank 1 to 128), and a live Adam training run in the browser where rank 1, 2 and 4 adapters learn a rank-2 32 × 32 update, showing rank 1 stalling at the Eckart–Young floor of 4. It also has stacked memory bars for inference, full fine-tuning, LoRA and QLoRA, a run planner with ZeRO stage, per-GPU memory and rough communication per step, a GPipe timeline that shows the bubble, and a table of FP32, FP16, BF16 and FP8 formats.

## Preference Tuning (`/preference-tuning`)
**In one line:** How a model is tuned towards answers people prefer, with a reward model, PPO and DPO, and how it goes wrong through reward hacking.

**Key terms**
- **Preference data**: pairs of answers to the same prompt with a label saying which one a person (or model) preferred.
- **Reward model (Bradley–Terry)**: learns a score r so that P(A preferred over B) = σ(r(A) − r(B)).
- **Policy and reference model**: the model being tuned, and a frozen copy of the SFT model it started from.
- **KL penalty (β)**: a cost for drifting away from the reference model's distribution, subtracted from the reward.
- **PPO clipped objective**: maximise min(r·A, clip(r, 1−ε, 1+ε)·A), where r is the new-to-old probability ratio and A the advantage, so each update stays small.
- **Advantage**: how much better an answer did than expected, positive to make it more likely and negative to make it less likely.
- **Reward hacking**: the policy raises the reward model's score by exploiting its flaws while true quality falls.
- **DPO (Direct Preference Optimisation)**: trains the policy directly on preference pairs with −log σ(β[(log π(y_w) − log π_ref(y_w)) − (log π(y_l) − log π_ref(y_l))]).

**Questions they could ask**
- **Q:** Walk me through RLHF.
  **A:** Start from an SFT model. Sample pairs of answers to prompts and have people pick the better one, then train a reward model on those comparisons with a Bradley–Terry loss. Finally optimise the policy with PPO to maximise the reward model's score minus β times the KL divergence from the frozen SFT model. In memory that is usually four models: policy, reference, reward model and a value model.
- **Q:** Why do you need the KL penalty?
  **A:** The reward model is only a proxy trained on a limited set of answers, and optimising a proxy hard finds its blind spots. Without the penalty the policy drifts into outputs the reward model overrates, such as padded answers, and true quality falls while the reward keeps rising. β is the leash: too loose and it hacks, too tight and it barely improves.
- **Q:** What does PPO's clipping do?
  **A:** PPO reuses answers sampled from the previous policy, so it weights each by the ratio r = π_new / π_old. Clipping the ratio to [1 − ε, 1 + ε] (ε is often 0.2) flattens the objective once an answer has become sufficiently more likely (if good) or less likely (if bad). That stops one batch pushing the policy far into regions its old samples say nothing about, which keeps training stable.
- **Q:** DPO or RLHF with PPO: which would you choose and why?
  **A:** DPO needs only preference pairs, a policy and a reference model, and trains like supervised fine-tuning, so it is cheaper, steadier and widely used for open models. PPO-based RLHF learns from fresh answers the model generates during training and the reward model can score new outputs, which helps when you have an online reward, but it is expensive and fiddly. Neither fixes bad data: both learn the raters' biases, such as a liking for length.
- **Q:** How would you detect reward hacking or rater bias?
  **A:** Track a separate, trusted quality measure alongside the reward, such as a held-out human evaluation or a strong judge, and watch for reward rising while quality stalls or falls. Check simple correlates of the reward, like answer length; length-controlled win rates exist for exactly this reason. Inspect samples from the tuned model, and audit the preference data for systematic biases before training.

**What I built:** A seeded toy world where eight candidate answers are described by correctness, helpfulness and length, and 600 labelled pairs come from raters with an adjustable hidden liking for length. A logistic reward model trains on 450 pairs and is tested on 150; PPO's clipped objective is plotted with an ε slider; exact policy-gradient tuning with a β slider shows the reward rising while hidden true quality peaks and falls; and DPO on 200 comparisons is compared with RLHF at the same β.

## Reasoning Models (`/reasoning-models`)
**In one line:** How reasoning models think before answering, how RL with checkable rewards (GRPO) trains them, how a weak checker gets gamed, and when extra thinking or samples are worth the cost.

**Key terms**
- **Thinking tokens**: intermediate working the model writes before its answer; billed as output tokens and adding latency.
- **Test-time compute**: spending more compute at answer time, by thinking longer or sampling several answers and picking one.
- **RL with verifiable rewards (RLVR)**: reinforcement learning where the reward comes from a checker, such as a known maths answer or unit tests, instead of a learned reward model.
- **GRPO (Group Relative Policy Optimisation)**: samples a group of answers per problem and uses advantage = (reward − group mean) / group standard deviation, with no value model.
- **REINFORCE baseline**: subtracting an expected reward from each reward to reduce gradient variance; GRPO's group mean is such a baseline.
- **pass@k**: the probability that at least one of k sampled answers is correct, which is what you get if a checker can pick.
- **Majority vote (self-consistency)**: taking the most common answer across k samples, with no checker needed.
- **Reasoning effort / thinking budget**: an API setting that controls how much the model thinks before answering.

**Questions they could ask**
- **Q:** How are reasoning models trained differently from a standard chat model?
  **A:** On top of pre-training and instruction tuning, they get reinforcement learning on problems whose answers can be checked automatically, such as maths with known answers and code with tests. The reward is whether the final answer is right, so the model learns whatever intermediate reasoning reaches right answers, including checking and retrying. Algorithms such as GRPO, introduced with DeepSeekMath and used for DeepSeek-R1, make this cheap enough to run at scale.
- **Q:** How does GRPO differ from PPO, and what is its weakness?
  **A:** PPO needs a learned value model to estimate each answer's advantage. GRPO samples a group of, say, 8 answers to the same problem and normalises each reward against the group's mean and standard deviation, so the group is its own baseline and no value model is needed. The weakness is that when every answer in a group is right or every one is wrong, all advantages are zero and that problem teaches nothing, so learning slows at both ends; larger groups or filtering for problems of medium difficulty help.
- **Q:** What is the difference between pass@k and majority voting, and when does voting fail?
  **A:** pass@k = 1 − (1 − p)^k assumes a checker picks any right answer, so with p = 0.3 and k = 10 it reaches about 97%. Majority voting needs no checker but only converges on the right answer if it is the single most likely answer; with p = 0.2 and one common wrong answer at 0.8, more samples make it worse. Real models' errors are correlated, which weakens voting further; for benchmarks, pass@k is usually estimated from n samples with the unbiased formula 1 − C(n−c, k)/C(n, k).
- **Q:** How can RL with verifiable rewards go wrong?
  **A:** The policy optimises the check, not your intention. If a coding reward only runs the visible tests, hard-coding their expected outputs earns the same reward as a real solution, so the reward hits 100% while the real pass rate does not improve. Hidden tests on new inputs, property-based tests and human review of samples catch it, and the same applies to any retry loop you build against a checker.
- **Q:** How do you decide how much reasoning effort to use in production?
  **A:** Build an evaluation set and run it at two or three effort levels, then pick the cheapest level that holds quality. Look-ups, extraction, rewriting and chat gain almost nothing from extra thinking, while multi-step maths, code and planning gain a lot until returns diminish. Thinking tokens are billed as output and add seconds of latency, so the trade-off is task-specific.

**What I built:** A toy GRPO trainer runs live in the browser (four problem types with four strategies each, the right one starting at 12%), averaging five seeded runs, with group size, learning rate and KL β controls, an optional REINFORCE comparison and a chart of groups with no learning signal. It also has a reward-hacking demo with a weak checker (visible tests only) against a strong one (hidden tests), an exact pass@k versus majority-vote calculator, and an illustrative thinking-budget chart for three kinds of task.

## Images as Tokens (`/vision`)
**In one line:** How a Vision Transformer turns an image into a sequence of tokens that the same transformer machinery, and a multimodal LLM, can read.

**Key terms**
- **Vision Transformer (ViT)**: a transformer that reads an image as a sequence of patch tokens instead of using convolutions.
- **Patch**: a small square of the image, typically 16 × 16 pixels; a 224 × 224 image gives 14 × 14 = 196 patches.
- **Patch embedding**: flattening a patch to 16 × 16 × 3 = 768 numbers and multiplying by a learned matrix to get one token vector.
- **2D position embedding**: a vector added to each patch token so the model knows its row and column.
- **Inductive bias**: built-in assumptions; a CNN assumes nearby pixels belong together, a ViT does not and must learn it from data.
- **Multimodal sequence**: image tokens and text tokens placed in one sequence so the model predicts the next text token conditioned on both.
- **Image token cost**: images are billed as tokens; for Claude roughly width × height ÷ 750.

**Questions they could ask**
- **Q:** How does a ViT turn an image into tokens?
  **A:** It cuts the image into fixed-size patches, for example 16 × 16 pixels, so 224 × 224 gives 196 patches. Each patch is flattened into 768 numbers (16 × 16 × 3 colour channels) and linearly projected to the model width, 768 for ViT-Base, and a position embedding is added. From there it is an ordinary transformer encoder; the original ViT also prepends a learned class token whose output is used for classification.
- **Q:** Why did ViT need so much more data than a CNN?
  **A:** A CNN's convolutions build in locality and translation equivariance, which is usually true of images, so it learns well from fewer pictures. A ViT starts with no such assumption: every patch can attend to every other from the first layer, so it has to learn locality from data. That costs more data at small scale but pays off at large scale; the original ViT was pre-trained on hundreds of millions of images.
- **Q:** How does a multimodal LLM combine images with text?
  **A:** A vision encoder, often a ViT, turns the image into patch embeddings, and a small projection or adapter maps them into the language model's embedding space. Those image tokens are placed in the same sequence as the text tokens, and the decoder predicts the next text token as usual. So "what is in this picture?" becomes the same next-token problem.
- **Q:** How would you control the cost of sending images to a model?
  **A:** Image tokens are billed like text and count against the context. For Claude the count is roughly width × height ÷ 750, so a 1,000 × 1,000 image is about 1,300 tokens; other providers tile the image at high detail or use a small fixed view at low detail. Resize or crop to the smallest size that still shows what matters, and very large images are downscaled by the provider anyway.

**What I built:** A canvas pipeline that works on real pixels from a sample scene or your own upload at 64 × 64 or 224 × 224: click a patch to see its flattened RGB values, a fixed random projection to an embedding, sine/cosine 2D position similarity, an attention stand-in based on colour and texture similarity, and a CNN 3 × 3 receptive-field overlay for contrast. It ends with the image and text tokens in one sequence and a table of measured token counts for Claude and a GPT deployment at four image sizes.

## Hardware for AI (`/hardware`)
**In one line:** Which processor fits which AI job, and the two ideas that decide it: how much maths runs in parallel and how fast weights can be read from memory.

**Key terms**
- **Memory bandwidth (HBM)**: how many bytes per second a chip can read from its memory; about 3.35 TB/s on an H100.
- **Memory-bound vs compute-bound**: whether a job is limited by moving data or by arithmetic; set by its arithmetic intensity (FLOPs per byte).
- **Prefill vs decode**: reading the prompt processes all tokens together and is compute-bound; generating reads every weight per token and is memory-bound.
- **Batching**: serving many users at once so each weight read from memory is reused across their tokens, raising total throughput.
- **Quantisation**: storing weights in fewer bits (8 or 4 instead of 16), with a scale per group of weights, to cut memory and speed up decoding.
- **Systolic array**: a grid of multiply-add cells that pass operands to neighbours each clock tick, so each value is read from memory once; the core of a TPU.
- **NPU / LPU / DPU**: a low-power on-device accelerator for quantised models; an inference chip that keeps weights in on-chip SRAM; a network-card processor that offloads networking, storage and encryption.

**Questions they could ask**
- **Q:** Why is LLM text generation memory-bound, and what is the speed limit for one user?
  **A:** Each new token needs every weight read once, but only about 2 FLOPs per weight, so the chip waits on memory, not maths. The upper bound for a single stream on one chip is bandwidth ÷ model size in bytes: an 8B model at 16-bit is 16 GB, so an H100 at 3.35 TB/s tops out near 210 tokens per second, and real systems reach perhaps 50–80% of that. At 4-bit the model is 4 GB and the bound rises about four times.
- **Q:** Why do providers batch requests, and why are output tokens priced higher than input tokens?
  **A:** One user's decode cannot keep the compute units busy, but the weights fetched for one token can serve many users' tokens at once. On an H100 at 16-bit the crossover to compute-bound is around 989 TFLOPS × 2 bytes ÷ (2 × 3.35 TB/s) ≈ 300 concurrent sequences, ignoring the KV cache, which also has to be read for every sequence and pushes that point higher, or out of reach at long contexts. Prompt tokens are processed in parallel and are cheap; output tokens are generated one at a time and are memory-bound, so they cost several times more.
- **Q:** What are the trade-offs of quantising a model to 4-bit?
  **A:** Weights take a quarter of the 16-bit memory, so the model fits on smaller hardware and decodes up to about four times faster. 8-bit is close to lossless; at 4-bit, outlier weights make a single per-tensor scale coarse for everything else, so methods like GPTQ and AWQ use a scale per small group (often 32 to 128 weights) and keep sensitive layers at higher precision. Always re-run your evaluation set after quantising.
- **Q:** Why does the GPU lose to the CPU on small matrix multiplies but win on large ones?
  **A:** Every GPU job has a fixed overhead to submit, schedule and report back, a fraction of a millisecond whatever the size. Multiplying two n × n matrices costs 2n³ operations, about half a million at 64 × 64 and 17 billion at 2,048 × 2,048, so small jobs finish before the overhead is paid off while large ones use thousands of parallel cores. The same logic says small models or single short requests can be fine on a CPU, while big models and batches need an accelerator.
- **Q:** What is a systolic array and why is it efficient?
  **A:** It is a grid of multiply-add cells; rows of A flow in from one side and columns of B from the other, skewed so the right pairs meet, and each cell keeps a running sum that ends as one entry of C. Each input is read from memory once and reused as it moves across the grid, so an N × N array reads 2N² values instead of the 2N³ a naive multiplier would fetch. Memory traffic, not arithmetic, dominates time and energy, which is why TPUs use large arrays (128 × 128 or 256 × 256).

**What I built:** A CPU-versus-GPU race that multiplies matrices on your own machine, in a Web Worker on the CPU and a tiled WebGPU compute shader on the GPU, timing both and checking the GPU's answer against the CPU's. It also has a bandwidth calculator across real chips and model sizes with a batching throughput chart, a quantisation demo on a 64-weight toy model with per-tensor or group scales, an animated 4 × 4 systolic array, and an illustrative DPU offload simulation.

## Deep Learning Notebooks (`/deep-learning`)
**In one line:** The notebooks from Simon Prince's *Understanding Deep Learning*, rebuilt as interactive browser demos, from a single line through backpropagation, residual networks and transformers to diffusion, RL and ethics.

**Key terms**
- **ReLU network as piecewise-linear function**: a network of ReLUs carves the input into regions, each with its own linear function; depth multiplies the number of regions far faster than width.
- **Loss as negative log-likelihood**: least squares is the loss for a Gaussian output, and binary or multiclass cross-entropy for Bernoulli or categorical outputs.
- **Stochastic gradient descent, momentum and Adam**: SGD steps on noisy mini-batch gradients; momentum smooths the direction; Adam also scales each parameter's step by its recent gradient magnitude.
- **Backpropagation**: computing all gradients in one backward pass by caching forward values and applying the chain rule layer by layer.
- **He initialisation**: drawing weights with variance 2/fan-in for ReLU layers so activations and gradients neither vanish nor explode with depth.
- **Residual connections and batch normalisation**: skip connections give gradients a direct path; batch norm normalises each feature over the batch to keep activations well scaled.
- **Bias–variance trade-off and double descent**: test error falls then rises as capacity grows, then can fall again once the model is large enough to interpolate the training data.
- **Regularisation**: methods that improve generalisation, such as L2 weight decay, the implicit regularisation of SGD, ensembling and dropout.

**Questions they could ask**
- **Q:** Why are deep networks more expressive than shallow ones with the same number of parameters?
  **A:** A one-hidden-layer ReLU network makes a piecewise-linear function whose number of pieces grows roughly with the number of hidden units. Composing layers folds the input space onto itself, so each later layer's pieces are replicated in every fold and the number of linear regions can grow exponentially with depth. So depth buys far more regions per parameter than width.
- **Q:** What causes vanishing or exploding gradients, and how do initialisation and residuals fix them?
  **A:** Backprop multiplies one Jacobian per layer, so if each layer shrinks or grows the signal slightly, the product vanishes or explodes over dozens of layers. He initialisation sets weight variance to 2/fan-in so ReLU layers preserve the signal's variance at the start. Residual connections add an identity path, so the gradient always has a direct route back, which is what made 100-plus-layer networks trainable.
- **Q:** Compare SGD with momentum and Adam.
  **A:** Momentum keeps a running average of gradients, which damps oscillation across narrow valleys and speeds travel along them. Adam adds a running average of squared gradients and divides by its square root, giving each parameter its own step size, with bias correction for the early steps; defaults are β1 = 0.9 and β2 = 0.999. Adam (usually AdamW with decoupled weight decay) is the default for transformers; SGD with momentum can generalise slightly better on some vision tasks.
- **Q:** Why do transformers use layer norm rather than batch norm?
  **A:** Batch norm normalises each feature using statistics over the batch, which depend on batch size, behave differently at training and inference, and are awkward for variable-length sequences. Layer norm normalises each token's vector over its own features, so it works the same for any batch size, including a batch of one during generation. That makes it the natural fit for sequence models.
- **Q:** What is double descent?
  **A:** Classical bias–variance says test error is U-shaped in model size. In practice, as you keep growing the model, test error peaks near the interpolation threshold, where parameters roughly match training examples and the model is forced to fit the noise exactly, then falls again as larger models find smoother interpolating solutions. It helps explain why heavily over-parameterised networks can still generalise.

**What I built:** All 68 notebooks from the book, plus a lab extra on encoder, decoder and encoder–decoder transformers, rebuilt as React demos that run entirely in the browser with sliders and draggable points and the answers worked in. They cover chapters 1–21, from shallow and deep networks, losses, optimisers, backpropagation, initialisation and regularisation through CNNs, residual networks, self-attention, tokenisation, decoding and graph networks to GANs, flows, VAEs, diffusion, reinforcement learning and fairness.

## Understanding Deep Learning: the Book and Research (`/deep-learning-book`)
**In one line:** the book's worked examples chapter by chapter and where each idea lives in an LLM, then which changes make LLMs faster, cheaper or better, and by how much.

**Key terms**
- **Memory-bound and compute-bound**: a decode step takes as long as the slower of reading weights and caches from memory or doing the arithmetic; at small batches memory bandwidth is usually the limit.
- **KV cache**: the keys and values saved for earlier tokens so they are not recomputed; its size per token is 2 × layers × KV heads × head size × bytes per number.
- **Grouped-query attention (GQA)**: several query heads share one key and value head, which shrinks the cache by that ratio.
- **Mixture of experts (MoE)**: each token runs only a few of many feed-forward experts, so active parameters are far fewer than total parameters.
- **Quantisation (FP8, INT4)**: storing numbers in fewer bits, which cuts memory and bandwidth and can cost some accuracy.
- **Speculative decoding**: a small model drafts γ tokens and the large model checks them in one step, keeping on average (1 − α^(γ+1)) / (1 − α) of them, where α is the acceptance rate.
- **Test-time compute**: spending more tokens at inference, by thinking longer or sampling several answers, to raise quality.

**Questions they could ask**
- **Q:** Why does an LLM get faster when you quantise it, if the arithmetic is the same?
  **A:** At small batches the limit is usually memory bandwidth, not arithmetic. Every token reads all the active weights, so halving the bytes halves the time per step. An H100 reads 3,350 GB/s, so a 70B model at one byte per parameter tops out near 47 tokens a second for one user. It also fits on fewer GPUs, which is often the bigger saving.
- **Q:** How big is the KV cache, and how do you shrink it?
  **A:** Twice layers times KV heads times head size times bytes, per token. A Llama 70B-style model with 80 layers, 8 KV heads, head size 128 and FP8 uses about 164 KB per token, so 16 users at 8k context need about 21 GB. Without grouped-query attention, at 64 heads, it is about 172 GB. Compressed caches such as multi-head latent attention go further.
- **Q:** When does speculative decoding not help?
  **A:** When the step is compute-bound. With α = 0.7 and γ = 4 you check 5 tokens and keep about 2.8. That pays off while memory reading dominates, because the check reads the weights once. If the GPU is already busy with a large batch, checking extra tokens can make each user slower. Low acceptance rates and an expensive draft model also eat the gain.
- **Q:** Which gives more: mixture of experts or quantisation? (trade-off)
  **A:** They attack different things and don't simply multiply. A mixture of experts reduces the parameters each token uses: DeepSeek-V3 has 671B in total and 37B active. You still have to store all of them, and a large batch touches most experts. Quantisation cuts the bytes for everything but can cost accuracy. I would estimate both, then confirm on my own evaluation set.
- **Q:** Does thinking longer always improve a model?
  **A:** It raises scores on tasks with checkable answers. OpenAI reported o1 at 74% on AIME with one sample, 83% with a consensus of 64 samples, and 93% re-ranking 1,000, against 12% for GPT-4o. It costs tokens and latency for every extra sample, the gains flatten, and it does little for tasks that have no way to check an answer.

**What I built:** the book's 206 worked examples, each with its printed page, linked to the matching notebook demo or given a new one (heteroscedastic regression, early stopping, classifier-free guidance, REINFORCE with a KL penalty and others). A what-if estimator compares a plain baseline with your choices for memory, speed and cost per token on H100, H200 or B200. Evidence cards give each lever's measured gain, condition, trade-off and primary source.

## Token Counter (`/token-counter`)
**In one line:** paste a prompt, pick any model, and see its tokens, the cost per call and the share of the context window, coloured token by token where the tokenizer is published.

**Key terms**
- **Tokenizer**: the fixed vocabulary and rules that cut text into the pieces a model reads. Every model family has its own, so the same text is a different number of tokens on each.
- **Framing**: the tokens a request adds around your text (roles, system prompt, tool definitions), counted in the request total.
- **Exact or estimate**: exact when the model's own tokenizer runs; an estimate when it is not published, as for Gemini, where Gemma 2's is the closest.
- **count_tokens**: Claude's endpoint that counts a request's tokens for free. Claude's tokenizer is not published, so the page uses it.

**Questions they could ask**
- **Q:** Why does the same prompt cost different amounts on different models?
  **A:** Two reasons: the price per token differs, and so does the number of tokens, because each tokenizer cuts text differently. Code, non-English text and numbers vary the most. Comparing cost per character, not per token, is the fair way.
- **Q:** How do you count Claude's tokens without its tokenizer?
  **A:** With the `count_tokens` endpoint, which is free. To colour the text, the page counts it word by word through that endpoint, which is close enough to see where the tokens go.

**What I built:** the backend runs the open tokenizers from Hugging Face (cached in `generated/tokenizers/`, about 90 MB once) and Claude's count through the API; prices come from `python/common.py`. "Every model, side by side" compares them all. Counting is free.

## Fine-tuning with LoRA (`/lora`)
**In one line:** a small open model, SmolLM2, learns on this machine to turn customer emails into one JSON object in a fixed shape, with every score checked by code before and after.

**Key terms**
- **LoRA (low-rank adaptation)**: the original weights stay frozen; each chosen layer learns two small matrices, A and B, whose product is added to it. Only those are trained.
- **Rank (r) and alpha**: r is the size of the small matrices (more capacity, more parameters); the update is scaled by alpha / r.
- **Target layers**: which layers get adapters, usually the attention projections (q, k, v, o), sometimes the MLP too.
- **Adapter**: the saved small matrices: megabytes, not the gigabytes of the model.
- **Merging**: adding the adapter into the weights so it costs nothing at inference. The page checks merging changes no answer.
- **QLoRA**: LoRA on a frozen model stored in 4-bit, so a bigger model fits in less memory. Its 4-bit loading needs an NVIDIA GPU.

**Questions they could ask**
- **Q:** When would you fine-tune rather than prompt?
  **A:** When the task is narrow and repeated, the output must have an exact shape, and prompting a small model gets it wrong too often. Here the base model asked nicely produces the right JSON on none of the held-out emails; after a few minutes of LoRA, every field is right on all of them. A smaller fine-tuned model can then replace a larger one for that task.
- **Q:** Why LoRA rather than full fine-tuning?
  **A:** Memory and storage. Full fine-tuning needs the weights, gradients and optimiser state for every parameter. LoRA trains well under 1% of them, so it fits on a laptop, and the adapter is a small file you can swap per task. The page works out the memory for full, LoRA and QLoRA from each model's shape.
- **Q:** How do you know the training worked and is not memorising?
  **A:** Code writes 400 emails with their right answers, trains on 340 and scores 40 of the held-out ones: valid JSON, exactly the right keys, each field, and every field. A model never grades another model here.
- **Q:** How do you share an adapter?
  **A:** Publish it to Hugging Face with a model card. The page writes the card from the adapter's own scores, uploads only the weights, the config and the card, names the base model by its Hub id rather than a local folder, and keeps it private unless you choose otherwise.

**What I built:** `examples/lora/` (`run_lora.py` trains and scores in its own PyTorch environment; `lora_data.py` holds the task, scoring and memory arithmetic with no PyTorch, so the backend uses it too; `publish_adapter.py` uploads). The backend runs one training run at a time and streams the loss to the page.

## Tabular Foundation Models (`/tabular`)
**In one line:** TabPFN predicts a new table by reading its rows as context, with no training on it, compared with gradient boosting on the same split.

**Key terms**
- **TabPFN**: a transformer pre-trained on millions of invented tables. It reads the training rows and predicts the test rows in one forward pass.
- **In-context learning**: learning from examples in the input, not by changing weights.
- **Gradient boosting**: many small decision trees, each fixing the last one's errors; the usual strong baseline for tables.
- **Metrics**: accuracy, balanced accuracy and ROC AUC for classes; RMSE, MAE and R² for numbers.

**Questions they could ask**
- **Q:** Do LLMs replace classic machine learning on tables?
  **A:** Not by reading the table as text. But the idea behind LLMs, a model pre-trained on huge amounts of data that adapts in context, works for tables too. TabPFN often matches or beats gradient boosting on small tables with no tuning. On large tables, boosting is still the safe choice.
- **Q:** Where does the language model come in?
  **A:** Around the edges. It suggests what to predict from the column summary only, and explains the result. Code checks the target is a real, usable column, computes every metric, and checks the explanation uses no number that is not in the results.

**What I built:** `examples/tabular/run_tabular.py`, run by the backend from its own environment; three invented sample tables or an uploaded CSV.

## One Photo to a 3D Object (`/image-to-3d`)
**In one line:** Idol turns one photo into a 3D object made of Gaussian splats, on this machine, shown in the browser to turn and zoom.

**Key terms**
- **Gaussian splat**: a small, coloured, see-through ellipsoid. Hundreds of thousands of them, blended, look like a solid object. There is no mesh.
- **3DGS `.ply`**: the standard file format for Gaussian splats, which other viewers open.
- **Diffusion transformer**: a transformer that starts from noise and removes it step by step, guided by the image, to produce the object's shape.
- **Image encoders**: DINOv3 and FLUX.2's encoder turn the photo into features the model conditions on. Both are gated on Hugging Face.
- **Steps and Gaussians**: more steps give a cleaner shape; more Gaussians give finer detail. Both cost time.

**Questions they could ask**
- **Q:** How can one photo give a full 3D object?
  **A:** The model has learnt from many objects what the unseen sides usually look like, so it generates them. The back of the object is a plausible guess, not a measurement, which is why the page shows the image it saw beside the result.
- **Q:** Why Gaussian splats rather than a mesh?
  **A:** They are fast to render and capture soft detail and colour well, and they come straight out of the decoder. A mesh is better when you need to edit or 3D print the object.
- **Q:** What does it take to run?
  **A:** Its own Python environment with PyTorch, about 5 GB of weights on the first run, access to the two gated encoders, and a GPU (Apple's MPS or NVIDIA's CUDA). On an M-series Mac, 10 steps and 65,536 Gaussians take about 80 seconds to generate. It costs nothing per run.

**What I built:** `examples/image-to-3d/run_idol.py`, run by the backend from its own environment, one object at a time, streaming each stage with its time; objects kept in `generated/image-to-3d/`; the viewer uses Spark on three.js. `tools/setup-envs.sh` sets it up and checks access.

## Why Atoms Never Touch (`/atoms-touch`)
**In one line:** a short film halves the gap between two fingertips 25 times, from 10 mm to atoms, to show why the push you feel is quantum, not just electric charge.

**Key terms**
- **Pauli exclusion principle**: no two electrons can share the same quantum state, so electron clouds resist being squeezed together.
- **Charge repulsion**: like charges pushing apart. Atoms are neutral overall, so this alone does not explain the push.
- **Force against distance**: almost nothing until the clouds overlap, then a very steep rise.

**Questions they could ask**
- **Q:** Do things ever really touch?
  **A:** It depends on what touching means. Atoms' electron clouds overlap a little, and the resistance rises so steeply that they stop at a distance of about a tenth of a nanometre. What you feel as touch is that resistance.

**What I built:** a film drawn by the page with three.js (with a flat cross-section where WebGL is missing) and a force chart that follows it.

## Songbird: Two Voices at Once (`/songbird`)
**In one line:** a songbird's syrinx has two sides that sing independently, shown on a drawn bird with real-time synthesised songs, and a model that composes for both sides with code checking the score.

**Key terms**
- **Syrinx**: the bird's voice organ, where the windpipe splits into the two bronchi. Each side has its own vibrating membranes.
- **Two-voice singing**: the left side usually sings lower and the right side higher, at the same time or handed between them.
- **Spectrogram**: frequency against time, so two voices show as two lines.
- **Score**: the composed song as data: for each side, notes with pitch, time and length.

**Questions they could ask**
- **Q:** How does the model's song get checked?
  **A:** The model writes a score as structured output. Code checks each side stays in its range, no side sings two notes at once, and the length is right, and sends the problems back once. A cut-off reply is reported as cut off rather than played. The page also names the model that actually answered, because failover may have switched it.
- **Q:** Why synthesise rather than play recordings?
  **A:** So each side can be shown and heard on its own, and so you can play it: SynthBird has breath, glide, grit, windpipe length and throat controls on the keyboard.

**What I built:** an original drawn bird animated from what each side sings, seven stylised songs in Web Audio along the bird's own signal path, and a compose route on the backend with a smaller note limit for the local model.

## Machine Learning and AI in 25 Weeks (`/ml-course`)
**In one line:** the lab's own course, from vectors and Bayes' rule through classical models, neural networks and language models to reinforcement learning and a capstone, with lab pages, a Python exercise and a quiz each week.

**Key terms**
- **Week**: goals, lab pages to work through, one hands-on task, a Python exercise with tests, and a short quiz.
- **Exercise and solution**: `exercise.py` has stubs that fail their tests until filled in; `ML_COURSE_SOLUTIONS=1` runs the same tests on the worked solution.
- **Capstone**: black-box optimisation of invented systems on a fixed budget, the same in the browser and in Python.

**Questions they could ask**
- **Q:** What does the course cover, in order?
  **A:** Maths and optimisation, then probability and statistics, evaluation, the classical models (nearest neighbours, trees and ensembles, naive Bayes and logistic regression, SVMs), Bayesian optimisation, neural networks and CNNs, tuning, language models, interpretability and fairness, clustering and PCA, reinforcement learning, and the capstone.
- **Q:** Why build each idea in NumPy before using a library?
  **A:** Writing k-NN, a tree split, backpropagation or a Gaussian process once by hand shows what the library's settings mean and where it can go wrong. After that the library is a faster, tested version of something you understand, and its defaults stop being magic.
- **Q:** How is it assessed?
  **A:** Each week's tests check the exercise, and its quiz explains every answer and counts as passed at three quarters of its questions. The capstone is judged by regret on the clean function and by the decision log: what was tried each round and why.

**What I built:** a course hub with 26 weeks (an orientation week and 25 more), progress and quiz scores kept in the browser, quizzes gathered from the pages that teach each week, seven new teaching pages and a capstone, and `examples/ml-course/` with an exercise, a worked solution and tests for every week.

## Maths for Machine Learning (`/ml-maths`)
**In one line:** the linear algebra and calculus a model actually uses: vectors and matrices for data and weights, derivatives and the chain rule for learning, and gradient descent with its failure modes.

**Key terms**
- **Dot product and cosine similarity**: matching entries multiplied and summed; divided by both lengths, a measure of direction only.
- **Determinant**: the factor by which a matrix scales areas; zero means information is lost and there is no inverse.
- **Gradient**: the vector of partial derivatives, pointing in the direction of steepest increase.
- **Chain rule**: the derivative of a chain of steps is the product of each step's local derivative; backpropagation applies it backwards through a graph.
- **Learning rate**: the size of each step against the gradient.
- **Momentum and Adam**: optimisers that keep a running velocity, and a running size of each coordinate's gradient.

**Questions they could ask**
- **Q:** Why is cosine similarity used for embeddings rather than the plain dot product?
  **A:** The dot product grows with length as well as alignment, so a long vector looks similar to everything. Dividing by both lengths keeps only direction, which is what carries meaning in an embedding. If vectors are normalised to length one, the two are the same.
- **Q:** Why does a network need a non-linearity between layers?
  **A:** A matrix times a matrix is another matrix, so a stack of purely linear layers is one linear layer. The non-linearity between them is what lets depth model curved boundaries and interactions.
- **Q:** What does backpropagation actually compute?
  **A:** The gradient of the loss with respect to every weight, in one backward pass. It runs the chain rule over the computation graph: each node multiplies the gradient arriving from above by its own local derivative and passes it on. The cost is about the same as one forward pass.
- **Q:** Your loss goes to NaN in the first few steps. What do you try?
  **A:** Lower the learning rate first: a step bigger than the curvature allows overshoots and grows. Then check for exploding gradients (clip them), bad input scaling (normalise features) and a warm-up schedule. The ravine surface on the page shows the threshold exactly.
- **Q:** Why do most deep learning projects use Adam rather than plain gradient descent?
  **A:** Real loss surfaces are badly conditioned: steep in some directions, flat in others. Plain descent must keep its step small for the steep ones and crawls along the flat ones. Adam divides each coordinate's step by a running size of its gradient, so all directions move at similar speeds with less tuning.
- **Q:** Does gradient descent find the best possible model?
  **A:** Not in general. It finds a point where the gradient is near zero, which can be a local minimum or, in high dimensions more often, a long flat region or a saddle. Where you start matters, as the two-valley surface shows. In large networks many minima are about equally good, which is part of why it works anyway.

**What I built:** a page that builds vectors, matrices, a network layer, derivatives, gradients, the chain rule and three optimisers from things you can drag and click, with the formula after each, a NumPy line fit by hand-written gradient descent, and self-check questions for weeks 1 and 2.

## Probability and Statistics for ML (`/probability-stats`)
**In one line:** the probability and statistics machine learning leans on: Bayes' rule and base rates, distributions, simulation, robust summaries, likelihood, regression, the bootstrap, missing data, and the entropy and Bayes behind trees and naive Bayes.

**Key terms**
- **Conditional probability**: P(A | B), the chance of A among the cases where B happened; not the same as P(B | A).
- **Base rate**: how common something is before any evidence; it decides how much a positive result means.
- **Maximum likelihood**: the parameter values that make the observed data most probable; most training losses are negative log-likelihoods.
- **Bootstrap**: resampling the data with replacement to see how much a statistic varies.
- **MCAR, MAR, MNAR**: missing completely at random, at random given what you observe, and not at random (because of the missing value itself).
- **Entropy and Gini impurity**: two measures of how mixed a node's classes are, used to choose tree splits.

**Questions they could ask**
- **Q:** A fraud model is 95% accurate on both classes. Why might most of its alerts still be wrong?
  **A:** Base rates. If 1 in 1,000 transactions is fraud, the 5% false alarms on the 999 genuine ones vastly outnumber the true catches. Precision depends on prevalence, so report it alongside recall and test at the real base rate.
- **Q:** How do squared error and cross-entropy relate to likelihood?
  **A:** Minimising squared error is maximising likelihood under normal noise; minimising cross-entropy is maximising likelihood for a Bernoulli or categorical outcome. Choosing a loss is choosing a noise model.
- **Q:** How would you handle missing values in a training set?
  **A:** First ask why they are missing. If it depends on observed columns, model-based imputation using them removes most of the bias; if it depends on the value itself, nothing fully fixes it, so add a missing-indicator column and say so. Avoid mean filling for anything that needs the spread, and fit any imputer on the training split only.
- **Q:** Mean or median, and which outlier rule?
  **A:** Median and IQR when the data is skewed or may contain errors, because one extreme value cannot drag them. The z-score rule uses the standard deviation, which the outlier inflates, so it can miss the very point it should flag. Either way, investigate an outlier before removing it.
- **Q:** When would you use the bootstrap?
  **A:** Whenever you need an interval for a statistic with no simple formula: a median, a ratio, an AUC, the gap between two models on the same test set. Resample with replacement a few thousand times and take the middle 95% of the results.
- **Q:** How does a decision tree decide where to split, and why might naive Bayes be overconfident?
  **A:** The tree tries every candidate split and keeps the one with the largest size-weighted drop in entropy or Gini impurity. Naive Bayes multiplies one likelihood ratio per feature, assuming independence given the class; correlated features get counted several times, which pushes probabilities towards 0 or 1 even when the ranking is good.

**What I built:** a page on invented data with ten working demos: a 1,000-person screening test for Bayes' rule, five distributions, Monte Carlo with its 1/√n error, outliers under two rules, likelihood for a coin and a normal, least squares with residuals, a bootstrap interval, three missing-data mechanisms against three fixes, entropy and Gini choosing a tree's first split, and naive Bayes with smoothing. It has self-check questions for weeks 3, 4, 5, 10 and 12.

## Evaluating Models Honestly (`/model-evaluation`)
**In one line:** how to get honest evidence that a model works on data it has not seen: three splits, learning curves, the measures of a classifier at a threshold, cross-validation, and the traps of imbalance and leakage.

**Key terms**
- **Validation and test sets**: validation chooses between models; the test set is read once, at the end, for the number you report.
- **Learning curve**: training and validation error against the amount of training data; a gap that closes with data means variance.
- **Sensitivity and specificity**: the share of real positives caught, and the share of real negatives correctly cleared.
- **Precision**: the share of positive calls that are right; it falls as positives get rarer.
- **ROC AUC**: the chance a random positive scores above a random negative; a ranking measure, independent of threshold and prevalence.
- **Lift**: the share of positives found in the top of a ranked list, divided by the share contacted.
- **Stratified k-fold**: cross-validation that keeps each class's share the same in every fold.
- **Leakage**: information from the evaluation data reaching training, such as resampling before the split.

**Questions they could ask**
- **Q:** Why is accuracy a poor measure for fraud or disease screening?
  **A:** Positives are rare, so doing nothing scores well: at 1% prevalence, calling everyone negative is 99% accurate and finds nobody. Use sensitivity and precision, read the precision–recall curve, compare with the do-nothing baseline, and set the threshold from what each kind of mistake costs.
- **Q:** How do you choose a classification threshold?
  **A:** From the costs, not by default at 0.5. Put a cost on a miss and on a false alarm, compute the total cost at each threshold on validation data, and take the cheapest. On the page, when a miss costs twenty times a false alarm, the best threshold drops well below 0.5.
- **Q:** ROC AUC or precision–recall?
  **A:** Both answer different questions. ROC AUC measures how well the scores rank people and hardly moves with prevalence. Precision–recall shows what a positive call is worth, which collapses when positives are rare. For rare-event problems, report the precision–recall curve or average precision alongside AUC.
- **Q:** What does a learning curve tell you to do?
  **A:** Both errors high and close together means bias: use a more flexible model or better features; more data will not help. A large gap that shrinks as rows are added means variance: get more data, regularise or simplify. The page shows both with a straight line and a degree-9 polynomial.
- **Q:** Why must resampling happen inside the training fold?
  **A:** Oversampling before the split puts copies of test positives into training, so a nearest neighbour finds its own copy and sensitivity soars. Undersampling first leaves a balanced test set, so precision looks far better than on real traffic. In scikit-learn, put the resampler in an imbalanced-learn pipeline so cross-validation applies it fold by fold.
- **Q:** When do you need nested cross-validation?
  **A:** When you tune and want an unbiased estimate of the whole tune-then-train procedure. The inner loop tunes on each outer training set; the outer fold scores the tuned model on data the tuning never saw. Reporting the best inner cross-validated score is optimistic, as the three-splits demo shows.

**What I built:** a browser page on invented data. It shows how choosing many models inflates the validation score, learning and complexity curves from polynomial fits, and a screening test with a threshold slider driving a live confusion matrix, ROC, precision–recall and gains charts and a cost-based threshold. It also has a fold grid comparing plain and stratified k-fold, a nested CV diagram, four ways of handling imbalance run both correctly and leakily, time-ordered splits, and scikit-learn code.

## Hyperparameter Tuning and Bayesian Optimisation (`/tuning`)
**In one line:** how to search for good hyperparameters on a budget: random beats grid, stop bad trials early, and let a Gaussian process choose the next trial when each one is expensive.

**Key terms**
- **Hyperparameter**: a setting chosen before training (learning rate, depth, regularisation), unlike parameters, which training learns.
- **Random search**: sampling settings at random; each trial tries a new value of every hyperparameter.
- **Successive halving / Hyperband**: train many settings briefly, keep the best fraction, give survivors more budget, repeat.
- **Gaussian process**: a surrogate that gives a mean and an uncertainty at every input, shaped by a kernel's length-scale and noise.
- **Acquisition function**: turns the surrogate into the next point to try; expected improvement, probability of improvement or upper confidence bound.
- **Exploration and exploitation**: measuring where you are unsure, against measuring where the surrogate already looks good.

**Questions they could ask**
- **Q:** Why does random search often beat grid search?
  **A:** Usually only a few hyperparameters matter. A 3 × 3 grid tests just three values of the important one; nine random trials test nine. On the page's loss, where learning rate matters and dropout hardly does, random search wins most of 200 draws.
- **Q:** How does Bayesian optimisation work?
  **A:** Fit a surrogate, usually a Gaussian process, to the trials so far. Use an acquisition function to pick the point that best balances a high predicted score against high uncertainty. Run that trial, refit and repeat. It pays off when each trial is expensive, because choosing carefully costs seconds and a trial costs hours.
- **Q:** Expected improvement or UCB?
  **A:** Expected improvement weighs both the chance and the size of beating the best so far, and needs little tuning, so it is a good default. UCB, the mean plus κ standard deviations, makes the balance explicit: larger κ explores more. Probability of improvement is greedy and settles on small, sure gains.
- **Q:** What do the length-scale and noise of a Gaussian process do?
  **A:** The length-scale says how far apart two inputs can be and still move together: short gives wiggly fits that are unsure between points, long gives smooth ones. The noise says how much a repeated measurement can differ, so the mean need not pass through every point. Set them badly and the suggestions go wrong.
- **Q:** Is Bayesian optimisation guaranteed to find the best setting?
  **A:** No. On the page's function, every run quickly climbs a broad hill, far faster than random search, but only some find a taller, narrow peak within 25 evaluations. It is efficient, not magic. More starting points, a shorter length-scale or more exploration change the odds at the cost of evaluations.
- **Q:** How do you avoid overfitting the validation set when tuning?
  **A:** Score each trial by cross-validation rather than one split, limit the budget, and report the chosen settings on a test set the search never saw, or use nested cross-validation. After hundreds of trials, the best validation score is partly luck.

**What I built:** a browser page with grid and random search on an invented loss, successive halving against full training at the same budget, a clickable one-input Gaussian process with posterior samples and three acquisition functions, and Bayesian optimisation against random search over eight runs in two dimensions. It ends with practical advice and scikit-learn and Optuna code. The Gaussian process is written out with no library and reused by the capstone.

## Capstone: Optimise a Black Box (`/capstone`)
**In one line:** an original capstone in which you find the best settings of five invented systems on a fixed budget of trials, explain each round's choices, and turn the work into a portfolio project.

**Key terms**
- **Black-box optimisation**: improving a function you can only evaluate, with no formula or gradient.
- **Query budget**: the fixed number of evaluations, released round by round.
- **Surrogate**: a cheap model of the black box, here a Gaussian process, used to choose where to measure.
- **Batch suggestion**: choosing several points per round, here by pretending each suggestion returned its predicted mean (a "believer").
- **Regret**: how far the clean value of your chosen point is below the true optimum.
- **Decision log**: a short record of what was tried each round and why.

**Questions they could ask**
- **Q:** How would you approach a black-box optimisation problem with a small budget?
  **A:** Start from the given points and the surrogate's view. Spend early rounds exploring the regions the surrogate is least sure of, then shift to exploiting the best region, checking any surprising high reading before trusting it. Each round's note records which acquisition and settings were used and why.
- **Q:** Why score regret on the clean function?
  **A:** Because with noise a lucky reading can look like success. What matters is how good the setting you would actually choose is, so the score uses the noise-free value of your best-measured point.
- **Q:** How do you choose several points in one round with Bayesian optimisation?
  **A:** Suggest one point, then pretend it came back at the surrogate's predicted mean, refit and suggest the next. That spreads the batch out instead of putting every point on the same peak. Other methods sample from the posterior or penalise points near those already chosen.
- **Q:** What changes as the number of inputs rises?
  **A:** The space grows so fast that a budget of around 40 trials sees almost none of it; a grid of three values in six inputs is already 729 points. The surrogate's assumptions about smoothness and the number of peaks decide where to look, so the length-scale matters more, and some exploration budget is worth keeping.
- **Q:** One of the functions has a broad, easy peak and a narrow, taller one. How would you avoid settling on the easy one?
  **A:** Keep some exploration going after the first good region is found: a larger κ in UCB for a round, a deliberately distant point, or a shorter length-scale so the surrogate admits it could have missed a narrow peak. Then compare what that exploration cost with what it found.
- **Q:** How would you present it as a portfolio project?
  **A:** Write a README with the problem, the result and one progress plot. Add a method section on the surrogate and acquisition, a decision log per round including what failed, regret and surrogate plots, and code that reproduces every query from a fixed seed. Finish with a reflection on what would change with more noise, more inputs or twice the budget.

**What I built:** five invented black boxes with two to six inputs, starting points, ten rounds and a note per round. It has optional Gaussian-process helpers (a surrogate map for two inputs and batch suggestions by expected improvement or UCB), progress and regret plots with the optimum revealed only at the end, a Markdown export for a portfolio README, and progress saved in the browser. The same functions are in `examples/ml-course/capstone/` for Python.

## Interpretability, Fairness and Documentation (`/interpretability`)
**In one line:** why a model decided what it did, whether it treats groups fairly, and what it is for, worked exactly on a small invented loan model.

**Key terms**
- **Global and local explanation**: how the model behaves overall, against why it made one decision.
- **Permutation importance**: the fall in score when one input is shuffled; it measures dependence, not truth.
- **Partial dependence and ICE**: the average prediction as one input is swept, and the same sweep per person.
- **Shapley value**: a feature's fair share of the gap between one prediction and the average prediction.
- **Counterfactual**: the smallest change to the inputs that would flip the decision.
- **Proxy**: an allowed input that tracks a sensitive attribute, bringing it into the decisions.
- **Model card and datasheet**: documentation of what a model is for and how it performs, and of how a dataset was made.

**Questions they could ask**
- **Q:** What is the difference between SHAP and permutation importance?
  **A:** Permutation importance is global: shuffle a column and see how much the model's score falls across the whole dataset. SHAP is local: it splits one prediction among the inputs, and the shares add up exactly to that prediction minus the average. You can average absolute SHAP values for a global view, but they answer a different question.
- **Q:** We removed the protected attribute. Is the model fair now?
  **A:** Not necessarily. Other inputs can carry it. On the page, the branch area is never an input, yet years at address and income both track it and the approval gap is 22 points. Check outcomes by group, not just the input list.
- **Q:** Why can't a model satisfy every fairness metric?
  **A:** When groups have different base rates and the model is imperfect, equal precision, equal true positive rates and equal false positive rates cannot all hold together. That is arithmetic. You choose the metric that matches the harm you most need to avoid, and write down why.
- **Q:** When would you trust a post-hoc explanation?
  **A:** As a lead, not a finding. Post-hoc methods describe behaviour, and with correlated inputs they evaluate combinations that never occur. Confirm with a second method, a test on real cases, or a simpler model that can be read directly.
- **Q:** What goes in a model card?
  **A:** Intended use and out-of-scope uses, the training data and who is missing from it, metrics overall and by group at the threshold used, fairness findings and what was decided, and known limits. It travels with the model so later teams inherit the findings.
- **Q:** Is a model's chain of thought an explanation?
  **A:** No. It is more generated text, and studies have found models giving reasons that leave out what actually drove the answer. For LLM systems, rely on behaviour: test sets broken down by group and case type, refusal checks and records of inputs.

**What I built:** an invented loan model with exact explanations (weights, permutation importance, PD and ICE curves, all 16 Shapley coalitions with a waterfall, counterfactuals marked by whether they can be acted on), a proxy analysis, fairness metrics with per-group thresholds and a search showing they conflict, calibration by group, a table of bias sources, and fillable model card and datasheet forms that render Markdown.

## Reinforcement Learning from Bandits to Q-learning (`/reinforcement-learning`)
**In one line:** learning what to do from rewards rather than answers, from choosing between options to planning and learning in a grid world, all seeded so runs repeat.

**Key terms**
- **Return and discount factor**: the total future reward, with a reward t steps away weighted by γ to the power t.
- **Regret**: reward lost compared with always choosing the best option, which nobody knows in advance.
- **ε-greedy, UCB1, Thompson sampling**: exploring at random, by optimism where evidence is thin, and by sampling from beliefs.
- **Markov decision process**: states, actions, outcome probabilities and rewards, with the next state depending only on the current one.
- **Value iteration**: planning with known rules by repeatedly setting each state's value to its best action's expected return.
- **Q-learning and SARSA**: learning action values from experience; off-policy towards the best next action, on-policy towards the next action taken.

**Questions they could ask**
- **Q:** When would you use a bandit instead of an A/B test?
  **A:** When showing a losing option costs money and you care about the total outcome more than a clean estimate. A bandit shifts traffic to the winner as evidence builds; a fixed split keeps paying for the loser until the test ends but gives an unbiased comparison.
- **Q:** Why does Thompson sampling usually beat ε-greedy?
  **A:** ε-greedy keeps exploring at a fixed rate for ever, so its regret grows in a straight line. Thompson sampling explores in proportion to its uncertainty, so it nearly stops once the best option is clear. On the page's 3,000 visitors, it ends with markedly less regret.
- **Q:** What is the difference between value iteration and Q-learning?
  **A:** Value iteration plans: it needs the transition probabilities and rewards written down. Q-learning learns the same action values from experience alone, by acting and updating towards the reward plus the discounted best next value.
- **Q:** Q-learning or SARSA?
  **A:** Q-learning is off-policy and learns the best policy as if it will play perfectly afterwards. SARSA is on-policy and learns the value of what it actually does, exploration included. On a cliff walk, Q-learning hugs the edge and falls more while learning; SARSA keeps a safe distance and earns more per episode.
- **Q:** How does the reward design change behaviour?
  **A:** Directly. In the page's grid world, raising each step's cost makes the agent accept a risky route past the pit, and at a high enough cost it walks into the pit to end the episode. The agent optimises the reward you wrote, not the one you meant.
- **Q:** Where is reinforcement learning used in language models?
  **A:** In RLHF, a reward model trained on people's preferences scores answers and the model is tuned to score well, with a penalty for drifting. Reasoning models are trained with checkable rewards such as passing tests, often with GRPO. The main risk is reward hacking: pleasing the scorer rather than the person.

**What I built:** seeded simulations of discounting, a three-way bandit race with regret curves and pull counts, an editable slippery grid world solved by value iteration sweep by sweep, Q-learning on the same world with a learning curve and Q-value map, and Q-learning against SARSA on a cliff walk, with a Python tabular Q-learning sample.
