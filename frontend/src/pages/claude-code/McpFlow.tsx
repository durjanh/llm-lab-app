import { useEffect, useState, type CSSProperties } from 'react';
import './mcp-flow.css';

/* One MCP tool call from end to end, as a sequence diagram you step through: who sends what to whom, and the message
   on the wire at each step. The tool and its names are illustrative; the methods and shapes are MCP's and the
   Messages API's. Its own state only, so the page around it never re-renders. */

const LANES = ['You', 'Claude Code (host)', 'MCP client', 'MCP server', 'Claude (API)', 'GitHub'];
const [YOU, HOST, CLIENT, SERVER, CLAUDE, GITHUB] = [0, 1, 2, 3, 4, 5];

type Kind = 'you' | 'host' | 'mcp' | 'api' | 'http';

interface Step {
  from: number;
  to: number;
  label: string;
  kind: Kind;
  title: string;
  text: string;
  wire?: string;
  /** Steps that happen once, when Claude Code connects, rather than for every question. */
  setup?: boolean;
}

const STEPS: Step[] = [
  {
    from: CLIENT,
    to: SERVER,
    label: 'initialize',
    kind: 'mcp',
    setup: true,
    title: 'Connect: agree the protocol',
    text: 'When Claude Code starts, its MCP client starts each configured server (stdio) or connects to its URL (Streamable HTTP), and they agree a protocol version and what each side supports. Messages are JSON-RPC 2.0.',
    wire: '{"jsonrpc": "2.0", "id": 1, "method": "initialize",\n "params": {"protocolVersion": "<the newest the client supports>",\n            "capabilities": {},\n            "clientInfo": {"name": "claude-code"}}}',
  },
  {
    from: SERVER,
    to: CLIENT,
    label: 'capabilities',
    kind: 'mcp',
    setup: true,
    title: 'The server says what it offers',
    text: 'The server answers with the version it will use and its capabilities: tools, resources, prompts. The client then sends notifications/initialized, and the session is open.',
    wire: '{"jsonrpc": "2.0", "id": 1,\n "result": {"protocolVersion": "…",\n            "capabilities": {"tools": {"listChanged": true}},\n            "serverInfo": {"name": "github"}}}',
  },
  {
    from: CLIENT,
    to: SERVER,
    label: 'tools/list',
    kind: 'mcp',
    setup: true,
    title: 'List the tools',
    text: 'The client asks for the tools once, at connect, not for every question. If the server later sends notifications/tools/list_changed, the client asks again.',
    wire: '{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}',
  },
  {
    from: SERVER,
    to: CLIENT,
    label: 'tools + schemas',
    kind: 'mcp',
    setup: true,
    title: 'Each tool with its description and input schema',
    text: 'The description is what Claude reads to decide when to use the tool, so it matters as much as the code. Claude Code names each one mcp__<server>__<tool>, so tools from different servers never clash.',
    wire: '{"jsonrpc": "2.0", "id": 2, "result": {"tools": [{\n  "name": "list_repositories",\n  "description": "Lists the signed-in user\'s repositories, newest first.",\n  "inputSchema": {"type": "object",\n                  "properties": {"limit": {"type": "integer"}}}\n}]}}',
  },
  {
    from: YOU,
    to: HOST,
    label: 'What repositories do I have?',
    kind: 'you',
    title: 'You ask a question',
    text: 'Nothing about MCP is visible to you. You type a question in Claude Code.',
  },
  {
    from: HOST,
    to: CLAUDE,
    label: 'question + tools',
    kind: 'api',
    title: 'Claude Code sends the question and every tool',
    text: "One Messages API request holds the conversation and the tool definitions: the built-in ones (Read, Edit, Bash…) and every MCP tool, translated from MCP's inputSchema to the API's input_schema.",
    wire: 'POST /v1/messages\n{"model": "claude-sonnet-5-5",\n "messages": [{"role": "user", "content": "What repositories do I have?"}],\n "tools": [ …built-in tools…,\n   {"name": "mcp__github__list_repositories",\n    "description": "Lists the signed-in user\'s repositories, newest first.",\n    "input_schema": {"type": "object", "properties": {"limit": {"type": "integer"}}}}]}',
  },
  {
    from: CLAUDE,
    to: HOST,
    label: 'tool_use',
    kind: 'api',
    title: 'Claude chooses a tool',
    text: 'Claude does not run anything. It answers with a tool_use block and stop_reason "tool_use": a request for the host to run the tool with these arguments.',
    wire: '{"stop_reason": "tool_use",\n "content": [{"type": "tool_use", "id": "toolu_01A…",\n              "name": "mcp__github__list_repositories",\n              "input": {"limit": 20}}]}',
  },
  {
    from: HOST,
    to: CLIENT,
    label: 'run it (if allowed)',
    kind: 'host',
    title: 'Claude Code checks permission, then hands the call to the MCP client',
    text: 'Before running it, Claude Code applies your permission rules: a tool you allowed (for example "mcp__github__list_repositories" in settings.json) runs; otherwise it asks you. A denied call goes back to Claude as an error, never to the server.',
  },
  {
    from: CLIENT,
    to: SERVER,
    label: 'tools/call',
    kind: 'mcp',
    title: 'The client calls the tool',
    text: 'The prefix is dropped: the server only knows its own tool names.',
    wire: '{"jsonrpc": "2.0", "id": 3, "method": "tools/call",\n "params": {"name": "list_repositories", "arguments": {"limit": 20}}}',
  },
  {
    from: SERVER,
    to: GITHUB,
    label: 'GET /user/repos',
    kind: 'http',
    title: 'The server does the real work',
    text: "The MCP server calls GitHub's own API with its own credentials. The token lives with the server: Claude never sees it, and neither does the conversation.",
    wire: "GET https://api.github.com/user/repos?per_page=20&sort=created\nAuthorization: Bearer <the server's token>",
  },
  {
    from: GITHUB,
    to: SERVER,
    label: '200 OK',
    kind: 'http',
    title: 'GitHub answers',
    text: 'An ordinary API response, often far bigger than Claude needs. A good server trims it to the fields that matter, because every token of the result goes into the context.',
    wire: '200 OK\n[{"full_name": "you/llm-lab-app", "private": true, …}, …]',
  },
  {
    from: SERVER,
    to: CLIENT,
    label: 'result',
    kind: 'mcp',
    title: 'The tool result',
    text: 'Content blocks (text here; images and resource links are possible too). A failure is still a result, with isError true and a message Claude can act on, rather than a protocol error.',
    wire: '{"jsonrpc": "2.0", "id": 3, "result": {\n  "content": [{"type": "text",\n               "text": "you/llm-lab-app (private)\\nyou/notes (public)\\n…"}],\n  "isError": false}}',
  },
  {
    from: HOST,
    to: CLAUDE,
    label: 'tool_result',
    kind: 'api',
    title: 'Claude Code sends the result back',
    text: "The next request repeats the conversation, adds Claude's tool_use turn, and answers it with a tool_result carrying the same id. The client handed the result to the host, which is the only part that talks to Claude.",
    wire: 'POST /v1/messages\n{"messages": [ …the question…, …Claude\'s tool_use…,\n   {"role": "user", "content": [{"type": "tool_result",\n      "tool_use_id": "toolu_01A…",\n      "content": "you/llm-lab-app (private)\\nyou/notes (public)\\n…"}]}],\n "tools": [ …the same tools… ]}',
  },
  {
    from: CLAUDE,
    to: HOST,
    label: 'answer',
    kind: 'api',
    title: 'Claude answers in words',
    text: 'With the result in front of it, Claude writes the answer and stops with "end_turn". Had it needed another tool, this would be another tool_use and the loop would go round again.',
    wire: '{"stop_reason": "end_turn",\n "content": [{"type": "text", "text": "You have 12 repositories. The newest are…"}]}',
  },
  {
    from: HOST,
    to: YOU,
    label: 'Your repositories are…',
    kind: 'you',
    title: 'You see the answer',
    text: 'Claude Code shows the answer, with the tool call it made, so you can see where the facts came from.',
  },
];

const W = 960;
const LANE_X = LANES.map((_, i) => 80 + i * 160);
const TOP = 96;
const GAP = 34;
const QUESTION_GAP = 26; // room for the "Every question" heading
const H = TOP + STEPS.length * GAP + QUESTION_GAP + 16;
const SETUP_END = STEPS.findIndex((s) => !s.setup);

const PLAY_MS = 2600;

export function McpFlow() {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const step = STEPS[at];

  useEffect(() => {
    if (!playing) return;
    if (at >= STEPS.length - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setAt((n) => n + 1), PLAY_MS);
    return () => window.clearTimeout(t);
  }, [playing, at]);

  const go = (n: number) => {
    setPlaying(false);
    setAt(Math.max(0, Math.min(STEPS.length - 1, n)));
  };

  return (
    <div className="mf-wrap">
      <div className="mf-scroll">
        <svg className="mf-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MCP tool call sequence diagram">
          <rect x={8} y={TOP - 22} width={W - 16} height={SETUP_END * GAP + 8} rx={8} className="mf-setup" />
          <text x={16} y={TOP - 8} className="mf-zone">
            Once, when Claude Code connects
          </text>
          <text x={16} y={TOP + SETUP_END * GAP + 4} className="mf-zone">
            Every question
          </text>
          {LANES.map((name, i) => (
            <g key={name}>
              <rect x={LANE_X[i] - 72} y={10} width={144} height={40} rx={8} className="mf-head" />
              <text x={LANE_X[i]} y={35} textAnchor="middle" className="mf-head-text">
                {name}
              </text>
              <line x1={LANE_X[i]} y1={50} x2={LANE_X[i]} y2={H - 6} className="mf-life" />
            </g>
          ))}
          {STEPS.map((s, i) => {
            const y = TOP + i * GAP + (s.setup ? 0 : QUESTION_GAP);
            const x1 = LANE_X[s.from];
            const x2 = LANE_X[s.to];
            const dir = x2 > x1 ? 1 : -1;
            const tip = x2 - dir * 4;
            const state = i === at ? 'now' : i < at ? 'done' : 'later';
            return (
              <g
                key={i}
                className={`mf-step mf-${s.kind} mf-${state}`}
                onClick={() => go(i)}
                role="button"
                tabIndex={0}
                aria-label={`Step ${i + 1}: ${s.title}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    go(i);
                  }
                }}
              >
                <rect x={Math.min(x1, x2)} y={y - 18} width={Math.abs(x2 - x1)} height={26} className="mf-hit" />
                <line x1={x1 + dir * 4} y1={y} x2={tip - dir * 8} y2={y} className="mf-line" />
                <polygon
                  points={`${tip},${y} ${tip - dir * 10},${y - 5} ${tip - dir * 10},${y + 5}`}
                  className="mf-head-arrow"
                />
                <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" className="mf-label">
                  {s.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mf-legend">
        <span style={{ '--c': 'var(--s3)' } as CSSProperties}>MCP (JSON-RPC)</span>
        <span style={{ '--c': 'var(--brand)' } as CSSProperties}>Messages API</span>
        <span style={{ '--c': 'var(--s2)' } as CSSProperties}>GitHub's own API</span>
        <span style={{ '--c': 'var(--ink2)' } as CSSProperties}>You and the host</span>
      </div>

      <div className="mf-controls" role="group" aria-label="Step through the call">
        <button type="button" className="btn small" onClick={() => go(at - 1)} disabled={at === 0}>
          Back
        </button>
        <button
          type="button"
          className="btn small primary"
          onClick={() => (at >= STEPS.length - 1 ? (setAt(0), setPlaying(true)) : setPlaying((p) => !p))}
        >
          {playing ? 'Pause' : at >= STEPS.length - 1 ? 'Play again' : 'Play'}
        </button>
        <button type="button" className="btn small" onClick={() => go(at + 1)} disabled={at === STEPS.length - 1}>
          Next
        </button>
        <span className="small muted">
          Step {at + 1} of {STEPS.length}. Click any arrow to jump to it.
        </span>
      </div>

      <div className={`mf-panel card mf-${step.kind}`} aria-live="polite">
        <h4>
          {at + 1}. {step.title}
          <span className="mf-route">
            {LANES[step.from]} → {LANES[step.to]}
          </span>
        </h4>
        <p>{step.text}</p>
        {step.wire && <pre className="mf-wire">{step.wire}</pre>}
      </div>
    </div>
  );
}
