import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import {
  BLOCKS,
  CLOUDS,
  DEFAULT_DRIVERS,
  SECOND_CLOUD_COSTS,
  SECOND_CLOUD_REASONS,
  SERVICES,
  USE_CASES,
  blockById,
  decide,
  secondCloudVerdict,
  type BlockId,
  type Cloud,
  type Drivers,
} from './architecture';
import { DIFFERENCES } from './differences';
import './multicloud.css';

const SECTIONS: [string, string][] = [
  ['use-case', 'Use case to architecture'],
  ['clouds', 'The same blocks on each cloud'],
  ['requirements', 'Requirements to decisions'],
  ['differences', 'Differences that matter'],
  ['second-cloud', 'One cloud or two'],
];

/* ---------- The diagram ---------- */

const W = 176;
const H = 60;
/** Where each block sits: the request path across the top, data underneath, cross-cutting blocks in a band. */
const POS: Record<BlockId, [number, number]> = {
  gateway: [112, 40],
  compute: [306, 40],
  orchestration: [500, 40],
  models: [694, 40],
  retrieval: [500, 138],
  specialist: [694, 138],
  pipelines: [306, 236],
  storage: [500, 236],
  identity: [8, 346],
  safety: [196, 346],
  monitoring: [384, 346],
  secrets: [572, 346],
  cicd: [760, 346],
};

/** The y of the free channel between the request path (ending at 100) and the retrieval row (from 138). */
const GAP = 119;

const mid = (id: BlockId) => {
  const [x, y] = POS[id];
  return { cx: x + W / 2, cy: y + H / 2, x, y };
};

/** The arrows for a use case: drawn only where both ends are in use, so the picture shows the real path. */
function edges(used: (id: BlockId) => boolean): { key: string; d: string }[] {
  const out: { key: string; d: string }[] = [];
  const right = (a: BlockId, b: BlockId) => {
    const p = mid(a);
    const q = mid(b);
    out.push({ key: `${a}-${b}`, d: `M${p.x + W} ${p.cy}L${q.x - 4} ${q.cy}` });
  };
  const down = (a: BlockId, b: BlockId) => {
    const p = mid(a);
    const q = mid(b);
    out.push({ key: `${a}-${b}`, d: `M${p.cx} ${p.y + H}L${q.cx} ${q.y - 4}` });
  };
  out.push({ key: 'channel-gateway', d: `M96 70L${POS.gateway[0] - 4} 70` });
  right('gateway', 'compute');
  const brain: BlockId = used('orchestration') ? 'orchestration' : 'compute';
  if (used('orchestration')) right('compute', 'orchestration');
  if (brain === 'orchestration') right('orchestration', 'models');
  else {
    const p = mid('compute');
    const q = mid('models');
    out.push({
      key: 'compute-models',
      // Over the top of the unused agent runtime, so the arrow does not run through its box.
      d: `M${p.x + W - 20} ${p.y}L${p.x + W - 20} ${p.y - 12}L${q.x + 20} ${p.y - 12}L${q.x + 20} ${q.y - 4}`,
    });
  }
  if (used('retrieval')) {
    if (brain === 'orchestration') down('orchestration', 'retrieval');
    else {
      const p = mid('compute');
      const q = mid('retrieval');
      out.push({ key: 'compute-retrieval', d: `M${p.cx} ${p.y + H}L${p.cx} ${q.cy}L${q.x - 4} ${q.cy}` });
    }
  }
  if (used('specialist')) {
    const p = mid('compute');
    const q = mid('specialist');
    out.push({
      key: 'compute-specialist',
      // Through the gap between the request path and the retrieval row.
      d: `M${p.cx + 30} ${p.y + H}L${p.cx + 30} ${GAP}L${q.cx} ${GAP}L${q.cx} ${q.y - 4}`,
    });
  }
  if (used('pipelines') && used('storage')) right('pipelines', 'storage');
  if (used('storage') && used('retrieval')) {
    const p = mid('storage');
    out.push({ key: 'storage-retrieval', d: `M${p.cx} ${p.y}L${p.cx} ${POS.retrieval[1] + H + 4}` });
  }
  if (used('pipelines') && !used('retrieval') && used('models')) {
    const p = mid('pipelines');
    const q = mid('models');
    out.push({
      key: 'pipelines-models',
      d: `M${p.cx} ${p.y}L${p.cx} ${GAP}L${q.cx} ${GAP}L${q.cx} ${q.y + H + 4}`,
    });
  }
  return out;
}

function Diagram({
  useCase,
  cloud,
  selected,
  onSelect,
}: {
  useCase: (typeof USE_CASES)[number];
  cloud: Cloud;
  selected: BlockId;
  onSelect: (id: BlockId) => void;
}) {
  const used = (id: BlockId) => Boolean(useCase.roles[id]);
  const key = (id: BlockId) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  };
  return (
    <svg viewBox="0 0 944 416" className="mc-diagram" role="group" aria-labelledby="mc-d-t mc-d-d">
      <title id="mc-d-t">{useCase.name}: reference architecture</title>
      <desc id="mc-d-d">
        The request path runs left to right from the channel through the gateway and app to the model. Retrieval and
        specialist services sit underneath, data storage and pipelines below them, and the blocks that apply everywhere
        in a band at the bottom. Blocks this use case does not need are faded. Select a block for details.
      </desc>
      <defs>
        <marker id="mc-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="mc-head" />
        </marker>
      </defs>
      <text x="8" y="22" className="mc-lane">
        REQUEST PATH
      </text>
      <text x="306" y="226" className="mc-lane">
        DATA
      </text>
      <text x="8" y="334" className="mc-lane">
        ACROSS EVERY BLOCK
      </text>
      <line x1="8" x2="936" y1="318" y2="318" className="mc-rule" />
      <g className="mc-channel">
        <rect x="8" y="48" width="88" height="44" rx="22" />
        <text x="52" y="74" textAnchor="middle">
          Users
        </text>
      </g>
      {edges(used).map((e) => (
        <path key={e.key} d={e.d} className="mc-edge" markerEnd="url(#mc-arr)" />
      ))}
      {BLOCKS.map((b) => {
        const [x, y] = POS[b.id];
        const on = used(b.id);
        const cls = `mc-box${on ? '' : ' off'}${selected === b.id ? ' sel' : ''}${b.cross ? ' cross' : ''}`;
        return (
          <g
            key={b.id}
            className={cls}
            role="button"
            tabIndex={0}
            aria-pressed={selected === b.id}
            aria-label={`${b.name}: ${on ? SERVICES[b.id][cloud].short : 'not needed for this use case'}`}
            onClick={() => onSelect(b.id)}
            onKeyDown={key(b.id)}
          >
            <rect x={x} y={y} width={W} height={H} rx={9} />
            <text x={x + W / 2} y={y + 24} textAnchor="middle" className="mc-name">
              {b.name.replace(' and agent runtime', '').replace(' (search and vectors)', '')}
            </text>
            <text x={x + W / 2} y={y + 43} textAnchor="middle" className="mc-svc">
              {on ? SERVICES[b.id][cloud].short : 'not needed'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- Code: the same Claude call, keyless, on each platform ---------- */

const CLIENT_CODE: Record<Cloud, string> = {
  azure: `# Claude on Microsoft Foundry, signed in with Entra ID (az login locally, a managed identity in Azure).
from anthropic import AnthropicFoundry
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

token = get_bearer_token_provider(DefaultAzureCredential(), "https://ai.azure.com/.default")
client = AnthropicFoundry(resource="my-foundry-resource", azure_ad_token_provider=token)
reply = client.messages.create(
    model="claude-haiku-5-5",  # the deployment name you chose
    max_tokens=512,
    messages=[{"role": "user", "content": "Summarise this policy in two lines."}],
)`,
  gcp: `# Claude on Vertex AI, signed in with Application Default Credentials (a service account in production).
from anthropic import AnthropicVertex

client = AnthropicVertex(project_id="my-project", region="europe-west1")  # or "global", or "eu"
reply = client.messages.create(
    model="claude-haiku-5-5",
    max_tokens=512,
    messages=[{"role": "user", "content": "Summarise this policy in two lines."}],
)`,
  aws: `# Claude on Amazon Bedrock, signed with the workload's IAM role (SigV4); no access keys in code.
from anthropic import AnthropicBedrockMantle

client = AnthropicBedrockMantle(aws_region="eu-west-2")
reply = client.messages.create(
    model="anthropic.claude-haiku-5-5",  # Bedrock ids carry the provider prefix
    max_tokens=512,
    messages=[{"role": "user", "content": "Summarise this policy in two lines."}],
)`,
  databricks: `# A Databricks serving endpoint through its OpenAI-compatible API; the SDK signs in with OAuth.
from databricks.sdk import WorkspaceClient

client = WorkspaceClient().serving_endpoints.get_open_ai_client()
reply = client.chat.completions.create(
    model="my-claude-endpoint",  # a foundation model or an external-model endpoint you created
    max_tokens=512,
    messages=[{"role": "user", "content": "Summarise this policy in two lines."}],
)`,
};

/* ---------- Requirements worksheet ---------- */

type Option<K extends keyof Drivers> = { key: K; label: string; options: [Drivers[K], string][] };

const DRIVER_FIELDS: Option<keyof Drivers>[] = [
  {
    key: 'residency',
    label: 'Data residency',
    options: [
      ['none', 'No rule'],
      ['zone', 'Within a zone (such as the EU)'],
      ['country', 'Within one country'],
    ],
  },
  {
    key: 'estate',
    label: 'Existing cloud estate',
    options: [
      ['azure', 'Azure'],
      ['gcp', 'Google Cloud'],
      ['aws', 'AWS'],
      ['none', 'None yet'],
    ],
  },
  {
    key: 'latency',
    label: 'Latency target',
    options: [
      ['batch', 'Batch (minutes or hours)'],
      ['interactive', 'Interactive (seconds)'],
      ['realtime', 'Real time (under a second)'],
    ],
  },
  {
    key: 'peak',
    label: 'Load shape',
    options: [
      ['low', 'Low'],
      ['steady', 'High and steady'],
      ['spiky', 'Spiky'],
    ],
  },
  {
    key: 'sensitivity',
    label: 'Data sensitivity',
    options: [
      ['public', 'Public'],
      ['internal', 'Internal'],
      ['regulated', 'Regulated (health, finance, personal)'],
    ],
  },
  {
    key: 'openModels',
    label: 'Open-weight models needed',
    options: [
      [false, 'No'],
      [true, 'Yes'],
    ],
  },
  {
    key: 'skills',
    label: 'Team skills',
    options: [
      ['cloud', 'Cloud-native engineers'],
      ['data', 'Data platform (Spark, SQL)'],
      ['small', 'Small generalist team'],
    ],
  },
  {
    key: 'budget',
    label: 'Budget model',
    options: [
      ['payg', 'Pay as you go'],
      ['committed', 'Can commit to reserved capacity'],
    ],
  },
];

function Worksheet() {
  const [drivers, setDrivers] = useState<Drivers>(DEFAULT_DRIVERS);
  const [copied, setCopied] = useState('Copy as ADR lines');
  const decisions = decide(drivers);

  async function copy() {
    const text = decisions.map((d) => `- **${d.area}:** ${d.decision} Because: ${d.because}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied');
    } catch {
      setCopied('Copy failed: select the text instead');
    }
    setTimeout(() => setCopied('Copy as ADR lines'), 1600);
  }

  return (
    <div className="card mc-sheet">
      <div className="mc-drivers">
        {DRIVER_FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            <select
              value={String(drivers[f.key])}
              onChange={(e) => {
                const chosen = f.options.find(([v]) => String(v) === e.target.value);
                if (chosen) setDrivers((d) => ({ ...d, [f.key]: chosen[0] }));
              }}
            >
              {f.options.map(([v, l]) => (
                <option key={String(v)} value={String(v)}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <ol className="mc-decisions" aria-live="polite">
        {decisions.map((d) => (
          <li key={d.area}>
            <b>{d.area}.</b> {d.decision}
            <span className="small muted mc-because">Because: {d.because}</span>
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="button" className="btn small" onClick={copy}>
          {copied}
        </button>
        <button type="button" className="btn small" onClick={() => setDrivers(DEFAULT_DRIVERS)}>
          Reset
        </button>
      </div>
    </div>
  );
}

/* ---------- Second cloud ---------- */

function SecondCloud() {
  const [ticked, setTicked] = useState<string[]>([]);
  const v = secondCloudVerdict(ticked);
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  return (
    <div className="grid2">
      <div className="card">
        <h3>Reasons you have</h3>
        {SECOND_CLOUD_REASONS.map((r) => (
          <label key={r.id} className="mc-check">
            <input type="checkbox" checked={ticked.includes(r.id)} onChange={() => toggle(r.id)} /> {r.label}
          </label>
        ))}
        <p className={`mc-verdict ${v.verdict}`} aria-live="polite">
          <b>{v.verdict === 'yes' ? 'Yes.' : v.verdict === 'maybe' ? 'Maybe.' : 'No.'}</b> {v.text}
        </p>
      </div>
      <div className="card">
        <h3>What you pay for it, whatever the reason</h3>
        <ul>
          {SECOND_CLOUD_COSTS.map((c) => (
            <li key={c.id}>{c.label}</li>
          ))}
        </ul>
        <h3>Portability that costs little on day one</h3>
        <ul>
          <li>
            <b>One model interface.</b> The lab's own code calls every model through one client (<code>LabClient</code>{' '}
            in <code>python/local_model.py</code>), so Claude, a GPT deployment or a local model is a configuration
            change. <Link to="/model-failover">Model failover</Link> builds on it.
          </li>
          <li>
            <b>Open table formats.</b> Delta or Iceberg tables can be read by another engine on another cloud; see{' '}
            <Link to="/data-integration">data and integration</Link>.
          </li>
          <li>
            <b>Containers and infrastructure as code.</b> The app moves with its image and its templates; see{' '}
            <Link to="/llmops">LLMOps and CI/CD</Link>.
          </li>
          <li>
            <b>OpenTelemetry.</b> Traces in the GenAI semantic conventions go to any backend; see{' '}
            <Link to="/observability">monitoring and traces</Link>.
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ---------- The page ---------- */

export default function MultiCloudPage() {
  const [caseId, setCaseId] = useState(USE_CASES[0].id);
  const [cloud, setCloud] = useState<Cloud>('azure');
  const [block, setBlock] = useState<BlockId>('models');
  const [diff, setDiff] = useState(DIFFERENCES[0].id);
  const useCase = USE_CASES.find((u) => u.id === caseId) ?? USE_CASES[0];
  const b = blockById(block);
  const role = useCase.roles[block];
  const d = DIFFERENCES.find((x) => x.id === diff) ?? DIFFERENCES[0];

  const cloudChips = (
    <div className="chips" role="group" aria-label="Platform">
      {CLOUDS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`chip-btn${cloud === c.id ? ' on' : ''}`}
          aria-pressed={cloud === c.id}
          onClick={() => setCloud(c.id)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );

  return (
    <main className="page-multicloud">
      <p className="kicker">Architecture</p>
      <h1>One AI architecture on three clouds</h1>
      <p className="lede">
        A use case becomes a set of building blocks first and a list of products second. The blocks are the same on
        Azure, Google Cloud and AWS: a gateway, compute, an agent runtime, models, retrieval, data, pipelines, and the
        identity, safety, monitoring and delivery that run through all of them. This page starts from the use case,
        shows the blocks, then names them on each platform and turns your requirements into decisions you can defend.
      </p>
      <nav className="mc-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="use-case" className="mc-section">
        <h2>Use case to architecture</h2>
        <p>
          Pick a use case. The blocks it needs light up; the rest fade. A RAG assistant has no agent runtime because its
          flow is fixed; classic ML scoring has no retrieval. Select any block to see what it does here and what it is
          on each platform. <Link to="/medassist/architecture">MedAssist's architecture</Link> is one of these drawn in
          full for a single system.
        </p>
        <div className="chips" role="group" aria-label="Use case">
          {USE_CASES.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`chip-btn${caseId === u.id ? ' on' : ''}`}
              aria-pressed={caseId === u.id}
              onClick={() => setCaseId(u.id)}
            >
              {u.name}
            </button>
          ))}
        </div>
        <p className="small muted mc-summary">
          {useCase.summary} Working example in the lab: <Link to={useCase.page.path}>{useCase.page.name}</Link>.
        </p>
        <div className="row mc-switch">
          <span className="small muted">Name the blocks on:</span>
          {cloudChips}
        </div>
        <div className="card mc-diagram-card">
          <Diagram useCase={useCase} cloud={cloud} selected={block} onSelect={setBlock} />
        </div>
        <div className="card mc-detail" aria-live="polite">
          <h3>{b.name}</h3>
          <p className="small">{b.what}</p>
          <p className="small">
            <b>In this use case:</b> {role ?? 'Not needed. Leaving a block out is a design decision too.'}
          </p>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Services</th>
                  <th>What differs</th>
                </tr>
              </thead>
              <tbody>
                {CLOUDS.map((c) => (
                  <tr key={c.id} className={c.id === cloud ? 'mc-here' : undefined}>
                    <td>{c.name}</td>
                    <td>{SERVICES[block][c.id].service}</td>
                    <td className="small">{SERVICES[block][c.id].note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="clouds" className="mc-section">
        <h2>The same blocks on each cloud</h2>
        <p>
          Every block on one platform at a time. Databricks is not a fourth hyperscaler: it runs on all three and
          replaces the data, pipeline, registry and often the serving blocks, while identity, networking and the
          customer-facing API stay with the host cloud.
        </p>
        {cloudChips}
        <div className="table-wrap">
          <table className="t mc-map">
            <thead>
              <tr>
                <th>Block</th>
                <th>{CLOUDS.find((c) => c.id === cloud)?.name}</th>
                <th>What differs</th>
              </tr>
            </thead>
            <tbody>
              {BLOCKS.map((x) => (
                <tr key={x.id}>
                  <td>
                    <b>{x.name}</b>
                  </td>
                  <td>{SERVICES[x.id][cloud].service}</td>
                  <td className="small">{SERVICES[x.id][cloud].note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Claude and the agent frameworks on each</h3>
        <p>
          Claude is served by all three hyperscalers: Microsoft Foundry, Vertex AI and Amazon Bedrock. The request is
          the same Messages API; what changes is the sign-in, the model id and which features have arrived (the lab's{' '}
          <code>examples/claude-platforms/</code> lists them). Agent frameworks fill the orchestration block on any
          cloud: Microsoft Agent Framework, Google ADK, LangGraph, LlamaIndex, Strands Agents, or a managed runtime such
          as Foundry Agent Service, Vertex AI Agent Engine or Bedrock AgentCore. The lab runs the same tasks in sixteen
          of them in <code>examples/sdks/</code>, and <Link to="/ai-stack">the AI tech stack</Link> maps the wider
          tooling.
        </p>
        <CodeBlock html={highlight(CLIENT_CODE[cloud])} />
      </section>

      <section id="requirements" className="mc-section">
        <h2>Requirements to decisions</h2>
        <p>
          Architecture is the drivers, not the diagram. Set the drivers for a use case and read the decisions they lead
          to, each with its reason, in the form an architecture decision record (ADR) uses. The rules are deliberately
          simple and explicit; real work adds cost estimates and a spike.{' '}
          <Link to="/delivery">Delivery and governance</Link> covers discovery, ADRs and value;{' '}
          <Link to="/foundry-operations">Foundry operations</Link> shows deployment types and quotas on a real resource.
        </p>
        <Worksheet />
      </section>

      <section id="differences" className="mc-section">
        <h2>The differences that matter</h2>
        <p>
          The product names are the easy part. These six topics are where the three clouds genuinely differ, and where a
          design copied from one to another goes wrong.
        </p>
        <div className="chips" role="group" aria-label="Topic">
          {DIFFERENCES.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip-btn${diff === x.id ? ' on' : ''}`}
              aria-pressed={diff === x.id}
              onClick={() => setDiff(x.id)}
            >
              {x.name}
            </button>
          ))}
        </div>
        <p className="mc-why">{d.why}</p>
        <div className="grid3">
          <div className="card">
            <h3>Azure</h3>
            <p className="small">{d.azure}</p>
          </div>
          <div className="card">
            <h3>Google Cloud</h3>
            <p className="small">{d.gcp}</p>
          </div>
          <div className="card">
            <h3>AWS</h3>
            <p className="small">{d.aws}</p>
          </div>
        </div>
        <p className="note">
          Quotas, regions and model lists change month by month. Treat these as the questions to ask, and check the
          provider's current documentation before a number goes into a design. When capacity runs out at run time,{' '}
          <Link to="/model-failover">model failover</Link> shows the client-side answer.
        </p>
      </section>

      <section id="second-cloud" className="mc-section">
        <h2>One cloud or two</h2>
        <p>
          A second cloud is sometimes right and often expensive. Tick the reasons you actually have and see whether they
          outweigh the standing costs. Resilience against a whole provider is rarer than it sounds; a second region
          usually meets it.
        </p>
        <SecondCloud />
        <div className="takeaways">
          <h3>Takeaways</h3>
          <ul>
            <li>Start from the use case and the drivers; name products last.</li>
            <li>
              The blocks are the same on every cloud. Identity, capacity, residency and networking are what differ.
            </li>
            <li>Build on the estate the client already runs unless a named gap forces a second platform.</li>
            <li>
              Keep the model behind one interface, data in open formats, the app in containers and traces in
              OpenTelemetry. That is what makes a later move cheap. See also <Link to="/mlops">MLOps</Link>.
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
