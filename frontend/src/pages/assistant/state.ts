/* Turns the send route's stream of events into what the page shows: the reply, the plan, the files, the cost, why it
   stopped, and one lane of activity per agent. Pure functions, so the same code rebuilds a past turn from its log. */
import type { AssistantEvent, AssistantFile, EventType, Plan, StopReason, Turn } from '@/services/assistantService';

export interface Lane {
  agent: string;
  brief: string | null;
  status: 'running' | 'done';
  stopped: StopReason | null;
  costUsd: number;
  events: AssistantEvent[];
}

export interface ToolApproval {
  approvalId: string;
  agent: string;
  server: string;
  tool: string;
  input: unknown;
}

export interface TurnState {
  runId: string | null;
  turnId: string | null;
  user: { text: string; attachments: AssistantFile[] };
  /** The main agent's reply, built from its text deltas. */
  text: string;
  plan: Plan | null;
  planReason: string | null;
  files: AssistantFile[];
  model: string | null;
  modelsUsed: string[];
  costUsd: number;
  stopped: StopReason | null;
  error: string | null;
  /** A plan waiting for the person: approve, edit or reject. */
  approval: { approvalId: string; plan: Plan } | null;
  /** MCP tool calls waiting for the person, oldest first (servers set to ask before each call). */
  toolApprovals: ToolApproval[];
  /** Notes from the backend about the main agent's turn, such as plan steps left unticked. */
  notes: string[];
  title: string | null;
  lanes: Lane[];
}

const KNOWN: ReadonlySet<EventType> = new Set<EventType>([
  'run',
  'turn',
  'model_call',
  'text',
  'thinking',
  'plan',
  'plan_approval',
  'tool_call',
  'tool_approval',
  'tool_result',
  'note',
  'file',
  'agent_start',
  'agent_end',
  'usage',
  'compaction',
  'model_switch',
  'fallback',
  'title',
  'done',
  'error',
]);

export function startTurn(user: TurnState['user']): TurnState {
  return {
    runId: null,
    turnId: null,
    user,
    text: '',
    plan: null,
    planReason: null,
    files: [],
    model: null,
    modelsUsed: [],
    costUsd: 0,
    stopped: null,
    error: null,
    approval: null,
    toolApprovals: [],
    notes: [],
    title: null,
    lanes: [],
  };
}

const agentOf = (e: AssistantEvent): string => ('agent' in e && typeof e.agent === 'string' ? e.agent : 'main');

/** Lanes in a stable order: main first, then sub-agents by number. */
function laneOrder(a: Lane, b: Lane): number {
  const n = (s: string) => (s === 'main' ? -1 : Number(s.replace(/\D+/g, '')) || 0);
  return n(a.agent) - n(b.agent) || a.agent.localeCompare(b.agent);
}

function withLane(lanes: Lane[], agent: string, change: (l: Lane) => Lane): Lane[] {
  const found = lanes.find((l) => l.agent === agent);
  const base: Lane = found ?? { agent, brief: null, status: 'running', stopped: null, costUsd: 0, events: [] };
  const next = change(base);
  return (found ? lanes.map((l) => (l === found ? next : l)) : [...lanes, next]).sort(laneOrder);
}

/** Text deltas are not logged one by one; consecutive ones are joined so the activity panel stays readable. */
function logEvent(events: AssistantEvent[], e: AssistantEvent): AssistantEvent[] {
  const last = events[events.length - 1];
  if (e.type === 'text' && last?.type === 'text')
    return [...events.slice(0, -1), { ...last, delta: last.delta + e.delta }];
  return [...events, e];
}

function addFile(files: AssistantFile[], f: AssistantFile): AssistantFile[] {
  const i = files.findIndex((x) => x.id === f.id || x.name === f.name);
  return i < 0 ? [...files, f] : files.map((x, k) => (k === i ? f : x));
}

/**
 * Applies one event. Unknown event types are ignored, and so is everything after the turn has finished, so a late
 * or repeated line cannot change a finished turn.
 */
export function reduceTurn(s: TurnState, e: AssistantEvent): TurnState {
  if (!e || typeof e !== 'object' || !KNOWN.has(e.type)) return s;
  if (s.stopped !== null) return s;
  const agent = agentOf(e);
  let next: TurnState = { ...s, lanes: withLane(s.lanes, agent, (l) => ({ ...l, events: logEvent(l.events, e) })) };

  switch (e.type) {
    case 'run':
      next = { ...next, runId: e.run_id };
      break;
    case 'turn':
      next = { ...next, turnId: e.turn_id };
      break;
    case 'model_call':
      if (agent === 'main')
        next = {
          ...next,
          model: e.model,
          modelsUsed: next.modelsUsed.includes(e.model) ? next.modelsUsed : [...next.modelsUsed, e.model],
        };
      break;
    case 'text':
      if (agent === 'main') next = { ...next, text: next.text + e.delta };
      break;
    case 'plan':
      // The main agent's plan is the one shown above the reply; sub-agents' plans stay in their lanes.
      if (agent === 'main') next = { ...next, plan: e.plan, planReason: e.reason ?? null };
      break;
    case 'plan_approval':
      next = { ...next, approval: { approvalId: e.approval_id, plan: e.plan }, plan: e.plan };
      break;
    case 'file':
      next = { ...next, files: addFile(next.files, e.file) };
      break;
    case 'tool_approval':
      if (!next.toolApprovals.some((a) => a.approvalId === e.approval_id))
        next = {
          ...next,
          toolApprovals: [
            ...next.toolApprovals,
            { approvalId: e.approval_id, agent, server: e.server, tool: e.tool, input: e.input },
          ],
        };
      break;
    case 'note':
      if (agent === 'main') next = { ...next, notes: [...next.notes, e.text] };
      break;
    case 'agent_start':
      next = { ...next, lanes: withLane(next.lanes, agent, (l) => ({ ...l, brief: e.brief, status: 'running' })) };
      break;
    case 'agent_end':
      next = {
        ...next,
        lanes: withLane(next.lanes, agent, (l) => ({ ...l, status: 'done', stopped: e.stopped, costUsd: e.cost_usd })),
      };
      break;
    case 'usage':
      next = {
        ...next,
        costUsd: Math.max(next.costUsd, e.run_cost_usd),
        lanes: withLane(next.lanes, agent, (l) => ({ ...l, costUsd: l.costUsd + e.cost_usd })),
      };
      break;
    case 'title':
      next = { ...next, title: e.title };
      break;
    case 'error':
      next = { ...next, error: e.message };
      break;
    case 'done':
      next = {
        ...next,
        stopped: e.stopped,
        costUsd: e.cost_usd,
        // The final text is authoritative: it is what was stored, even if a delta was missed.
        text: e.text || next.text,
        approval: null,
        toolApprovals: [],
        lanes: next.lanes.map((l) => (l.status === 'running' ? { ...l, status: 'done' } : l)),
      };
      break;
    default:
      break;
  }
  return next;
}

/** Removes a tool approval once the person has answered it, so its card goes away at once. */
export function answeredTool(s: TurnState, approvalId: string): TurnState {
  return { ...s, toolApprovals: s.toolApprovals.filter((a) => a.approvalId !== approvalId) };
}

/** Ends a turn whose stream broke off without a "done" line, keeping what arrived. */
export function endWithError(s: TurnState, message: string): TurnState {
  if (s.stopped !== null) return s;
  return reduceTurn(
    { ...s, error: message },
    { type: 'done', ts: Date.now(), stopped: 'error', cost_usd: s.costUsd, text: s.text },
  );
}

/** Rebuilds a past turn's lanes from its saved log; the stored turn supplies everything else. */
export function fromStored(turn: Turn, log: AssistantEvent[] = []): TurnState {
  const replayed = log.reduce(reduceTurn, startTurn(turn.user));
  return {
    ...replayed,
    turnId: turn.id,
    text: turn.assistant.text,
    plan: turn.assistant.plan,
    files: turn.assistant.files,
    model: turn.assistant.model,
    modelsUsed: turn.assistant.models_used,
    costUsd: turn.assistant.cost_usd,
    stopped: turn.assistant.stopped,
    error: turn.assistant.error ?? null,
    approval: null,
    toolApprovals: [],
    lanes: replayed.lanes.map((l) => (l.status === 'running' ? { ...l, status: 'done' } : l)),
  };
}

export const STOPPED_TEXT: Record<StopReason, string> = {
  finished: 'Finished.',
  budget: 'Stopped: this run reached its budget. Raise the run budget and ask it to carry on.',
  time: 'Stopped: this run reached its time limit. Ask it to carry on from where it stopped.',
  stopped: 'Stopped by you.',
  refused: 'The model declined to answer this request.',
  error: 'Stopped by an error.',
  running: 'Still running.',
};

/** One line for an activity row: an icon, a short title and, where useful, a detail to expand. */
export interface Row {
  icon: string;
  title: string;
  detail: string | null;
  tone: 'normal' | 'network' | 'error' | 'meta' | 'good';
}

const dollars = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const json = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

function commandOf(input: unknown): string | null {
  if (
    input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof (input as { command: unknown }).command === 'string'
  )
    return (input as { command: string }).command;
  return null;
}

export function describe(e: AssistantEvent): Row {
  switch (e.type) {
    case 'run':
      return { icon: '▶', title: 'Run started', detail: `run ${e.run_id}`, tone: 'meta' };
    case 'turn':
      return { icon: '✉', title: 'Message stored', detail: null, tone: 'meta' };
    case 'model_call':
      return {
        icon: '◆',
        title: `Model call ${e.n}: ${e.model}${e.effort ? `, ${e.effort} effort` : ''}`,
        detail: null,
        tone: 'meta',
      };
    case 'text':
      return { icon: '✎', title: `Wrote: ${clip(e.delta.replace(/\s+/g, ' '))}`, detail: e.delta, tone: 'normal' };
    case 'thinking':
      return { icon: '💭', title: `Thinking: ${clip(e.text.replace(/\s+/g, ' '))}`, detail: e.text, tone: 'normal' };
    case 'plan':
      return {
        icon: '☑',
        title: `Plan${e.plan.revision > 1 ? `, revision ${e.plan.revision}` : ''}: ${e.plan.steps.length} steps`,
        detail: [e.reason ? `Why: ${e.reason}` : '', ...e.plan.steps.map((s) => `[${s.status}] ${s.text}`)]
          .filter(Boolean)
          .join('\n'),
        tone: 'good',
      };
    case 'plan_approval':
      return { icon: '⏸', title: 'Waiting for you to approve the plan', detail: null, tone: 'meta' };
    case 'tool_approval':
      return {
        icon: '⏸',
        title: `Waiting for you to allow ${e.server} › ${e.tool}`,
        detail: json(e.input),
        tone: 'meta',
      };
    case 'note':
      return { icon: 'ℹ', title: e.text, detail: null, tone: 'meta' };
    case 'tool_call': {
      if (e.mcp)
        return {
          icon: '🔌',
          title: `${e.mcp.server} › ${e.mcp.tool}`,
          // The server's own description is untrusted text: shown as plain text, never as markup.
          detail: [e.mcp.description ? `Described by the server: ${e.mcp.description}` : '', json(e.input)]
            .filter(Boolean)
            .join('\n\n'),
          tone: 'normal',
        };
      const cmd = commandOf(e.input);
      return {
        icon: e.network ? '🌐' : '⚙',
        title: `${e.name}${cmd ? `: ${clip(cmd)}` : ''}${e.network ? ' (network)' : ''}`,
        detail: json(e.input),
        tone: e.network ? 'network' : 'normal',
      };
    }
    case 'tool_result':
      return {
        icon: e.ok ? '✓' : '✗',
        title: `${e.ok ? 'Done' : 'Failed'}${e.exit_code !== undefined ? `, exit ${e.exit_code}` : ''} in ${(e.duration_ms / 1000).toFixed(1)} s${e.truncated ? ' (output cut)' : ''}`,
        detail: e.output,
        tone: e.ok ? 'normal' : 'error',
      };
    case 'file':
      return {
        icon: '📄',
        title: `Made ${e.file.name}`,
        detail: `${e.file.media_type}, ${e.file.size} bytes`,
        tone: 'good',
      };
    case 'agent_start':
      return {
        icon: '⇉',
        title: `Sub-agent started: ${clip(e.brief)}`,
        detail: `Brief: ${e.brief}\nExpected: ${e.expected_output}`,
        tone: 'meta',
      };
    case 'agent_end':
      return {
        icon: '⇇',
        title: `Sub-agent ${e.stopped === 'finished' ? 'finished' : `stopped (${e.stopped})`}, ${dollars(e.cost_usd)}`,
        detail: e.summary,
        tone: 'meta',
      };
    case 'usage':
      return {
        icon: '¤',
        title: `${e.input_tokens.toLocaleString('en-GB')} in, ${e.output_tokens.toLocaleString('en-GB')} out, ${dollars(e.cost_usd)} (run ${dollars(e.run_cost_usd)})${e.partial ? ', partial, estimated' : ''}`,
        detail: `${e.model}; ${e.cache_read_tokens.toLocaleString('en-GB')} tokens read from the cache`,
        tone: 'meta',
      };
    case 'compaction':
      return {
        icon: '⇲',
        title: `Compacted the history: ${e.tokens_before.toLocaleString('en-GB')} to ${e.tokens_after.toLocaleString('en-GB')} tokens`,
        detail: `Summary by ${e.model}, covering up to ${e.covers_until}`,
        tone: 'meta',
      };
    case 'model_switch':
      return {
        icon: '⇄',
        title: `Model changed: ${e.from} to ${e.to}`,
        detail: 'The whole history was passed to the new model.',
        tone: 'meta',
      };
    case 'fallback':
      return { icon: '↪', title: `Fell back from ${e.from} to ${e.to}`, detail: e.reason, tone: 'error' };
    case 'title':
      return { icon: '🏷', title: `Titled: ${e.title}`, detail: null, tone: 'meta' };
    case 'done':
      return {
        icon: '■',
        title: `${STOPPED_TEXT[e.stopped]} ${dollars(e.cost_usd)}`,
        detail: null,
        tone: e.stopped === 'finished' ? 'good' : 'error',
      };
    case 'error':
      return { icon: '!', title: e.message, detail: null, tone: 'error' };
  }
}

export const isImage = (f: Pick<AssistantFile, 'media_type'>) => f.media_type.startsWith('image/');
