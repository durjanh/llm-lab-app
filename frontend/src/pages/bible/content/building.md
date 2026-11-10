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
**In one line:** the model writes a website through file tools confined to one folder, you watch the code stream in, and it fixes what it sees in screenshots.

**Key terms**
- **Confined file tools**: write_file, edit_file, read_file, list_files and delete_file, with every path resolved and checked to stay inside the site's folder.
- **Path traversal**: using ".." or absolute paths to escape a folder; prevented by resolving the path and checking the folder is one of its parents.
- **Fine-grained (eager) tool input streaming**: streaming a tool call's JSON input as it is generated, so the page can show code being written.
- **Headless browser screenshot**: rendering the page in Chrome without a window, at set viewport sizes, and capturing the image and console messages.
- **CSP sandbox**: a Content-Security-Policy that runs the page in an opaque origin, so generated scripts cannot use the app's cookies or call its API as the app.
- **Resource limits**: caps on files, bytes per file, site size and requests per turn.

**Questions they could ask**
- **Q:** Why give the model file tools only and no shell?
  **A:** Building a static site needs only files, so a shell would add risk without adding capability. Five narrow tools confined to one folder are easy to reason about and need no sandbox. It is least privilege: give the agent the smallest tool set that does the job.
- **Q:** The model writes JavaScript that you then serve. How do you keep that safe?
  **A:** Generated code is untrusted. The sites are served with a CSP `sandbox` header, so they run in an opaque origin and cannot call the lab's API with its credentials. The file tools also reject paths that escape the site folder, and there are limits of 80 files, 300 KB per file and 3 MB per site.
- **Q:** How do you show code appearing as the model writes it?
  **A:** I stream the response and turn on eager input streaming for the writing tools, then forward each `input_json_delta` fragment to the page as it arrives. Each tool call runs as soon as its block completes, so the preview reloads while the model is still working. A call cut off by max_tokens never runs.
- **Q:** How does the model check its own work, and what limits that?
  **A:** When it has finished, the backend screenshots the site in headless Chrome at 1280 × 800 and a 390 × 844 phone size and sends the images and any console errors back. The model fixes what it sees, up to two review rounds and 40 requests per turn, so a site that never looks right still ends. Without Chrome the review is skipped and the page says so.

**What I built:** `SiteService` runs each turn as a background `Run`, streams Claude's file writes to the page, stores files and the conversation under `sites/<id>/`, and uses a Chrome DevTools gateway for the desktop and phone screenshots. `main.py` serves the result at `/sites/<id>/` with the CSP sandbox.

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
