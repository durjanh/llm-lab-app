import { useEffect, useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { modelName, modelNameStart } from '@/lib/models';
import { mcpLabService, statusService, type LiveStatus, type McpExchange, type McpStep } from '@/services';
import './mcp.css';

// Ready-made requests for the live server. Each is a real MCP JSON-RPC method with its params.
const REQUESTS: { id: string; label: string; method: string; params: unknown }[] = [
  { id: 'list', label: 'List the tools (tools/list)', method: 'tools/list', params: {} },
  { id: 'search', label: 'Search engagements', method: 'tools/call', params: { name: 'search_engagements', arguments: { query: '', status: 'all', limit: 2 } } },
  { id: 'get', label: 'Get one engagement', method: 'tools/call', params: { name: 'get_engagement', arguments: { engagement_id: 'ENG-104' } } },
  { id: 'missing', label: 'Get an id that does not exist', method: 'tools/call', params: { name: 'get_engagement', arguments: { engagement_id: 'ENG-999' } } },
  {
    id: 'write',
    label: 'Log a risk (writes)',
    method: 'tools/call',
    params: {
      name: 'log_risk',
      arguments: { engagement_id: 'ENG-104', title: 'Legal team on leave until December', severity: 'high', owner: 'Priya Shah', idempotency_key: 'page-0001-abcd' },
    },
  },
  { id: 'bad', label: 'Break the input schema', method: 'tools/call', params: { name: 'search_engagements', arguments: { limit: 500 } } },
  { id: 'resource', label: 'Read a resource (resources/read)', method: 'resources/read', params: { uri: 'engagement://ENG-101/brief' } },
  { id: 'prompt', label: 'Get a prompt (prompts/get)', method: 'prompts/get', params: { name: 'weekly_update', arguments: { engagement_id: 'ENG-101' } } },
];

const TASKS = [
  'Which active engagements have high risks, and how much of their budget is used?',
  'Log a high risk on the Brightwater engagement: their legal team is on leave until December. Priya Shah owns it.',
  'Is anything about AWS in progress? Who is the partner?',
];

const SERVER_CODE = `@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
def get_engagement(engagement_id: str) -> EngagementDetail:
    """The full record of one engagement: dates, partner, budget and spend, and its open risks.

    Args:
        engagement_id: The engagement's id, such as ENG-104.
    """
    require(READ)                      # over HTTP, the token must carry this scope
    e = find(engagement_id)            # raises ToolError: "No engagement ... use search_engagements"
    return EngagementDetail(engagement=e, budget_used_percent=round(100 * e.spent_gbp / e.budget_gbp, 1))`;

const CLAUDE_CODE = `// .mcp.json at the project root: Claude Code starts the server, or connects to a hosted one
{
  "mcpServers": {
    "engagements": { "command": "python", "args": ["examples/mcp/server.py"] },
    "engagements-hosted": {
      "type": "http",
      "url": "\${MCP_URL}",
      "headers": { "Authorization": "Bearer \${MCP_TOKEN}" }
    }
  }
}`;

const CONNECTOR_CODE = `# The Claude API connects to your hosted server itself (beta). Allowlist: read tools only.
client.beta.messages.create(
    model="claude-opus-5-5", max_tokens=16000,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{"type": "url", "url": MCP_URL, "name": "engagements",
                  "authorization_token": token}],   # short-lived, read-only
    tools=[{"type": "mcp_toolset", "mcp_server_name": "engagements",
            "default_config": {"enabled": False},
            "configs": {"search_engagements": {"enabled": True}, "get_engagement": {"enabled": True}}}],
    messages=[{"role": "user", "content": "Summarise the active engagements."}],
)`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export default function McpPage() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [info, setInfo] = useState<{ url: string; tokens: Record<string, string> } | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    statusService.status().then(setStatus);
    mcpLabService
      .info()
      .then(setInfo)
      .catch(() => setProblem('The lab backend is not running, or is older than this page. Start or restart it: python -m backend --budget 1'));
  }, []);

  return (
    <main className="page-mcp">
      <div className="kicker">Lab 24 · MCP servers</div>
      <h1>Give Claude your tools with MCP</h1>
      <p className="lede">
        The Model Context Protocol is a standard way to offer tools and data to an AI application. You write a server
        once, and Claude Code, Claude Desktop, your own agent or the Claude API can all use it. This page runs a real
        MCP server inside the lab backend: call it yourself, then watch Claude use it.
      </p>
      {problem && <p className="small mc-problem">{problem}</p>}

      <section>
        <h2>The pieces</h2>
        <div className="mc-grid">
          <div className="card">
            <h3>Tools</h3>
            <p className="small">Functions the <b>model</b> decides to call, such as search or log a risk. Each has a name, a description and a JSON schema.</p>
          </div>
          <div className="card">
            <h3>Resources</h3>
            <p className="small">Data the <b>person or app</b> chooses to attach, by URI, such as a one-page brief of an engagement.</p>
          </div>
          <div className="card">
            <h3>Prompts</h3>
            <p className="small">Starting messages the <b>person</b> picks, which show up as slash commands in Claude Code.</p>
          </div>
          <div className="card">
            <h3>Transports</h3>
            <p className="small">
              <b>stdio</b>: the client starts the server as a local process. <b>Streamable HTTP</b>: a hosted server
              with a URL, authenticated with OAuth bearer tokens.
            </p>
          </div>
        </div>
      </section>

      <RawCalls url={info?.url} tokens={info?.tokens} />
      <AskClaude status={status} />

      <section>
        <h2>Design decisions</h2>
        <ol className="mc-design">
          <li>
            <b>Write tools for the model, like an API for a new colleague.</b> Few tools, each a whole task. Clear names and
            descriptions with examples. Constrained inputs, enforced before your code runs. Every tool's description is in
            Claude's context on every request, so fewer, better tools beat many small ones.
          </li>
          <li>
            <b>Keep results small.</b> Search returns summaries and the detail is one call away. Page long lists with an
            opaque cursor.
          </li>
          <li>
            <b>Make errors instructions.</b> Say what went wrong and what to do next, such as "use search_engagements to
            find the id" or "do not retry". Try "Get an id that does not exist" above.
          </li>
          <li>
            <b>Say what changes data, and make writes safe to retry.</b> Annotations mark tools as read-only or writing, so
            the client can ask a person first. An idempotency key stops a retried call from logging a risk twice.
          </li>
          <li>
            <b>Host it stateless, authenticate every request.</b> Any copy of the server can answer any request, so it
            scales behind a load balancer. Bearer tokens carry scopes (read, write), and a token issued for another server
            is refused.
          </li>
        </ol>
        <CodeBlock html={esc(SERVER_CODE)} />
      </section>

      <section>
        <h2>Three ways Claude connects</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Way</th>
                <th>Who runs the MCP client</th>
                <th>Use it for</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Claude Code</td>
                <td>Claude Code, from <code>.mcp.json</code> or a plugin</td>
                <td>Developers' own tools, shared with the team in the repo</td>
              </tr>
              <tr>
                <td>Your own harness</td>
                <td>Your code, with the SDK's MCP helpers (as "Ask Claude" above)</td>
                <td>Your agent, where you control approvals, logging and retries</td>
              </tr>
              <tr>
                <td>The MCP connector</td>
                <td>Anthropic's servers, during the API request</td>
                <td>No MCP client in your code; the server must be on public HTTPS</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid2">
          <CodeBlock html={esc(CLAUDE_CODE)} />
          <CodeBlock html={esc(CONNECTOR_CODE)} />
        </div>
      </section>

      <section>
        <h2>When a backend calls the server</h2>
        <ul className="mc-design">
          <li>
            <b>As itself</b> (a report job, an internal service): the OAuth client credentials grant. It gets a short-lived
            token for the server's URL with only the scopes it needs. On Azure a managed identity needs no secret; on AWS
            read the secret from Secrets Manager with the service's IAM role.
          </li>
          <li>
            <b>For a signed-in user:</b> never forward the user's token. Exchange it (token exchange, or On-Behalf-Of in
            Entra) for one meant for the MCP server that still names the user, so the server can apply that user's access.
          </li>
          <li>
            <b>Through the MCP connector:</b> your backend passes a short-lived, read-only token in each request, and the
            toolset allowlists only the tools that integration needs.
          </li>
        </ul>
        <p className="small muted">
          The code is in <code>examples/mcp/</code>: the server, tests, a harness with approvals, the connector example and a
          README with the full design notes. It uses the MCP Python SDK 2.x.
        </p>
      </section>
    </main>
  );
}

function RawCalls({ url, tokens }: { url?: string; tokens?: Record<string, string> }) {
  const [token, setToken] = useState('demo-read');
  const [pick, setPick] = useState('list');
  const [body, setBody] = useState(pretty(REQUESTS[0].params));
  const [exchange, setExchange] = useState<McpExchange | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const method = REQUESTS.find((r) => r.id === pick)?.method ?? 'tools/list';

  async function send() {
    if (!url) return;
    let params: unknown;
    try {
      params = JSON.parse(body || '{}');
    } catch {
      setNote('The params are not valid JSON.');
      return;
    }
    setBusy(true);
    setNote('');
    try {
      setExchange(await mcpLabService.rpc(url, token, method, params));
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Call the server yourself</h2>
      <p className="small muted">
        These are the requests any MCP client sends: JSON-RPC over HTTP to <code>{url ?? '…'}</code>. Pick a token, then
        try a write with the read-only one, or leave the token out.
      </p>
      <div className="card">
        <div className="mc-bar">
          <label className="small">
            Token{' '}
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              <option value="">No token</option>
              {Object.entries(tokens ?? {}).map(([t, scopes]) => (
                <option key={t} value={t}>
                  {t} ({scopes})
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            Request{' '}
            <select
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setBody(pretty(REQUESTS.find((r) => r.id === e.target.value)?.params ?? {}));
              }}
            >
              {REQUESTS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" disabled={!url || busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button className="btn small" disabled={busy} onClick={() => void mcpLabService.reset().then(() => setNote('Back to the sample data.'))}>
            Reset data
          </button>
        </div>
        <label className="small muted">
          params for <code>{method}</code>
        </label>
        <textarea className="mc-body" rows={Math.min(12, body.split('\n').length + 1)} value={body} onChange={(e) => setBody(e.target.value)} />
        {note && <p className="small muted">{note}</p>}
        {exchange && (
          <div className="mc-wire">
            <div>
              <h4>Request</h4>
              <pre>
                {`POST ${exchange.request.url}\n`}
                {Object.entries(exchange.request.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
                {`\n\n${pretty(exchange.request.body)}`}
              </pre>
            </div>
            <div>
              <h4>
                Response
                <span className={`mc-status ${exchange.status < 300 ? 'ok' : 'bad'}`}>{exchange.status}</span>
                <span className="small muted"> {exchange.ms} ms</span>
              </h4>
              <pre>
                {Object.entries(exchange.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
                {`\n\n${pretty(exchange.body)}`}
              </pre>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function AskClaude({ status }: { status: LiveStatus | null }) {
  const [task, setTask] = useState(TASKS[0]);
  const [model, setModel] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [steps, setSteps] = useState<McpStep[]>([]);
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const ready = !!(status?.available && status.has_credentials);

  useEffect(() => {
    if (status?.default_model) setModel(status.default_model);
  }, [status]);

  async function ask() {
    setBusy(true);
    setProblem('');
    setSteps([]);
    setCost(null);
    try {
      const r = await mcpLabService.ask(task, allowWrites, model);
      setSteps(r.steps);
      setCost(r.cost);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Claude uses the server</h2>
      <p className="small muted">
        A small harness: Claude gets the server's tools and decides which to call. The harness, not the model, decides
        whether a tool that writes may run: with "Allow writes" off, it declines them and Claude is told why.
      </p>
      <div className="card">
        <div className="mc-bar">
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!ready || busy}>
            {(status?.models ?? []).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <label className="small">
            <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} /> Allow writes
          </label>
          <button className="btn primary" disabled={!ready || busy || !task.trim()} onClick={() => void ask()}>
            {busy ? `${modelNameStart(model)} is working…` : `Ask ${modelName(model)}`}
          </button>
          {cost !== null && <span className="small muted">about ${cost.toFixed(4)}</span>}
        </div>
        <div className="chips" style={{ marginBottom: 8 }}>
          {TASKS.map((t) => (
            <button key={t} className={`chip-btn ${t === task ? 'on' : ''}`} onClick={() => setTask(t)}>
              {t.length > 60 ? `${t.slice(0, 58)}…` : t}
            </button>
          ))}
        </div>
        <textarea className="mc-body" rows={2} value={task} onChange={(e) => setTask(e.target.value)} />
        {!ready && status && <p className="small muted">{status.reason ?? 'Live Claude needs the lab backend and an API key.'}</p>}
        {problem && <p className="small mc-problem">{problem}</p>}
        {steps.length > 0 && (
          <div className="mc-steps">
            {steps.map((s, i) =>
              s.kind === 'call' ? (
                <details key={i} className={`mc-step ${s.declined ? 'declined' : ''}`}>
                  <summary>
                    <code>
                      {s.tool}({JSON.stringify(s.input)})
                    </code>
                    {s.writes || s.declined ? <span className="mc-tag write">writes</span> : <span className="mc-tag">reads</span>}
                    {s.declined && <span className="mc-tag err">declined by the harness</span>}
                    {!s.declined && s.is_error && <span className="mc-tag err">error</span>}
                  </summary>
                  <pre>{prettyResult(s.result)}</pre>
                </details>
              ) : (
                <div key={i} className={`mc-step ${s.kind === 'answer' ? 'answer' : ''}`}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{s.text}</div>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function prettyResult(result?: string): string {
  if (!result) return '';
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}
