import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { statusService } from '@/services';
import type { LocalModelStatus } from '@/services/statusService';
import * as S from './snippets';
import './local-model.css';

type Check = { state: 'loading' } | { state: 'offline'; reason: string } | { state: 'ok'; local?: LocalModelStatus };

/** What the running backend says about the local model, checked again on request. */
function LiveStatus() {
  const [check, setCheck] = useState<Check>({ state: 'loading' });

  const load = (fresh: boolean) => {
    setCheck({ state: 'loading' });
    (fresh ? statusService.refresh() : statusService.status()).then((s) =>
      setCheck(s.available ? { state: 'ok', local: s.local } : { state: 'offline', reason: s.reason ?? '' }),
    );
  };
  useEffect(() => load(false), []);

  let tone = 'warn';
  let text: string;
  if (check.state === 'loading') text = 'Checking…';
  else if (check.state === 'offline') text = check.reason || 'The lab backend is not running.';
  else if (!check.local?.configured)
    text = 'No local model is configured: LLM_LAB_LOCAL_MODEL is not set in .env, so pages default to Claude.';
  else if (!check.local.running)
    text = `${check.local.model} is configured, but nothing answers on the local server. Open Docker Desktop and run ./tools/local-model.sh.`;
  else if (!check.local.has_model)
    text = `The local server is running, but ${check.local.model} is not on it. Run ./tools/local-model.sh to pull it.`;
  else {
    tone = 'ok';
    text = `${check.local.model} is configured, the server is running and the model is pulled. It is the default model on pages that can use it.`;
  }

  return (
    <div className={`lm-status ${tone}`} role="status">
      <span className="lm-dot" aria-hidden="true" />
      <span>{text}</span>
      <button type="button" onClick={() => load(true)}>
        Check again
      </button>
    </div>
  );
}

/** How the lab runs an open model on this machine: provisioning, configuration, daily use and how requests reach it. */
export default function LocalModelPage() {
  return (
    <main className="page-local-model">
      <div className="kicker">Cost and operations · local model</div>
      <h1>Running a local model</h1>
      <p className="lede">
        An open model, Qwen 3.5 9B, runs on this machine in Docker Model Runner and costs nothing per token. Every page
        and script reaches it through the same client as Claude and GPT, so code does not change: only the model’s name
        does. Set it up once, start it after a restart, and use it to practise without spending.
      </p>
      <LiveStatus />

      <h2>Claude or the local model</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th></th>
              <th>Claude Haiku 5.5</th>
              <th>Qwen 3.5 9B, local</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Runs in</td>
              <td>Anthropic’s cloud</td>
              <td>Docker Model Runner on this machine: llama.cpp on the host, using the GPU (Metal on a Mac)</td>
            </tr>
            <tr>
              <td>Price</td>
              <td>$0.10 in, $0.50 out per million tokens</td>
              <td>Free</td>
            </tr>
            <tr>
              <td>Speed</td>
              <td>Fast</td>
              <td>About 20 tokens a second on an M5 Pro; an agent run takes a minute or more</td>
            </tr>
            <tr>
              <td>Long agent work</td>
              <td>Much better</td>
              <td>Fine for short tasks and practice</td>
            </tr>
            <tr>
              <td>Data</td>
              <td>Sent to Anthropic</td>
              <td>Stays on this machine; works offline once pulled</td>
            </tr>
            <tr>
              <td>Claude-only features</td>
              <td>All</td>
              <td>Refused with a clear message (below)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Where it fits</h2>
      <div className="lm-flow" aria-label="How a request reaches the local model">
        <div className="lm-box">
          <b>Page or script</b>
          <span>a request in Claude’s shape</span>
        </div>
        <div className="lm-arrow">→</div>
        <div className="lm-box core">
          <b>Model client</b>
          <span>python/local_model.py</span>
        </div>
        <div className="lm-arrow">→</div>
        <div className="lm-col">
          <div className="lm-box">
            <b>:12434/anthropic</b>
            <span>Docker Model Runner, Anthropic Messages API</span>
          </div>
          <div className="lm-box">
            <b>:12434/engines/v1</b>
            <span>OpenAI-compatible API, for replies held to a JSON schema</span>
          </div>
          <div className="lm-box faint">
            <b>Claude or GPT</b>
            <span>any other model name</span>
          </div>
        </div>
      </div>

      <h2>1. Provision it once</h2>
      <CodeBlock html={S.provision} />
      <ol className="lm-steps">
        <li>
          <b>Enable Model Runner</b> on port 12434, if <code>docker model status</code> says it is off. If that fails,
          turn it on in Docker Desktop: Settings › AI › Enable Docker Model Runner, with host-side TCP on 12434.
        </li>
        <li>
          <b>Pull the model</b>: Qwen 3.5 9B, Apache 2.0, 6.9 GB. It calls tools and reads images, and fits in 24 GB of
          memory.
        </li>
        <li>
          <b>Set the context</b> to 32,768 tokens (agent pages send long prompts) and keep the model loaded for 30
          minutes after each request.
        </li>
        <li>
          <b>Check it answers</b>, and remind you to set <code>LLM_LAB_LOCAL_MODEL</code> in <code>.env</code>.
        </li>
      </ol>
      <CodeBlock html={S.script} />

      <h2>2. Configure the lab</h2>
      <CodeBlock html={S.env} />
      <CodeBlock html={S.common} />
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>With LLM_LAB_LOCAL_MODEL set</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Model pickers</td>
              <td>List it first and select it</td>
            </tr>
            <tr>
              <td>Scripts in python/</td>
              <td>Default to it; --model picks another</td>
            </tr>
            <tr>
              <td>Spending cap</td>
              <td>Its calls are charged at $0</td>
            </tr>
            <tr>
              <td>Work that needs Claude</td>
              <td>Still defaults to Claude (LLM_LAB_MODEL)</td>
            </tr>
            <tr>
              <td>Unset it</td>
              <td>Everything defaults to Claude again after a restart</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>3. Run it every day</h2>
      <CodeBlock html={S.daily} />
      <p>Or talk to the server directly, which is what the script’s check does:</p>
      <CodeBlock html={S.curl} />
      <p className="small muted">
        The model unloads after 30 minutes idle; the next request loads it again and takes a few seconds longer.
      </p>

      <h2>4. How the lab talks to it</h2>
      <p>
        Docker Model Runner serves the Anthropic Messages API, so the lab calls it with the Anthropic SDK and requests
        keep their shape. Three things are handled in the client so no page has to know:
      </p>
      <div className="grid2">
        <div>
          <div className="lm-label">Routing by name</div>
          <CodeBlock html={S.routing} />
        </div>
        <div>
          <div className="lm-label">Thinking off unless asked</div>
          <CodeBlock html={S.prepare} />
        </div>
      </div>
      <div className="lm-label">Replies held to a JSON schema</div>
      <p>
        The local Anthropic endpoint ignores <code>output_config</code>’s JSON schema, so those requests go to the
        OpenAI-compatible endpoint, where a grammar holds the reply to the schema.
      </p>
      <CodeBlock html={S.schema} />

      <h2>5. What it cannot do</h2>
      <p>
        Anything only Anthropic runs is refused with a message, not dropped quietly, because dropping it would change
        what the page is testing.
      </p>
      <CodeBlock html={S.refusals} />
      <ul className="lm-points">
        <li>
          Skills and the deck builder still work on the local model: they run in the lab’s own sandbox (
          <code>python/sandbox_skills.py</code>) instead of Anthropic’s container.
        </li>
        <li>The coding agent’s Agent SDK mode and the Batch API script stay Claude only.</li>
        <li>Azure labs keep their Azure models.</li>
        <li>A model that cannot read images says so when a page sends one.</li>
      </ul>

      <h2>One local model at a time</h2>
      <p>
        <code>LLM_LAB_LOCAL_MODEL</code> holds one name, and the client treats a request as local only when the model
        matches it exactly. So pickers show one local model, even when Docker has several downloaded. To use another,
        change the name and run the script again.
      </p>
      <CodeBlock html={S.switchModel} />

      <h2>A local embedding model</h2>
      <p>
        Model Runner also serves open embedding models on the same port. <code>--embed</code> pulls one and checks it
        answers; the chat model is left alone, and both can be loaded at once. With{' '}
        <code>LLM_LAB_LOCAL_EMBED_MODEL</code> set, the <Link to="/embeddings">embeddings page</Link> offers it beside
        the MiniLM model that runs in the browser, so the sentence map and the retrieval demo run on either. It is free,
        and the text never leaves this machine.
      </p>
      <CodeBlock html={S.embed} />
      <p className="small muted">
        nomic-embed-text gives 768 numbers per text and expects <code>search_document: </code> or{' '}
        <code>search_query: </code> in front of it; the backend adds them. Other embedding models in Docker Hub’s{' '}
        <code>ai/</code> namespace: <code>ai/mxbai-embed-large</code>, <code>ai/embeddinggemma</code> and{' '}
        <code>ai/qwen3-embedding</code>.
      </p>

      <h2>Troubleshooting</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>You see</th>
              <th>Do this</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>“The local model … is not answering at …”</td>
              <td>
                Open Docker Desktop, then <code>./tools/local-model.sh</code>
              </td>
            </tr>
            <tr>
              <td>The script says nothing answers on 12434</td>
              <td>Turn on host-side TCP support in Docker Desktop’s AI settings</td>
            </tr>
            <tr>
              <td>“… cannot use … Choose a Claude model for this.”</td>
              <td>The page needs a Claude-only feature: pick a Claude model</td>
            </tr>
            <tr>
              <td>The first answer is slow</td>
              <td>The model was unloaded after 30 minutes idle; the next ones are quicker</td>
            </tr>
            <tr>
              <td>Long agent runs lose earlier steps</td>
              <td>The 32k context is full; older steps are shortened to fit (sandbox_skills.fit_context)</td>
            </tr>
            <tr>
              <td>Free memory</td>
              <td>
                <code>./tools/local-model.sh --stop</code> unloads it; <code>--remove</code> deletes it (about 7 GB)
              </td>
            </tr>
            <tr>
              <td>Find another model</td>
              <td>
                <code>docker model search &lt;name&gt;</code>: choose one that can call tools
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        The full architecture is on the <Link to="/architecture">architecture page</Link>; how agents use the model is
        on <Link to="/building-agents">Building agents</Link>.
      </p>
    </main>
  );
}
