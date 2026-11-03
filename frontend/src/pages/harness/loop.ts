import { Site } from '@/lib/site';
import type { Life } from '@/lib/lifecycle';
import { harnessService, statusService, type HarnessEvent, type Scenario } from '@/services';

/**
 * Section 5: the ten-tool harness of python/11_harness_loop.py, two ways.
 * Simulated: Claude's choices are scripted per scenario, but every tool really computes.
 * Live: the lab backend runs the real harness against Claude and streams each step here.
 */

type Kind = 'user' | 'request' | 'final' | 'finish' | 'tool' | 'parallel' | 'send' | 'start' | 'return' | 'denied' | 'server' | 'note' | 'ask';

/** One row of the timeline, with the state shown in the side panels at that moment. */
interface Step {
  lane: string;
  kind: Kind;
  title: string;
  detail: string;
  json: unknown;
  wall: number;
  seq: number;
  ctx: Record<string, number>;
  tools: string[];
}

type Input = Record<string, number | string>;
interface ToolUse { type: 'tool_use'; id: string; name: string; input: Input }
interface TextBlock { type: 'text'; text: string }
interface ToolResult { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }

type Approval = Extract<HarnessEvent, { type: 'approval' }>;
type ToolUseEvent = Extract<HarnessEvent, { type: 'tool_use' }>;

interface LiveRun {
  controller: AbortController;
  start: number;
  runId: string | null;
  ctx: Record<string, number>;
  uses: Record<string, ToolUseEvent>;
  waiting: Record<string, Approval>;
  awaiting: Record<string, boolean>;  // lanes whose tool results have not been sent back yet
  done: { cls: 'good' | 'warn' | 'bad'; text: string } | null;
  cost: number;
  toolCalls: number;
  running: boolean;
}

const CODE = ['add', 'multiply', 'divide', 'square_root', 'is_prime', 'factorise', 'digit_sum'];
const AGENTS = ['math_agent', 'bash_agent', 'web_agent'];
const PROMPTS: Record<string, string> = {
  main: 'You answer questions about numbers. Use the tools for every calculation. When steps do not depend on each other, ask for all of them in the same turn…',
  math_agent: 'You are a worker. Do the task with your tools, never doing arithmetic yourself. Reply with a short, plain answer.',
  bash_agent: 'You do the task by running shell commands with the bash tool. Run one command per call, with no pipes, redirects or &&…',
  web_agent: 'You answer the task by searching the web. Answer in one or two sentences and cite your sources.',
};
const TOOLSETS: Record<string, string[]> = {
  main: [...CODE, ...AGENTS],
  math_agent: CODE,
  bash_agent: ['bash  (Anthropic-defined, type bash_20250124)'],
  web_agent: ['web_search  (server tool, run by Anthropic)'],
};
const REQUEST_S = 1.2, TOOL_S = 0.5, SEARCH_S = 1.5;  // simulated seconds
const ICON: Record<Kind, string> = { user: 'U', request: 'C', final: '★', finish: '★', tool: 'T', parallel: '⇉', send: '↩', start: '┌', return: '└', denied: '✗', server: 'W', note: 'i', ask: '?' };
const COLOUR: Record<Kind, string> = { user: 'gate', request: 'say', final: 'done', finish: 'done', tool: 'tool', parallel: 'plan', send: 'result', start: 'approval', return: 'approval', denied: 'error', server: 'compact', note: 'result', ask: 'approval' };

// ---------- the tools, computed for real ----------
const isPrime = (n: number): boolean => {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
};
const factorise = (n: number): number[] => {
  const f: number[] = [];
  for (let d = 2; d * d <= n; d++) while (n % d === 0) { f.push(d); n /= d; }
  return n > 1 ? [...f, n] : f;
};
const digitSum = (n: number): number => [...String(Math.abs(n))].reduce((s, d) => s + Number(d), 0);
const divisors = (n: number): number => {
  let k = 0;
  for (let d = 1; d * d <= n; d++) if (n % d === 0) k += d * d === n ? 1 : 2;
  return k;
};
const RUN: Record<string, (input: Input) => unknown> = {
  add: ({ a, b }) => Number(a) + Number(b),
  multiply: ({ a, b }) => Number(a) * Number(b),
  square_root: ({ n }) => Number(Math.sqrt(Number(n)).toFixed(4)),
  is_prime: ({ n }) => isPrime(Number(n)),
  factorise: ({ n }) => factorise(Number(n)),
  digit_sum: ({ n }) => digitSum(Number(n)),
};

/** Builds the scripted run for one scenario. */
function simulate(scenario: Scenario, n: number): { steps: Step[]; outcome: string } {
  const steps: Step[] = [];
  let outcome = '', id = 0, wall = 0, seq = 0;
  const ctx: Record<string, number> = { main: 1 };  // messages in each agent's own conversation
  const push = (e: Partial<Step> & Pick<Step, 'lane' | 'kind' | 'title'>) =>
    steps.push({ wall, seq, ctx: { ...ctx }, tools: [], detail: '', json: null, ...e });
  const use = (name: string, input: Input): ToolUse => ({ type: 'tool_use', id: `toolu_${String(++id).padStart(2, '0')}`, name, input });
  const text = (t: string): TextBlock => ({ type: 'text', text: t });
  const resultBlock = (call: ToolUse, content: string, error = false): ToolResult =>
    ({ type: 'tool_result', tool_use_id: call.id, content, ...(error ? { is_error: true as const } : {}) });
  const sub = (lane: string) => lane !== 'main';

  function request(lane: string, content: (ToolUse | TextBlock)[]) {
    wall += REQUEST_S; seq += REQUEST_S; ctx[lane]++;
    const calls = content.filter((b): b is ToolUse => b.type === 'tool_use');
    push({
      lane, kind: calls.length ? 'request' : 'final', tools: calls.map(c => c.name),
      title: calls.length ? `Claude replies with ${calls.length > 1 ? `${calls.length} tool calls` : 'a tool call'}: ${calls.map(c => c.name).join(', ')}`
        : sub(lane) ? 'Claude answers with no tool call, so this agent is done' : 'Claude answers with no tool call, so the loop ends',
      detail: calls.length ? 'The harness reads each tool_use block: the name says which tool, the input is already JSON.'
        : `stop_reason is end_turn. ${content.find((b): b is TextBlock => b.type === 'text')?.text ?? ''}`,
      json: { stop_reason: calls.length ? 'tool_use' : 'end_turn', content },
    });
  }
  function runCode(lane: string, call: ToolUse): ToolResult {
    const value = JSON.stringify(RUN[call.name](call.input));
    wall += TOOL_S; seq += TOOL_S;
    push({
      lane, kind: 'tool', tools: [call.name],
      title: `${call.name}(${Object.values(call.input).join(', ')}) → ${value}`,
      detail: `Permission: allowed by the rule "${call.name}". The harness runs the Python function and wraps its output.`,
      json: resultBlock(call, value),
    });
    return resultBlock(call, value);
  }
  function runCommand(lane: string, call: ToolUse, out: string, rule: string): ToolResult {
    wall += TOOL_S; seq += TOOL_S;
    push({
      lane, kind: 'tool', title: `bash: ${call.input.command} → ${out}`,
      detail: `Permission: allowed by the rule "${rule}". It runs in an empty temporary folder, without a shell, with a 10-second timeout.`,
      json: resultBlock(call, out),
    });
    return resultBlock(call, out);
  }
  function send(lane: string, results: ToolResult[]) {
    ctx[lane]++;
    push({
      lane, kind: 'send',
      title: results.length > 1 ? `The harness sends all ${results.length} results back in one message` : 'The harness sends the result back',
      detail: 'Each tool_result carries the tool_use_id it answers, so Claude can match them up. Then the harness calls Claude again.',
      json: { role: 'user', content: results },
    });
  }
  function parallel(lane: string, calls: ToolUse[], runOne: (call: ToolUse, i: number) => ToolResult): ToolResult[] {
    push({
      lane, kind: 'parallel', tools: calls.map(c => c.name),
      title: `${calls.length} read-only calls run at the same time`,
      detail: 'They do not depend on each other and change nothing, so the harness starts them together and waits for the slowest.',
      json: { parallel: calls.map(c => ({ id: c.id, name: c.name, input: c.input })) },
    });
    const start = wall;
    let end = start;
    const results = calls.map((c, i) => { wall = start; const r = runOne(c, i); end = Math.max(end, wall); return r; });
    wall = end;
    return results;
  }
  function agent(name: string, k: number, call: ToolUse, body: (lane: string) => string): ToolResult {
    const lane = `${name} ${k}`;
    ctx[lane] = 1;
    push({
      lane, kind: 'start', tools: [name], title: 'Starts with an empty context',
      detail: "Its own system prompt, its own tools and the task text. It cannot see anything from main's conversation.",
      json: { system: PROMPTS[name], tools: TOOLSETS[name], messages: [{ role: 'user', content: call.input.task }] },
    });
    const answer = body(lane);
    push({ lane, kind: 'return', tools: [name], title: 'Hands back only its final answer', detail: answer, json: resultBlock(call, answer) });
    return resultBlock(call, answer);
  }
  const finish = (lane: string, answer: string): string => {
    request(lane, [text(answer)]);
    if (!sub(lane)) outcome = answer;
    return answer;
  };

  const tasks: Record<Scenario, string> = {
    chain: `Take ${n}. Multiply it by itself, add 7 to the result, check whether that is prime, then factorise it.`,
    parallel: `Profile ${n}: is it prime, what are its prime factors, its digit sum and its square root?`,
    team: `For ${n}, ${n + 5} and ${n * 30}: which are prime, and which has the largest digit sum? Give each number to its own math_agent.`,
    bash: `Ask the bash_agent to work out ${n} times ${n} with the expr command and to print today's date. Then check its product with your multiply tool.`,
    web: `Ask the web_agent for one notable fact about the number ${n}, and at the same time check whether ${n} is prime.`,
  };
  push({
    lane: 'main', kind: 'user', title: 'You send a number and a task', detail: tasks[scenario],
    json: { model: 'claude-haiku-5-5', system: PROMPTS.main, tools: TOOLSETS.main, messages: [{ role: 'user', content: tasks[scenario] }] },
  });

  if (scenario === 'chain') {
    const sq = n * n, r = sq + 7;
    let c = use('multiply', { a: n, b: n });
    request('main', [text('First I square the number.'), c]); send('main', [runCode('main', c)]);
    c = use('add', { a: sq, b: 7 });
    request('main', [c]); send('main', [runCode('main', c)]);
    c = use('is_prime', { n: r });
    request('main', [c]); send('main', [runCode('main', c)]);
    c = use('factorise', { n: r });
    request('main', [c]); send('main', [runCode('main', c)]);
    finish('main', `${n} × ${n} = ${sq}, and ${sq} + 7 = ${r}. ${r} is ${isPrime(r) ? 'prime' : 'not prime'}; its prime factors are ${factorise(r).join(' × ')}.`);
  }
  if (scenario === 'parallel') {
    const calls = [use('is_prime', { n }), use('factorise', { n }), use('digit_sum', { n }), use('square_root', { n })];
    request('main', [text('These four checks are independent, so I ask for all of them at once.'), ...calls]);
    send('main', parallel('main', calls, c => runCode('main', c)));
    finish('main', `${n} is ${isPrime(n) ? 'prime' : 'not prime'}. Prime factors: ${factorise(n).join(' × ')}. Digit sum: ${digitSum(n)}. Square root: ${RUN.square_root({ n })}.`);
  }
  if (scenario === 'team') {
    const nums = [n, n + 5, n * 30];
    const calls = nums.map(x => use('math_agent', { task: `Is ${x} prime, and what is its digit sum?` }));
    request('main', [text('Three independent jobs: one worker each.'), ...calls]);
    const results = parallel('main', calls, (call, i) => agent('math_agent', i + 1, call, lane => {
      const x = nums[i], cs = [use('is_prime', { n: x }), use('digit_sum', { n: x })];
      request(lane, cs);
      send(lane, parallel(lane, cs, cc => runCode(lane, cc)));
      return finish(lane, `${x} is ${isPrime(x) ? '' : 'not '}prime; its digit sum is ${digitSum(x)}.`);
    }));
    send('main', results);
    const primes = nums.filter(isPrime), top = nums.reduce((a, b) => (digitSum(b) > digitSum(a) ? b : a));
    finish('main', `${primes.length ? `Prime: ${primes.join(', ')}.` : 'None of them is prime.'} The largest digit sum is ${digitSum(top)}, for ${top}.`);
  }
  if (scenario === 'bash') {
    const call = use('bash_agent', { task: `Work out ${n} times ${n} with the expr command, and print today's date.` });
    request('main', [call]);
    push({ lane: 'main', kind: 'note', tools: ['bash_agent'], title: 'bash_agent has side effects, so it runs on its own', detail: 'The harness never runs a tool that can change things in parallel with anything else.', json: { read_only: false } });
    const today = new Date().toDateString();
    send('main', [agent('bash_agent', 1, call, lane => {
      let b = use('bash', { command: `python3 -c "print(${n}*${n})"` });
      request(lane, [b]);
      const refused = resultBlock(b, 'Permission denied (a person decided).', true);
      push({ lane, kind: 'denied', title: 'bash: python3 → an "ask" rule → the person says no', detail: 'The rule bash(python*) asks a person first. The refusal goes back to Claude as an error result, not as a crash.', json: refused });
      send(lane, [refused]);
      b = use('bash', { command: `expr ${n} \\* ${n}` });
      request(lane, [text('I will use expr instead, as the task asked.'), b]);
      send(lane, [runCommand(lane, b, String(n * n), 'bash(expr *)')]);
      b = use('bash', { command: 'date' });
      request(lane, [b]);
      send(lane, [runCommand(lane, b, today, 'bash(date*)')]);
      return finish(lane, `expr ${n} \\* ${n} printed ${n * n}. date printed ${today}. python3 was refused.`);
    })]);
    const c = use('multiply', { a: n, b: n });
    request('main', [c]); send('main', [runCode('main', c)]);
    finish('main', `The bash agent got ${n * n} from expr, and multiply agrees: ${n} × ${n} = ${n * n}. Today is ${today}.`);
  }
  if (scenario === 'web') {
    const calls = [use('web_agent', { task: `Find one notable fact about the number ${n}. One sentence, with a source.` }), use('is_prime', { n })];
    request('main', [text('The search and the prime check are independent, so both start now.'), ...calls]);
    const fact = `${n} is ${isPrime(n) ? 'a prime number' : `a composite number with ${divisors(n)} divisors`}.`;
    send('main', parallel('main', calls, c => c.name === 'is_prime' ? runCode('main', c) : agent('web_agent', 1, c, lane => {
      const s = { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: `number ${n} facts` } };
      wall += SEARCH_S; seq += SEARCH_S; ctx[lane]++;
      push({
        lane, kind: 'server', title: 'Anthropic runs web_search on its own servers',
        detail: 'A server tool comes back as server_tool_use and its results inside the same reply. The harness has nothing to run. If the server pauses (stop_reason pause_turn), the harness sends the reply back unchanged and it resumes.',
        json: { content: [s, { type: 'web_search_tool_result', tool_use_id: s.id, content: ['… search results …'] }] },
      });
      return finish(lane, `${fact} (Simulated: the real script returns what Claude found, with the pages it cites.)`);
    })));
    finish('main', `${n} is ${isPrime(n) ? '' : 'not '}prime. The web agent found: ${fact}`);
  }
  return { steps, outcome };
}

export function mountLoop(life: Life): void {
  const { $, esc } = Site;
  let mode: 'sim' | 'live' = 'sim', live: LiveRun | null = null;
  let steps: Step[] = [], outcome = '', idx = -1, timer: number | null = null;

  $('#hlTools').innerHTML = [...CODE.map(t => [t, 'code']), ...AGENTS.map(t => [t, 'agent'])]
    .map(([t, k]) => `<span class="hl-tool ${k}" data-t="${t}">${t}</span>`).join('');
  const number = (max: number) => Math.max(2, Math.min(max, Math.round(Number($('#hlNum').value) || 12)));

  // ---------- live runs, through the lab backend ----------
  const short = (v: unknown) => (typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : String(v));
  const fmtArgs = (input?: Record<string, unknown>) => (input ? Object.values(input).map(short).join(', ') : '');
  const firstLine = (s: unknown) => String(s ?? '').split('\n')[0].slice(0, 90);

  function onLiveEvent(L: LiveRun, ev: HarnessEvent): void {
    const lane = 'who' in ev ? ev.who : 'main';
    const add = (e: Partial<Step> & Pick<Step, 'kind' | 'title'>) => {
      const follow = idx >= steps.length - 1;
      const wall = (performance.now() - L.start) / 1000;
      steps.push({ lane, wall, seq: wall, ctx: { ...L.ctx }, tools: [], detail: '', json: ev, ...e });
      if (follow) idx = steps.length - 1;
    };
    switch (ev.type) {
      case 'run': L.runId = ev.run_id; return;
      case 'task':
        L.ctx.main = 1;
        add({ kind: 'user', title: 'You send a number and a task', detail: ev.task, json: { model: ev.model, tools: ev.tools, messages: [{ role: 'user', content: ev.task }] } });
        break;
      case 'agent_start':
        L.ctx[lane] = 1;
        add({ kind: 'start', tools: [ev.agent], title: 'Starts with an empty context', detail: ev.task, json: { system: ev.system, tools: ev.tools, messages: [{ role: 'user', content: ev.task }] } });
        break;
      case 'request': {
        L.ctx[lane] = (L.ctx[lane] || 1) + 1;
        L.cost += ev.cost || 0;
        const calls = ev.content.filter(b => b.type === 'tool_use');
        const said = ev.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        const paused = ev.stop_reason === 'pause_turn';
        if (calls.length) L.awaiting[lane] = true;
        add({
          kind: calls.length ? 'request' : paused ? 'server' : 'final', tools: calls.map(c => String(c.name)),
          title: calls.length ? `Claude replies with ${calls.length > 1 ? `${calls.length} tool calls` : 'a tool call'}: ${calls.map(c => c.name).join(', ')}`
            : paused ? 'A server tool paused; the harness sends the turn back'
            : lane === 'main' ? 'Claude answers with no tool call, so the loop ends' : 'Claude answers with no tool call, so this agent is done',
          detail: `stop_reason ${ev.stop_reason} · ${ev.input_tokens} tokens in, ${ev.output_tokens} out${said ? ` · ${said}` : ''}`,
          json: { stop_reason: ev.stop_reason, content: ev.content },
        });
        break;
      }
      case 'server_tool':
        add({ kind: 'server', title: `Anthropic runs ${ev.name} on its servers`, detail: 'A server tool: its results come back inside the reply, so the harness has nothing to run.', json: { name: ev.name, input: ev.input } });
        break;
      case 'tool_use': L.uses[ev.id] = ev; return;
      case 'parallel':
        add({ kind: 'parallel', tools: ev.names, title: `${ev.count} read-only calls run at the same time`, detail: 'They change nothing and do not depend on each other, so the harness starts them together.' });
        break;
      case 'approval':
        L.waiting[ev.id] = ev;
        add({ kind: 'ask', title: `Waiting for you: bash ${ev.input.command ?? 'restart'}`, detail: `In the browser every command asks first (${ev.reason}). Approve or deny it below.` });
        break;
      case 'approval_done':
        delete L.waiting[ev.id];
        add({ lane: L.uses[ev.id]?.who ?? lane, kind: ev.allow ? 'note' : 'denied', title: ev.allow ? 'You approved the command' : ev.timed_out ? 'Nobody answered in time, so the command is refused' : 'The command is refused' });
        break;
      case 'result': {
        const use = L.uses[ev.tool_use_id];
        if (L.awaiting[lane]) { L.ctx[lane]++; L.awaiting[lane] = false; }  // one user message per turn
        L.toolCalls++;
        add({
          kind: ev.is_error ? 'denied' : 'tool', tools: [ev.name],
          title: `${ev.name}(${fmtArgs(use?.input)}) → ${firstLine(ev.content)}`,
          detail: ev.is_error ? 'Sent back with is_error: true, so Claude can adapt.' : `Took ${ev.seconds.toFixed(2)}s.`,
          json: {
            tool_use: { type: 'tool_use', id: ev.tool_use_id, name: ev.name, input: use?.input },
            tool_result: { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, ...(ev.is_error ? { is_error: true } : {}) },
          },
        });
        break;
      }
      case 'agent_end':
        add({ kind: 'return', title: 'Hands back only its final answer', detail: ev.answer });
        break;
      case 'final':
        L.done = { cls: ev.answer ? 'good' : 'warn', text: ev.answer || ev.outcome };
        add({ kind: ev.answer ? 'finish' : 'denied', title: ev.answer ? 'The run is finished' : 'The harness stopped the run', detail: ev.outcome });
        break;
      case 'error':
        L.done = { cls: 'bad', text: ev.message };
        add({ kind: 'denied', title: 'Error', detail: ev.message });
        break;
      default:
        return;
    }
    render();
  }

  async function startLive(): Promise<void> {
    live?.controller.abort();
    steps = []; outcome = ''; idx = -1;
    const L: LiveRun = live = {
      controller: new AbortController(), start: performance.now(), runId: null, ctx: {}, uses: {}, waiting: {},
      awaiting: {}, done: null, cost: 0, toolCalls: 0, running: true,
    };
    setRunning(true); render();
    try {
      await harnessService.run({ scenario: $('#hlScenario').value, number: number(1_000_000), model: $('#hlModel').value },
        ev => onLiveEvent(L, ev), L.controller.signal);
    } catch (err) {
      const e = err as Error;
      L.done = e.name === 'AbortError' ? { cls: 'warn', text: 'Stopped. The server stops the agents too.' } : { cls: 'bad', text: e.message };
    }
    L.done ??= { cls: 'warn', text: 'The run ended without a final answer.' };
    L.running = false; L.waiting = {};
    if (live === L) { setRunning(false); render(); }
  }
  function setRunning(on: boolean): void {
    $('#hlRun').disabled = on;
    $('#hlStop').disabled = !on;
  }

  // ---------- rendering ----------
  function render(): void {
    $('#hlBack').disabled = idx < 0;
    $('#hlNext').disabled = idx >= steps.length - 1;
    $('#hlTimeline').innerHTML = steps.map((e, i) => `<li class="${i === idx ? 'cur' : i > idx ? 'future' : ''} ${e.lane === 'main' ? '' : 'hl-sub'}"><span class="ic k-${COLOUR[e.kind]}">${ICON[e.kind]}</span><span><span class="hl-lane">${esc(e.lane)}</span> <b>${esc(e.title)}</b><div class="detail">${esc(e.detail)}</div></span><span class="meta">${e.wall.toFixed(1)}s</span></li>`).join('');
    $('#hlTimeline li.cur')?.scrollIntoView({ block: 'nearest' });
    const e: Step | undefined = steps[Math.max(0, idx)];
    document.querySelectorAll<HTMLElement>('#hlTools .hl-tool').forEach(t => t.classList.toggle('on', idx >= 0 && !!e?.tools.includes(t.dataset.t ?? '')));
    $('#hlJson').textContent = idx < 0 || !e ? (mode === 'live' ? "Press Run. Each step's JSON appears here." : 'Press Next to see the JSON of each step.') : JSON.stringify(e.json, null, 2);
    $('#hlCtx').innerHTML = Object.entries(e?.ctx ?? {}).map(([k, v]) => `<div><b>${esc(k)}</b>: ${v} message${v === 1 ? '' : 's'}</div>`).join('')
      + '<div class="small muted">Each agent keeps its own list. None of them can read another\'s.</div>';
    const wall = e?.wall ?? 0;
    $('#hlTime').innerHTML = mode === 'live'
      ? `Elapsed <b>${wall.toFixed(1)}s</b> · <b>${live?.toolCalls ?? 0}</b> tool calls · about <b>$${(live?.cost ?? 0).toFixed(4)}</b><div class="small muted">A real run against Claude through the lab backend, inside its spending cap.</div>`
      : `Elapsed <b>${wall.toFixed(1)}s</b> · one after another it would be <b>${(e?.seq ?? 0).toFixed(1)}s</b><div class="small muted">Simulated: ${REQUEST_S}s per request to Claude, ${TOOL_S}s per tool.</div>`;
    renderOutcome();
  }
  function renderOutcome(): void {
    const o = $('#hlOutcome');
    if (mode === 'sim') {
      if (idx === steps.length - 1) { o.className = 'outcome good'; o.innerHTML = `<b>Done.</b> ${esc(outcome)}`; }
      else { o.className = 'outcome'; o.textContent = idx < 0 ? 'Pick a scenario and press Next or Play.' : `Step ${idx + 1} of ${steps.length}.`; }
      return;
    }
    const waiting = live && Object.values(live.waiting)[0];
    if (waiting) {
      o.className = 'outcome warn';
      o.innerHTML = `<b>${esc(waiting.who)} wants to run:</b> <code>${esc(waiting.input.command ?? 'restart')}</code><div class="small muted">It runs in an empty temporary folder on the machine running the backend, without a shell. Refused automatically after ${waiting.timeout_s}s.</div><div class="row" style="margin-top:8px"><button class="btn primary" data-allow="1" data-id="${esc(waiting.id)}">Approve</button><button class="btn" data-allow="0" data-id="${esc(waiting.id)}">Deny</button></div>`;
    } else if (live?.done && idx === steps.length - 1) {
      o.className = `outcome ${live.done.cls}`;
      o.innerHTML = `<b>${live.done.cls === 'good' ? 'Done.' : 'Stopped.'}</b> ${esc(live.done.text)}`;
    } else {
      o.className = 'outcome';
      o.textContent = !live ? 'Choose a number, a scenario and a model, then press Run.' : live.running ? `Running… ${steps.length} steps so far.` : `Step ${idx + 1} of ${steps.length}.`;
    }
  }

  // ---------- controls ----------
  function rebuild(): void {
    if (mode === 'live') return;  // a live run starts only when you press Run
    ({ steps, outcome } = simulate($('#hlScenario').value, number(100_000)));
    stopPlay(); idx = -1; render();
  }
  function setMode(m: 'sim' | 'live'): void {
    mode = m; stopPlay();
    live?.controller.abort();
    live = null;
    $('#hlSimBtns').hidden = m !== 'sim';
    $('#hlLiveBtns').hidden = m !== 'live';
    if (m === 'live') { steps = []; idx = -1; setRunning(false); render(); } else rebuild();
  }
  function go(d: number): void { idx = Math.max(-1, Math.min(steps.length - 1, idx + d)); render(); }
  function stopPlay(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    $('#hlPlay').textContent = 'Play';
  }
  $('#hlScenario').addEventListener('change', rebuild);
  $('#hlNum').addEventListener('change', rebuild);
  $('#hlNext').addEventListener('click', () => { stopPlay(); go(1); });
  $('#hlBack').addEventListener('click', () => { stopPlay(); go(-1); });
  $('#hlReset').addEventListener('click', () => { stopPlay(); idx = -1; render(); });
  $('#hlPlay').addEventListener('click', () => {
    if (timer !== null) return stopPlay();
    if (idx >= steps.length - 1) idx = -1;
    $('#hlPlay').textContent = 'Pause'; go(1);
    timer = life.setInterval(() => { if (idx >= steps.length - 1) stopPlay(); else go(1); }, 1300);
  });
  document.querySelectorAll<HTMLInputElement>('input[name="hlMode"]').forEach(r => r.addEventListener('change', () => setMode(r.value as 'sim' | 'live')));
  $('#hlRun').addEventListener('click', startLive);
  $('#hlStop').addEventListener('click', () => live?.controller.abort());
  life.signal.addEventListener('abort', () => live?.controller.abort());  // leaving the page stops the run
  $('#hlOutcome').addEventListener('click', async (ev: MouseEvent) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-allow]');
    if (!b || !live?.runId) return;
    b.parentElement?.querySelectorAll('button').forEach(x => (x.disabled = true));
    try {
      await harnessService.approve(live.runId, b.dataset.id ?? '', b.dataset.allow === '1');
    } catch (err) {
      live.done = { cls: 'bad', text: (err as Error).message };
      render();
    }
  });
  statusService.status().then(s => {
    if (!life.alive) return;
    const ok = s.available && s.has_credentials;
    $('#hlLiveRadio').disabled = !ok;
    $('#hlLiveNote').textContent = ok ? `Live runs spend real credit (about $${(s.spent_usd ?? 0).toFixed(2)} of $${(s.budget_usd ?? 0).toFixed(2)} used so far).` : s.reason;
    $('#hlModel').innerHTML = (s.models ?? []).map(m => `<option ${m === s.default_model ? 'selected' : ''}>${esc(m)}</option>`).join('');
  });
  rebuild();
}
