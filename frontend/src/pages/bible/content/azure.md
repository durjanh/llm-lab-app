## Document Automation (`/documents`)
**In one line:** document assembly stays deterministic (a Word template filled from interview answers), and the model only works around it: authoring templates, proposing answers with quotes, and reviewing the result.

**Key terms**
- **Document assembly**: generating a document by filling a template's variables, conditional clauses and repeated sections from structured answers, with no model in the loop.
- **docxtpl / Jinja tags**: the Python library the lab uses; `{{ field }}` is a variable, `{%p if x %}` an optional paragraph, `{%p for item in list %}` a repeated paragraph.
- **Interview**: the form of questions, generated from the template's fields, whose answers drive assembly.
- **Structured outputs**: the model's reply is constrained to a JSON schema (here `output_config.format = json_schema`), so the code gets fields, not prose to parse.
- **Extraction with provenance**: every proposed answer carries the quote it came from and a confidence, so a person can verify it at a glance.
- **Human in the loop**: AI proposes, a person confirms; nothing enters the document without being shown.
- **Model per step**: rare, hard steps (authoring a template) get a stronger model; frequent steps (filling, checking) get a fast, cheap one.

**Questions they could ask**
- **Q:** Why not just ask the LLM to write the whole contract?
  **A:** Because legal output must be reproducible and auditable. A template filled by code gives the same document for the same answers every time, and lawyers can review the template once. The model is used where it adds value, reading messy source notes and spotting inconsistencies, and its output is structured data a person confirms rather than free text that goes straight into the document.
- **Q:** How do you stop the model inventing an answer for a field?
  **A:** Require a verbatim quote for each proposed value and a confidence, and show both beside the field. Fields the source does not mention stay empty rather than guessed. In production I would also check the quote actually appears in the source in code, and track extraction accuracy per field against a labelled set.
- **Q:** How would you evaluate this before rolling it out to a legal team?
  **A:** Build a gold set of source documents with hand-filled answers, then measure per-field precision and recall for extraction, precision of the review step (are its issues real), and time saved per document. Run it for both the cheap and the strong model, because the schema and prompts are identical, so the comparison is like for like.
- **Q:** What are the failure modes in turning a finished document into a template?
  **A:** The model can propose replacements that are not in the text, or overlapping clauses. The code only wraps text it actually finds, replaces longer strings first (so a full company name is replaced before its short form), refuses overlapping clause spans, and reports anything it could not find rather than silently skipping it.

**What I built:** A FastAPI service using docxtpl for deterministic assembly and a live preview, with Claude (or an Azure OpenAI GPT deployment, same schema) for template authoring, interview extraction with quotes, a talk-to-fill chat with Azure Speech dictation, and a final review. Each AI step is a schema-constrained call charged to a spend tracker, and the page shows its cost.

## Case Handling on Azure (`/casework`)
**In one line:** a multi-agent pipeline drafts complaint decisions from records and policy, separate checks verify it, a named person approves, and everything goes into a tamper-evident audit log with a release gate.

**Key terms**
- **Multi-agent pipeline**: separate prompts for intake, evidence gathering, query planning, drafting, verification and revision, each with a narrow job and its own structured output.
- **Function calling (tool loop)**: the evidence agent calls read-only tools over three systems of record in a bounded loop (six rounds) until it returns facts.
- **Hybrid search**: one Azure AI Search request running BM25 keyword search and a vector query together, merged by Reciprocal Rank Fusion.
- **Semantic ranker**: Azure AI Search's reranker that rescores the top hybrid results with a language model, enabled with `queryType: semantic` and a semantic configuration.
- **Groundedness check**: a separate model call that tests each claim in the draft against the facts and policy extracts it cites.
- **Rule check**: code recalculates the decision and compensation from the records and policy; the model proposes, code verifies.
- **Hash-chained audit log**: append-only JSON lines where each entry stores the hash of the previous one, so editing or deleting an entry breaks the chain.
- **Release gate**: thresholds (decision 80%, compensation 80%, groundedness 90%) on a gold set that a prompt, model or retrieval change must pass before it ships.

**Questions they could ask**
- **Q:** How do you make an LLM-drafted decision safe to send to a member of the public?
  **A:** Layer the controls. Every claim must cite a fact id or a policy id; a separate verifier checks those citations; code recomputes the money from the rules; failures go back for one revision. Then a named caseworker reads, edits and approves, and approving despite failed checks requires a written reason.
- **Q:** Why recompute the compensation in code rather than trust the model?
  **A:** Arithmetic over dates and rates is deterministic and has a right answer, so code is cheaper and more reliable. The model is good at reading the policy and writing the letter. Comparing the two also gives a measurable signal: a mismatch flags the draft and feeds the revision prompt.
- **Q:** Is a hash chain enough for a tamper-proof audit trail?
  **A:** It is tamper-evident, not tamper-proof. Anyone with write access could rewrite the whole file and recompute every hash. In production I would anchor the latest hash somewhere the application cannot change, such as Azure Blob immutable storage or a ledger table in Azure SQL, and write the log under a separate identity.
- **Q:** How do you stop a prompt change from silently degrading quality?
  **A:** Version each prompt by a hash of its text and record the version with every model call. Run the whole pipeline over a gold set with hand-worked outcomes and block the release if any gated metric falls below its threshold. First-draft accuracy is reported too, so you can see how much the revision loop is covering for.
- **Q:** Why hybrid plus semantic ranker for policy retrieval?
  **A:** Policies use exact terms like "Stage 1" that keyword search matches well, while residents describe things in their own words, which vectors handle. RRF combines both, and the semantic ranker improves the order of the top results. The model plans four to six narrow queries, one per rule, so each search targets one rule.

**What I built:** Azure OpenAI (chat and text-embedding-3-small) and Azure AI Search over REST, both keyless with `DefaultAzureCredential` (Search needs the Search Index Data Contributor role). The run streams NDJSON to the page step by step; approval is a separate endpoint that refuses a second decision (409) and logs the reviewer, whether the letter was edited, and a hash of the letter sent.

## MedAssist on Foundry (`/medassist`)
**In one line:** a Foundry prompt agent books GP appointments; the model decides which tools to call, while what it is allowed to do is enforced in code inside the tools.

**Key terms**
- **Foundry prompt agent**: an agent definition (model, instructions, tools) stored and versioned in a Microsoft Foundry project, created with `PromptAgentDefinition`.
- **File Search tool**: a hosted tool that searches a vector store of uploaded documents (here the practice's information leaflets) and runs on Foundry's side.
- **Code Interpreter tool**: a hosted sandbox where the agent runs Python, used here for every calculation such as BMI.
- **Function tool**: a tool the agent requests but your code runs; the result goes back as a `function_call_output` item.
- **Conversation**: Foundry's server-side conversation state, referenced by id on each `responses.create` call.
- **Rules in tools**: constraints such as "book only a slot the patient has already seen" and "cancel takes two turns" live in the tool code, not the prompt.
- **Least privilege by session**: the signed-in patient is fixed by the portal session, so no tool argument can reach another patient's record.

**Questions they could ask**
- **Q:** Why put the booking rules in the tools rather than in the system prompt?
  **A:** A prompt is a request; the model does not always follow it, and it can be argued with. Code cannot. Here `book_appointment` refuses a slot offered in the same turn (the patient has not seen it yet), the database update only claims a slot that is still free, and cancelling returns "confirm first" until a later turn. The prompt explains the behaviour; the code guarantees it.
- **Q:** How does the tool loop work with a Foundry agent?
  **A:** Each patient message goes to `responses.create` with the conversation id and an agent reference. Foundry runs File Search and Code Interpreter itself; any function calls come back to our backend, which runs them against the session and sends the outputs back, round after round, up to six rounds, until the agent replies in words.
- **Q:** What would you change to run this in production for real patients?
  **A:** Real identity (Entra External ID or the NHS login equivalent) feeding the session, a managed identity for the backend instead of `az login`, private networking to Foundry, content safety on inputs and outputs, and evaluation sets for emergencies and refusals. I would also budget for File Search and Code Interpreter sessions, which are billed separately from tokens and are not counted by the lab's spend tracker.
- **Q:** How do you handle safety-critical messages like chest pain?
  **A:** The instructions say to give the 999 advice in the first sentence before doing anything else, and never to advise on doses. The page has test prompts for these (chest pain, a partner asking for someone's medication, a dose question). For production I would back that with a deterministic screen in code, as the Aftercare page does, because instructions alone are not a guarantee.

**What I built:** The agent is created once by `examples/medassist/medassist.py` (vector store, File Search, Code Interpreter, four function tools). The backend gateway uses `azure-ai-projects` with `DefaultAzureCredential` (Foundry User role), and the same `clinic.py` tool loop and rules serve the page, the command line and a C# port. A "Behind the portal" panel shows the real database, texts and audit log changing.

## Review Analysis with Azure Language (`/reviews`)
**In one line:** prebuilt Azure Language features (language detection, sentiment with opinion mining, key phrases, entities) applied to multilingual reviews, compared with asking a language model the same.

**Key terms**
- **Language detection**: returns the primary language as a name and ISO 639-1 code with a confidence from 0 to 1.
- **Sentiment analysis**: positive, neutral, negative and mixed labels per sentence and per document, with three scores that sum to 1.
- **Opinion mining**: aspect-based sentiment that links a target ("cable") to what was said about it ("stopped charging").
- **Key phrase extraction**: the main talking points, returned in the text's own language.
- **Named entity recognition (NER)**: names with a category such as Product, Organization or Location.
- **Text record**: the billing unit, one per feature for each started 1,000 characters.
- **modelVersion**: a request parameter that pins a feature's model so results do not shift when Microsoft updates it.

**Questions they could ask**
- **Q:** Why detect the language first?
  **A:** The other features assume English when no language is given, so a German review would be scored as if it were English. The page detects first and passes the code on. It also maps `zh_chs` to `zh-hans`, because detection and the other features use different codes for Chinese.
- **Q:** Would you use Azure Language or an LLM for this today?
  **A:** Microsoft is retiring sentiment analysis, opinion mining and key phrase extraction from Azure Language on 31 March 2029 and points new projects to Foundry models, so for new work I would start with a model and a JSON schema. A model can use my own categories and report phrases in English for counting across languages. Azure Language still gives calibrated scores and pinned model versions, which matter when you need stable trends over time.
- **Q:** What traps are there in trusting the dashboard numbers?
  **A:** Stars and text often disagree, and sometimes the text is right. Entity labels are noisy: a brand can come back as a Location, or as a Product in one language and an Organization in another, so a list of your own brands matched in code is better for counting. Detection returns one language per document, so a mixed-language review is analysed as the first language.
- **Q:** How do you handle the service limits at scale?
  **A:** Each feature has its own documents-per-request limit (here 10 for sentiment and key phrases, 5 for entities, 1,000 for detection), so the gateway splits the list and sends the batches in parallel. A 429 comes back as a clear "wait and retry" message. The service also caches results per session, so the same text is never paid for twice.

**What I built:** A keyless REST gateway to `/language/:analyze-text` (api-version 2024-11-01) with an Entra token (Cognitive Services Language Reader), batching by feature limit with a thread pool. A comparison panel sends the same review to Claude with a schema and shows the two side by side, with cost.

## Aftercare: Post-discharge Follow-up Agent (`/aftercare`)
**In one line:** an agent calls or texts discharged patients to check medicines, warning signs and follow-up; the conversation is the model's, but identity, escalation, the checklist and the record are rules in code that hold under two different engines.

**Key terms**
- **LACE index**: a 30-day readmission or death risk score from Length of stay, Acute admission, Comorbidity (Charlson) and Emergency visits; 10 or more is high risk.
- **Identity gate**: nothing clinical reaches the model until the patient's date of birth matches; three wrong answers lock the call.
- **Deterministic emergency screen**: every patient message is checked for emergency phrases in English and Spanish before the model sees it, with negation handling.
- **Code-held checklist**: the call cannot finish until medicines, warning signs, follow-up and barriers are recorded, unless the patient ends it.
- **Microsoft Agent Framework**: Microsoft's agent SDK; here an `Agent` on `FoundryChatClient` (the Responses API on the Foundry project) runs the tool loop itself.
- **Prompt caching**: the instructions and tool definitions are marked `cache_control: ephemeral` so each Claude round pays full price only for new tokens.
- **Outcome-based evaluation**: scripted simulated patients, with code checking what the call left in the record rather than asking a model whether it went well.

**Questions they could ask**
- **Q:** What changes when you move from your own tool loop to a framework that runs the loop for you?
  **A:** You no longer see each round, so every rule has to live inside the tools, which is why they are there. Agent Framework also runs parallel tool calls at the same moment; two writes on one SQLite connection failed until a lock made tools run one at a time per call. Our own Claude loop runs them in order, so the bug only showed under the framework.
- **Q:** How do you test a conversational agent like this?
  **A:** Eight scripted patients, each with a story and checks: a prescription never collected, chest pain mid-call, a Spanish speaker, a neighbour answering. A simulated patient plays the story and code inspects the record afterwards: tasks raised, escalation level, note in English. I test what the call left behind, not what the agent said, and read transcripts as well as the score.
- **Q:** How do you stop the agent leaking data to the wrong person?
  **A:** The model only gets the first name, the wave and the channel until the date of birth matches in code. It cannot leak what it was never given. Three failed attempts lock the call, and every recorded answer must quote the patient's latest message, which is checked.
- **Q:** What did you learn comparing models?
  **A:** Both Haiku and gpt-5.4-mini passed every check once the rules were in code. Before that, gpt-5.4-mini invented answers and wrote a Spanish care-team note, and Haiku recorded a medicine before asking. In that run gpt-5.4-mini cost about four times as much. Different models fail differently, so the guardrails must not depend on one model's habits.
- **Q:** How would this connect to a real hospital system?
  **A:** The lab uses SQLite, but each write already has the shape of a FHIR resource (tasks, appointments, communications, the note), so it would go to the EHR's FHIR API, or an integration layer where there is no API. A real phone line would add telephony such as Azure Communication Services; the speech-to-text, agent, text-to-speech pipeline and the rules would stay the same.

**What I built:** One tool file (`examples/aftercare/ward.py`) serves both engines: Claude through our Messages API loop with cached tools, and Agent Framework on a Foundry model with keyless sign-in. Voice uses Azure Speech neural voices in the browser; the care team's queue shows tasks the agent raised, which only a person can close.

## Data Agent with a Semantic Layer (`/data-agent`)
**In one line:** an analytics agent answers questions over a warehouse by querying a semantic model first, adding a field when one is missing, and writing SQL only as a fallback, with row-level security enforced below the model.

**Key terms**
- **Semantic layer**: declared topics, joins, dimensions, measures and timeframes, so "merge rate" means the same thing in every chart.
- **Query compiler**: code that checks field names, puts values in parameters and builds the SQL from a structured query.
- **Row-level security (RLS)**: limiting rows by the caller's identity; here each company's queries run on a copy holding only its rows.
- **SQLite authorizer**: a per-statement callback that allows only reads (no writes, PRAGMA or ATTACH), on a read-only connection.
- **Progress handler timeout**: stops any query running longer than five seconds; results are capped at 5,000 rows.
- **Value lookup**: the agent fetches real values ("harbour") before filtering, instead of guessing them.
- **Tenant-scoped cache**: the result cache key includes the company, because the same SQL returns different rows per tenant.

**Questions they could ask**
- **Q:** Why not just let the model write SQL against the schema?
  **A:** Free SQL invents columns, picks wrong joins and redefines metrics from chart to chart. A semantic model gives agreed definitions and lets code validate every name. SQL stays available for what the model cannot express, such as ranks or cross-topic subqueries, but it is the fallback, not the default.
- **Q:** How do you make multi-tenant data safe with an LLM writing queries?
  **A:** Never rely on the prompt to filter. The company comes from the sign-in, no tool takes a company argument, and every query runs on a database holding only that tenant's rows. My first attempt used views named like the tables, and it leaked: a CTE named after the view read the base table. On a real warehouse I would use native row policies, such as Azure SQL security policies or Postgres `CREATE POLICY` with a role that cannot bypass them.
- **Q:** What happens when the agent's SQL is wrong?
  **A:** The error goes back to the model as a tool result, so it fixes its own query. A new field is tried once before it joins the model, so a bad expression fails as a tool error rather than as a broken chart later. The model sees only the first 40 rows and a summary, so long results do not fill the context.
- **Q:** What would you do differently on Azure?
  **A:** Run it on Azure SQL or Fabric with Entra sign-in per user, a read-only database role, row-level security policies tied to the user's claims, and query timeouts set on the server. The semantic model itself could live in a Power BI or Fabric semantic model if the organisation already has one.

**What I built:** Claude drives nine tools (search the model, describe a topic, look up values, run a query, create a field, describe the schema, run SQL, set a chart, add to a dashboard) in a streamed background run. People can edit the agent's query in a field list or SQL tab, which runs through the same checks at no model cost.

## AI-103 Exam Map (`/ai-103`)
**In one line:** every skill in the AI-103 "Developing AI Apps and Agents on Azure" study guide (as of 16 April 2026), mapped to a lab page where it runs or is explained.

**Key terms**
- **Exam domains and weights**: Plan and manage an Azure AI solution 25–30%; Implement generative AI and agentic solutions 30–35%; Computer vision 10–15%; Text analysis 10–15%; Information extraction 10–15%. A score of 700 passes.
- **Foundry project**: the workspace in a Microsoft Foundry resource that holds model deployments, agents, connections, evaluations and tracing; apps connect through its endpoint with `azure-ai-projects`.
- **Foundry Tools**: the prebuilt AI services (Language, Translator, Speech, Content Safety, Content Understanding) alongside models.
- **Deployment types**: Global Standard, Data Zone Standard, regional Standard, Provisioned (PTU), Global Batch and Developer, which trade price, quota and data residency.
- **Keyless authentication**: Microsoft Entra ID with a managed identity and data-plane roles, with `disableLocalAuth` switching keys off.
- **Guardrails (content filters)**: Content Safety categories with severity thresholds, Prompt Shields for direct and indirect prompt injection, protected material and groundedness detection.
- **Evaluators**: built-in quality evaluators (groundedness, relevance, coherence, fluency) and safety evaluators, run locally or as cloud evaluations in Foundry.
- **Content Credentials (C2PA)**: signed provenance metadata embedded in generated images.

**Questions they could ask**
- **Q:** A company must keep inference data inside the EU but wants high quota. Which deployment type?
  **A:** Data Zone Standard (EU), which keeps processing within the EU data zone while pooling capacity across its regions. Global Standard gives the most quota but can process anywhere. Regional Standard keeps data in one region but has lower quota and fewer models.
- **Q:** An app gets 429s even though monthly token usage is far below quota. Why, and what do you do?
  **A:** Rate limits are per minute per deployment, and requests per minute are checked over short windows of 1 or 10 seconds, so bursts throttle you. Read the `x-ratelimit-remaining-*` headers, honour `retry-after`, smooth traffic with a queue, spread load across deployments or regions, or move steady volume to provisioned throughput.
- **Q:** How do you let an app call Azure OpenAI without storing a key?
  **A:** Give the app a managed identity, assign it the Cognitive Services OpenAI User role (or the Foundry User role for agents) on the resource, use `DefaultAzureCredential`, and set `disableLocalAuth` to true. Add private endpoints and disable public network access for production.
- **Q:** Which search configuration gives the best grounding for RAG?
  **A:** Usually hybrid search (keyword plus vector, merged by RRF) with the semantic ranker on top, but measure it on labelled questions. Exact codes favour keyword; paraphrases favour vectors; the semantic ranker improves the top of the list but is not always better.
- **Q:** A document contains hidden instructions that try to hijack the agent. Which feature detects that?
  **A:** Prompt Shields in Azure AI Content Safety, with the document passed in the `documents` field, which is the indirect prompt injection (document attack) check. User-input jailbreaks are checked in `userPrompt`. For text inside images, extract it first (OCR or Content Understanding) and then screen it.

**What I built:** A static map page (`AREAS` in `Ai103Page.tsx`) listing each skill with links to the labs, tagged "runs here" or "explained" where something outside the lab is needed (indexer skillsets, video generation, the CI/CD workflow's first run). Six labs were built for the exam: guardrails, Content Understanding, image generation, search pipeline, translation and speech, and Foundry operations.

## Content Understanding and Vision (`/content-understanding`)
**In one line:** two ways to read files: Azure Content Understanding for Markdown and fields with confidence scores and source boxes, and a multimodal model for captions, alt text, visual Q&A and regions.

**Key terms**
- **Azure Content Understanding**: a Foundry Tool that analyses documents, images, audio and video into Markdown and schema fields, using OCR, layout and a generative model.
- **Analyzer**: a configuration (prebuilt such as `prebuilt-layout`, `prebuilt-invoice`, `prebuilt-documentSearch`, or custom) that defines what to extract.
- **Field methods**: `extract` (copy what is printed), `classify` (choose from a fixed list) and `generate` (work something out).
- **Confidence and grounding**: each field value comes with a score and the bounding box it came from, enabled by `estimateFieldSourceAndConfidence`.
- **Straight-through processing**: high-confidence values go through automatically; low-confidence ones go to a person.
- **Agentic mode**: a preview workflow (successor to the 2025 "pro mode") that reasons over evidence in several steps, at more cost and time.
- **Supported models**: each analyzer lists the completion models it accepts; the resource needs default model deployments set.

**Questions they could ask**
- **Q:** When would you use Content Understanding over just sending the image to GPT?
  **A:** When extraction will be automated at volume. Content Understanding gives each field a confidence and a source box, so you can route low-confidence values to review and audit where a value came from. A model's answer has neither, and its boxes are approximate. Use the model for flexible tasks like captions, alt text and questions about one picture.
- **Q:** An invoice's lines add up to 409 but its subtotal says 400. How do you catch that?
  **A:** Add a `generate` field that works out the sum, alongside `extract` fields for what is printed, then compare in code. Here the standard analyzer got 409 against 400 correctly. Agentic mode also got it, but took about five times as long, used four times the tokens and garbled the pound sign, so use it only when standard gets an answer wrong.
- **Q:** How do you treat generated fields compared with extracted ones?
  **A:** As drafts. Extracted values here had confidences of 0.9 and above; generated notes came in under 0.25. Extraction is a different promise from generation, and the review workflow should reflect that.
- **Q:** What went wrong deploying it, and what is the lesson?
  **A:** A domain prebuilt refused gpt-4.1-mini and needed a full-size model deployment. Check each analyzer's supported models before deploying, deploy what your analyzers need, then set the resource's default model deployments once.

**What I built:** A keyless REST gateway (`foundry_tools.py`) calls Content Understanding (GA api-version 2025-11-01, and a 2026-06-01 preview for agentic mode) with custom analyzers defined in code, plus gpt-5.4-mini for vision tasks with a schema, drawing both kinds of boxes over the image. Samples are an invented insurance claim: invoice, claim form, photos and a narrated video.

## Image Generation with gpt-image-2 (`/image-generation`)
**In one line:** generating and editing images (prompt, reference images, mask inpainting) with every API control, then provenance, watermarking and a brand-rules check before use.

**Key terms**
- **gpt-image-2**: the image model deployed in Foundry; it supports generation, edits with references and mask-based inpainting.
- **Inpainting mask**: a PNG the same size as the image where fully transparent pixels (alpha zero) mark the area to edit.
- **Generation controls**: size (1024×1024, 1536×1024, 1024×1536), quality, background and number of images (`n`).
- **Token billing for images**: text and image input tokens plus image output tokens; higher quality or larger size means more output tokens.
- **Content Credentials (C2PA)**: a signed provenance manifest embedded in the image (a `caBX` chunk in a PNG) saying an AI made it.
- **Visible watermark**: a label drawn on the pixels, which survives re-saving and screenshots, unlike metadata.
- **Visual policy check**: a multimodal model judging the image against brand rules a content filter does not know.

**Questions they could ask**
- **Q:** How do you prove an image was AI-generated, and what are the limits?
  **A:** Azure OpenAI embeds C2PA Content Credentials, which a verifier can check. But metadata disappears when the file is re-saved or screenshotted. So keep the original, and add a visible watermark where people need to see it.
- **Q:** The deployment returns 429 on the second image. Why, and how do you design for it?
  **A:** Image deployments have small per-minute capacity; at capacity 1 a second request within the minute is throttled. Wait out `retry-after`, queue requests, or request more quota. The lab waits up to a minute and reports the wait.
- **Q:** How would you enforce brand rules on generated images?
  **A:** Content filters catch harmful content, not "no real brands" or "prices in pounds". Run a multimodal model with a schema listing each rule and a pass or fail with a reason, and route failures to a person. Combine that with Content Credentials for provenance and a visible label.
- **Q:** What about video generation?
  **A:** The page explains it with code (text to video, image to video, remix of a finished video by id) but does not run it, because Sora 2 was refused as deprecated in both regions tried. The lesson is to check a model's lifecycle and retirement date before designing around it, especially for previews.

**What I built:** The backend calls `/openai/v1/images/generations` and `/images/edits` on a second AI Services resource in Sweden Central with an Entra token, saves images for re-editing, reads usage from each response for cost, checks for the C2PA chunk, draws a watermark with Pillow and runs a gpt-5.4-mini policy check with a schema.

## Search Ingestion and Relevance (`/search-pipeline`)
**In one line:** a push pipeline from mixed-media files to an Azure AI Search index, then keyword, vector, hybrid and semantic modes scored on labelled questions, and the index used as an agent's tool.

**Key terms**
- **Push vs pull ingestion**: push means your code extracts, chunks, embeds and uploads; pull means an indexer reads a data source on a schedule.
- **Indexer and skillset**: an indexer pulls from Blob, SharePoint or a database and runs a skillset of built-in skills (OCR, layout, split, key phrases, embeddings) and custom Web API skills.
- **Index projections**: write one search document per chunk from a skillset, so a parent file becomes many child documents.
- **Vector profile / HNSW**: the vector field's profile names an algorithm; HNSW is an approximate nearest-neighbour graph (fast, slightly lossy), against exhaustive KNN (exact, slower).
- **RRF hybrid scoring**: Reciprocal Rank Fusion merges the keyword and vector result lists by rank, not by raw score.
- **Semantic ranker**: reranks the top results with a language model and can return extractive captions and answers; needs a semantic configuration naming title, content and keyword fields.
- **Integrated vectorization**: a vectorizer on the index so the service embeds queries itself; needs the search service's managed identity to reach Azure OpenAI.
- **Hit@k and MRR**: relevance metrics; Hit@1 means the right source came first, MRR is the mean of 1/rank.

**Questions they could ask**
- **Q:** How do you choose between keyword, vector, hybrid and semantic search?
  **A:** Measure on your own labelled questions. Here keyword missed paraphrases ("report the damage" against "tell us about a claim") that vectors found, while exact codes like an invoice number suit keywords. Hybrid is the usual default; the semantic ranker put the right source first most often but dropped a long video transcript chunk out of the top five for one question.
- **Q:** How do you monitor ingestion quality and index health?
  **A:** Compare what the pipeline reported (chunks per source) with the index's document count and storage from the statistics API. Statistics lag uploads by a few seconds, so check after a short wait. Track relevance metrics over time against a fixed question set.
- **Q:** Push or indexer for production?
  **A:** An indexer suits data already in Blob, SharePoint or SQL that changes on a schedule: it handles change tracking and retries, and skillsets do enrichment. Push gives full control over chunking and enrichment and works for any source, at the cost of writing the orchestration. Either way, cache the extraction output, because it is the slow, costly step, and re-chunk or re-embed from the cache.
- **Q:** What are the limits of the Free tier?
  **A:** Three indexes, 50 MB, and the semantic ranker's free plan of 1,000 queries a month. Fine for a lab, but production needs Basic or above for capacity, an SLA with replicas, and private endpoints.

**What I built:** Content Understanding extracts text from documents, photos and video; chunks of 900 characters with 100 overlap get Azure Language key phrases and text-embedding-3-small vectors (1536 dims, HNSW, cosine) and go into one index with a semantic configuration. A relevance panel scores the four modes, and gpt-5.4-mini gets one function, `search_claim_file`, that runs hybrid plus semantic search and answers with citations. All calls use Entra tokens.

## Translation, Text Analysis and Speech (`/translation-speech`)
**In one line:** translating with Azure Translator (glossary, transliteration, dictionary) or a language model (tone and terms), structured complaint analysis with a schema, and Azure Speech for transcription, phrase lists and speech translation.

**Key terms**
- **Azure Translator**: Text Translation v3.0; translates into several targets in one call and detects the source language.
- **Dynamic dictionary**: `<mstrans:dictionary translation="...">term</mstrans:dictionary>` markup that forces a term's translation in one request.
- **Transliteration**: changing script without changing language, such as Japanese into Latin letters.
- **Dictionary lookup**: alternative translations with back-translations, showing that one word has several meanings.
- **Phrase list**: a runtime hint telling the speech recogniser which names and terms to expect; no training needed.
- **Custom speech**: a trained speech-to-text model for domain vocabulary or acoustics, when phrase lists are not enough.
- **TranslationRecognizer**: the Speech SDK class that recognises speech in one language and returns text in another, which a neural voice can then speak.

**Questions they could ask**
- **Q:** Translator or an LLM for customer letters?
  **A:** Measure on your own text. Here gpt-5.4-mini kept the approved terms with correct grammar and a consistent formal tone, and cost less for one language. Translator handles many targets in one call and is predictable, but bills characters per target language, and its dynamic dictionary forced the term without fixing the article around it. For fixed terminology at scale, Custom Translator with a glossary is the more robust option.
- **Q:** How do you get the browser to use Azure Speech without exposing a key?
  **A:** The backend issues a short-lived token. With Entra, it gets a token with its own identity and passes it to the SDK as `aad#<resource id>#<token>`; that needs a custom domain on the Speech resource and the Cognitive Services Speech User role. The backend reuses a token for eight minutes and the page refreshes before it expires.
- **Q:** The recogniser keeps misspelling a street name. What do you do?
  **A:** Add a phrase list first: here "Harbour Rd." became "Harbour Road" with no training. If that is not enough, train and deploy a custom speech model with domain text or audio. Also check the locale: an en-US analyzer wrote "Harbor Road".
- **Q:** How do you turn a complaint in any language into something a regulated team can act on?
  **A:** Send it to a model with a JSON schema: category, tone, vulnerability signals, redress asked for, and the 56-day final response deadline, with the summary always in English. The schema makes it usable downstream, but check the words: it summarised "techo" as the roof rather than the ceiling.

**What I built:** The backend calls Translator v3.0 through the AI Services endpoint with Entra (keyless), one call per target when the glossary is on since its markup is per language. Speech runs in the browser with the Speech SDK and a backend token, and audio questions use Content Understanding's audio analyzer plus gpt-5.4-mini.
Profanity handling only covers what Translator classes as profanity, so it is not a content filter.

## Foundry Operations (`/foundry-operations`)
**In one line:** running AI on Foundry in practice: deployment types, quota, rate-limit headers, Azure Monitor metrics, security posture, an evaluation gate and an OpenTelemetry trace, all read live from the lab's own resources.

**Key terms**
- **Deployment types**: Global Standard (any region, most quota), Data Zone Standard (EU or US), regional Standard, Provisioned (PTU, reserved throughput), Global Batch (async within 24 hours at about half price), Developer (fine-tuned models, no hosting fee, no SLA).
- **Quota vs rate limit**: quota is per subscription, region, model and deployment type in TPM; assigning it to a deployment sets that deployment's TPM and RPM limits.
- **Rate-limit headers**: `x-ratelimit-remaining-tokens` and `x-ratelimit-remaining-requests` on every response, and `retry-after` on a 429.
- **Azure Monitor metrics**: AzureOpenAIRequests, ProcessedPromptTokens, GeneratedTokens, TimeToResponse, Ratelimit and BlockedCalls, read from `Microsoft.Insights/metrics`.
- **Security posture**: `disableLocalAuth` (keyless), `publicNetworkAccess`, managed identity and role assignments at the resource scope.
- **LLM-judge evaluators**: a model scores groundedness, relevance and coherence from 1 to 5 with a reason.
- **OpenTelemetry GenAI spans**: one span per step (embed, search, chat, safety) with token and timing attributes, exported to Application Insights with `configure_azure_monitor()`.
- **OIDC federated credentials**: the CI pipeline signs in to Azure with a GitHub token trusted for the main branch only, with no stored secret.

**Questions they could ask**
- **Q:** How do you design a release gate for an LLM app?
  **A:** Use several evaluators, because each misses something. Here the gate needs mean groundedness, relevance and coherence of 4.0 and token F1 of 0.3. The judge caught the invented and off-topic answers, while F1 alone would have failed a correct but longer answer. Then do error analysis: read the low rows and the judge's reasons before trusting a score.
- **Q:** Another team's deployment is eating your quota. How?
  **A:** Quota is shared across every resource in the subscription for that region, model and deployment type. Compare usage against the limit in the usages API, not just your own capacity, and agree allocations, use a different region or deployment type, or move to PTU for guaranteed throughput.
- **Q:** What does your CI/CD for Foundry look like?
  **A:** On a pull request it only compiles the Bicep, with no Azure sign-in. On main it signs in with OpenID Connect, shows a what-if, runs `azd provision`, then runs the evaluation gate, which fails the run below its thresholds. The pipeline identity has Contributor and can grant only the lab's own roles on its resource group, through a role-assignment condition. The page notes this workflow has not had its first GitHub run yet.
- **Q:** What would a production security review flag here?
  **A:** Keyless and a managed identity are in place, but public network access is still on. Production wants private endpoints, selected networks only, diagnostic logs to Log Analytics, and alerts on BlockedCalls, RAI metrics and time to response.
- **Q:** How do you find where latency comes from in a RAG request?
  **A:** Trace it. Each step is a span: embedding, search, chat, content safety. Here the model call was most of the time, and the search span showed what the answer was built from. In Foundry, the spans go to the project's connected Application Insights.

**What I built:** The service reads deployments, quotas, metrics and role assignments read-only from Azure Resource Manager with an Entra token, makes one small call to show the rate-limit headers, runs the evaluation with gpt-5.4-mini as judge plus Content Safety groundedness detection, and records a traced RAG answer with the OpenTelemetry SDK. Deployments are code in `infra/resources.bicep`.
