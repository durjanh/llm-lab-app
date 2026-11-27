## Prompting Lab (`/prompting`)
**In one line:** a prompt is just the start of a text, so instructions, examples and roles work by shifting next-token probabilities, and you judge a prompt on a test set, not one example.

**Key terms**
- **Next-token distribution**: the probability the model gives to every token in its vocabulary as the continuation; everything in prompting changes this distribution.
- **Few-shot prompting (in-context learning)**: putting input and output examples in the prompt so the model picks up the task format and label set without any weight updates.
- **Majority-label and recency bias**: the tendency to favour labels that appear most often, or last, among the examples.
- **Contextual calibration**: measuring the model's label probabilities on a content-free input (such as "N/A") and dividing them out, so a prompt's built-in bias is cancelled.
- **Constrained decoding**: restricting generation to tokens that keep the output valid (an allowed label, or text matching a grammar or JSON schema) by masking everything else.
- **Structured outputs**: the API-level form of constrained decoding, where the reply is guaranteed to match a JSON schema or a strict tool input schema.
- **Role markers / chat template**: the special tokens that turn system, user and assistant messages into one token stream the model actually reads.
- **Prompt injection**: instructions hidden in data (an email, a web page, a tool result) that the model may follow because data and instructions share one stream.

**Questions they could ask**
- **Q:** Why does few-shot prompting work, and what can go wrong with it?
  **A:** The examples show the model the output format and the label space, which is often worth more than a long instruction. Research has shown that the format and label space matter more than whether each example's label is correct. The risks are that the model copies the examples' label mix and order, so eight positive examples push it towards "positive". Balance the labels, vary the order, and check the effect on a labelled set.
- **Q:** How do you get output your code can parse reliably?
  **A:** Use structured outputs or strict tool schemas, so the decoder is constrained to valid JSON for the schema and you are not parsing free text. That guarantees syntax, not correctness, so you still validate values and handle refusals or truncation at max_tokens. For classification you can go further and score only the allowed labels.
- **Q:** What are the trade-offs of constrained decoding when you score a fixed set of labels?
  **A:** It removes unparseable answers completely, which is why the page's "probability on a valid label" matters. But a multi-token label's score is the product of its token probabilities, so longer labels are penalised unless you length-normalise. Forcing a format too early can also cut off reasoning, so for hard tasks let the model think first, then constrain the final field.
- **Q:** How would you defend an LLM feature against prompt injection?
  **A:** Delimiting untrusted text in tags and saying "this is data" helps, but it is not a security boundary. The real defence is least privilege: the least trusted text in the context should not be able to trigger anything harmful, so side-effecting tools need approval or a policy check, secrets stay out of the context, and outputs are validated. Add an injection classifier on inputs and tool results, and log everything for review.
- **Q:** How do you decide whether a prompt change is an improvement?
  **A:** Run both prompts over a fixed labelled test set and compare accuracy and the other metrics you care about. Eight cases, as on the page, means one example is 12.5 points, so real evaluations need dozens to hundreds of cases before a difference means anything. Keep the set versioned and run it in CI so regressions show up.

**What I built:** the page runs GPT-2 in the browser through transformers.js and reads real next-token probabilities for " positive" and " negative" over eight labelled reviews, with optional calibration against an "N/A" input and a constrained-decoding panel that multiplies per-token probabilities for multi-token labels. It needs no backend; `python/03_classify_reviews.py` is the runnable Claude version.

## Embeddings and RAG (`/embeddings`)
**In one line:** embeddings put similar meanings close together, and RAG retrieves the best chunks first and gives only those to the LLM.

**Key terms**
- **Embedding**: a fixed-length vector a model produces for a piece of text, where texts with similar meaning have nearby vectors (384 dimensions for all-MiniLM-L6-v2).
- **Cosine similarity**: the cosine of the angle between two vectors, used to score how close two embeddings are; for normalised vectors it equals the dot product.
- **Chunking**: splitting documents into retrievable pieces, by fixed size with overlap or by the document's own structure such as headings.
- **BM25**: a keyword ranking formula that scores term matches, weights rare terms higher through IDF, saturates repeated terms (k1) and normalises for document length (b).
- **Hybrid search with reciprocal rank fusion (RRF)**: running vector and keyword search together and merging by rank, scoring each item 1/(k + rank) per list with k usually 60, so scores on different scales are never compared.
- **Bi-encoder vs cross-encoder reranker**: a bi-encoder embeds query and passage separately so passages can be indexed ahead; a cross-encoder reads them together, which is more accurate but must run per pair at query time.
- **Top-k and similarity threshold**: how many chunks you pass on, and the minimum score below which you say "not found" instead of answering.
- **Groundedness / citations**: keeping a source id on every chunk so the answer can cite it and be checked.

**Questions they could ask**
- **Q:** Walk me through a RAG pipeline end to end.
  **A:** Offline, you chunk the documents, embed each chunk once and store vectors with source metadata, often alongside a keyword index. At query time you embed the question, retrieve candidates by vector and keyword search, fuse them, optionally rerank a shortlist with a cross-encoder, apply a threshold, and put the top few chunks into the prompt with an instruction to answer only from them and say when they do not contain the answer. The answer cites the chunk sources.
- **Q:** Why use hybrid search instead of embeddings alone?
  **A:** Embeddings handle synonyms and paraphrase, such as "vacation" against "annual leave", but they blur exact tokens like amounts, product codes and names. BM25 catches "£35" or "extension 4400" exactly but misses synonyms. RRF merges the two rankings by position, so a chunk near the top of either list rises without you having to calibrate cosine scores against BM25 scores.
- **Q:** Why not just rerank everything with the cross-encoder, since it is more accurate?
  **A:** A cross-encoder needs one forward pass per query and passage pair, and nothing can be precomputed, so cost grows with the size of the collection on every query. Vector search with precomputed embeddings is cheap over millions of chunks. So you retrieve a few dozen candidates cheaply and rerank only those; the page reranks a shortlist of 8.
- **Q:** How do you choose chunk size and overlap, and how do you know retrieval is working?
  **A:** Too small and an answer is split across chunks; too large and the match is diluted and you pay for irrelevant tokens. Splitting on headings or paragraphs is a strong default, with some overlap for answers that cross a boundary. Measure retrieval on its own with a set of questions and known answer passages, using recall@k and MRR or nDCG, because if retrieval misses, no prompt fixes the answer.
- **Q:** What happens when someone asks an off-topic question, and what if you change embedding model?
  **A:** Nearest-neighbour search always returns something, so without a threshold the model gets irrelevant chunks and may answer confidently. Use a minimum score plus an instruction to say "I don't know". Vectors from different models are not comparable, so a model change means re-embedding the whole corpus.
- **Q:** Walk me through how you would choose a chunking strategy, with numbers.
  **A:** Structure first: split on the units the author made (headings, paragraphs, FAQ pairs, table rows, functions) and use fixed windows only when there is no structure, as in transcripts or OCR. Size a chunk to hold one whole answer to a typical question, then measure. On the lab's 12-section handbook with 24 labelled questions (a hit is a chunk containing the exact answering phrase, all-MiniLM-L6-v2), one chunk per section scored hit@1 22/24 and MRR 0.96 with vectors. Fixed 60-word windows with no overlap fell to 17/24 and MRR 0.83, because answers were cut at the boundary; 15% overlap brought them back to 21/24 and 0.94, and 30% overlap was no better (0.88). 30-word windows were worst, especially for BM25 (MRR 0.58 with overlap), because a tiny chunk holds too few of the query's words. It is a small invented corpus, so treat these as the shape of the effect, not a benchmark.
- **Q:** Should each chunk carry its document title or heading?
  **A:** Usually yes, because a chunk that says "it costs £35" loses what "it" is once it is cut out. The search lab puts the title in front of every chunk before embedding. On the handbook, prefixing the section title to 60-word windows raised hybrid MRR from 0.90 to 0.92 and left vector MRR unchanged at 0.94 (MiniLM); with bge-small, hybrid rose from 0.85 to 0.88 and vector slipped from 0.89 to 0.88. Small, mixed effects. Short sections already name their topic, so the gain shows on long documents where a chunk sits far from its heading. A related pattern is small-to-big: retrieve a small chunk for precision, then send the whole section around it to the model.
- **Q:** How do you choose an embedding model?
  **A:** On your own labelled questions, not a leaderboard. Check four things: languages (an English-only model is weak on Welsh or Polish queries), the maximum input, the dimensions (storage and search cost), and the price to embed and re-embed the corpus. On the handbook, bge-small-en-v1.5 ranks above all-MiniLM-L6-v2 on public benchmarks, yet scored lower here (section chunks, vector MRR 0.90 against 0.96) and took 2.8 times as long on a laptop CPU (1,030 ms against 370 ms for 120 chunks). In Azure, text-embedding-3-small (1,536 dimensions, $0.02 per million tokens in the lab's price table) against text-embedding-3-large (3,072 dimensions, $0.13) is the usual choice: embedding 250 million tokens of chunks costs about $5 against $32.50, before storage.
- **Q:** What happens to text past the embedding model's input limit?
  **A:** It is silently dropped. fastembed truncates all-MiniLM-L6-v2 at 256 word pieces. Measured on the handbook: the equipment section alone scored cosine 0.61 against "My laptop was stolen, who do I call?". The same section placed after 725 word pieces of other sections scored -0.03, exactly the same as the other sections without it, because the model never saw it. Placed first, before the same text, it scored 0.27: still found, but diluted. So keep chunks inside the model's limit (text-embedding-3-small takes 8,191 tokens), and remember that a long chunk blurs its own match even when nothing is cut.
- **Q:** Is hybrid search always better than vector search?
  **A:** No; it is the safer default, not always the top score. On the handbook, whose 24 questions are mostly paraphrases ("holiday days" for "annual leave"), vector search scored MRR 0.96, hybrid 0.92 and BM25 0.84. In the Azure search lab (12 labelled questions over 15 chunks, 10 November 2026), vector scored hit@1 10/12 and MRR 0.92, hybrid 9/12 and 0.85, keyword 8/12 and 0.75. Keyword earns its place on exact tokens: invoice KD-20419 and claim HM-HOME-558120 were first by keyword too. Hybrid with RRF (k 60) protects you when you do not know which kind of question will come, at the cost of sometimes pulling a strong vector hit down a place.
- **Q:** How do you measure groundedness?
  **A:** Separately from retrieval. Retrieval metrics (hit@k, MRR, nDCG on labelled passages) say whether the right text reached the model; groundedness says whether the answer stays within that text. Check it per claim: split the answer into factual claims and label each supported, unsupported or contradicted against the retrieved chunks only, and call the answer grounded only if every claim is supported. Also check that each citation points at a chunk that was actually retrieved. On 10 handbook answers with known labels (5 faithful, 5 with a changed number, an added claim or a contradiction), a Claude Haiku claim-level judge agreed with all 10 for $0.001. Word overlap could not tell them apart: answers with a wrong number overlapped 0.89 to 0.90 with the source, while one faithful paraphrase overlapped only 0.55. Before trusting any judge, measure its agreement with human labels on your own data, and watch for position and length bias.

**What I built:** everything runs in the browser: all-MiniLM-L6-v2 for embeddings (with PCA to draw the 2D map), my own BM25 (k1 1.2, b 0.75), RRF with k 60, and the ms-marco-MiniLM-L-6-v2 cross-encoder reranking the top 8, over a made-up handbook with fixed-size or heading-based chunking. `python/05_rag.py` is the runnable version with a "not found" path.

## Agents and Tools (`/agents`)
**In one line:** an agent is a loop you write: the model only writes structured tool requests, and your code decides whether to run them and sends the results back.

**Key terms**
- **Tool use (function calling)**: the model returns a structured request naming a tool and its JSON input, defined by a name, description and input schema you supply.
- **tool_use / tool_result blocks**: the assistant's request block with an id, and the matching result your code sends back in the next user message under the same id.
- **stop_reason**: why the model stopped; "tool_use" means it wants a tool run, anything else (such as "end_turn" or "max_tokens") ends or interrupts the loop.
- **is_error**: a flag on a tool result that tells the model the call failed, so it can correct itself instead of the program crashing.
- **Parallel tool calls**: several tool_use blocks in one reply; all their results go back together in a single message.
- **Agentic loop**: call the model, run requested tools, append results, repeat until it answers without a tool call or a limit is hit.
- **Human-in-the-loop approval**: a gate that makes a person or policy approve side-effecting calls such as sending email.
- **SDK tool runner**: an SDK helper that runs the loop for you, so you only write the tool functions.

**Questions they could ask**
- **Q:** What actually happens on the wire when a model "calls a tool"?
  **A:** The model never executes anything. It returns an assistant message containing a tool_use block with an id, a tool name and JSON input, with stop_reason "tool_use". Your code validates the input, runs the function, and sends a user message with a tool_result for that id. The next call carries the whole history again, including the tool schemas, because the API is stateless.
- **Q:** How would you stop an agent looping forever?
  **A:** Cap the number of iterations, cap the spend and set a wall-clock timeout, and stop on any stop reason other than tool_use. Detect repeated identical calls, return clear errors so the model can change course, and when a limit is hit, end with a report that asks a person for help rather than silently failing. My scripts default to 10 steps and the backend harness also checks a per-run budget before every call.
- **Q:** When should you not build an agent?
  **A:** When the steps can be specified in advance, a single call or a fixed workflow is cheaper, faster and easier to test. An agent is justified when the task is multi-step and hard to specify, the value pays for more tokens and latency, the model is actually good at it (checked with a small evaluation), and mistakes can be caught and undone.
- **Q:** Why does an agent's cost grow so fast, and what do you do about it?
  **A:** Every call resends the full history, so input tokens per call grow with each step and the total grows roughly with the square of the number of steps. Tool schemas are sent every time too. Cache the stable prefix (tools and system prompt), trim or summarise large tool results, and offer only the tools the task needs.
- **Q:** How should tools report failures?
  **A:** Return the failure as a tool_result with is_error set and a message that says what went wrong and what to do next, rather than throwing. The model can then retry with a correct id or choose another path. When several tools ran in parallel, send all results, successes and failures, back in one message.

**What I built:** the page is a scripted step-through of three scenarios (one call, two parallel calls with one failure, several steps with approval) that shows the exact request JSON and a chart of input tokens per call, estimated at four characters per token. `python/06_agent_loop.py` is the manual loop with is_error results, an email allow-list and a human approval prompt, and `07_tool_runner.py` does the same with the SDK tool runner.

## Context Engineering (`/context-engineering`)
**In one line:** the context window is the model's entire world on each call, so you choose what goes in, in what order, and what is left out.

**Key terms**
- **Context window**: the maximum tokens one request can hold, covering system prompt, tools, history, documents and the reply.
- **Context engineering**: deciding what information, tools and history go into each request so the model has what it needs and little else.
- **Prompt caching**: reusing the processed state of an identical prompt prefix; on Claude, cache reads cost about a tenth of normal input and cache writes a little more than normal input.
- **Stable-first, volatile-last ordering**: putting tools, instructions and fixed documents first and timestamps, ids and the question last, so the cacheable prefix stays identical.
- **Sliding window**: keeping only the last N turns; cheap but silently forgets early facts.
- **Summarisation / compaction**: replacing older turns with a summary when the context fills, keeping key facts at lower cost.
- **External memory (notes file)**: writing important facts outside the context so they survive trimming and restarts.
- **Tool output shaping**: returning only the fields the model needs, summarised and paginated, because every tool result is resent on later calls.

**Questions they could ask**
- **Q:** What is the difference between prompt engineering and context engineering?
  **A:** Prompt engineering is about wording the instruction. Context engineering is about the whole payload on every call: which documents are retrieved, which tools are offered, how history is kept, what tool results look like and in what order it all goes. Missing facts make the model guess, and irrelevant text costs money and latency and buries the facts that matter.
- **Q:** How do you lay out a prompt to get the most from prompt caching?
  **A:** The cache matches an identical prefix from the start, so one changing detail near the top invalidates everything after it. Put tool definitions in a fixed order, then the system prompt with no timestamp, then fixed documents, and put the current time, ids and the user's question last. Common mistakes are a "current time" line in the system prompt and building the tool list from an unordered set.
- **Q:** A support conversation runs to 50 turns and no longer fits. What are your options?
  **A:** A sliding window is simplest but drops early facts, such as an account number given in turn 2. Summarising when the window is around 70 per cent full keeps facts if the summary captures them. A notes file of key facts plus the last few turns is the most reliable. In practice you combine them: structured facts in memory, a running summary, and recent turns verbatim.
- **Q:** How do you stop tool results bloating the context?
  **A:** Shape the output at the source: return the handful of fields the model needs rather than the raw API response, summarise long lists and paginate with a cursor. Cap tool output size in the harness. Prefer trimming when the result is created rather than editing old messages later, because rewriting history also breaks the cache.
- **Q:** What is the trade-off between stuffing everything in and a lean context?
  **A:** Stuffing everything in covers every fact but costs more per call, adds latency and can reduce accuracy because relevant details are buried among irrelevant ones. Too lean saves tokens but misses facts and the model guesses. The engineered middle is retrieve and look up: the relevant policy sections and the one order, not the whole handbook and database.

**What I built:** a browser simulation with four parts: choosing context blocks and watching tokens, cost and fact coverage change; comparing three cache layouts; charting four memory strategies over a 50-turn conversation in a 20,000-token window; and a raw against shaped tool response. Sizes are illustrative and estimated at four characters per token.

## Harness Engineering (`/harness`)
**In one line:** the model proposes the next step; the harness (the code around it) runs the loop, provides tools, manages context, checks the work and decides when to stop.

**Key terms**
- **Harness**: the code that turns a model into an agent: loop, tools, permissions, context management, progress tracking, verification and stopping rules.
- **Definition of done**: a check in code, such as tests passing or a schema validating, rather than the model saying it has finished.
- **Sub-agent**: an agent started by another with an empty context, its own prompt and tools, that returns only its answer.
- **Permission rules**: deny, ask and allow rules checked before each tool call, with deny winning, then ask, then allow, and a person deciding the rest.
- **Compaction**: replacing older turns with a model-written summary when the conversation grows past a limit.
- **Agent Skills**: a folder with a SKILL.md and scripts; only the name and description sit in context until the task needs the rest (progressive disclosure).
- **Run limits**: maximum turns, a spending cap and a wall-clock or cancellation signal that turn a runaway loop into a report.
- **Managed harnesses**: the SDK tool runner, the Claude Agent SDK (Claude Code's loop as a library) and Claude Managed Agents (Anthropic runs the loop and sandbox).

**Questions they could ask**
- **Q:** Is an autonomous agent a property of the model or of the harness?
  **A:** Of the harness. At each step the model only proposes an action. The harness decides whether to run it, what the model sees next, which actions are allowed, whether the work is really finished and when to give up and ask a person. "Keep going until done" is a loop with a definition of done, and both live in your code.
- **Q:** How do you stop an autonomous agent running away with time or money?
  **A:** Check limits before every model call: a turn cap, an estimated spend against a per-run budget and a cancellation flag. In my harness the main agent stops with a StopRun error at its turn limit, while a stuck sub-agent reports a tool error to its parent, which can decide what to do. Retry timeouts and rate limits with backoff in the harness so the model never sees them.
- **Q:** When would you use sub-agents, and what do they cost you?
  **A:** Use them for side tasks that would flood the main context, such as reading many files, or that need a narrower tool set. They start with an empty context and return only a summary, which keeps the main conversation small and allows parallel work. The cost is extra calls, lost detail in the hand-off, and harder debugging, so you log each agent's conversation separately.
- **Q:** Can the harness run tool calls in parallel safely?
  **A:** Only when they cannot interfere. My harness, like Claude Code, groups consecutive read-only calls and runs them on a thread pool, while any call with side effects runs alone. All results still go back in one message in the original order.
- **Q:** Build your own loop, or use the Agent SDK or a managed service?
  **A:** Write your own when you need full control of every step or your tools are not files and a shell. The tool runner saves writing the loop for custom tools. The Agent SDK gives you Claude Code's tested loop, tools and context management but with a much larger system prompt per call. Managed Agents suit long-running or scheduled work when you do not want to run the sandbox infrastructure.

**What I built:** the page has a scripted autonomous run with harness features you switch off to see each failure, then a live mode that runs `python/11_harness_loop.py` through `HarnessService`: ten tools including three sub-agents and a bash tool behind deny/ask/allow rules, tool output capped at 2,000 characters, optional compaction, and a per-run budget. It runs as a background `Run` that streams NDJSON events to the page, every bash command waits for approval on the page (unanswered after a timeout means no), and a skills section runs Anthropic's xlsx/pptx/docx/pdf skills in the code-execution container and returns the file.

## Assistant (`/assistant`)
**In one line:** a general chat assistant built as an agent: it plans, works in a sandbox until it decides it is done, can split big jobs across parallel sub-agents, and shows every step it takes.

**Key terms**
- **Agentic loop**: call the model, run the tools it asks for, send back the results, and repeat until it answers without asking for a tool.
- **Plan first**: before any tool runs, the agent writes a checklist and keeps it up to date; an optional switch waits for a person to approve it.
- **Sub-agent**: a second agent with its own brief, history and folder, started by the main agent; several run at once and the main agent combines what they return.
- **Run budget**: one limit on spending for a whole turn, shared by the main agent and every sub-agent.
- **Compaction**: when a chat grows past a size, older turns are summarised and the summary is sent instead; nothing stored is deleted.

**Questions they could ask**
- **Q:** If there is no limit on the number of steps, what stops a runaway agent?
  **A:** Money and time. Each turn has a budget shared by every agent it starts and a wall-clock limit, the person can press Stop, and the lab's overall cap still applies. A step count is a poor proxy: one step can be a cheap file read or a long build, so the limits are set on what actually matters.
- **Q:** How does the chat keep working when you change model halfway through?
  **A:** The history is stored in one neutral shape, not inside a provider's session. Each call rebuilds the messages for the chosen model from the latest summary and the later steps, and drops the previous model's private thinking blocks, which another model cannot read. Files live in the lab's sandbox, not in one provider's container, so every model sees the same workspace.
- **Q:** Why run Claude's commands in your own sandbox instead of Anthropic's code execution?
  **A:** So every model shares one workspace and one log. With Claude in its own container, its files would be out of reach after a switch to GPT or the local model, and the commands it ran would not appear in the lab's activity log.
- **Q:** When should an agent split work across sub-agents?
  **A:** When the parts are independent and each is big enough to be worth its own context: research on several topics, one chart per dataset, sections of a report. Each gets a clear brief and its own folder so they cannot overwrite each other. Tightly linked steps stay with one agent, because handing context back and forth costs more than it saves.
- **Q:** The sandbox can reach the internet. What stops a web page or an uploaded file from steering the agent?
  **A:** The system prompt treats file and page contents as data, never instructions, and tells the agent not to send the person's files anywhere unasked. The sandbox holds no keys or credentials, and every command that reaches the network is flagged in the log. That reduces the risk; it does not remove it, which is why the log and the budget exist.
- **Q:** What does the activity log record, and why keep it?
  **A:** Every model call with its model, effort, tokens and cost; every plan and revision; every command with its output, exit code and time; every file made; compactions, model switches and failovers; and one lane per sub-agent. It is saved with the turn, so a strange answer can be traced to the step that caused it.

**What I built:** a chat page with stored chats, uploads, model and effort per message, and a live activity panel. Behind it, one streaming loop for Claude, GPT and the local model that plans, runs bash and file tools in the lab's Docker sandbox, reads the office-file skills, starts up to four parallel sub-agents in folders of their own, makes PDF, deck, spreadsheet and chart previews, compacts long chats, and stops on a shared budget, a time limit or Stop.

## Auto Routing in the Assistant (`/assistant`)
**In one line:** the lab picks a model and effort per message: cheap, explainable rules first, a tiny classifier only when they don't settle it, and one step up when the chosen model fails.

**Key terms**
- **Tier**: quick, standard or deep, each a ranked list of models in one table.
- **Ceiling**: a model the person sets that routing and escalation may not go above.
- **Escalation**: moving the rest of a turn to the next tier up, once, after a refusal, an empty or cut-off reply, or two failed tool rounds.
- **Baseline**: what the same tokens would have cost on Sonnet at medium effort; the savings are measured against it.

**Questions they could ask**
- **Q:** Why rules first and a model only when unclear?
  **A:** Most messages are obvious from cheap signals (a file attached, "make a chart", "prove"), and a rule costs nothing, adds no wait and can say why in one line. A classifier call is kept for the genuinely unclear ones, on the cheapest model with a 60-token cap and strict JSON.
- **Q:** What stops routing from making things worse?
  **A:** Capability rules (pictures never to the local model, PDFs only to Claude), one escalation when the cheap model fails, a ceiling the person can set, and a record of cost against an always-Sonnet baseline, so a router that saves nothing shows it.
- **Q:** Is the savings figure exact?
  **A:** No. It prices the routed turn's tokens at Sonnet's list prices. A different model might have used more or fewer tokens, so it is an estimate for comparing like with like, not a bill.

**What I built:** a router in one module with its tier table, the rules, a strict-JSON classifier, capability and ceiling checks, one-step escalation, a routing log with savings against Sonnet, an Auto switch in the assistant's model menu, route and escalate rows in the activity log, and an Auto routing card on the control layer page.

## Software Factory (`/software-factory`)
**In one line:** agents take tickets from plan to merge, and people step in by risk: low-risk changes run dark, medium ones wait for a person at the diff, high ones at the plan and the diff, and each area earns autonomy with a clean record.

**Key terms**
- **Risk tier**: low, medium or high, set by an explicit policy from the ticket's kind and area, and raised (never lowered) by what the work turns out to touch.
- **Running dark**: a change that plans, builds, passes every gate and merges with no person involved.
- **Gate**: an automatic check every change must pass: no new failing tests, no tests deleted or skipped, no secrets, nothing outside the project, the diff size, and an independent reviewer agent.
- **Baseline**: the tests already failing on main before a change starts; a change is judged on the failures it adds.
- **Earned autonomy**: an area's level (probation, standard, trusted) moves up after a run of clean changes and down at once when a defect escapes.
- **Escape**: a merged change that turns out to be wrong; reverting it records one.

**Questions they could ask**
- **Q:** How do you decide which changes an agent may merge without a person?
  **A:** With a written policy, not the model's judgement. The ticket's kind and area set a starting tier; evidence from the plan and the diff (a sensitive path, a new dependency, a big diff, edited tests, code no test covers) can only raise it. A trusted area may let declared medium-risk work run dark, but never work whose own evidence called for a person, and high-risk changes always need one.
- **Q:** What stops an agent from making the tests pass by changing the tests?
  **A:** A gate that compares the test files before and after: fewer test functions, a deleted file or a new skip marker blocks the change, and editing tests raises its tier so a person must look. The implementer is also told never to weaken a test.
- **Q:** Why a separate reviewer agent rather than asking the implementer to check its own work?
  **A:** The implementer has its own reasoning in context and tends to agree with it. The reviewer starts fresh, sees only the ticket, the diff and the test output, works from a checklist, and must return a verdict in a fixed format; no verdict counts as a fail.
- **Q:** How does a team earn more autonomy, and how does it lose it?
  **A:** Each area keeps a ledger. Three clean changes in a row (merged with no person correcting them) move it up a level, so medium-risk work there may run dark. A reverted change is an escaped defect: the area drops a level at once and its streak starts again. Trust is earned slowly and lost quickly, on purpose.
- **Q:** What happens when the project already has failing tests?
  **A:** The factory runs the tests on main before each change and records what already fails. A change passes the test gate if it adds no new failure; fixing old ones is shown as progress. Otherwise a docs change would be blocked by unrelated bugs, or an agent would be pushed to fix them out of scope.
- **Q:** How do you keep an audit trail you could defend?
  **A:** Every decision is recorded with who or what made it and why: the policy's tier and reasons, the planner, each gate's result and detail, the reviewer's findings, and each person's approval, note, edit or takeover. The full event stream is kept per change, and each merge is a git commit whose message names the ticket and the change.
- **Q:** Agents write code on your machine. What stops them reaching the host through git?
  **A:** They never see a repository. They work in a plain folder in the sandbox; the factory copies only their regular files into its own clone, never a .git folder or a link, and runs git there with hooks, fsmonitor, editors and outside config files switched off and no keys in its environment. Nothing an agent writes can become something git executes.

**What I built:** a factory on a copy of the practice project with an invented backlog, a tested risk policy, a read-only planner, an implementer in the sandbox, seven gates including an independent reviewer, person decisions on plans and diffs, real git merges and reverts in a clone only the factory touches, a per-area autonomy ledger, a flow board, metrics and a full audit trail per change.

## Shopping Assistant (`/shop-assistant`)
**In one line:** a shop agent is safe when the database, not the prompt, decides whose rows it can see, and the same question gets the same answer when retrieval is deterministic and answers are cached by everything they depend on.

**Key terms**
- **Row-level security (RLS)**: PostgreSQL policies that filter every query by a condition, here `customer_id = current_setting('app.customer_id')`; FORCE applies them to the table's owner as well.
- **SET LOCAL**: a setting that lasts until the end of the current transaction, so a pooled connection never carries one shopper's id into the next query.
- **Hybrid search with reciprocal rank fusion**: vector and keyword rankings merged by 1/(60 + rank), with ties broken by id so the order never changes.
- **HNSW**: a graph index for approximate nearest neighbours; built once after a bulk load, kept up to date on each write, rebuilt CONCURRENTLY after heavy churn.
- **CAG (cache-augmented generation)**: answering from a stored answer or a preloaded context instead of retrieving again.
- **FOR UPDATE SKIP LOCKED**: lets several workers take different rows from one queue table without waiting for each other.

**Questions they could ask**
- **Q:** RAG or CAG for a shop assistant?
  **A:** Both, for different things. Retrieval (RAG) is needed because a catalogue of a million products cannot sit in a prompt and stock changes all the time. Caching (CAG-style) suits repeated read-only questions: the stored answer is returned while nothing it depends on has changed. The key includes the data version, the shopper's state and profile, the conversation so far, the model and the prompt version, so a price change or a new purchase moves the key and the cache needs no expiry.
- **Q:** How do you stop the agent showing one customer another customer's orders?
  **A:** Not with the prompt. The tools have no customer parameter; the server takes the shopper from the session token, and each query runs as a role with no login and few grants, in a transaction that sets `app.customer_id`. Forced RLS then returns only that shopper's rows, so a guessed order id simply does not exist for them, and a write naming someone else fails the policy's WITH CHECK.
- **Q:** Why are the agent's queries run as a separate role?
  **A:** Superusers and, without FORCE, table owners bypass RLS. Switching to a NOLOGIN role for the transaction makes the policies apply, and its grants limit the damage of any bug: it can take stock but not change a price, and it cannot write the metadata table.
- **Q:** How do you make the same question get the same answer?
  **A:** Deterministic retrieval first: a fixed index, ranking by score then id, and a seeded data generator, so the model always sees the same results in the same order. Then cache the whole answer for read-only turns. Model sampling alone is not enough to rely on.
- **Q:** How do you keep embeddings in step with a changing catalogue?
  **A:** A trigger hashes exactly the text that is embedded; only when the hash changes does it mark the product pending and send a NOTIFY, so price or stock edits never re-embed. A worker listens, polls as a fallback, claims rows with SKIP LOCKED, retries with backoff and parks repeated failures in a dead-letter list. Searches keep the last good vector meanwhile. With several services writing products, the same idea scales through a transactional outbox or change data capture into a queue with a pool of workers.
- **Q:** How do you stop the model placing an order on its own, or being talked into it by a product description?
  **A:** The model can only propose: the tool returns totals worked out from the rows and a confirmation id, and the order is placed by a separate route when the person presses Confirm. That route rechecks the basket, takes the stock and locks the basket, so a double click or a second tab places nothing twice. Product text reaches the model marked as untrusted data, and the tools would refuse what it asks for anyway.

**What I built:** a shop website for an invented retailer with a chat agent that asks clarifying questions, on PostgreSQL with pgvector. It has per-shopper row-level security, hybrid search in a fixed order, an answer cache, confirm-only checkout and returns, consent-based browsing profiles with taste vectors and a guest-to-account merge, a self-maintaining embedding queue, and a live "Try to break it" check that tries to reach other shoppers' data and reports every attempt.

## Coding Agent (`/coding-agent`)
**In one line:** a coding agent built the way Claude Code is, where the short loop is easy and the rules that make it safe to point at code are the real work.

**Key terms**
- **Read-before-edit**: the edit tool refuses a file the agent has not read, or that changed since it was read.
- **Exact-string edit**: an edit replaces one old_string that must appear exactly once, so the change is unambiguous.
- **Permission modes**: default (ask before edits and unlisted commands), accept_edits, plan (read only), bypass (deny rules still apply) and auto (no approvals, only inside a sandbox).
- **Hooks**: harness code at fixed points: PreToolUse (protect .env and .git), PostToolUse (syntax check after editing Python) and Stop (send the agent back until tests pass).
- **Checkpoint**: the file's content saved before every write so it can be undone; shell side effects are not checkpointed.
- **OS sandbox**: an operating-system boundary for shell commands (sandbox-exec on macOS, bubblewrap on Linux, a Docker container or an Azure Container Apps dynamic session) limiting writes, reads and environment.
- **Tool-result clearing**: replacing old tool outputs with a placeholder in one go once the context passes a limit, so the cache breaks once rather than every turn.
- **Explore sub-agent**: a read-only helper with an empty context that returns a short report.

**Questions they could ask**
- **Q:** Why sandbox a coding agent, and why is a deny list not enough?
  **A:** A shell is a general tool: with it the agent can do almost anything, including reading credentials or deleting files. Pattern deny lists are easy to get around with substitution, redirects, scripts or encoded commands, so they are a convenience, not a boundary. Letting the agent run without approvals is only safe inside a boundary the operating system enforces: writes only in the project, no home folder or .env, and a clean environment with no API key. On a server that holds a managed identity, commands must not run in that container at all, so I run them in a separate per-session container.
- **Q:** Why does your edit tool refuse blind edits?
  **A:** Most damage from coding agents comes from editing code the model has not seen, or a file someone else changed meanwhile. Requiring a read since the last change, and an old_string that appears exactly once, turns those cases into tool errors the model reads and fixes, usually by reading again. Every write is checkpointed first, so a person can undo it.
- **Q:** How do you make "done" mean done?
  **A:** A model saying it has finished is a claim. A Stop hook checks evidence: if the agent changed files, the harness runs the test command and, if it fails, sends the agent back with the failure as a system reminder. I cap that at three attempts so a task it cannot solve still ends.
- **Q:** Why does plan mode not remove the edit tools from the tool list?
  **A:** Tool definitions sit at the start of the cached prefix, so changing the list would invalidate the cache for the whole conversation. Plan mode is instead a note in the next message plus permission checks that refuse edits. For the same reason, old tool results are cleared in one batch when the context passes a threshold, not a few per turn.
- **Q:** What does the agent do when there is no tool for the job, such as making an Excel file?
  **A:** In auto mode it uses the shell as the general tool: it writes a script or installs a package into the project's own virtual environment. Successful installs are recorded and listed in later sessions' instructions so they are reused. That is only allowed because the sandbox contains it; without a sandbox, auto mode keeps the full deny rules.

**What I built:** `python/19_coding_agent.py` (about 500 lines of harness, no framework) has file tools with the read-first rule, glob, grep, a bash tool that splits compound commands and checks every part, modes, hooks, CLAUDE.md in the system prompt, a to-do list, checkpoints with undo, an explore sub-agent, image results for screenshots, a turn cap and a spending budget. The backend runs it as a streamed `Run` with approvals on the page; the same task can run on the Claude Agent SDK, and the hand-built harness also runs on a GPT deployment by translating Claude-format messages to Chat Completions on each call.

## Deck Builder (`/decks`)
**In one line:** a conversation that builds and revises a real PowerPoint deck, where the model looks at its own rendered slides and fixes the layout before you download it.

**Key terms**
- **Agent Skill (pptx)**: a packaged folder of instructions and scripts for making PowerPoint files, loaded only when the task needs it.
- **Code execution container**: a sandboxed environment on Anthropic's side where Claude runs code and skills, kept between turns by passing its container id.
- **Files API**: uploads files once and refers to them by id, so attachments go into the container without being inlined in every request.
- **Visual self-review**: rendering slides to images and sending them back to the model so it can check spacing, alignment and overflow.
- **Change detection by hash**: only slides whose image changed since the last check are sent again.
- **Image token cost**: roughly width × height / 750 tokens, so a 960 × 540 slide is about 700 tokens.

**Questions they could ask**
- **Q:** Why render the slides and send them back to the model?
  **A:** The model writes the deck through code and cannot see the result in the container, so it has no idea whether text overflows or shapes overlap. Rendering to PDF with LibreOffice, then to PNG per slide, and sending those images back closes the loop: the model inspects its own output and fixes what it sees. I limit this to two review rounds so cost and latency stay bounded.
- **Q:** How do you keep the cost of follow-up edits down?
  **A:** Each slide image costs about 700 input tokens, so re-checking a 20-slide deck after a one-word change is wasteful. I hash every rendered slide and send only the ones that differ from what the model last checked, so a change to one slide costs one slide's review. I also cap review messages at 30 slides.
- **Q:** What are skills and why use them rather than a long system prompt?
  **A:** A skill is a folder with SKILL.md and scripts. Only its name and description stay in context; the full instructions and scripts load when the task needs them, which is progressive disclosure. Deterministic work goes in scripts, which run the same way every time and cost no context to read.
- **Q:** What are the trade-offs of running in Anthropic's container against your own sandbox?
  **A:** Anthropic's container needs no infrastructure and comes with the official skills, but it only works with Claude and files have to go through the Files API. My own sandbox lets GPT or a local model build decks with my own pptx skill, at the cost of running and securing it. A deck stays with the kind of model it started with, because each keeps its files in a different place.

**What I built:** `DecksService` uploads attachments and an optional .pptx template to the Files API (deleted after a day or on New deck), runs Claude with the pptx skill in the code-execution container and reuses the container across turns, then sends changed slide images back for up to two review rounds. With GPT or the local model the same conversation runs in the lab's sandbox through `python/sandbox_skills.py`; progress streams to the page as a background `Run`.

## Site Builder (`/site-builder`)
**In one line:** describe an app and watch it being built: the model writes the files while the app runs live beside the conversation, every change is a version you can go back to, and errors from the running app come back to the model with one click.

**Key terms**
- **Confined file tools**: the model can only write, edit, read, list and delete text files inside the site's folder; it runs no commands.
- **Sandboxed preview**: the app is served with a Content-Security-Policy `sandbox`, so it runs in an opaque origin with no access to the lab's API, cookies or storage.
- **Version**: a snapshot of the site's files after a turn that changed them; restoring one is itself a new version, so nothing is lost.
- **Error reporter**: a small script added to every served page that only sends uncaught errors, rejected promises and console errors to the page that frames it.
- **Visual check**: after a turn, the server screenshots the site at desktop and phone widths and shows the model the pictures and console errors so it can fix what it sees.
- **Effort**: how long the model thinks before answering, chosen per message; Claude takes five levels, GPT three, and the local model none.

**Questions they could ask**
- **Q:** How do you let a model build a web app without risking the system it runs on?
  **A:** Narrow tools and a sandbox. The model only gets file tools confined to one folder, with checks on paths, file types and sizes, and no shell. The result is served under a CSP sandbox, so even hostile JavaScript runs in an opaque origin and cannot call the lab's API or read its storage, whether it is in the preview or opened in its own tab.
- **Q:** How do you report errors from a sandboxed iframe back to the page?
  **A:** With a one-way postMessage. A tiny script, injected first in the head, catches errors and posts a fixed-shape message to the parent; it listens to nothing, so it opens no door into the sandbox. The parent accepts only messages whose source is that frame and whose shape matches, and treats the text as untrusted. Because a sandboxed page has an opaque origin, its own scripts count as cross-origin and their errors arrive as a bare "Script error." unless they are loaded with CORS, so the server adds `crossorigin` to the site's own script tags.
- **Q:** Why keep versions as snapshots rather than replaying the model's edits?
  **A:** A snapshot is exact and cheap for a site of a few megabytes: restoring is a copy, viewing an old version is just serving another folder, and nothing depends on edits replaying cleanly. Each restore becomes a new version, and the model is told with the next message, so it reads the files again instead of trusting its memory of a state that no longer exists.
- **Q:** What does the model see between turns?
  **A:** The whole conversation, including its own tool calls and results, which is cached, plus anything the person did meanwhile, such as restoring a version, as a short notice before their next message. When it is unsure what a file contains, it reads it first.
- **Q:** Why screenshot the result and show it to the model?
  **A:** Code that parses is not a page that looks right. Showing the model its page at 1280 and 390 pixels, with the console errors, lets it catch overflow, contrast and layout mistakes it cannot see from the source. It is limited to two rounds so a turn cannot loop.
- **Q:** How do you build "something like this" from a screenshot without copying it?
  **A:** The picture goes to the model with an instruction to match layout, spacing, colours and typography in its own code and words, never copying text, logos or images. Uploads are checked by content and shrunk before use, and a model that can't read pictures is refused clearly.
- **Q:** What stops two tabs from changing the same site at once?
  **A:** A per-site lock: a second message, a restore or a delete while a turn is running is refused with 409, and the list of sites shows which ones are being built.

**What I built:** a split view with the conversation on the left and the running app on the right (versions, device frames, reload, new tab, full screen, zip), a start screen with ideas and a gallery of earlier apps with screenshot thumbnails, per-turn change summaries with version chips, snapshot versions (the last 20) that can be viewed or restored, a one-way error reporter with "Ask to fix", and the visual check, all kept on disk per site.

## Tutor (`/tutor`)
**In one line:** a spoken tutor on a 3D avatar: an English speaking partner with corrections and pronunciation scores, or a subject tutor that explains aloud and in writing.

**Key terms**
- **Streaming response**: receiving the reply token by token so speech can start before the reply is complete.
- **Speech-to-text and text-to-speech**: Azure Speech turns the learner's voice into text and the tutor's text into voice.
- **Pronunciation assessment**: Azure Speech scores how accurately and fluently a learner said a sentence against reference text.
- **Visemes**: mouth shapes with timings that the TTS service returns, used to lip-sync the avatar.
- **Short-lived token**: a credential the backend issues to the browser so the Speech key never leaves the server.
- **Structured outputs (JSON schema)**: the feedback call is constrained to a schema of corrections, vocabulary, level and tip.
- **Spoken/written split**: subject answers come in two parts separated by `===`, a short part spoken aloud and a longer written working with LaTeX.

**Questions they could ask**
- **Q:** How do you keep a voice tutor responsive when it also gives detailed feedback?
  **A:** Each English message makes two Claude calls at the same time. One streams the reply, and the page speaks it sentence by sentence as text arrives. The other returns structured feedback as JSON. Running them side by side keeps the reply as fast as a single call, and if the feedback call fails the conversation still carries on.
- **Q:** How do you split a streamed answer into a spoken part and a written part?
  **A:** The prompt asks for a short spoken part, a line of `===`, then the written explanation. A small parser buffers the stream and holds back the last few characters, so a delimiter that arrives split across chunks is never spoken. Everything before the delimiter goes to speech, everything after goes to the screen.
- **Q:** How do you keep the browser's speech credentials safe?
  **A:** The Speech key stays on the backend. The browser asks the backend for a short-lived authorisation token for the region and reuses it for eight minutes (tokens last about ten) before asking again. If the main Speech resource refuses, the backend can issue a token for a fallback resource.
- **Q:** What stops a long tutoring session getting expensive?
  **A:** The conversation lives in the page and is sent back each turn, so I cap it at 40 messages and keep only the last four images, replacing older ones with a note. Feedback runs at low effort with a capped output length, and every reply is charged to the spending tracker, which refuses requests once the budget is used.

**What I built:** `TutorService` builds the system prompt from level, scenario (including a job role-play mode built from a pasted role description) and coaching settings, then runs the streamed reply and the JSON-schema feedback call in one background `Run`. The page drives a TalkingHead avatar with Azure's visemes, sends speech for transcription and pronunciation scoring, and accepts screenshots or photos of homework for subject tutoring.

## Claude Code Setup (`/claude-code`)
**In one line:** Claude Code is a harness you shape with CLAUDE.md, skills, hooks, subagents, MCP servers and plugins, each for a different job.

**Key terms**
- **CLAUDE.md**: standing instructions loaded into context at the start of each session, at organisation, user, project and local scope; guidance, not enforcement.
- **.claude/rules/**: rule files with a paths field that load only when matching files are touched.
- **Skill**: a folder with SKILL.md (plus references and scripts) whose description is always in context and whose body loads when relevant or when called as `/name`.
- **Hook**: a command or handler that Claude Code runs at fixed events (SessionStart, PreToolUse, PostToolUse, Stop and others), receiving the event as JSON on standard input.
- **Exit code 2**: the hook result that blocks the action and sends standard error back to Claude; exit 1 is only a non-blocking error.
- **Subagent**: a Markdown-defined assistant with its own context, prompt and tool list, used to keep side work out of the main context.
- **Plugin**: a package of skills, subagents, hooks and MCP servers shared through a marketplace.

**Questions they could ask**
- **Q:** Someone writes "never edit .env" in CLAUDE.md. Is that enough?
  **A:** No. CLAUDE.md is context the model follows as guidance, so it can be ignored or forgotten. Anything that must always or never happen belongs in a permission deny rule or a PreToolUse hook that exits with code 2, which blocks the call whatever the model decides.
- **Q:** When do you use a skill instead of putting instructions in CLAUDE.md?
  **A:** CLAUDE.md is paid for in every session, so it should hold short, always-true facts such as build commands and conventions, ideally under about 200 lines. Procedures and reference material that matter only sometimes go in skills, because only the description is loaded until Claude needs the rest. Skills with side effects, like a release, should set disable-model-invocation so only a person can start them.
- **Q:** What are subagents good for, and how would you configure a safe one?
  **A:** They protect the main context: a search that reads fifty files happens in the subagent's own window and only its summary comes back. Give it only the tools it needs; a reviewer with Read, Glob and Grep cannot change anything. Write its description for the delegation decision, because Claude uses it to decide when to hand work over.
- **Q:** What are the risks of hooks and plugins, and how do you manage them?
  **A:** Hooks run with your full user permissions on every matching event, and plugins can bring hooks and MCP servers that run code on your machine. Read every hook before adding it, quote variables and reject `..` in paths, use `$CLAUDE_PROJECT_DIR` for absolute paths and keep hooks fast. Install plugins only from sources you trust, and keep them focused, because every enabled plugin's descriptions sit in context.

**What I built:** an explainer page with a "which one do I need?" picker and a stepped session that shows what enters Claude's context, what loads on demand and what runs as plain code. Copyable examples of every piece are in `examples/claude-code/`, stored under names Claude Code does not load so they do not configure the repo.

## Inside Claude Code (`/claude-code-inside`)
**In one line:** thirteen chapters that show, step by step, what Claude Code sends to the model, what runs on your machine and what is in the context window.

**Key terms**
- **Stateless API**: the model keeps nothing between requests; Claude Code resends the system prompt, tools, CLAUDE.md and the whole conversation each time.
- **Agentic search**: finding code with grep, find and file reads through tools, rather than a prebuilt embedding index.
- **Tool search (deferred tools)**: MCP tool names are listed up front and their full definitions are loaded only when needed, to save context.
- **Auto-compaction**: when the context nears its limit, older tool output is cleared and the conversation is replaced by a summary.
- **Checkpoints and rewind**: every prompt is a checkpoint that can restore code and conversation, but only for edits made by Claude's file tools.
- **Permission modes and rules**: allow, ask and deny rules in settings files, with the mode (such as plan mode) deciding unmatched cases.
- **/sandbox**: runs shell commands inside an OS sandbox that limits files and network hosts they can reach.

**Questions they could ask**
- **Q:** How does Claude Code find the right code in a large repository without an index?
  **A:** The model guesses likely names from your prompt and asks Claude Code to run grep or find; only the matching file names come back into the context. It then reads the relevant files as numbered text. This agentic search is always up to date and needs no indexing, at the cost of extra tool round trips; pointing at the file yourself with @ skips the search.
- **Q:** What happens when a long session fills the context window?
  **A:** Claude Code first clears older tool output, then asks the model to summarise the conversation and replaces the history with that summary. The system prompt, CLAUDE.md (read again from disk), the plan, a few recently changed files and the skills used are kept. Instructions you gave only in the chat and the detail of old tool output can be lost, so put lasting rules in CLAUDE.md or compact manually with a focus.
- **Q:** Can you rely on rewind as your undo?
  **A:** Only partly. Checkpoints track edits made by Claude's file-editing tools. Files changed by shell commands like `rm`, `mv` or a database migration are not restored, and neither are edits made outside Claude Code. It is a quick local undo, not version control, so commit before big changes.
- **Q:** How would you let Claude Code run more commands without approving each one, safely?
  **A:** Use permission rules: allow known-safe commands such as the test runner, ask for things like git push, and deny reading secrets. Then turn on the sandbox, which enforces file and network limits at the operating-system level for shell commands, so you can allow more without a prompt each time. Note that the sandbox covers shell commands, not file tools, MCP servers or hooks.
- **Q:** Why is prompt caching central to how a tool like this works?
  **A:** Every request resends a large stable prefix: a few thousand tokens of system prompt, around ten thousand of tool definitions, CLAUDE.md and the conversation so far. Caching that prefix makes repeated calls much cheaper and faster. It is also why mid-session edits to CLAUDE.md only fully apply after compaction or a new session, and why the tool list should stay fixed.

**What I built:** an animated walkthrough (`claude-code-chapters.js` plus an SVG map) that plays each step three ways at once: the terminal, the packets between Claude Code, the model and your files, and the context window with illustrative token counts. It has a presenter mode with keyboard control; facts were checked against the Claude Code documentation.

## MCP Servers (`/mcp`)
**In one line:** the Model Context Protocol is a standard way to offer tools and data to any AI application, shown with a real server you can call directly and then watch Claude use.

**Key terms**
- **MCP server and client**: the server exposes tools, resources and prompts; the client (Claude Code, Claude Desktop, your own agent, or the API connector) connects and uses them.
- **Tools, resources, prompts**: functions the model chooses to call; data the user or app attaches by URI; reusable starting messages the user picks, shown as slash commands in Claude Code.
- **JSON-RPC methods**: the wire format, with calls such as `tools/list` and `tools/call`.
- **Transports**: stdio, where the client starts the server as a local process, and Streamable HTTP, a hosted server at a URL with OAuth bearer tokens.
- **Tool annotations**: hints such as read-only or open-world that let the client decide whether to ask a person first.
- **Idempotency key**: a client-supplied unique key so a retried write is applied once.
- **Scopes and audience**: what a token permits (read, write) and which server it was issued for; a token for another server is refused.

**Questions they could ask**
- **Q:** Why would you build an MCP server instead of defining tools directly in your agent?
  **A:** You write the integration once and every MCP client can use it: Claude Code, Claude Desktop, your own harness, or the Claude API's MCP connector. Authentication, validation and data access sit in one place owned by the team that owns the data. The trade-off is another service to host, secure and version, so for a single agent with a couple of internal functions, plain tools are simpler.
- **Q:** How do you design good MCP tools?
  **A:** Few tools, each a whole task, with clear names, descriptions and examples, and constrained inputs validated before your code runs, such as a limit between 1 and 20. Keep results small: search returns summaries and pages with an opaque cursor. Make errors instructions, such as "no engagement with that id; use search_engagements to find it". Mark writes, and make them safe to retry with an idempotency key.
- **Q:** How would you authenticate a hosted MCP server, including when a backend calls it for a user?
  **A:** Host it stateless and authenticate every request with an OAuth bearer token that carries scopes and is issued for this server's URL. A backend calling as itself uses the client credentials grant, or a managed identity on Azure, with only the scopes it needs. For a signed-in user, never forward their token; exchange it (token exchange, or On-Behalf-Of in Entra) for one meant for the MCP server that still names the user.
- **Q:** Who decides whether a write tool may run: the model, the server or the client?
  **A:** Not the model. The server enforces scopes, so a read-only token cannot write. The client or harness decides on approval: in my harness, any tool the server does not mark read-only is declined unless writes are allowed, and Claude is told why.
- **Q:** What does it cost to connect many MCP servers to an agent?
  **A:** Each tool's name, description and schema is context, so many servers mean more tokens on every request and a harder choice between similar tools. Keep servers focused and allowlist only the tools an integration needs.

- **Q:** Walk me through one MCP tool call, end to end.
  **A:** When the host starts, say Claude Code, its MCP client connects to each server, agrees a protocol version with `initialize`, and gets the tools with `tools/list`, once. When you ask a question, the host sends it to Claude with every tool's name, description and schema. Claude doesn't run anything: it replies with a `tool_use` block. The host checks permissions, its MCP client sends `tools/call` to the server, and the server does the real work with its own credentials, for example calling GitHub's API. The result goes back to the host, which sends it to Claude as a `tool_result`, and Claude answers in words. Claude never talks to the server and never sees its token. With the API's MCP connector, Anthropic's side plays the client instead. [Claude Code setup](/claude-code#mcp) steps through every message.

**What I built:** the backend hosts the example server (`examples/mcp/server.py`, MCP Python SDK 2.x) at a real Streamable HTTP endpoint with demo read and write bearer tokens, so the page can send raw `tools/list` and `tools/call` requests, including a bad id and an input that breaks the schema. A small harness gives Claude the same tools in-process, capped at eight turns, and blocks writes unless "Allow writes" is on; `examples/mcp/` also has tests and a connector example with a read-only allowlist.

## Agent Workflows (`/workflows`)
**In one line:** the shapes a multi-agent system can take, when each fits, and what stops each one going wrong.

**Key terms**
- **Sequential**: agents run in a fixed order, each adding to the last one's work.
- **Concurrent (fan-out/fan-in)**: several agents work on the same input at once, and something combines their answers.
- **Handoff**: the active agent passes full control to a better-placed one.
- **Group chat**: agents share one conversation and a manager picks who speaks next.
- **Maker-checker**: one agent writes, another judges against criteria, in a loop with a cap.
- **Magentic**: a manager keeps a task ledger and a progress ledger, picks who acts next and replans when work stalls.
- **Subagent (agent as a tool)**: a worker with an empty context that the main agent calls like a function and that returns only its answer.
- **Checkpoint**: saved workflow state, so a crashed or paused run resumes without repeating finished work.
- **Declarative workflow**: the steps and routing held in a YAML file, with Power Fx expressions for conditions, loaded by a small program that supplies the agents.

**Questions they could ask**
- **Q:** Fan-out or handoff: how do you choose?
  **A:** They solve different problems. Fan-out runs several agents at once on the same input and needs a rule for merging or settling disagreement. Handoff runs one agent at a time and passes control when a different specialist is needed. If the right specialist can be read from the input, I use neither: a model fills in a typed ticket and plain code routes it, which is cheaper and easier to test.
- **Q:** What is the difference between a subagent and a handoff?
  **A:** Control. A subagent is called like a function: the orchestrator stays in charge and gets one answer back, and the worker's reading never enters its context. In a handoff, control passes over and the next agent carries on with the conversation. Subagents protect context but cost more tokens overall, and the main agent sees only the summary.
- **Q:** How do you stop a multi-agent system looping for ever?
  **A:** Every loop needs a limit and a fallback: turn limits on handoffs, max rounds on group chat, an iteration cap on maker-checker, and round, stall and reset limits on Magentic, plus a per-run budget. In my Magentic example, workers that kept asking for data nobody had sent the manager round in a loop until the reset limit ended the run. Telling them to state assumptions and answer fixed it.
- **Q:** When would you define a workflow in YAML instead of code?
  **A:** When people need to change the flow without a code release, or want to review it as data, such as changing a route or some fixed wording. In my example a safety message gets a fixed reply straight from the YAML, with no second model call. The cost is that expressions are a small language and mistakes appear at run time, so it still needs tests. It also added a dependency: Power Fx needs a .NET runtime and isn't published for Python 3.14, so mine runs in its own Python 3.12 environment.
- **Q:** When would you not use multi-agent at all? (trade-off)
  **A:** Most of the time. Microsoft's guidance starts from a direct model call, then a single agent with tools, and only then orchestration. In my runs a sequential workflow cost about a tenth of a cent, and Magentic about two cents for a similar-sized question, more than ten times as much, and it was slower. More agents means more calls, more shared context and more ways to fail, so each one has to earn its place.
- **Q:** How do you put a human in the loop properly?
  **A:** Make it structural. The workflow stops at `request_info` and holds its state, and only the agent past the gate has the tool that acts, so the plan cannot send anything before someone approves. With a checkpoint, the wait can outlast the process. Approve only what matters, because people stop reading prompts that appear for every step.

**What I built:** thirteen runnable programs on Microsoft Agent Framework and Azure OpenAI, sharing one runner that streams events, meters tokens against the spending cap and stops at a per-run budget. The page draws each diagram from the built workflow, replays real recorded runs for free, and runs them live, including a real pause for approval.

## Shoplifting Alert Desk (`/store-watch`)
**In one line:** where automation has to stop and a person has to decide, when a mistake means accusing someone of a crime.

**Key terms**
- **Behaviour score**: how much a movement resembled theft to the model. It is not the probability that the person stole.
- **Held face**: a template kept for review after a high score, which can't trigger any door alert.
- **Possible match**: a face similarity above a threshold, which a trained person must check before anyone is approached.
- **Special category data**: biometric data used to identify someone, which needs an Article 9 condition under UK GDPR.
- **DPIA**: a data protection impact assessment, done before high-risk processing starts.
- **False match**: an innocent person scoring above the threshold.

**Questions they could ask**
- **Q:** Why not add someone to the watchlist automatically when the model is over 90% confident?
  **A:** Because the score measures how much a movement looked like theft, not whether a theft happened. In my simulation, a phone going back in a handbag scores 93. Auto-adding would put an innocent person on a list that flags them at every visit, on a fully automated decision about biometric data. So a high score does everything short of that: it alerts the admin at once and holds the face at the top of the queue, and a held face can't match at the door.
- **Q:** How can a model tell someone left without paying, when it only sees a few frames at a time?
  **A:** It can't from one look, so I give it memory. Each few seconds it reports what it can see, such as picked up, put back, paid or left, along with its reasoning, and it gets its own earlier notes as context. Plain code then keeps the state: picking up starts carrying, paying or putting back ends it, and leaving while carrying raises the alert. The model reads the pictures, and the rule is code you can test.
- **Q:** How do you decide what can be automated?
  **A:** By the cost of being wrong and whether it can be undone. Alerting a person is cheap to get wrong, so I automate it. Accusing someone is not, so a person decides, and the system records who decided and on what evidence.
- **Q:** What happens to shoppers who aren't on the list? (privacy)
  **A:** Their face is compared and immediately discarded. The system keeps a count and nothing about them. That has to be true in the code and tested, because it is what you tell the regulator and put on the sign at the door.
- **Q:** How would you set the match threshold?
  **A:** On your own cameras, with measured false match and miss rates, and checked across demographic groups. A lower threshold catches more returning offenders and flags more innocent people. At 5,000 visitors a day, even 0.1% false matches is five innocent people flagged daily, so a person always confirms before anyone is approached.
- **Q:** What would stop you shipping this to a real shop?
  **A:** A completed DPIA and legal advice on the lawful basis, because substantial public interest for shoplifting is contested. Then signage, staff training, a tested provider and a way to handle erasure requests. The simulation enforces the shape of these, but recording a reference doesn't make anything lawful.

**What I built:** an alert desk that runs on scripted people or, in a test mode for people who have agreed, a real webcam. A behaviour model on Azure OpenAI sees frames with faces blurred in the browser and keeps a running account of the visit, and plain code applies the rule that someone left while carrying something unpaid. A face model in the browser makes 128-number templates. The rules are enforced in the service and covered by tests, not the page. It has a score-driven admin alert, held faces that expire, one named reviewer who must confirm having watched the footage, possible matches for staff, retention, removal and an audit log.

## Agent Types (`/agent-types`)
**In one line:** thirteen kinds of agent, what each is for, when not to use it, and where each is built in the lab with the command that runs it.

**Key terms**
- **Reflex agent**: fixed rules from input to action, with no model. Fast and predictable.
- **Planning agent**: writes a plan first, then carries it out step by step.
- **Memory agent**: keeps what it learns about a person between separate sessions.
- **Self-improving agent**: reviews its own results and changes its instructions for next time.
- **Browser and computer use agents**: act on web pages or a whole screen through screenshots, clicks and typing.
- **Autonomous agent**: runs towards a goal with no human in the loop, which needs the strongest limits.

**Questions they could ask**
- **Q:** When should you not build an agent?
  **A:** When the steps are known in advance. A fixed workflow, or even plain code, is cheaper, faster and easier to test. An agent earns its place when the path depends on what it finds along the way.
- **Q:** What makes an agent risky?
  **A:** What its tools can change, not how clever it is. Read-only tools are low risk. Tools that send, pay or delete need limits in code and a person's approval.

**What I built:** lesson scripts `python/20` to `25` (reflex, planning, memory, self-improving, browser and computer use, the last two driving headless Chrome through `python/chrome_driver.py`), and the page that maps every type to where it runs.

## Building Agents as Software (`/building-agents`)
**In one line:** agents explained in developer terms, in the lab's own code: the request and response, a tool's schema, and the same loop written four ways.

**Key terms**
- **Messages API**: one request holds the model, system prompt, messages and tools; the reply holds content blocks and a `stop_reason`.
- **Tool schema**: a JSON Schema describing a tool's input, which the model fills in.
- **Agent loop**: call the model; if it asks for a tool, run it in code and send the result back; stop when it answers.
- **Rules as code**: limits enforced by the tools, not by the prompt.

**Questions they could ask**
- **Q:** What is an agent, to a developer?
  **A:** A loop around a model call. The model chooses the next tool; your code runs it, checks it and returns the result. Everything else (memory, approvals, retries) is ordinary software around that loop.
- **Q:** Why write the loop four ways?
  **A:** To show what frameworks hide. By hand with the Claude API, in my harness, in Microsoft Agent Framework and with Foundry's Responses API, it is the same loop. Knowing that makes any framework easy to pick up and debug.

**What I built:** a static page with code from the lab: MedAssist's rules as code, and testing against the database.

## Planning Patterns (`/planning-patterns`)
**In one line:** one task run four ways at once (a plain tool loop, ReAct, plan and execute, and reflexion), each streamed live and marked against the known right answer.

**Key terms**
- **ReAct**: the model writes a short thought before each action, then sees the result.
- **Plan and execute**: plan all steps first, run them, and replan after a failed step.
- **Reflexion**: a critic reviews the answer, and the agent gets one retry with the critique.
- **Step cap**: a hard limit on model calls, so a confused agent stops.

**Questions they could ask**
- **Q:** Which pattern is best?
  **A:** It depends on the task, which is why the page runs all four on the same one. Modern models do well with a plain tool loop. Plan and execute helps on long tasks where steps are known; reflexion helps when the first answer is often wrong, at twice the cost. The page shows calls, tokens, time and cost for each.
- **Q:** How do you test agents fairly?
  **A:** On an invented shop with fixed data and a fixed "today", so every answer has one right value that code checks. One task makes the stock system fail the first time, to see who recovers.

**What I built:** a backend that streams four patterns in parallel against one tool set, with step caps (14 model calls, 24 for plan and execute) and a budget per run.

## The Cognitive Core (`/cognitive-core`)
**In one line:** Andrej Karpathy's idea that a small model which reasons and uses tools could replace a big one that memorises, tested: two models, three setups each, ten questions marked by code, then distillation in the browser.

**Key terms**
- **Cognitive core**: a model of about a billion parameters that keeps the ability to reason and use tools, with its knowledge outside it in search, memory and tools.
- **Closed book**: answering from the weights alone.
- **Retrieval done for it (RAG)**: code searches with the question and puts the best entries in the prompt.
- **Agentic retrieval**: the model decides what to search for, and when, and can search again.
- **Knowledge distillation**: a small student trained on a big teacher's full probabilities ("soft targets") instead of single labels.

**Questions they could ask**
- **Q:** Does a 1B model really match a big one?
  **A:** On knowledge, given the facts, nearly: on this machine the 0.8B model got 7 of 10 with retrieval done for it, the 9B 8, and both only 4 from memory. On deciding to look things up, no: with its own tools the 0.8B got 1 of 10 because it never chose to search, while the 9B got 10. A cognitive core has to be trained to lean on tools; until then the harness does the retrieval.
- **Q:** Why an invented island?
  **A:** So no model can know the facts from training: any right answer about it came from retrieval. A few real-world facts show the other side, where a model's memory helps.
- **Q:** Why does distillation help a small model?
  **A:** A teacher's probabilities say how close each example was to the other classes, so the same data carries more. In the demo a straight-line student learns from 6 points to 69% with bare labels and 90% with soft targets.

**What I built:** a backend that runs six setups side by side on each question and streams every step, a gateway for a second, small local model beside the default one, and a seeded distillation demo in TypeScript.

## Agent Memory (`/agent-memory`)
**In one line:** an assistant that remembers people across separate sessions, showing all fifteen building blocks of agent memory as they happen, on the local model, Claude or GPT.

**Key terms**
- **Working memory**: the current conversation.
- **Episodic memory**: what happened in earlier sessions.
- **Semantic memory**: facts about the person, such as their job or allergies.
- **Procedural memory**: how they like things done.
- **Consolidation**: merging new memories into existing ones instead of piling them up.
- **Decay and forgetting**: older, unused memories lose weight by a half-life and are dropped.
- **Provenance**: each memory keeps the quote it came from, checked against what the person really said.
- **Isolation**: one file per person, so memories never mix.

**Questions they could ask**
- **Q:** Who decides what to remember, the model or the code?
  **A:** Both. The model chooses what is worth keeping with `remember` and `forget` tools. Code applies the rules: it checks the quote really appears in what the person said, resolves conflicts, applies decay, and refuses sensitive data through a privacy guard.
- **Q:** Why not keep the whole conversation history?
  **A:** It grows without end, costs tokens every turn, and mixes trivial with important. A short profile that is always loaded, plus one-off memories retrieved when relevant, is cheaper and works better.
- **Q:** How do you test memory?
  **A:** A scenario plays three sessions for one person with time jumps, then a second person, and checks what is recalled, updated, forgotten and kept apart. On the local model it costs nothing.

**What I built:** `python/22_memory_agent.py` for the rules and the guard; the page streams each step and keeps memory in `generated/agent-memory-lab/`.

## Memory Stores (`/memory-stores`)
**In one line:** folders of small, versioned text files that a coding agent reads and writes across sessions, as in Claude Managed Agents but kept on this machine.

**Key terms**
- **Memory store**: a named folder of memories with a description, mounted into an agent's workspace.
- **Mount**: the store appears as `.memory/<store>/`, read-write or read-only.
- **Version**: every change to a memory is kept, signed by the session that made it, so it can be restored or redacted.
- **Redact**: removing a version's content for good (for example a secret) while keeping that a change happened.

**Questions they could ask**
- **Q:** Why files rather than a vector database?
  **A:** A coding agent is already good at reading and writing files, and people can read, edit and review them. A small store with an index of its files in the agent's instructions is enough; search can come later.
- **Q:** How do you make sure the agent actually writes memory?
  **A:** A Stop hook sends a run back until it has written to a read-write store, at least a session note. Without it, agents often finish without recording anything.
- **Q:** What stops the agent damaging memory?
  **A:** Changes to a read-only store are refused and put back. Anything that looks like a key or token is refused. Symlinks are never followed, and non-text files are refused. Each change is a new version, so nothing is lost.

**What I built:** `backend/app/services/memory_stores.py` (stores, versions, restore and redact, in `generated/memory-stores/`), the mounts and sync in the coding agent, and the page to browse, edit and compare versions. It works on the local model, Claude and GPT.

## Code Knowledge Graph (`/code-graph`)
**In one line:** a codebase read into a graph of files, functions, imports and calls by code, then questioned by a model through tools over the graph.

**Key terms**
- **Parse, don't guess**: Python is read with `ast`; JavaScript and TypeScript with a real parser, so the graph comes from the code's structure.
- **Approximate call graph**: calls are joined to functions by name, so each edge says how it was matched.
- **Graph tools**: the model asks the graph (find, neighbours, path, code of a node) instead of reading every file.

**Questions they could ask**
- **Q:** Why a graph rather than embeddings for code?
  **A:** Questions about code are often about structure: who calls this, what breaks if I change it, how does a request get from A to B. A graph answers those exactly; similarity search does not. The model uses graph tools and the nodes it used light up.
- **Q:** Is it safe to load someone's repository?
  **A:** Nothing is run. Archives are unpacked with checks on paths, links, size and file count, and the code is only parsed.

**What I built:** a four-pass indexer (files, parsing, imports, calls), seven graph tools for the model, a force-laid graph with filters and focus, cached in `generated/code-graph/`.

## Vector Database (`/vector-db`)
**In one line:** PostgreSQL with pgvector, run yourself: chunks searched by meaning, by words and both fused, with the SQL shown and access enforced by row-level security.

**Key terms**
- **Embedding**: a vector for a piece of text, so similar meanings are close together.
- **HNSW index**: an approximate nearest-neighbour index that makes vector search fast.
- **Full-text search**: Postgres's own word search, good at exact names and codes.
- **Reciprocal rank fusion (RRF)**: combines two ranked lists by adding 1 / (k + rank), so items high in either list rise.
- **Row-level security**: a database policy that hides rows the reader is not allowed to see, whatever the query.

**Questions they could ask**
- **Q:** Why hybrid search?
  **A:** Vectors find meaning but miss exact terms such as product codes; words find exact terms but miss paraphrases. Fusing both is more reliable than either, and in SQL it is one query.
- **Q:** How do you stop RAG showing documents a user should not see?
  **A:** Enforce it in the database, not the prompt. Every search runs as an unprivileged role with the reader's groups, and a row-level security policy hides every other chunk. Superusers skip such policies, so searches never run as one.
- **Q:** Why record the embedding model on each row?
  **A:** Vectors from two different models cannot be compared, so a change of model means re-embedding.

**What I built:** `tools/vector-db.sh` (pgvector in Docker on `127.0.0.1:5433`), chunking under headings, the local embedding model, three search modes with their plans, and cited answers whose citations code checks.

## MLOps (`/mlops`)
**In one line:** the life cycle that turns a notebook model into a repeatable, safely released and monitored service: tracking, registry, feature store, release strategies, drift and retraining.

**Key terms**
- **Experiment tracking**: every run's parameters, metrics, code commit, data version and model file, recorded by a server such as MLflow.
- **Model registry**: numbered model versions with lineage, and aliases (`champion`, `challenger`) that deployments load.
- **Feature store**: features computed once, kept offline for training and online for low-latency scoring.
- **Point-in-time join**: each training row gets feature values as they were at its label time, never later ones.
- **Training/serving skew**: the same feature computed differently in training and in production.
- **Shadow, canary, blue-green, A/B**: ways to release a new version without exposing every user at once.
- **PSI and KS**: measures of how far a feature's distribution has moved since training.

**Questions they could ask**
- **Q:** How do you choose which run to promote?
  **A:** By validation score, only among runs on the same data version, with a time-based split when the model predicts the future. The test set is read once, after choosing, as the number to report. Choosing by test score turns it into a second validation set, and the reported number is optimistic. The page's runs table warns on exactly these cases.
- **Q:** Why load a model by alias rather than by version?
  **A:** The scoring code then never changes. Promotion moves `champion` to the new version after it passes the gate; rollback moves it back. Both are one registry change with full history, not a redeploy.
- **Q:** What is a point-in-time join and why does it matter?
  **A:** Each label is joined to the latest feature value on or before its label time. Joining the newest value leaks the outcome: churned customers have no logins after leaving, so the model learns "zero logins means gone". On the page that scores 99.7% offline and 70.8% in production. In pandas it is `merge_asof` with `direction="backward"`; feature stores do it for you.
- **Q:** What does a feature store actually solve?
  **A:** Two failures. Leakage, through point-in-time joins for training sets. Training/serving skew, through one feature definition used by both the offline store and the online lookup. It also lets teams reuse features instead of rebuilding them.
- **Q:** Canary or blue-green?
  **A:** A canary exposes a small, growing share and rolls back automatically on a threshold, so a bad version hurts few users. Blue-green switches everything at once and rolls back as quickly, but every user is exposed until then. Shadow is the safest first step (no user impact, double the cost); A/B is for measuring a business outcome, with guard metrics still able to stop it.
- **Q:** When should a model be retrained?
  **A:** On a measured performance drop when fresh labels exist, or on a schedule if that is cheaper to run than the monitoring. Drift alone is a reason to investigate: the cause may be a broken feed, and retraining on it bakes the fault in. Every retrained version goes back through the same evaluation and promotion gate.
- **Q:** How do you monitor a model whose labels arrive weeks later?
  **A:** Input drift (PSI, KS) and prediction drift as early warnings, service health as for any endpoint, and real performance once labels land. Under 0.1 PSI is usually stable, 0.1 to 0.25 worth watching, 0.25 and over a real shift.
- **Q:** What are the MLOps maturity levels?
  **A:** Level 0 is manual (notebooks, hand-off, rare releases). Level 1 automates the training pipeline with a feature store, registry and gate. Level 2 puts the pipeline itself under CI/CD, with monitoring triggering retraining and canary releases. Not every model needs level 2; the question is what to build next.

**What I built:** a page that walks an invented churn model through the eight stages, with a runs table and promotion warnings, a registry gate with aliases and rollback, a point-in-time join demo, a release simulator for four strategies, a drift slider with PSI and KS and a retraining decision, maturity levels, and a cross-platform tools table. `examples/mlops/` runs the same steps with MLflow on this machine.

## Data Platforms and Integration for AI (`/data-integration`)
**In one line:** the data and integration plumbing under an AI system: a lakehouse feeding training and retrieval, the right stores, a shared AI gateway, event streams that keep an index current, and the patterns that stop work being lost or done twice.

**Key terms**
- **Medallion layers**: bronze holds data as landed, silver holds it cleaned and unique, gold holds it shaped for a use (reports, features, text to embed).
- **Open table format**: Delta Lake or Apache Iceberg; Parquet files plus a log that gives ACID writes, schema enforcement and time travel.
- **AI gateway**: one place between apps and model endpoints for token limits per app, semantic caching, backend pools with spillover, circuit breakers and token metrics for chargeback.
- **Partition key**: decides which partition an event lands in; order is kept only within a partition.
- **At-least-once delivery**: after a crash, events since the last checkpoint arrive again, so every consumer must be idempotent.
- **Transactional outbox**: the change and its event written in one transaction, so neither is lost without the other.
- **Change data capture (CDC)**: turning a database's own change log into events, to keep indexes and the lakehouse in step.

**Questions they could ask**
- **Q:** Why keep a bronze layer at all, if silver is what everyone uses?
  **A:** So you can reprocess. When a rule was wrong, a new field matters, or a new embedding model arrives, you rebuild silver and gold from bronze instead of asking the source systems for history they may no longer have. Bronze is append-only and as landed; the rules live between bronze and silver, with rejected rows quarantined with a reason rather than dropped.
- **Q:** How do you make a model's training data reproducible?
  **A:** Train from a table in an open format and record its version with the run, for example the Delta version number in MLflow. Time travel then rebuilds exactly that data for a retrain, a fair comparison between two models or an audit. The same goes for a vector index: record which table version and embedding model built it.
- **Q:** pgvector or a dedicated vector database?
  **A:** Up to a few million vectors with relational data already in PostgreSQL, pgvector: one system, filtering with ordinary WHERE clauses and joins, and the embedding written in the same transaction as the row. At tens of millions or more, or when search load must scale apart from the app's database, a dedicated index beside the source of truth, kept in step by CDC or an outbox. If you also need keyword search, a search engine with hybrid search does both in one query.
- **Q:** Several teams share our model deployments. How do you stop one starving the rest?
  **A:** Put an AI gateway in front. Give each app a tokens-per-minute limit keyed on its subscription, send traffic to provisioned capacity first and spill over to pay-as-you-go, add a circuit breaker per backend, and emit token metrics per app so each team pays for what it used. In API Management these are the llm-token-limit and llm-emit-token-metric policies plus a backend pool; the simulation shows a batch job taking everyone's capacity until its limit is set.
- **Q:** How do you keep a RAG index current when documents change?
  **A:** Publish each change as an event, partitioned by document id so one document's changes stay in order, and have a consumer re-embed only that document. Because delivery is at least once, the consumer upserts by document id and remembers applied event ids, so a redelivery after a crash adds no duplicate chunks. A corrupt file goes to a dead-letter queue after a few attempts instead of blocking its partition. Retention also lets a new consumer group replay from the start to rebuild the index with a new embedding model.
- **Q:** What goes wrong if you write to the database and then publish an event?
  **A:** The dual-write problem: the process can die between the two, so the row is saved but the index never hears, or the event goes out for a change that then rolled back. The transactional outbox writes the event to an outbox table in the same transaction, and a relay or CDC publishes it, giving at-least-once publishing with no lost changes.
- **Q:** A user asks an agent for a report that takes five minutes. How do you expose that over HTTP?
  **A:** Async request-reply: accept with 202, a job id and a status URL, put the job on a queue and return at once. Workers take messages with a lock and complete them when done; if a worker dies the lock expires and another retries, and after the maximum deliveries the message is dead-lettered. The client polls the status URL or gets a webhook. Nothing holds a connection open for minutes.
- **Q:** Queue or stream?
  **A:** A queue hands each message to one worker and deletes it when done: right for jobs. A stream is an ordered, retained log that many consumer groups read at their own pace and can replay: right for change events several systems react to, like re-indexing, auditing and loading the lakehouse.

**What I built:** a browser-only page on invented data with four working demos: a medallion pipeline with quality rules you switch on and the downstream damage of each missing one; a store chooser by access pattern; an AI gateway simulation with per-app limits, caching, spillover, a circuit breaker and chargeback; and an event stream into a vector index where you crash the consumer and add a partition key, an idempotent consumer and a dead-letter queue. It closes with the matching API Management policies, async request-reply, the outbox and a table of integration patterns.

## GraphRAG (`/graphrag`)
**In one line:** a knowledge graph built from documents by a model, stored beside the chunks in PostgreSQL, and one question answered three ways: plain RAG, local graph search and global search.

**Key terms**
- **Entity and relationship extraction**: a model lists the people, teams, products and how they relate, from each chunk.
- **Community**: a group of closely linked entities, found with the Louvain method and summarised by a model.
- **Local search**: start from the entities nearest the question and walk up to two relationships.
- **Global search**: map the question over every community summary, then reduce to one answer.

**Questions they could ask**
- **Q:** When is GraphRAG worth it over plain RAG?
  **A:** For questions that need connections across documents ("who works with the team that owns X?") or the big picture ("what are the main themes?"). Plain RAG only sees the few chunks closest to the question. GraphRAG costs a model pass over every chunk to build, so it is not worth it for simple look-ups.
- **Q:** How do you keep the extraction trustworthy?
  **A:** Structured output for the extraction, code to merge mentions by normalised name, a cap of 40 chunks a build with the cost shown first, and every answer citing what it was given.

**What I built:** extraction, merging, Louvain communities and summaries stored in PostgreSQL tables beside the chunks; local search as one recursive SQL query; the three answers side by side, lit up on a drawing of the graph.

## Semantic Cache (`/semantic-cache`)
**In one line:** answers stored with the question's vector, so a close enough question skips the model, and the page shows why similarity alone is not safe.

**Key terms**
- **Semantic cache**: look up a new question by meaning among questions already answered.
- **Similarity threshold**: how close a question must be to reuse an answer.
- **False hit**: a near-identical question with a different meaning ("carry over 5 days" against "10 days").
- **Scoping**: entries belong to an answering model, a prompt version and a user, and expire.

**Questions they could ask**
- **Q:** Is a semantic cache a good idea?
  **A:** With care. The page's preset pairs show questions that differ in one number or verb scoring higher than true paraphrases, so no threshold is safe. A candidate must also pass a code check (the numbers match) and a yes-or-no check by a small model before it is served.
- **Q:** How does it differ from prompt caching?
  **A:** Prompt caching reuses the computation for an identical prefix and still calls the model; the answer is always fresh. A semantic cache skips the model entirely and returns a stored answer, which is cheaper but can be wrong or stale.

**What I built:** an HR help desk on the invented handbook, the cache in the same pgvector database, the two checks, scoping and expiry, and a comparison of KV, prompt and semantic caching.

## Local Model Setup (`/local-model`)
**In one line:** how to run an open model on this machine with Docker Model Runner and point the whole lab at it, with a live line showing whether it is configured, running and pulled.

**Key terms**
- **Docker Model Runner**: Docker Desktop's built-in server for open models (llama.cpp, with the GPU on a Mac).
- **`LLM_LAB_LOCAL_MODEL`**: the one setting that makes the local model the default everywhere.
- **NeedsClaude**: the error raised when a request needs a Claude-only feature, instead of silently dropping it.

**Questions they could ask**
- **Q:** What changes in the code when you switch to a local model?
  **A:** Nothing in the pages. One client, `LabClient`, sends each request to the right place by model name, and the local server speaks the Anthropic API.

**What I built:** `tools/local-model.sh` to provision it, and the page with the daily commands and troubleshooting. The essentials section "Running an open model locally" has the full answers.

## Support Desk Agent (`/support-desk`)
**In one line:** a customer support agent with four tools and a loop driven by `stop_reason`, where every safety mechanism runs and can be switched off to see what breaks.

**Key terms**
- **Gate in code**: no refund or order look-up until the customer is verified, whatever the model asks.
- **Pre-tool hook**: checks a call before it runs: refunds over $500 are blocked and sent to escalation.
- **Post-tool hook**: tidies a result before the model sees it, such as turning Unix, ISO and `03/11/2026` dates into one format.
- **Structured error**: a tool error with a category and whether it is worth retrying, so the agent reacts correctly.
- **Capability bloat**: giving an agent tools it does not need, such as `delete_account`, which it may then use.
- **Structured handoff**: the facts a person needs when the case is escalated, not the whole transcript.

**Questions they could ask**
- **Q:** Where do you enforce business rules: the prompt or the code?
  **A:** The code. The prompt explains the rules so the model behaves well, but a gate and a hook make sure they hold even when it does not. Switching a mechanism off on the page shows the failure it prevents.
- **Q:** How should a tool report errors?
  **A:** With a category and whether to retry. A transient outage is retried; a closed refund window is explained to the customer; "no orders" is a valid empty result, not an error. Mixing those up makes agents retry hopeless calls or give up on good ones.
- **Q:** How do you measure a support agent?
  **A:** From what the tools did, not what the agent said. "Run all" plays eight scripted customers and scores each outcome, then reports first-contact resolution.

**What I built:** an invented shop with `get_customer`, `lookup_order`, `process_refund` and `escalate_to_human`, our own loop, each mechanism with a switch, and the same agent on the Agent SDK in `examples/claude-agent-sdk/support_agent_sdk.py`.

## Research Team (`/research-team`)
**In one line:** a coordinator splits a question, delegates to four subagents in parallel, checks coverage and re-delegates, with every finding carrying its evidence and source.

**Key terms**
- **Coordinator**: plans the sub-questions and chooses which subagent to call.
- **Subagent**: starts with an empty context and gets only what it needs in its prompt, with only its own tools.
- **Coverage check**: after synthesis, finding what is still unanswered and sending targeted searches (two rounds at most).
- **Manifest**: a record of each run's steps, so it can be resumed.

**Questions they could ask**
- **Q:** Why give subagents an empty context?
  **A:** So each sees only what its job needs, which keeps it focused and cheap. The catch is that it knows nothing you do not pass on, so earlier findings go into its prompt in full, and the page shows exactly what each one got.
- **Q:** How do you deal with conflicting sources?
  **A:** Keep them apart rather than averaging. Each finding has claim, evidence, source and date; code checks them, and older or conflicting figures are reported as such.

**What I built:** a coordinator and four subagents over an invented 14-source corpus about heat pumps, with retries inside subagents, structured errors upwards, and a resumable manifest in `generated/research-team/`.

## Structured Extraction (`/extraction`)
**In one line:** invoices, receipts and purchase orders in varied layouts read into a fixed schema, with validation, retries, batches, confidence routing and accuracy measured against labels.

**Key terms**
- **Extraction as a tool**: the schema is a tool's input, so the reply is structured by construction.
- **Required against nullable**: a field that must be there against one that may honestly be empty. Making everything required invites made-up values.
- **`tool_choice`**: auto (the model may answer in text), any (it must call a tool) or a forced tool.
- **Semantic validation**: checks a schema cannot express, such as line items adding up to the total.
- **Message Batches API**: many requests sent at once for half the price, collected later.
- **Calibration**: whether the model's confidence matches how often it is right, used to route low-confidence documents to a person.

**Questions they could ask**
- **Q:** What do you do when validation fails?
  **A:** Retry once with the specific errors, but stop if the fact is not in the document. A retry cannot find what is not there; it can only invent it.
- **Q:** How do you know the extraction is good enough?
  **A:** Measure on labelled documents: accuracy by document type and by field, not one overall number. Then route by calibrated confidence, and spot-check a stratified sample of the confident ones.

**What I built:** 24 invented, labelled documents, the schema as a tool, validation with a retry, few-shot examples, batches with custom ids and resubmitting only failures, and an A/B comparison of two models on accuracy, latency and cost.

## Review Passes (`/review-passes`)
**In one line:** code review run several ways on one change set with six seeded problems, each scored against an answer key for what it found, missed and wrongly flagged.

**Key terms**
- **Explicit criteria**: telling the reviewer exactly what to look for, against a vague "review this".
- **Per-file and integration passes**: one pass per file, then one across files for problems no single file shows.
- **Independent reviewer**: a fresh context, not the one that wrote the code.
- **Precision**: the share of reported findings that are real.

**Questions they could ask**
- **Q:** Why not ask the model that wrote the code to review it?
  **A:** It shares its own assumptions, so it misses the same things. An independent reviewer with a fresh context finds more. The page measures the difference.
- **Q:** How do you stop a CI reviewer repeating itself on every push?
  **A:** Pass in the earlier findings and report only new or still-open ones, in a fixed schema.

**What I built:** an invented refunds change set (5 files, one problem visible only across files, plus style noise), scored modes, confidence routing with dismissed findings grouped by pattern, and a CI re-run in `examples/claude-code/ci/review-schema.json`'s schema.

## Hotel Booking Agent (`/hotel`)
**In one line:** guests book, change and cancel rooms by chat, while prices, availability, refunds and privacy are enforced in the tools.

**Key terms**
- **Two-turn confirmation**: the agent states the booking and its price, and only books after the guest says yes.
- **One row per room per night**: the database makes double-booking impossible, not the model.
- **Card number scrubbing**: a card number typed into the chat is removed before the model sees it.

**Questions they could ask**
- **Q:** How do you stop an agent selling the same room twice?
  **A:** With the database, not the prompt. Each room-night is a row with a unique key, so the second booking fails. A front-desk button tries it.
- **Q:** Should a chat agent take payments?
  **A:** No. It hands off to a payment page, and card numbers in the chat are removed before the model sees them. Here the payment page is pretend.

**What I built:** `examples/hotel/hotel.py` (the hotel, rules, tools and loop), shared with the page and a command line, with confirmations written by code and sent as a real email and text when configured.

## Diet Planner Agent (`/diet`)
**In one line:** a planner that asks a few questions, lets code work out safe targets, has the model design a week of meals, and checks the plan before giving it as a PDF, shopping list and spreadsheet.

**Key terms**
- **Targets in code**: calories and protein are calculated, and unsafe cases refused, before the model is involved.
- **Plan check**: allergies, diet, targets and cooking time checked by code after the model designs the week.
- **Consent for health data**: health details are kept for next time only with the person's agreement.

**Questions they could ask**
- **Q:** What is the model trusted to do?
  **A:** The creative part: choosing meals people will like. The numbers and the safety rules are code, because a model can be confidently wrong about either.

**What I built:** `examples/diet/diet.py` (targets, checks, tools, loop and files), shared with the page and a command line; runs on Claude, GPT or the local model.

## Closed-Deal Agents (`/deal-close`)
**In one line:** marking a deal won starts eight steps that find look-alike accounts and draft outreach, with the rules enforced by code and nothing sent without a person.

**Key terms**
- **Look-alikes**: accounts similar to the one just won, found and scored by code.
- **Model and code split**: the model reads the win notes, rates accounts and drafts emails; code finds, scores, prioritises and enforces.
- **Checked again at send time**: each rule is re-checked when the person approves, because things may have changed.

**Questions they could ask**
- **Q:** Which rules did you put in code?
  **A:** Only contacts who agreed to email, never the won customer's name, at most three emails a day, and nothing sent without approval. Each is checked again at the moment of sending.

**What I built:** an invented SQLite CRM, an eight-step chain shown as a graph that lights up as it streams, on Claude, GPT or the local model. Sending is simulated.

## Digital Teammate (`/digital-teammate`)
**In one line:** an AI agent with its own account works in a team channel like a colleague, while code decides what it may read, checks every number it posts, and logs each tool call under its name.

**Key terms**
- **Agent identity**: the agent acts as itself, with its own account, profile, owner and audit trail, not under a person's account or a shared app. In Teams these are agentic users with Microsoft Entra accounts.
- **Scopes checked at the tool call**: what the agent may read is the admin's setting, checked at every call, so a change applies even mid-answer.
- **Thread as the memory boundary**: a follow-up carries its own thread's messages and nothing else.
- **Proactive limits**: an agent that posts on its own does so only when allowed, at most a set number of times a day; code picks who to nudge.

**Questions they could ask**
- **Q:** Why give an agent its own identity?
  **A:** So its actions are attributed to it, not to whoever asked, and an admin can grant, review and disable it like any other account. The audit log shows each tool call under its name.
- **Q:** How do you stop it posting a wrong number?
  **A:** Code does every sum through a tool, and a reply is sent back when a number in it is in no record it read and no sum code worked out. On the local model it once wrote "covers the gap exactly" for 16 of 18 batches with every number genuine, so a shortlist that leaves a gap must now say by how much.

**What I built:** an invented procurement channel with a Sourcing Analyst agent, six tools, live plan and steps, a capacity widget backed by the same code as the agent's sums, and an admin centre with on and off, record scopes, posts of its own and the activity log. On Claude, GPT or the local model; nothing is ordered.

## Voice Agent (`/voice-agent`)
**In one line:** a conversation-native voice agent built from readable parts: our own turn detection, speculative replies, clause-by-clause speech, barge-in and a latency timeline.

**Key terms**
- **Turn detection**: deciding when the person has finished, from voice activity, silence timing and whether the sentence sounds finished.
- **Eager end of turn**: a likely end, on which the reply starts with its audio held back; if the person carries on, it is thrown away unspoken.
- **Barge-in**: the person talks over the agent; playback stops at once and the model and voice are cancelled.
- **Prosody**: speaking style, rate and pauses, written as SSML.
- **Text normalisation**: making card numbers, phone numbers, dates, money and postcodes read properly aloud.

**Questions they could ask**
- **Q:** What makes a voice agent feel slow?
  **A:** Waiting for silence to be sure the person has finished, then waiting for the whole reply before speaking. Starting the reply on a likely end of turn, and speaking clause by clause as it streams, removes most of that. The page shows each turn's timeline and the median and p95.
- **Q:** What happens to the history when someone interrupts?
  **A:** It keeps what was actually heard and marks what was not, so the agent does not assume the person heard the rest.

**What I built:** Azure Speech in the browser, a turn detector and prosody planner in our code, an Azure neural voice or Kokoro-82M running locally (`examples/voice-agent/`), and a tested normaliser.

## AI Whiteboard (`/whiteboard`)
**In one line:** a drawing board with four modes, where a vision model reads sketches as data and code checks and acts on them: maths, a guessing game, physics and sketch to picture.

**Key terms**
- **Sketch as data**: the model returns an equation, shapes or objects as structured output, not prose.
- **Whitelist check**: maths expressions are checked against allowed functions before they are plotted.
- **Code decides the match**: in the guessing game, code compares the guess to the word and a synonym list.

**Questions they could ask**
- **Q:** Why not let the model decide whether its guess is right?
  **A:** It would be marking its own work. Code compares the guess with the word and its synonyms, keeps the score, and limits how often the model looks (at most 12 times a round, only when the board changed).
- **Q:** How do you make a sketch move with physics?
  **A:** The model reads the sketch into balls, boxes and lines, given the page's exact shapes as hints. Code checks sizes and positions, and a physics engine (matter-js) runs gravity, collisions and bounce.

**What I built:** pen, shapes, undo and history; maths plotted with sliders or turned into 3D solids; the guessing game; physics; and sketch to picture with gpt-image-2 when an image deployment is set.

## Fitness Coach (`/fitness-coach`)
**In one line:** a pose model in the browser finds 33 points on the body, code checks the form for three holds, and a model answers "How's my form?" from the measurements.

**Key terms**
- **Pose landmarks**: points on the body (shoulders, hips, knees and so on) found in each camera frame.
- **Joint angle**: the angle at a joint from three points, the basis of every form rule.
- **Fixed cues**: spoken corrections chosen by code when a fault lasts, not written by a model.

**Questions they could ask**
- **Q:** What does the model see?
  **A:** What you choose: the measurements as text, a photo, or both, and the page shows exactly what it got. Measurements alone are cheaper and private; the photo adds context.
- **Q:** Why are the form checks in code?
  **A:** They need to run many times a second and be the same every time. A model is too slow and too variable for that, so it is only used for the spoken answer.

**What I built:** MediaPipe's pose landmarker in the browser, rules for a plank, a wall sit and a lunge stretch, a timer, spoken cues, a "your own pose" mode, and a drawn figure that stands in for the camera.

## Hands-free Pointer (`/gaze-pointer`)
**In one line:** the webcam follows the eyes and head to move a pointer, and a face movement the person chooses clicks, all in the browser.

**Key terms**
- **Face landmarks**: hundreds of points on the face, found in each frame.
- **Calibration**: looking at nine points so a least-squares fit maps face position to the screen.
- **One Euro filter**: smooths the pointer when still and keeps it quick when moving.
- **Personal threshold**: the click level set from the person's own resting and clicking movements.

**Questions they could ask**
- **Q:** Why is there no model call?
  **A:** It is a control problem, not a language one. It must run every frame with no delay and no camera images leaving the browser, so it is all code.

**What I built:** calibration, filtering, four click movements, an accuracy check and a practice task. A web page cannot move the system cursor, so the pointer is on the page.

## Brain Health Check (`/brain-check`)
**In one line:** five short thinking tasks and 14 risk-factor questions, scored by code with a fixed outcome and a PDF to take to a GP: a screening demonstration, not a medical test.

**Key terms**
- **Clock drawing**: a classic screening task; a model reads the drawing and code scores it.
- **Risk factors**: from the 2024 Lancet Commission on dementia.
- **Fixed outcomes**: one of four set messages chosen by code, never wording written by a model.

**Questions they could ask**
- **Q:** How do you use a model safely in a health setting?
  **A:** Only for perception, such as reading a drawing or picking animal names out of speech. Code scores, compares with earlier checks, and chooses one of four fixed outcomes. The page says plainly that the thresholds are illustrative.

**What I built:** the five tasks, code scoring, earlier checks kept only with agreement in `generated/brain-check/`, and the PDF.

## Scan Explainer (`/scan-explainer`)
**In one line:** upload a picture of a scan and a model fills in a fixed form about what it can see, while code blocks anything that sounds like a diagnosis or treatment.

**Key terms**
- **Fixed form**: what it sees, where, how sure, what the picture cannot tell, what it could be consistent with, and questions for the doctor.
- **Wording check**: code rejects text that states a diagnosis or suggests treatment; one retry, then nothing is shown.

**Questions they could ask**
- **Q:** How do you stop a model giving medical advice?
  **A:** Constrain the output to a form designed to inform, check the wording in code, and show nothing rather than something unsafe. The notices and the urgent message are written by code, not the model. Nothing uploaded is stored.

**What I built:** file checks, the form as structured output (Opus by default), the wording check with one retry, and code-written notices.
