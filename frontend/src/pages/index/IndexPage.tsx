import './index.css';

export default function IndexPage() {
  return (
    <main className="page-index">
      <div className="hero">
        <div className="kicker">LLM Lab for AI engineers</div>
        <h1>See how large language models work, then build with them better</h1>
        <p className="lede">
          Eighteen hands-on labs plus an animated transformer explainer. Each one runs real models or real arithmetic in
          your browser, explains one mechanism, and ends with the engineering decisions it should change in your code.
        </p>
        <div className="note" style={{ marginTop: '14px' }}>
          <b>How to run it.</b> Build the React frontend once with <code>npm run build</code> in <code>frontend/</code>,
          then start the FastAPI backend with <code>python -m backend --budget 1</code> and open http://localhost:8000.
          While changing the code, also run <code>npm run dev</code> and open http://localhost:5173. The <b>Start</b>{' '}
          section of <code>README.md</code> has every command and a troubleshooting table.
        </div>
      </div>
      <h2>Revise</h2>
      <p className="muted">Everything in the lab, as questions and answers.</p>
      <div className="labs">
        <a className="lab-card" href="/bible">
          <span className="num">Bible</span>
          <h3>The lab in questions and answers</h3>
          <p>
            For every page: the key terms, the questions people ask about them, and short answers you could give out
            loud. It opens with temperature and top-p, saving tokens, and running an AI system in production, and it is
            searchable.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which ideas you can explain, and which page to open for the ones you can&apos;t.
          </span>
          <span className="dl">No download</span>
        </a>
      </div>
      <h2>Foundations</h2>
      <p className="muted">How a model turns text into a prediction, and how it learned to do it.</p>
      <div className="labs">
        <a className="lab-card" href="/course">
          <span className="num">Course</span>
          <h3>The LLM course, lecture by lecture</h3>
          <p>
            Stanford's CME 295 in order, from the transformer to agents and evaluation, with "What is GPT" as lecture 0.
            Each lecture links to the labs that teach it.
          </p>
          <span className="decides">
            <b>Start here</b> if you want a path rather than a menu.
          </span>
          <span className="dl">A guide to the labs</span>
        </a>{' '}
        <a className="lab-card" href="/transformer">
          <span className="num">Start here</span>
          <h3>Transformer explainer</h3>
          <p>
            Follow a prompt through embeddings, attention, the MLP and the output probabilities, with every value
            computed live.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> nothing yet. It builds the mental model the other labs rely on.
          </span>
          <span className="dl">Tiny built-in model, or GPT-2 at 128 MB</span>
        </a>{' '}
        <a className="lab-card" href="/building">
          <span className="num">Lab 13</span>
          <h3>How LLMs are built</h3>
          <p>
            Follow a model from web crawl to assistant: data cleaning, scaling laws, fine-tuning, preference tuning and
            training memory.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when fine-tuning is worth it, what training would cost, and why models behave as
            they do.
          </span>
          <span className="dl">GPT-2, 128 MB, for two demos</span>
        </a>{' '}
        <a className="lab-card" href="/training">
          <span className="num">Lab 9</span>
          <h3>Training</h3>
          <p>Train a tiny language model in your browser and watch it learn, then overfit and memorise.</p>
          <span className="decides">
            <b>Helps you decide:</b> prompting, retrieval or fine-tuning, and how much data each needs.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/tokens">
          <span className="num">Lab 1</span>
          <h3>Tokens</h3>
          <p>Watch text turn into tokens, compare data formats by token count, and plan a context budget.</p>
          <span className="decides">
            <b>Helps you decide:</b> prompt formats, cost estimates, what fits in context, and which tasks need a tool.
          </span>
          <span className="dl">Tokenizer download, 2 MB</span>
        </a>{' '}
        <a className="lab-card" href="/token-counter">
          <span className="num">Lab 51</span>
          <h3>Token counter</h3>
          <p>
            Paste a prompt and a system prompt and see the exact token count from each Claude model, what sending it
            costs, and how much of the context window it fills.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> whether a prompt is worth trimming, and what it costs at volume.
          </span>
          <span className="dl">No download; needs the backend and an API key (counting is free)</span>
        </a>{' '}
        <a className="lab-card" href="/sampling">
          <span className="num">Lab 2</span>
          <h3>Sampling</h3>
          <p>
            Run one prompt under greedy, balanced and creative settings and see the model’s confidence token by token.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> temperature and top-p per task, when to sample several answers, and how to spot
            guesses.
          </span>
          <span className="dl">GPT-2 download, 128 MB</span>
        </a>{' '}
        <a className="lab-card" href="/ml">
          <span className="num">Lab 14</span>
          <h3>Machine learning algorithms</h3>
          <p>
            Seventeen algorithms, from linear regression to transformers, each running live with when to use it and
            where it appears in AI today.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which model fits your data, and when you do not need an LLM at all.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/deep-learning">
          <span className="num">Lab 23</span>
          <h3>Deep learning notebooks</h3>
          <p>
            The 29 notebooks of <i>Understanding Deep Learning</i> as interactive demos: shallow and deep networks,
            losses, gradient descent to Adam, backpropagation, initialisation, residual networks, batch norm, attention,
            tokenization and graph networks.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> why training settings such as the learning rate, initialisation and normalisation
            matter.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/store-watch">
          <span className="num">Lab 49</span>
          <h3>Shoplifting alert desk</h3>
          <p>
            A behaviour alert, a person&apos;s decision, a watchlist and a check at the door, with scripted people or
            your own webcam and consenting test participants. High scores alert the admin at once, and only a person can
            put anyone on the list.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> where automation stops and a person must decide when a mistake accuses someone.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/agent-types">
          <span className="num">Lab 50</span>
          <h3>Thirteen types of agent</h3>
          <p>
            Reflex, LLM, tool-using, planning, memory, multi-agent, hierarchical, self-improving, RAG, code, web
            browsing, computer use and autonomous agents: what each is for, when not to use it, and a working example of
            every one, from a free rules engine to Claude driving a browser and a desktop.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> the simplest kind of agent that does your job, and the limits it needs in code.
          </span>
          <span className="dl">Python scripts; the browser and desktop agents need Chrome</span>
        </a>{' '}
        <a className="lab-card" href="/workflows">
          <span className="num">Lab 48</span>
          <h3>Every kind of agent workflow</h3>
          <p>
            Thirteen real Agent Framework programs: sequential, concurrent, handoff, group chat, maker-checker,
            Magentic, orchestrator and workers, routing edges, human approval, checkpoints, sub-workflows and YAML
            workflows. Replay real runs for free or run them live.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which shape of workflow your task needs, if it needs one at all.
          </span>
          <span className="dl">No download; live runs need Azure</span>
        </a>{' '}
        <a className="lab-card" href="/deep-learning-book">
          <span className="num">Lab 47</span>
          <h3>Understanding Deep Learning: the book and research</h3>
          <p>
            The book chapter by chapter: what each one offers, its worked examples, and where its ideas live in an LLM.
            Then the research: which changes make LLMs faster, cheaper or better, by how much, and at what cost, with a
            what-if estimator and a source for every number.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which improvements (quantisation, mixture of experts, speculative decoding, RL
            post-training) are worth it for your system.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/hardware">
          <span className="num">Lab 26</span>
          <h3>Hardware for AI</h3>
          <p>
            CPU, GPU, TPU, NPU, LPU and DPU: race your own CPU against your GPU, watch a systolic array multiply, work
            out tokens per second from memory bandwidth for real chips, and see what quantising a model does.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which processor fits a workload, and why generating text is limited by memory
            speed.
          </span>
          <span className="dl">No download; the GPU race needs a browser with WebGPU</span>
        </a>{' '}
        <a className="lab-card" href="/vision">
          <span className="num">Lab 27</span>
          <h3>Images as tokens</h3>
          <p>
            How a transformer reads a picture: cut it into patches, flatten each into numbers, project it into a token,
            add position, run attention, and join it with text. With your own picture, and what images really cost in
            tokens.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how big to send images, and why vision models need so much data.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/what-is-gpt">
          <span className="num">Lab 28</span>
          <h3>What is GPT</h3>
          <p>
            Microsoft's "What is a GPT?" made hands-on: GPT-2 predicts the next token live, the "cloud" example, a
            corrected history, and decoder-only explained.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how a GPT really works before choosing or explaining one.
          </span>
          <span className="dl">GPT-2, 128 MB, when you press Load</span>
        </a>{' '}
        <a className="lab-card" href="/transformer-tricks">
          <span className="num">Lab 29</span>
          <h3>Transformer tricks</h3>
          <p>
            RoPE, RMSNorm, multi-query and grouped-query attention, sliding windows, FlashAttention's online softmax,
            mixture of experts and speculative decoding, each computed.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> what makes modern models fast and long-context.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/training-at-scale">
          <span className="num">Lab 30</span>
          <h3>Training at scale</h3>
          <p>
            LoRA trained live, the memory to train or fine-tune 1B to 70B models, and data, tensor and pipeline
            parallelism with ZeRO.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when LoRA is enough, and how many GPUs a job needs.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/preference-tuning">
          <span className="num">Lab 31</span>
          <h3>Preference tuning</h3>
          <p>
            A reward model from comparisons, PPO's clipping, reward hacking contained by the KL penalty, and DPO, on a
            policy you can train.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> RLHF or DPO, and why the KL penalty matters.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/reasoning-models">
          <span className="num">Lab 32</span>
          <h3>Reasoning models</h3>
          <p>
            GRPO running live, verifiable rewards and a gamed checker, pass@k against majority voting, and the
            thinking-budget trade-off.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when to pay for reasoning, and how reasoning models are trained.
          </span>
          <span className="dl">No download</span>
        </a>
      </div>
      <h2>Building</h2>
      <p className="muted">The three patterns most LLM features are made of.</p>
      <div className="labs">
        <a className="lab-card" href="/prompting">
          <span className="num">Lab 3</span>
          <h3>Prompting</h3>
          <p>
            Measure how instructions, examples and their balance change accuracy, try constrained decoding, and see a
            prompt injection.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> zero-shot or few-shot, structured outputs, and how to handle untrusted text.
          </span>
          <span className="dl">GPT-2 download, 128 MB</span>
        </a>{' '}
        <a className="lab-card" href="/embeddings">
          <span className="num">Lab 5</span>
          <h3>Embeddings and RAG</h3>
          <p>
            Search by meaning and by keyword, rerank, then run a full retrieval pipeline and see the exact prompt it
            builds.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> chunking, top-k, thresholds, hybrid search and reranking.
          </span>
          <span className="dl">Embedding model 23 MB, optional reranker</span>
        </a>{' '}
        <a className="lab-card" href="/agents">
          <span className="num">Lab 6</span>
          <h3>Agents and tools</h3>
          <p>
            Step through the tool-use loop request by request, including parallel calls, errors and a human approval
            gate.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> whether you need an agent at all, and how to write tools, loops and safeguards.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/context-engineering">
          <span className="num">Lab 15</span>
          <h3>Context engineering</h3>
          <p>Build the context for one request, order it for caching, and manage long conversations and tool output.</p>
          <span className="decides">
            <b>Helps you decide:</b> what to put in each request, in what order, and what to leave out.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/harness">
          <span className="num">Lab 16</span>
          <h3>Harness engineering</h3>
          <p>
            Watch an autonomous agent work until the job is done, and switch off verification, limits or approval to see
            what breaks.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how to design an agent that finishes reliably, and which harness to build on.
          </span>
          <span className="dl">No download; runnable Python agent</span>
        </a>{' '}
        <a className="lab-card" href="/claude-code">
          <span className="num">Lab 17</span>
          <h3>Claude Code setup</h3>
          <p>
            CLAUDE.md, skills, hooks, subagents and plugins, with a session walkthrough, best practices and copyable
            examples.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which mechanism to use for each need, and how to share a setup with your team.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/claude-code-inside">
          <span className="num">Lab 18</span>
          <h3>Claude Code behind the scenes</h3>
          <p>
            An animated, step-by-step tour for presenting: /init, the agent loop, what every request carries, how your
            code reaches the model, skills, hooks, MCP, plugins, subagents, compaction, rewind and permissions.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how to keep sessions fast and cheap, and how to explain Claude Code to your team.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/decks">
          <span className="num">Lab 19</span>
          <h3>Deck builder</h3>
          <p>
            Ask Claude for a PowerPoint deck, attach the files to build it from and your own template, then ask for
            changes in the same conversation.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> what Agent Skills and a code-execution container can produce, and what it costs.
          </span>
          <span className="dl">Needs the lab backend and an API key</span>
        </a>{' '}
        <a className="lab-card" href="/site-builder">
          <span className="num">Lab 20</span>
          <h3>Site builder</h3>
          <p>
            Describe a website and watch Claude write its files, with the site updating live beside the chat. Claude
            checks screenshots of its work and fixes what it sees.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how far a tool loop on your own server gets you, and what a screenshot check adds.
          </span>
          <span className="dl">Needs the lab backend, an API key and Chrome</span>
        </a>{' '}
        <a className="lab-card" href="/tutor">
          <span className="num">Lab 21</span>
          <h3>Tutor</h3>
          <p>
            A 3D tutor that talks with you. Practise English with corrections and pronunciation scores, or pick Maths,
            Physics, Chemistry or any subject, share a screenshot of your homework and get it explained line by line.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> what voice, a face and structured feedback add to a plain chat with Claude.
          </span>
          <span className="dl">Needs the lab backend, an API key and an Azure Speech key for the voice</span>
        </a>{' '}
        <a className="lab-card" href="/documents">
          <span className="num">Lab 22</span>
          <h3>Document automation</h3>
          <p>
            Templates, an interview and assembly as legal document tools do it, with Claude turning finished documents
            into templates, filling the interview from source documents with quotes, and checking the result.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> where AI belongs around a deterministic engine, and how people stay in control.
          </span>
          <span className="dl">Needs the lab backend and an API key</span>
        </a>{' '}
        <a className="lab-card" href="/mcp">
          <span className="num">Lab 24</span>
          <h3>MCP servers</h3>
          <p>
            A real MCP server running in the lab: send it raw requests with and without tokens, watch Claude use its
            tools with writes gated by the harness, and the design and authentication choices behind it.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how to design tools for a model, and how to host and secure an MCP server.
          </span>
          <span className="dl">Needs the lab backend; Ask Claude also needs an API key</span>
        </a>{' '}
        <a className="lab-card" href="/casework">
          <span className="num">Lab 25</span>
          <h3>Case handling on Azure</h3>
          <p>
            Multi-agent complaint handling on Azure OpenAI and Azure AI Search: evidence from systems of record, cited
            policy, groundedness and rule checks, approval by a named caseworker, a hash-chained audit trail and an
            evaluation gate.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> where checks, people and audit belong when agents handle regulated decisions.
          </span>
          <span className="dl">Needs the lab backend and Azure OpenAI with Azure AI Search</span>
        </a>{' '}
        <a className="lab-card" href="/medassist">
          <span className="num">Lab 35</span>
          <h3>MedAssist on Foundry</h3>
          <p>
            A Microsoft Foundry prompt agent in a patient portal: it reads the signed-in patient's record, shows free
            slots, books the one they choose and texts them, with File Search, the Code Interpreter and function tools.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> what an agent may decide for itself, and which rules must live in its tools.
          </span>
          <span className="dl">Needs the lab backend and a Microsoft Foundry project</span>
        </a>{' '}
        <a className="lab-card" href="/reviews">
          <span className="num">Lab 36</span>
          <h3>Review analysis</h3>
          <p>
            A dashboard of product reviews in eight languages. Azure Language detects each language, scores sentiment,
            pulls out key phrases and finds products, brands and places; Claude can read the same review beside it.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when a prebuilt language service is enough, and when a language model fits better.
          </span>
          <span className="dl">Needs the lab backend and an Azure AI Services or Language resource</span>
        </a>{' '}
        <a className="lab-card" href="/aftercare">
          <span className="num">Lab 37</span>
          <h3>Aftercare follow-up agent</h3>
          <p>
            An agent contacts patients after discharge, by text or phone, in English or Spanish: medicines, warning
            signs, a follow-up booking, and every answer written back to the record. Claude and Microsoft Agent
            Framework run the same tools under the same rules.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which rules belong in code when an agent talks to patients, and how to test them.
          </span>
          <span className="dl">Needs the lab backend; Agent Framework needs a Microsoft Foundry project</span>
        </a>{' '}
        <a className="lab-card" href="/hotel">
          <span className="num">Lab 52</span>
          <h3>Hotel booking agent</h3>
          <p>
            A guest books, changes and cancels a room by chatting with an agent on Claude, GPT or a local model. Prices,
            availability, the refund policy, who may see a booking and payment are enforced in the tools; confirmations
            go out by email and text, and a room can never be sold twice.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which rules a booking agent needs in code, and what to keep out of the chat.
          </span>
          <span className="dl">Needs the lab backend</span>
        </a>{' '}
        <a className="lab-card" href="/data-agent">
          <span className="num">Lab 45</span>
          <h3>Data agent</h3>
          <p>
            Ask questions of a warehouse in plain words. Claude queries a semantic model, adds fields it lacks, or
            writes read-only SQL, then draws charts and dashboards. Each signed-in person sees only their company&apos;s
            rows.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when an agent should use a semantic model and when SQL, and where row-level
            security belongs.
          </span>
          <span className="dl">Needs the lab backend</span>
        </a>{' '}
        <a className="lab-card" href="/coding-agent">
          <span className="num">Lab 46</span>
          <h3>Coding agent</h3>
          <p>
            A harness built the way Claude Code is: file tools that refuse blind edits, a shell behind permission rules
            and modes, hooks, CLAUDE.md, a to-do list, undo, and a read-only sub-agent. The same task also runs on the
            Claude Agent SDK.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> whether to build your own agent harness or use the Agent SDK, and which rules it
            needs.
          </span>
          <span className="dl">Needs the lab backend; the SDK version needs its own environment</span>
        </a>{' '}
        <a className="lab-card" href="/guardrails">
          <span className="num">Lab 38</span>
          <h3>Guardrails</h3>
          <p>
            Azure AI Content Safety, Prompt Shields, groundedness and PII detection around a Foundry model, a guarded
            pipeline, a labelled test set, and the deployment's own content filter.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which checks belong in the deployment and which in your app, and where to set the
            thresholds.
          </span>
          <span className="dl">Needs the backend and an AI Services resource</span>
        </a>{' '}
        <a className="lab-card" href="/content-understanding">
          <span className="num">Lab 39</span>
          <h3>Content Understanding</h3>
          <p>
            Documents, photos, audio and video as Markdown and fields with confidence and source boxes; custom and
            agentic analyzers; captions, alt text and grounded answers from a multimodal model.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when to extract with Content Understanding and when to ask a model.
          </span>
          <span className="dl">Needs the backend and an AI Services resource</span>
        </a>{' '}
        <a className="lab-card" href="/image-generation">
          <span className="num">Lab 40</span>
          <h3>Image generation</h3>
          <p>
            gpt-image-2 from prompts and reference images, inpainting with a painted mask, Content Credentials, a
            watermark and brand checks. Video generation explained.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how to control, check and label generated images.
          </span>
          <span className="dl">Needs the backend and a gpt-image-2 deployment</span>
        </a>{' '}
        <a className="lab-card" href="/search-pipeline">
          <span className="num">Lab 41</span>
          <h3>Search pipeline</h3>
          <p>
            Every modality into Azure AI Search with enrichment, then keyword, vector, hybrid and semantic search scored
            on labelled questions, index health, and search as an agent's tool.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which search mode to use, measured on your own questions.
          </span>
          <span className="dl">Needs the backend, AI Services and Azure AI Search</span>
        </a>{' '}
        <a className="lab-card" href="/translation-speech">
          <span className="num">Lab 42</span>
          <h3>Translation and speech</h3>
          <p>
            Azure Translator against a language model, with a glossary; a complaint in any language as a structured log
            entry; speech to text with phrase lists, speech translation, and questions over audio.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when to use Translator, a model, or both.
          </span>
          <span className="dl">Needs the backend, AI Services and Azure Speech</span>
        </a>{' '}
        <a className="lab-card" href="/foundry-operations">
          <span className="num">Lab 43</span>
          <h3>Foundry operations</h3>
          <p>
            Live deployments, quotas, rate-limit headers, Azure Monitor metrics and security posture, an evaluation with
            a release gate, an OpenTelemetry trace, and CI/CD with Bicep.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how to run, watch and release AI on Foundry.
          </span>
          <span className="dl">Needs the backend and an AI Services resource</span>
        </a>{' '}
        <a className="lab-card" href="/ai-103">
          <span className="num">Lab 44</span>
          <h3>AI-103 exam map</h3>
          <p>
            Every skill in Microsoft's AI-103 study guide, with where to practise it here: the six labs built for the
            exam and the earlier ones that cover the rest.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> what to study for AI-103, and where to try each skill.
          </span>
          <span className="dl">Nothing: a map</span>
        </a>{' '}
      </div>
      <h2>Quality and safety</h2>
      <p className="muted">How to know a change helped, when to trust an answer, and how to stay safe.</p>
      <div className="labs">
        <a className="lab-card" href="/evals">
          <span className="num">Lab 7</span>
          <h3>Evals</h3>
          <p>Build a test set, grade it three ways, and see how much a score wobbles with confidence intervals.</p>
          <span className="decides">
            <b>Helps you decide:</b> whether a prompt change really helped, and how big a test set you need.
          </span>
          <span className="dl">GPT-2 download, 128 MB; live judge optional</span>
        </a>{' '}
        <a className="lab-card" href="/benchmarks">
          <span className="num">Lab 33</span>
          <h3>Benchmarks</h3>
          <p>
            What MMLU, GPQA, SWE-bench and the rest test; pass@k computed properly; whether a score gap is real;
            contamination; and Elo against Bradley–Terry arenas.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> how far to trust a leaderboard.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/confidence">
          <span className="num">Lab 8</span>
          <h3>Confidence</h3>
          <p>
            Check whether a model’s confidence matches how often it is right, and route doubtful answers to a person.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> when to automate, when to ask a human, and where to set the threshold.
          </span>
          <span className="dl">GPT-2 download, 128 MB</span>
        </a>{' '}
        <a className="lab-card" href="/injection">
          <span className="num">Lab 10</span>
          <h3>Prompt injection</h3>
          <p>Attack a toy agent that holds a secret, then switch defences on and off to see which ones hold.</p>
          <span className="decides">
            <b>Helps you decide:</b> which safeguards are real security boundaries and which only reduce risk.
          </span>
          <span className="dl">No download; live mode optional</span>
        </a>
      </div>
      <h2>Cost and operations</h2>
      <p className="muted">Where the time and money go, and how to spend less of both.</p>
      <div className="labs">
        <a className="lab-card" href="/context">
          <span className="num">Lab 4</span>
          <h3>Context, latency and cost</h3>
          <p>Prefill against decode, the KV cache and its memory bill, and how cost grows over a long conversation.</p>
          <span className="decides">
            <b>Helps you decide:</b> streaming, output limits, prompt caching layout, and GPU sizing for self-hosting.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/routing">
          <span className="num">Lab 11</span>
          <h3>Routing</h3>
          <p>Compare one large model, one small model, a cascade and a router on cost per correct answer.</p>
          <span className="decides">
            <b>Helps you decide:</b> which model to use where, and whether a cascade is worth its complexity.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/resilience">
          <span className="num">Lab 34</span>
          <h3>Rate limits and resilience</h3>
          <p>
            Ten minutes of traffic against rate-limited deployments: backoff, failover, a smaller model and a circuit
            breaker.
          </p>
          <span className="decides">
            <b>Helps you decide:</b> which defence fits which shortage, and what to try before buying more quota.
          </span>
          <span className="dl">No download</span>
        </a>{' '}
        <a className="lab-card" href="/live">
          <span className="num">Lab 12</span>
          <h3>Live Claude</h3>
          <p>Send real requests through a local server and measure latency, tokens, effort, caching and cost.</p>
          <span className="decides">
            <b>Helps you decide:</b> effort levels and caching layout, using real numbers from your own prompts.
          </span>
          <span className="dl">Needs the local server and your API key</span>
        </a>
      </div>
      <h2>Decision cheat sheet</h2>
      <p>Common problems, the first thing to try, and where to see why it works.</p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>If you need to…</th>
              <th>Try first</th>
              <th>See</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Get the same kind of answer every time, for extraction or classification</td>
              <td>
                Structured outputs with a schema or enum, plus a few examples. On models that allow it, a low
                temperature.
              </td>
              <td>
                <a href="/prompting">Prompting</a>, <a href="/sampling">Sampling</a>
              </td>
            </tr>
            <tr>
              <td>Answer from your own documents</td>
              <td>
                Retrieval first, not fine-tuning. Chunk by structure, combine keyword and meaning search, set a
                threshold, and require citations.
              </td>
              <td>
                <a href="/embeddings">Embeddings &amp; RAG</a>, <a href="/training">Training</a>
              </td>
            </tr>
            <tr>
              <td>Fix output in the wrong format</td>
              <td>
                Show two or three input and output examples, then move to structured outputs if code reads the result.
              </td>
              <td>
                <a href="/prompting">Prompting</a>
              </td>
            </tr>
            <tr>
              <td>Cut cost</td>
              <td>
                Measure tokens, shorten outputs, cache the stable prefix, trim history and tool results, and use a
                smaller model or lower effort for easy steps.
              </td>
              <td>
                <a href="/tokens">Tokens</a>, <a href="/context">Context &amp; cost</a>, <a href="/live">Live Claude</a>
              </td>
            </tr>
            <tr>
              <td>Choose between a large and a small model</td>
              <td>
                Measure both on your eval, try the large model at lower effort, and compare cost per correct answer, not
                per request.
              </td>
              <td>
                <a href="/routing">Routing</a>, <a href="/live">Live Claude</a>
              </td>
            </tr>
            <tr>
              <td>Cut latency</td>
              <td>Stream, ask for shorter answers, and reduce the number of sequential calls.</td>
              <td>
                <a href="/context">Context &amp; cost</a>
              </td>
            </tr>
            <tr>
              <td>Stay up when you hit rate limits</td>
              <td>
                Back off with jitter and honour Retry-After, fail over to another region, let background work wait, and
                lower max_tokens. Add a circuit breaker once there is somewhere else to send traffic.
              </td>
              <td>
                <a href="/resilience">Rate limits</a>
              </td>
            </tr>
            <tr>
              <td>Reduce made-up facts</td>
              <td>
                Ground answers in retrieved sources, allow "I don't know", and route low-confidence answers to a person.
              </td>
              <td>
                <a href="/embeddings">Embeddings &amp; RAG</a>, <a href="/confidence">Confidence</a>
              </td>
            </tr>
            <tr>
              <td>Do exact maths, counting or string work</td>
              <td>Give the model a tool that runs code.</td>
              <td>
                <a href="/tokens">Tokens</a>, <a href="/agents">Agents &amp; tools</a>
              </td>
            </tr>
            <tr>
              <td>Let the model take actions</td>
              <td>
                Start with a fixed workflow. Use an agent loop only for open-ended tasks, with bounded iterations and
                approval for side effects.
              </td>
              <td>
                <a href="/agents">Agents &amp; tools</a>, <a href="/harness">Harness engineering</a>
              </td>
            </tr>
            <tr>
              <td>Make an agent finish long tasks reliably</td>
              <td>
                Keep progress in a file, verify "done" in code, set turn and budget limits, and compact the context.
              </td>
              <td>
                <a href="/harness">Harness engineering</a>, <a href="/context-engineering">Context engineering</a>
              </td>
            </tr>
            <tr>
              <td>Decide whether you need an LLM at all</td>
              <td>Try a small classic model first when you have labelled data and a fixed set of answers.</td>
              <td>
                <a href="/ml">Machine learning algorithms</a>
              </td>
            </tr>
            <tr>
              <td>Make Claude Code follow your team's rules</td>
              <td>Facts in CLAUDE.md, procedures in skills, enforcement in hooks, sharing through plugins.</td>
              <td>
                <a href="/claude-code">Claude Code setup</a>,{' '}
                <a href="/claude-code-inside">Claude Code behind the scenes</a>
              </td>
            </tr>
            <tr>
              <td>Process untrusted text safely</td>
              <td>
                Delimit it as data, keep instructions in the system prompt, and never give tools more power than that
                text should have.
              </td>
              <td>
                <a href="/prompting">Prompting</a>, <a href="/injection">Prompt injection</a>
              </td>
            </tr>
            <tr>
              <td>Know whether a prompt change helped</td>
              <td>
                Build a labelled test set, run every version against it several times, and compare confidence intervals,
                not single scores.
              </td>
              <td>
                <a href="/evals">Evals</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: '18px' }}>
        The browser models are GPT-2 (124M parameters, 2019), MiniLM and a small reranker, all tiny and old by today's
        standards. They are here because they show the mechanisms honestly and run on a laptop. Modern models are far
        more capable, but they work on the same principles.
      </p>
    </main>
  );
}
