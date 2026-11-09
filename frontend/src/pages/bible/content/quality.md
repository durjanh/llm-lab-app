## Guardrails and Content Safety (`/guardrails`)
**In one line:** a model deployment's built-in filter is one layer; the application adds its own checks on the way in and on the way out (harm scores, prompt attacks, groundedness, personal data), and decides what each score means.

**Key terms**
- **Content filter (deployment guardrail)**: the platform's own classifier that runs on every call to a deployment, whatever your code does, and reports what it found in the response (`content_filter_results`).
- **Severity threshold**: the score at or above which your code blocks; the service returns scores, and the threshold is a product decision you tune on your own cases.
- **Direct prompt attack (jailbreak)**: an instruction typed by the user to make the model break its rules.
- **Indirect prompt attack (document attack)**: an instruction hidden in content the model reads, such as an email, a web page, a tool result or text in an image.
- **Groundedness detection**: a check that marks the sentences of an answer that the supplied source does not support.
- **PII redaction**: finding personal data (names, phone numbers, NHS numbers) and replacing it before it is sent on or logged.
- **Protected material detection**: a check that flags known copyrighted text, such as song lyrics, in an output.
- **Human review (hold)**: a third outcome besides send and block, for answers that are probably fine but not fully supported.

**Questions they could ask**
- **Q:** Why do you need application-level guardrails if the model deployment already has a content filter?
  **A:** The deployment filter is generic: one set of thresholds for every caller, and it only knows about harm categories. The application knows its own rules: which terms it never wants in a reply, which source an answer must come from, and when a person should check. So you keep both: the platform layer protects every caller, and the app layer adds stricter thresholds, other detectors and decisions such as "hold for review" that a filter cannot make.
- **Q:** In what order would you run the checks in a customer assistant, and why?
  **A:** Cheap, blocking input checks first: shield the question and any attached document for attacks, then redact personal data, so a bad request never reaches the model and personal data never leaves your boundary. Then the model call, with the platform filter. Then output checks: harm scores, protected material and groundedness, which can run in parallel because they are independent. A failed input check refuses; a failed harm check blocks; an ungrounded answer goes to a person rather than being sent or thrown away.
- **Q:** How do you choose the severity threshold? (production trade-off)
  **A:** Treat it as a classifier and measure it on a labelled set from your own traffic. A lower threshold catches more harmful content (higher recall) but raises more false alarms (lower precision), and each false alarm is a blocked customer or a reviewer's time. For example, if a detector fires on 22 cases and 18 of them are real attacks out of 20 in the set, precision is 18/22 = 82% and recall is 18/20 = 90%. You pick the point where the cost of a miss and the cost of a false alarm balance for that use case, and re-measure when the model or the traffic changes.
- **Q:** An agent reads images. How can an attack get through, and what is the fix?
  **A:** Image moderation scores pictures for harm but does not read the text in them, so an instruction written in a picture passes it. The fix is to OCR the image and send the extracted text through the prompt-attack detector as a document, and to tell the model in the system message that text in images is data, never instructions. Even then, the real limit on damage is what tools the agent is allowed to call.
- **Q:** How do you know a detector is actually working in your region?
  **A:** Test each one with a case you know must fail, as part of deployment checks. A detector can return a valid "all clear" response without doing the work; that silent pass is worse than an error. Keep a small labelled test set per detector and run it in CI or on a schedule.

**What I built:** The page calls real Azure services through a backend `GuardrailsService`: Content Safety text and image scoring with a custom blocklist, Prompt Shields, groundedness detection (on a Sweden Central resource, because in UK South it answered "grounded" to a plain contradiction), Azure Language PII redaction and protected material. A pipeline endpoint runs the stages in order, stops at the first blocking input check, runs the three output checks in parallel, and returns sent, blocked or held for review; an evaluate endpoint scores a labelled test set at the chosen threshold and counts caught, missed, false alarms and clean cases per detector. Every call is charged to the spending tracker at the per-1,000-character text-record price, and the deployment's own filter policy is read from Resource Manager for comparison.

## Benchmarks (`/benchmarks`)
**In one line:** a benchmark score is a noisy sample with its own grading rules and failure modes, so you read it with an interval, compare models paired, and watch for saturation, contamination and Goodhart's law.

**Key terms**
- **pass@k**: the probability that at least one of k sampled attempts passes; estimated without bias from n ≥ k samples with c correct as 1 − C(n−c, k) / C(n, k).
- **pass^k**: the probability that all k attempts succeed; the right metric for agents that must be reliable every time.
- **Confidence interval (Wilson)**: a range for the true score given the sample; the Wilson interval behaves better than p ± 1.96·SE near 0%, near 100% and on small samples.
- **Paired comparison (McNemar's test)**: comparing two models on the same questions using only the questions where they disagree, which removes shared noise.
- **Saturation**: when top models all score near the ceiling, so the benchmark no longer separates them.
- **Contamination**: test questions (or close paraphrases) appearing in training data, which inflates scores without reflecting skill.
- **Elo / Bradley–Terry**: ways to turn pairwise human votes into ratings; online Elo depends on the order of votes, Bradley–Terry fits all votes at once and depends only on win counts.
- **Goodhart's law**: when a measure becomes a target, it stops being a good measure.

**Questions they could ask**
- **Q:** Model A scores 82% and model B 80% on a 500-question benchmark. Is A better?
  **A:** Probably not provably. Treated as independent samples, the standard error of the difference is about 2.5 points, so a 2-point gap is under one standard error. Because both ran on the same questions, a paired test is fairer: if they disagree on 15% of questions, the paired standard error drops to about 1.7 points, but a 2-point gap is still only about 1.2 standard errors, so not significant at 95%. I would report both scores with intervals and say the gap is within noise.
- **Q:** Explain pass@k, and why the obvious estimate is wrong.
  **A:** pass@k is the chance that at least one of k attempts works. The naive estimate plugs the observed rate p̂ = c/n into 1 − (1 − p̂)^k, which is biased low because that curve is concave. The unbiased estimator draws n ≥ k samples and computes 1 − C(n−c, k)/C(n, k). With n = 10 and c = 3, pass@5 is 1 − 21/252 ≈ 91.7%, while the naive formula gives 1 − 0.7^5 ≈ 83.2%.
- **Q:** How would you detect benchmark contamination?
  **A:** Compare scores on the original items against freshly written variants of the same difficulty: a large gap whose intervals do not overlap suggests memorisation. Check word n-gram overlap between test items and model outputs or training data, where you have it. Prefer benchmarks with a private or regularly refreshed test set, and be wary of public scores far above what you measure on your own tasks.
- **Q:** How should a team use public benchmarks when choosing a model? (production trade-off)
  **A:** Use them only to shortlist. Several benchmarks testing different things, plus human-preference rankings for open-ended quality, narrow the field, but the decision comes from an eval built on your own tasks and data, graded the way your users judge quality. Match the metric to the use: an agent that must work every time needs pass@1 or pass^k; pass@10 flatters it. For example, at 90% per attempt, pass^5 is only 0.9^5 ≈ 59%.
- **Q:** Why might two leaderboards built from the same votes rank models differently?
  **A:** Online Elo updates one vote at a time, so shuffling the vote order changes the final ratings, especially with a large K-factor. Bradley–Terry fits a single maximum-likelihood model to all the votes and gives the same answer whatever the order. Even then, neighbours whose intervals overlap cannot honestly be separated, so a rank difference between them means little.

**What I built:** The page is all client-side TypeScript (`stats.ts`): the unbiased pass@k estimator and a simulation showing the naive one is biased, Wilson intervals, unpaired versus paired (McNemar-style) standard errors, online Elo against a Bradley–Terry fit by the MM algorithm with a vote-shuffling demo, and an n-gram overlap check for contamination. It deliberately shows no real model scores, because they go stale and mean little without intervals.

## Evals Lab (`/evals`)
**In one line:** an eval is a frozen labelled test set plus a grader, and the real question is whether a prompt change beats the noise, measured with paired intervals and repeated runs.

**Key terms**
- **Golden set (labelled test set)**: inputs with answers people agree are correct, including hard cases (sarcasm, negation, mixed reviews), kept frozen while you compare prompts.
- **Grader**: code or a model that turns one output into a score; exact match, code-based rubric or LLM-as-judge.
- **LLM-as-judge**: a second model that reads the output and a rubric and returns a structured score and reason; it needs checking against human labels.
- **Precision**: of the cases flagged positive, the share that really are positive: TP / (TP + FP).
- **Recall**: of the real positives, the share that were flagged: TP / (TP + FN).
- **F1**: the harmonic mean of precision and recall, 2PR / (P + R), useful when one class is rare.
- **Bootstrap confidence interval**: resample the test set with replacement many times, rescore, and take the middle 95% of scores.
- **Run-to-run variance**: different results from identical calls because of sampling; measured by repeating each case.

**Questions they could ask**
- **Q:** Your new prompt scores 75% against the old one's 70%. Do you ship it?
  **A:** Not on that alone. I would look at the paired difference: bootstrap the test set, drawing the same cases for both prompts, and check whether the 95% interval on B − A excludes zero. I would also count what B fixed and what it broke, and slice by case type, because a prompt that gains on easy cases and loses on sarcasm can be worse for the users who matter. With 8 cases, one case is worth 12.5 points and the interval on a single score is about 50 points wide, so that kind of jump is noise.
- **Q:** Define precision, recall and F1 with an example.
  **A:** Say a classifier flags 50 reviews as negative; 40 really are, and there are 60 negative reviews in total. Then TP = 40, FP = 10, FN = 20. Precision = 40/50 = 80%, recall = 40/60 ≈ 67%, and F1 = 2 × 0.8 × 0.667 / (0.8 + 0.667) ≈ 73%. Accuracy can look fine on an imbalanced set while recall on the rare class is poor, which is why you report these per class.
- **Q:** When would you use an LLM as a judge, and how do you make it trustworthy?
  **A:** Use the cheapest grader that measures what matters: exact match or code where you can, a judge only for qualities code cannot check, such as faithfulness or tone. Give it a small, anchored scale (pass/fail, or 1 to 5 with each score described) and force structured output. Then label 50 to 100 outputs yourself and measure agreement, ideally with a chance-corrected statistic such as Cohen's kappa, and only rely on the judge where it agrees. Guard against position bias by running pairwise comparisons in both orders and counting only wins that survive the swap, against verbosity bias with length limits checked in code, and against self-preference by using a judge that did not write the answers.
- **Q:** How do you handle non-determinism in evals? (production trade-off)
  **A:** Run each case several times and report the mean with an interval over cases, because one run of each prompt can pick the wrong winner. On current Claude models you cannot lower the temperature, so repetition is the only lever; even at temperature 0, hosted models can vary a little. More runs cost more money and time, so I size the repeat count by how close the two candidates are.
- **Q:** Where do good test cases come from?
  **A:** From real traffic, including failures users reported, with a sensible label mix and deliberate hard cases. Few-shot examples in the prompt must never be copied from the test set, or you measure memory instead of skill. Freeze the set while comparing prompts: if the cases and the prompt change together, you cannot tell which moved the score.

**What I built:** GPT-2 runs in the browser and classifies by comparing its real next-token probabilities for " positive" and " negative", so formatting can never cause a miss. The page compares two prompts with paired bootstrap intervals (2,000 resamples), simulates repeated sampled runs at a chosen temperature, and grades free-text summaries with code rubrics. The LLM judge is a live Claude call through the backend's `/api/messages` with a JSON schema for structured output; the backend enforces the lab-page guard, the spending cap and the allowed model list, and reports time and cost per call, and the page measures judge–human agreement and position bias.

## Confidence and Calibration (`/confidence`)
**In one line:** a model's confidence is only useful for decisions if it is calibrated, so you measure it with a reliability diagram, fix it on held-out labels, and then pick an automation threshold from the coverage curve.

**Key terms**
- **Logprobs**: the log of the probability the model assigns to each token; the confidence for a label comes from the probabilities of its tokens.
- **Calibration**: when a model says 80%, it is right about 80% of the time.
- **Reliability diagram**: accuracy plotted against confidence in bins; bars below the diagonal mean overconfidence, above mean underconfidence.
- **Expected Calibration Error (ECE)**: the gap between confidence and accuracy in each bin, averaged with each bin weighted by its share of cases.
- **Temperature scaling**: dividing the logits (here the score gap between labels) by one fitted number T; it changes confidence but never which label wins.
- **Contextual calibration**: dividing each label's probability by the probability the model gives it for a content-free input such as "N/A", to remove a built-in lean towards one label.
- **Selective prediction (coverage)**: answering automatically only above a confidence threshold and sending the rest to a person; coverage is the share answered automatically.
- **Self-consistency (agreement)**: asking the same question several times and using the share of matching answers as a confidence signal.

**Questions they could ask**
- **Q:** What is calibration and how do you measure it?
  **A:** A calibrated model's stated confidence matches its hit rate. You score a labelled set, bin the predictions by confidence, and compare accuracy with mean confidence in each bin. ECE = Σ (n_b / N) × |acc_b − conf_b|. For example, if 20 of 60 cases sit in a bin with mean confidence 90% but only 14 are right (70%), that bin alone adds 20/60 × 0.2 ≈ 0.067 to the ECE. Look at the bars too, because the average can hide a badly calibrated bin.
- **Q:** How does temperature scaling work, and why does accuracy not change?
  **A:** You divide the logits by a single scalar T, fitted on a held-out labelled set by minimising negative log-likelihood. T above 1 softens probabilities and fixes overconfidence; T below 1 sharpens them. Dividing every logit by the same positive number keeps their order, so the argmax and therefore accuracy are unchanged. You should fit on one split and measure on another, as the page does with even and odd cases.
- **Q:** A support bot answers on its own above 0.8 confidence. How would you set that threshold? (production trade-off)
  **A:** Decide the error rate the business can accept, then read the threshold off the coverage curve: accuracy on the answered share against the share answered. A higher threshold lets fewer errors through but sends more work to people. Calibrate first, so "0.8" really means about 8 in 10 right and the risk owners can agree to it in plain terms. Revisit it when the prompt, the model or the traffic changes, because each can shift calibration.
- **Q:** Does a high token probability mean the answer is correct?
  **A:** No. It says how likely those words are to come next, not whether the fact is true. A model can give a famous but wrong answer, such as Sydney for the capital of Australia, a high probability. Calibration needs labels, so for factual answers you ground them in documents and verify, or measure how often answers at each confidence level are right on a labelled set.
- **Q:** Your API does not return token probabilities. What do you use instead?
  **A:** Sample the same question several times and use agreement, the share of answers that match the most common one, as the confidence signal. Calibrate that score on labelled data like any other, because agreement can be high on a consistently wrong answer. Do not trust verbal confidence ("I am 90% sure") without checking it, because that is generated text, not a measured probability.

**What I built:** GPT-2 runs in the browser on 60 labelled reviews; the page reads the probabilities of " positive" and " negative", renormalises them, and draws reliability diagrams with ECE. It fits temperature scaling and contextual calibration on one half of the cases and measures on the other, shows the coverage–accuracy trade-off for a chosen threshold, and contrasts probabilities with correctness on factual recall (capitals). A code sample shows the agreement method against Claude.

## Prompt Injection Challenge (`/injection`)
**In one line:** assume an injection will sometimes work, and design so that it cannot do damage: prompt rules help, but only checks in your own code are a security boundary.

**Key terms**
- **Prompt injection**: text that makes the model follow instructions other than the developer's, because instructions and data share one input stream.
- **Direct vs indirect injection**: direct comes from the user's own message; indirect is planted in content the model reads, such as an email, a web page or a tool result.
- **Data exfiltration**: getting a secret out through a reply, a tool call (for example an email) or a URL the client fetches, such as a markdown image.
- **Spotlighting (delimiting)**: wrapping untrusted content in tags and telling the model it is data, not instructions.
- **Least privilege**: never placing secrets in the model's context and giving it only the tools and permissions the task needs.
- **Tool argument allow-list**: code that checks tool inputs (recipients, amounts, targets) against permitted values before running the tool.
- **Human-in-the-loop approval**: a person confirms side effects such as outbound email before they happen.
- **Defence in depth**: layering independent controls so that each covers a path the others miss.

**Questions they could ask**
- **Q:** Why can't a system prompt rule stop prompt injection?
  **A:** The model reads the system prompt, the user's message and any retrieved content as one stream of tokens and cannot reliably tell whose text is whose. A rule is a request, not a lock: it stops plainly worded attempts, but attackers rephrase with forged authority (a fake "SYSTEM:" line) or framing (a puzzle, a formatting rule, "spell it backwards") until one works. So prompt defences lower the rate; they do not set a limit on the damage.
- **Q:** How would you secure an agent that reads customer emails and can send email?
  **A:** Start from the worst output and make it harmless in code. Keep secrets out of the context and give the model a tool that uses them on an authorised path. Allow-list tool arguments, for example `send_email` only to the customer on file. Gate side effects behind approval where the stakes justify it, filter outputs for secrets, and strip images and links that point outside your domain, because a chat client fetches images automatically. Then spotlight untrusted content and add prompt rules as an extra layer, not the main one.
- **Q:** Explain exfiltration through a markdown image.
  **A:** Injected text tells the model to end its answer with an image whose URL carries the secret, perhaps base64-encoded in a query string. When the chat window renders the reply, the browser requests the image and the secret goes to the attacker's server with no click needed. The fix is in code: remove or proxy images and links to domains not on an allow-list, and keep the secret out of context so there is nothing to encode.
- **Q:** What does each layer cost, and which would you keep under pressure? (production trade-off)
  **A:** Output filters are cheap but literal: a filter that normalises case and punctuation still misses the code written backwards or in base64, and it does not look inside tool inputs. Allow-lists are cheap and strong but can block legitimate use and still allow mail to the attacker's own address if the customer is the attacker. Human approval is the strongest for side effects but slow, and reviewers get tired. Least privilege removes the prize but not the agent's willingness to act. If I could keep only two, I would keep least privilege and argument allow-listing, because they hold whatever the model writes.
- **Q:** How would you test injection defences?
  **A:** Keep a suite of attacks covering each path out (reply, tool call, image), each placement (user message, email, web page) and each framing (naive, forged authority, clever), and run it on every prompt or model change. Score outcomes as leaked, misused a tool, or blocked, and record which defence stopped it. Run each live attack several times, because one live run is one sample.

**What I built:** The page attacks a support agent that holds a discount code and has `lookup_order` and `send_email` tools. Offline mode uses a scripted stand-in whose rules are listed on the page, so results show how defences work rather than real failure rates; live mode sends the same ticket to Claude through the backend's `/api/messages` (with the lab-page guard and spending cap), and the page acts as the harness: it applies the code defences (output filter, email allow-list, approval, least privilege, image stripping) to whatever Claude writes or asks to call, returns a made-up order for lookups for up to three requests, and never sends real email. A matrix shows which defence set stops which of the six attacks.

## Context and Cost (`/context`)
**In one line:** latency is dominated by output length because decoding is sequential, and cost grows with every turn because APIs are stateless, so you stream, keep answers short and cache the stable prefix.

**Key terms**
- **Input and output tokens**: tokens you send and tokens the model writes; output is priced higher (5 times input in the lab's price table) and is slower to produce.
- **Prefill**: processing the whole prompt in parallel; it sets most of the time to first token for long prompts.
- **Decode**: writing output one token at a time; its speed sets how long the answer takes.
- **Time to first token (TTFT)**: network and queueing plus prefill; what a streaming user waits for before seeing anything.
- **KV cache**: the stored keys and values of earlier tokens, so each decode step only processes the newest token; it grows with context and limits how many sequences one GPU can serve.
- **Prompt caching**: the provider keeps the processed state of a repeated prompt prefix between requests and bills reads at a fraction of the input price.
- **Context window**: the maximum number of tokens one request can hold, prompt and output together.
- **Grouped-query attention (GQA)**: sharing key and value heads across query heads to shrink the KV cache.

**Questions they could ask**
- **Q:** A chat feature feels slow. Where do you look first?
  **A:** Output length, because decode is sequential and usually much slower per token than prefill. Asking for concise answers and setting `max_tokens` deliberately is often the biggest speed-up. Then stream, so the user sees text after the time to first token instead of after the whole answer. For long prompts, prompt caching also cuts prefill time on repeat calls.
- **Q:** Why does the cost of a long conversation grow faster than linearly?
  **A:** The API is stateless, so call k resends the system prompt, tools and all previous turns. If each turn adds about the same number of tokens, input per call grows linearly and total input grows roughly with the square of the number of turns. For example, a 5,000-token system prompt plus 1,000 tokens per turn over 20 turns sends about 310,000 input tokens in total; at $2 per million that is about $0.62. With caching, most of each call is read from cache at a tenth of the price and only the new part is written at 1.25 times, which brings it to roughly $0.12.
- **Q:** How do you make sure prompt caching actually works? (production trade-off)
  **A:** Caching matches the exact prefix in order: tools, then system prompt, then messages. Put stable content first and anything that changes per request, such as a timestamp or a reordered tool list, after the cache breakpoint, because one changed byte invalidates everything after it. Check `usage.cache_read_input_tokens` on repeat calls; if it stays at zero, something in the prefix changes. Trade-offs: cache writes cost 1.25 times input, entries last about five minutes by default, prefixes below a model-specific minimum are not cached, and caches are per model, so splitting traffic across models loses reuse.
- **Q:** You are self-hosting a model. How much GPU memory does the KV cache need?
  **A:** 2 (keys and values) × layers × KV heads × head size × bytes per number × tokens × concurrent sequences. For a typical 8B model with 32 layers, 8 KV heads, head size 128 and 16-bit values, that is 128 KiB per token, so an 8,000-token context needs about 1 GiB per sequence, and 32 concurrent sequences need about 32 GiB, on top of the weights. Context length times concurrency, not just model size, decides the hardware.
- **Q:** How is the KV cache different from prompt caching?
  **A:** The KV cache works inside one request: it stores keys and values so decoding does not recompute earlier tokens. Prompt caching keeps that processed prefix between requests, so a later call with the same prefix skips the prefill work and is billed less. Prompt caching is essentially a reused, persisted KV cache for a prefix.

**What I built:** The page is a client-side calculator: a prefill/decode timing model with streaming against non-streaming playback, a KV cache grid and memory calculator using the formula above, and a turn-by-turn cost model with and without prompt caching (cache writes at 1.25 times input, reads at the cache-read price, prices from the lab's table). The runnable version is `python/04_caching_and_latency.py`.

## Model Routing Calculator (`/routing`)
**In one line:** compare always-large, always-small, a cascade and a router on cost per correct answer, not cost per request, using accuracy measured by your own eval.

**Key terms**
- **Cost per correct answer**: cost per task divided by accuracy; what you pay for each answer you can actually use.
- **Cascade**: send every task to the small model first, and escalate to the large model when a check rejects the answer.
- **Router**: a classifier that reads each task first and sends the ones it judges hard to the large model.
- **Catch rate**: the share of the small model's wrong answers that the cascade's check escalates.
- **False escalation rate**: the share of correct small-model answers that the check escalates anyway, adding cost for nothing.
- **Routing accuracy**: how often the router sends a task to the right model; its mistakes cost money one way and accuracy the other.
- **Effort**: a per-request setting that trades thinking depth against tokens within one model, an alternative to switching models.

**Questions they could ask**
- **Q:** Why compare on cost per correct answer?
  **A:** A cheap model that is often wrong is not really cheap, because each wrong answer has to be caught, redone or paid for in user harm. Dividing cost per task by accuracy shows what each usable answer costs. Then you take the cheapest strategy that also meets your accuracy target, since a low cost per correct answer does not help if overall accuracy is below what the use case needs.
- **Q:** Work through a cascade example.
  **A:** Say each task is 2,000 input and 500 output tokens. At the lab's prices, the small model (Haiku 5.5, $0.10/$0.50 per million) costs about $0.00045 per task and the large one (Opus 5.5, $4/$20) about $0.018. If the check costs little and escalates 25% of tasks, the cascade costs about $0.00045 + 0.25 × $0.018 ≈ $0.005 per task, under a third of always-large. Its accuracy depends on the check: every wrong answer it misses ships, and every correct answer it escalates wastes a large-model call.
- **Q:** When does a router beat a cascade? (production trade-off)
  **A:** A router pays its own cost on every task but never pays for two model calls on one task, so it wins when hard tasks are rare and easy to spot from the input. A cascade wins when difficulty only shows in the answer, so you need to see the small model's attempt. Cascades add latency on escalated tasks, which wait for two calls in a row, so look at the slow tail, not the average.
- **Q:** What would you try before building any routing?
  **A:** The capable model at a lower effort setting on the same tasks, measured with the same eval. It can match a cheaper model's cost per correct answer with one code path, one set of prompts and one prompt cache. Caches are per model, so a cascade or router splits traffic and gives up cache reuse, a saving this kind of calculator ignores.

**What I built:** A client-side calculator: you enter prices, token counts, easy and hard accuracy and latency for two models, the share of hard tasks, the check's catch and false-escalation rates and the router's accuracy. It computes accuracy, cost per task, cost per correct answer, monthly cost and latency for all four strategies and highlights the cheapest that meets the target. Prices come from the lab's table; accuracy and latency defaults are labelled placeholders, and it assumes independent mistakes and ignores caching, retries and rate limits, as the page states.

## Rate Limits and Resilience (`/resilience`)
**In one line:** name which limit ran out (rate, quota, context or budget), then add the defences that fit: backoff honouring Retry-After, failover, a smaller model, a circuit breaker, deferring background work and sending fewer tokens.

**Key terms**
- **TPM / RPM**: tokens and requests per minute allowed on a deployment or an organisation; exceeding them returns HTTP 429.
- **Quota**: capacity assigned per subscription, region, model and deployment type; persistent 429s at high traffic mean you need capacity elsewhere, not waiting.
- **Retry-After**: a response header telling the client how long to wait before retrying.
- **Exponential backoff with jitter**: waiting longer after each failure, with a random factor, so clients do not retry in step.
- **Circuit breaker**: after repeated failures, stop calling a deployment for a period (open), then send one trial request (half-open) before resuming (closed).
- **Failover**: sending traffic to a second region or deployment when the first is limited or down.
- **Provisioned throughput (PTU) with spillover**: reserved capacity for the base load, with overflow sent to a pay-as-you-go deployment.
- **529 (overloaded)**: the Claude API's status for temporary server-side overload, retried like a 429.

**Questions they could ask**
- **Q:** Your app starts returning 429s at peak. What do you do?
  **A:** First identify the limit. A rate limit with Retry-After is solved by backoff, spreading load and fewer tokens per request. Quota exhaustion needs another region, provisioned capacity or a quota increase, because waiting just moves the failures later. A context-length error (400) fails the same way on every retry, and a spent budget needs a business decision. Then layer defences: backoff with jitter honouring Retry-After, failover, a smaller model for tasks evals show it can handle, and holding background work while interactive users need the capacity.
- **Q:** Why is retrying immediately harmful?
  **A:** It multiplies calls and 429s without creating capacity, and synchronised clients hit the limit together again (a retry storm). Backoff with jitter, such as a random wait between 0 and min(cap, base × 2^attempt), and never shorter than Retry-After, spreads the load. It smooths a short spike, but if demand stays above the limit for minutes, it only delays failure. The SDKs already retry (two retries by default in the Claude SDK), so tune that rather than wrapping another loop round it.
- **Q:** How does max_tokens affect your rate limit?
  **A:** On Azure OpenAI the limiter counts prompt plus max_tokens when a request arrives, not the tokens actually written. With a 2,000-token prompt and max_tokens 2,000, each request counts as 4,000 tokens, so 200,000 TPM admits 50 requests a minute even if each reply is only 400 tokens, against about 83 if only actual tokens counted. The Claude API instead counts input and output tokens separately, does not count max_tokens towards output tokens per minute, and for most models does not count cache reads towards input tokens per minute. So setting max_tokens close to need and caching stable prefixes raise effective capacity.
- **Q:** What does a circuit breaker buy you, and when can it hurt? (production trade-off)
  **A:** During an outage, without a breaker every request first waits for the dead region to time out. With one, a few failures open the circuit, traffic goes straight elsewhere, and a periodic trial request checks for recovery; on a 429 it can stay open for the Retry-After. On a single deployment under steady overload it can lower the share of interactive answers, because it only routes around trouble, so it needs somewhere else to send traffic.
- **Q:** How do you protect interactive users from a batch job?
  **A:** Give background work lower priority: hold it while the deployment is near its limit, give it a separate deployment, or send it through a batch API, which on the Claude API runs asynchronously at about half price. A person needs an answer in seconds; a nightly job does not.

**What I built:** The page is a client-side, seeded simulation of ten minutes of traffic (a spike, a batch job and an optional regional outage) against token-bucket limiters, with toggles for each defence and a table adding them one by one, showing answered within the deadline, p95 wait, calls, 429s and hung calls. In the backend itself, the Claude SDK's own retries run first; then a request still rate limited or overloaded (429 or 529) is sent once to a configured fallback model (`fallback_model()` in `python/local_model.py`, `LLM_LAB_RATE_LIMIT_FALLBACK`), and `SpendTracker` prices the reply by the model that actually answered.

## Live Claude Lab (`/live`)
**In one line:** measure real Claude calls (time to first text, total time, input and output tokens, cost), see how effort trades quality for spend, and prove prompt caching works.

**Key terms**
- **Streaming**: receiving the answer as it is generated, so the user sees text after the time to first token.
- **Effort**: a request setting (low to max) that controls how much the model thinks and so how many output tokens it spends.
- **Thinking tokens**: reasoning the model does before answering; billed as output even when not shown.
- **Cache breakpoint (`cache_control`)**: marks the end of the prefix to cache; later requests with the same prefix read it.
- **Automatic caching**: a top-level setting that places the breakpoint at the end of each request.
- **Token counting endpoint**: returns the exact input token count for a request using the model's tokenizer, without generating.
- **Spending cap**: a server-side limit that refuses paid calls once a session has spent a set amount.

**Questions they could ask**
- **Q:** Why does the browser not call the model API directly?
  **A:** The API key would be exposed to anyone who opens developer tools. A small backend holds the key, sets limits (allowed models, max tokens, a budget) and records cost. Here the backend also only accepts calls from its own pages: it checks the Host and Origin headers and requires a custom header that forces a CORS preflight it never approves, so other websites cannot make your browser spend your credit.
- **Q:** You have a long fixed document and many different questions about it. How do you cache it?
  **A:** Put the document in the system prompt and place an explicit cache breakpoint at its end, so every question reads the same cached prefix. Automatic caching puts the breakpoint at the end of the request, after the question that changes each time, so in this case it writes a new entry on every call and never reads one back. Automatic caching suits a growing conversation, where the prefix really is shared. Either way, confirm with `cache_read_input_tokens`.
- **Q:** How do you choose the effort level? (production trade-off)
  **A:** Run the same questions from your eval at several effort levels and compare correctness, output tokens, time and cost, then pick the lowest level that keeps quality. Easy questions rarely gain from high effort but pay for the extra thinking as output tokens; hard ones may need it. One run per level is a single sample, so repeat before deciding, and tune per route rather than globally.
- **Q:** How did you stop experiments from running up a bill?
  **A:** The server takes a `--budget`, and every reply is charged to a spend tracker from the token usage and the price table. Paid routes depend on a guard that returns 429 `budget_exceeded` once the session total reaches the budget. The check runs before each call, so one call in flight can still overshoot by its own cost; max_tokens is capped on the server (16,000 non-streaming, 32,000 streaming) to bound that.

**What I built:** The page calls the backend's `/api/stream`, `/api/messages` and `/api/count_tokens`. The stream route returns NDJSON text events and then a final event with the message, time to first text, total time and cost; the backend checks the model against an allow-list, caps max_tokens, charges `SpendTracker` (pricing by the model that answered, including cache writes at 1.25 times and cache reads), and maps SDK errors to `{error: {type, message}}`. Sections compare effort levels on one question, run three questions with an explicit breakpoint, automatic caching or none, and count tokens exactly.
