"""A harness built the way Claude Code is built: one loop, ten tools, sub-agents with a fresh context.

Companion to the Harness engineering lab. You give a number and a task. The
harness sends them to Claude with ten tool definitions. Claude replies with
tool_use blocks, JSON naming a tool and its input. The harness finds that tool
by name, checks permissions, runs it, and sends every result back in one
message. It repeats until Claude answers without asking for a tool.

The ten tools
  code, instant and exact   add, multiply, divide, square_root, is_prime, factorise, digit_sum
  agents, each its own loop math_agent  a worker with the seven code tools
                            bash_agent  runs shell commands in a temporary folder (Anthropic's bash tool)
                            web_agent   searches the web (Anthropic's server-side web_search tool)

Patterns taken from Claude Code and the Claude Agent SDK
  - The loop ends when Claude stops asking for tools. Turn and spending limits stop runaway loops.
  - Each reply is appended with every block unchanged, so the history stays append-only, until it is
    compacted: when the conversation has grown past --compact-at tokens, Claude summarises the older turns,
    and the harness swaps them for that summary. The latest call and its results are kept as they were.
    The long scenario compacts at 400 tokens so you can watch it happen; at that size a summary costs more
    than it saves. Real harnesses compact near the context window, where it is the only way to carry on.
  - All results of one turn go back in one user message. Failures go back with is_error, not dropped.
  - Read-only tools asked for together run in parallel. A tool with side effects runs on its own.
  - A sub-agent starts with an empty context: its own system prompt, its own tools and the task text.
    Only its final answer comes back. Sub-agents cannot start sub-agents.
  - Hooks run around every call: PreToolUse can block it, PostToolUse trims its output.
  - Permission rules are checked before every call: deny wins, then ask, then allow; otherwise ask a person.

Claude Code offers its sub-agents through one Agent tool with a subagent_type
argument. Here each sub-agent is its own tool, so all ten are easy to see.

    python 11_harness_loop.py --scenario chain       # one tool at a time: each step needs the last result
    python 11_harness_loop.py --scenario parallel    # independent tools in one turn, run together
    python 11_harness_loop.py --scenario team        # three math_agent workers in parallel
    python 11_harness_loop.py --scenario bash        # a sub-agent with bash, behind permission rules
    python 11_harness_loop.py --scenario web         # a sub-agent with web search, next to a code tool
    python 11_harness_loop.py --scenario long        # twenty steps in a row, compacted on the way
    python 11_harness_loop.py 360 "Is 360 prime? Find one fact about it online."
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import math
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from common import cost_usd, create, ensure_answered, make_client, model_argument, run, text_of, tool

MAX_OUTPUT = 2000  # characters of tool output sent back to the model


class ToolError(Exception):
    """A failure the model should hear about, returned as an error tool result."""


class StopRun(Exception):
    """The harness ends the whole run: the turn limit or the budget was reached."""


@dataclass
class Tool:
    definition: dict                # what Claude sees: name, description, input schema
    run: Callable                   # run(input, harness, depth) -> result
    read_only: bool = True          # read-only tools may run in parallel with each other

    @property
    def name(self) -> str:
        return self.definition["name"]


@dataclass
class AgentDefinition:
    """A sub-agent, in the shape the Claude Agent SDK uses: when to call it, its prompt and its tools."""
    name: str
    description: str                # the parent reads this to decide when to call the agent
    prompt: str                     # the agent's own system prompt
    tools: list[Tool] = field(default_factory=list)
    server_tools: list[dict] = field(default_factory=list)  # run by Anthropic, such as web_search
    read_only: bool = True
    max_turns: int = 6


# --- The seven code tools ---------------------------------------------------

def divide(a: float, b: float) -> float:
    if b == 0:
        raise ToolError("Cannot divide by zero.")
    return a / b


def square_root(n: float) -> float:
    if n < 0:
        raise ToolError(f"{n} is negative, so it has no real square root.")
    return math.sqrt(n)


def is_prime(n: int) -> bool:
    if n > 10**12:
        raise ToolError("Numbers above 10^12 are too large for this tool.")
    return n >= 2 and all(n % d for d in range(2, math.isqrt(n) + 1))


def factorise(n: int) -> list[int]:
    if not 2 <= n <= 10**12:
        raise ToolError("factorise needs a whole number from 2 to 10^12.")
    factors, d = [], 2
    while d * d <= n:
        while n % d == 0:
            factors.append(d)
            n //= d
        d += 1
    return factors + ([n] if n > 1 else [])


def code_tool(name: str, description: str, properties: dict, fn: Callable) -> Tool:
    def run_code(args, harness, depth):
        time.sleep(harness.latency)  # stands in for a slow API, so parallel calls show a real speed-up
        return fn(**args)
    return Tool(tool(name, description, properties), run_code)


NUMBER, WHOLE = {"type": "number"}, {"type": "integer"}
CODE_TOOLS = [
    code_tool("add", "Add two numbers. Use it for every addition.", {"a": NUMBER, "b": NUMBER}, lambda a, b: a + b),
    code_tool("multiply", "Multiply two numbers. Use it for every multiplication, including squaring a number.",
              {"a": NUMBER, "b": NUMBER}, lambda a, b: a * b),
    code_tool("divide", "Divide a by b. Fails when b is 0.", {"a": NUMBER, "b": NUMBER}, divide),
    code_tool("square_root", "The square root of n. Fails when n is negative.", {"n": NUMBER}, square_root),
    code_tool("is_prime", "Whether a whole number is prime.", {"n": WHOLE}, is_prime),
    code_tool("factorise", "The prime factors of a whole number from 2 to 10^12, smallest first.",
              {"n": WHOLE}, factorise),
    code_tool("digit_sum", "The sum of the digits of a whole number.", {"n": WHOLE},
              lambda n: sum(map(int, str(abs(n))))),
]


# --- bash and web search, for the sub-agents ----------------------------------

BASH = {"type": "bash_20250124", "name": "bash"}  # Anthropic-defined: the schema is built into the model


def run_bash(args, harness, depth) -> str:
    """Runs one command in the sandbox folder, without a shell, so pipes and redirects cannot work."""
    if args.get("restart"):
        return "Shell restarted. Every command already runs in a fresh process in the same folder."
    try:
        argv = shlex.split(args.get("command", ""))
    except ValueError as exc:
        raise ToolError(f"Could not parse the command: {exc}")
    if not argv:
        raise ToolError("The command is empty.")
    try:
        proc = subprocess.run(argv, cwd=harness.sandbox, capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        raise ToolError(f"{argv[0]}: command not found.")
    except subprocess.TimeoutExpired:
        raise ToolError("The command timed out after 10 seconds.")
    output = (proc.stdout + proc.stderr).strip() or "(no output)"
    return output if proc.returncode == 0 else f"exit code {proc.returncode}\n{output}"


def web_search_tool(model: str) -> dict:
    # The _20260209 version filters results with code first; it needs an Opus, Sonnet or Fable model.
    dynamic = model.startswith(("claude-opus", "claude-sonnet", "claude-fable"))
    return {"type": "web_search_20260209" if dynamic else "web_search_20250305", "name": "web_search", "max_uses": 3}


def agent_tool(agent: AgentDefinition) -> Tool:
    """Expose a sub-agent as a tool. Calling it starts the agent's own loop with an empty context."""
    task = {"type": "string", "description": "A complete, self-contained task. The agent sees nothing else."}
    return Tool(tool(agent.name, agent.description, {"task": task}),
                lambda args, harness, depth: harness.run_agent(agent, args["task"], depth + 1),
                agent.read_only)


def build_agents(model: str, max_turns: int) -> AgentDefinition:
    math_agent = AgentDefinition(
        "math_agent",
        "A worker agent with the seven code tools and its own context. Give it one self-contained job about "
        "numbers. For several independent jobs, call it several times in the same turn: the calls run in parallel.",
        "You are a worker. Do the task with your tools, never doing arithmetic yourself. "
        "Reply with a short, plain answer.",
        tools=CODE_TOOLS)
    bash_agent = AgentDefinition(
        "bash_agent",
        "An agent that runs shell commands in an empty temporary folder. Use it when the task asks for a "
        "command to be run. Permission rules may refuse a command or ask a person first.",
        "You do the task by running shell commands with the bash tool. Run one command per call, with no pipes, "
        "redirects or &&. If a command is refused, say so instead of working around it. "
        "Reply with each command you ran and what it printed.",
        tools=[Tool(BASH, run_bash, read_only=False)], read_only=False)
    web_agent = AgentDefinition(
        "web_agent",
        "An agent that searches the web. Use it for facts that are not in the conversation or that may have "
        "changed. It answers in one or two sentences, with sources.",
        "You answer the task by searching the web. Answer in one or two sentences and cite your sources.",
        server_tools=[web_search_tool(model)])
    return AgentDefinition(
        "main", "", MAIN_PROMPT, max_turns=max_turns,
        tools=[*CODE_TOOLS, agent_tool(math_agent), agent_tool(bash_agent), agent_tool(web_agent)])


MAIN_PROMPT = """You answer questions about numbers.
- Use the tools for every calculation. Never do arithmetic in your head.
- When steps do not depend on each other, ask for all of them in the same turn; the harness runs them in parallel.
- When a step needs an earlier result, wait for that result first.
- An agent cannot see this conversation, so give it a complete, self-contained task.
- When the request is fully answered, reply with the final answer and no tool calls."""


# --- Permissions and hooks, the Claude Code way -------------------------------

# A rule is a tool name, or "bash(<command pattern>)". Deny wins, then ask, then allow; anything else asks a person.
PERMISSIONS = {
    "deny": ["bash(rm *)", "bash(sudo *)", "bash(curl *)", "bash(wget *)"],
    "ask": ["bash(python*)"],
    "allow": [*(t.name for t in CODE_TOOLS), "math_agent", "bash_agent", "web_agent", "bash(restart)",
              "bash(echo *)", "bash(expr *)", "bash(seq *)", "bash(factor *)", "bash(date*)", "bash(ls*)"],
}
SHELL_OPERATORS = ("&&", "||", ";", "|", "`", "$(", ">", "<")


def permission(name: str, args: dict, rules: dict = PERMISSIONS) -> tuple[str, str]:
    """Returns ("allow" | "ask" | "deny", reason) for one tool call."""
    subject = name
    if name == "bash":
        command = args.get("command", "restart")
        if any(op in command for op in SHELL_OPERATORS):
            return "deny", "shell operators are not allowed; run one command at a time"
        subject = f"bash({command})"
    for decision in ("deny", "ask", "allow"):
        for rule in rules[decision]:
            if fnmatch.fnmatchcase(subject, rule):
                return decision, f"rule {rule}"
    return "ask", "no rule matches"


def log_call(harness, who: str, depth: int, block) -> str | None:
    """PreToolUse hook: reports the JSON Claude sent. Return a reason to block the call."""
    harness.emit({"type": "tool_use", "who": who, "depth": depth,
                  "id": block.id, "name": block.name, "input": block.input})
    return None


def trim_output(harness, who: str, depth: int, block, output: str) -> str:
    """PostToolUse hook: keeps long output from filling the context."""
    if len(output) <= MAX_OUTPUT:
        return output
    return output[:MAX_OUTPUT] + f"\n[... {len(output) - MAX_OUTPUT} characters trimmed by the harness]"


HOOKS = {"PreToolUse": [log_call], "PostToolUse": [trim_output]}


# --- Compaction ----------------------------------------------------------------

COMPACT_PROMPT = """You compact an agent's working history so it can carry on with a shorter context.
Write a summary for the agent itself: every result found so far with its exact value, the decisions made,
and what is left to do. Leave out anything superseded. Plain text, no preamble."""


def transcript(messages: list[dict]) -> str:
    """The history as plain text, for the model that writes the summary."""
    lines = []
    for m in messages:
        if isinstance(m["content"], str):
            lines.append(f"{m['role']}: {m['content']}")
            continue
        for block in m["content"]:
            b = block if isinstance(block, dict) else dump(block)
            kind = b.get("type")
            if kind == "text" and b["text"].strip():
                lines.append(f"{m['role']}: {b['text'].strip()}")
            elif kind in ("tool_use", "server_tool_use"):
                lines.append(f"tool call: {b['name']} {json.dumps(b['input'])}")
            elif kind == "tool_result":
                lines.append(f"tool result{' (error)' if b.get('is_error') else ''}: {b['content']}")
    return "\n".join(lines)


# --- The harness -------------------------------------------------------------

def print_event(e: dict) -> None:
    """Shows one harness event in the terminal. The lab backend streams the same events to the page instead."""
    kind, depth = e["type"], e.get("depth", 0)
    text = {
        "request": lambda: f"[{e['agent']} · request {e['turn']} · stop_reason={e['stop_reason']}]",
        "server_tool": lambda: f"⇢ server_tool_use {e['name']} {json.dumps(e['input'])} (run by Anthropic)",
        "says": lambda: f"{e['agent']} says: {e['text']}",
        "agent_start": lambda: f"┌ starts with an empty context. Task: {e['task']}",
        "agent_end": lambda: f"└ returns: {e['answer']}",
        "tool_use": lambda: f"→ tool_use {json.dumps({k: e[k] for k in ('id', 'name', 'input')})}",
        "parallel": lambda: f"⇉ running {e['count']} read-only calls in parallel",
        "compact": lambda: f"⇊ compacted {e['messages']} messages ({e['tokens']:,} input tokens) into a summary:\n"
                           + "\n".join("      " + line for line in e["summary"].splitlines()),
        "result": lambda: f"  ✗ {e['content']}" if e["is_error"] else
                          f"  ← {e['name']}: {e['content'].splitlines()[0][:100] if e['content'] else ''}  ({e['seconds']:.2f}s)",
    }.get(kind)
    if text:  # parallel agents print interleaved, so sub-agent lines carry a label
        print("    " * depth + (f"{e['who']} │ " if depth else "") + text(), flush=True)


def dump(block) -> dict:
    return block.model_dump(mode="json", exclude_none=True) if hasattr(block, "model_dump") else dict(vars(block))


class Harness:
    def __init__(self, client, model: str, *, effort: str = "low", latency: float = 0.5, budget: float = 0.25,
                 emit: Callable[[dict], None] = print_event, approve: Callable | None = None,
                 permissions: dict = PERMISSIONS, on_response: Callable | None = None,
                 compact_at: int = 0) -> None:
        self.client, self.model, self.effort = client, model, effort
        self.compact_at = compact_at  # tokens of conversation growth that start a compaction; 0 never compacts
        self.latency, self.budget, self.permissions = latency, budget, permissions
        self._emit, self._approve, self.on_response = emit, approve, on_response
        self.cancelled = threading.Event()  # set by whoever started the run, to stop it early
        self.sandbox = tempfile.mkdtemp(prefix="harness-bash-")
        self.lock = threading.Lock()  # tool calls run on several threads
        self.usage = defaultdict(lambda: {"calls": 0, "input": 0, "output": 0, "cost": 0.0})
        self.started = defaultdict(int)  # sub-agents started so far, by name, to label each one
        self.spent = 0.0
        self.tool_calls = 0
        self.tool_seconds = 0.0  # time the main agent's tools took, as if run one after another

    def emit(self, event: dict) -> None:
        with self.lock:
            self._emit(event)

    def record(self, agent: str, resp) -> float:
        cost = cost_usd(resp.usage, self.model) or 0
        with self.lock:
            u = self.usage[agent]
            u["calls"] += 1
            u["input"] += resp.usage.input_tokens
            u["output"] += resp.usage.output_tokens
            u["cost"] += cost
            self.spent += cost
        if self.on_response:
            self.on_response(resp)
        return cost

    def ask(self, block, who: str, depth: int, reason: str) -> bool:
        """A permission prompt. Without an approve callback, nobody can answer, so the call is refused."""
        return bool(self._approve and self._approve(block, who, depth, reason))

    def check_running(self) -> None:
        if self.cancelled.is_set():
            raise StopRun("the run was cancelled")
        if self.spent >= self.budget:
            raise StopRun(f"the estimated spend ${self.spent:.3f} reached the ${self.budget:.2f} budget")

    def run_agent(self, agent: AgentDefinition, task: str, depth: int = 0) -> str:
        """The agent loop. The main agent and every sub-agent run through this same code."""
        with self.lock:
            self.started[agent.name] += 1
            who = f"{agent.name} {self.started[agent.name]}" if depth else agent.name
        if depth:
            self.emit({"type": "agent_start", "who": who, "depth": depth, "agent": agent.name, "task": task,
                       "system": agent.prompt, "tools": [t.name for t in agent.tools] + [t["name"] for t in agent.server_tools]})
        tools = {t.name: t for t in agent.tools}
        definitions = [t.definition for t in agent.tools] + agent.server_tools
        messages: list[dict] = [{"role": "user", "content": task}]
        start_tokens = None  # input of the first request since the start or the last compaction
        for turn in range(1, agent.max_turns + 1):
            self.check_running()
            resp = create(self.client, model=self.model, max_tokens=16000, system=agent.prompt,
                          tools=definitions, messages=messages, output_config={"effort": self.effort})
            cost = self.record(agent.name, resp)
            start_tokens = start_tokens or resp.usage.input_tokens
            messages.append({"role": "assistant", "content": resp.content})  # every block, unchanged
            ensure_answered(resp)  # a refusal or a reply cut off at max_tokens stops here
            self.emit({"type": "request", "who": who, "depth": depth, "agent": agent.name, "turn": turn,
                       "stop_reason": resp.stop_reason, "content": [dump(b) for b in resp.content
                                                                     if b.type not in ("thinking", "redacted_thinking")],
                       "input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens,
                       "cost": cost})
            for block in resp.content:
                if block.type == "server_tool_use":
                    self.emit({"type": "server_tool", "who": who, "depth": depth, "name": block.name, "input": block.input})

            if resp.stop_reason == "pause_turn":  # a server tool paused; sending the turn back resumes it
                continue
            calls = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not calls:
                answer = with_sources(resp)
                if depth:
                    self.emit({"type": "agent_end", "who": who, "depth": depth, "agent": agent.name, "answer": answer})
                return answer
            if text_of(resp).strip():
                self.emit({"type": "says", "who": who, "depth": depth, "agent": agent.name, "text": text_of(resp).strip()})
            messages.append({"role": "user", "content": self.execute(calls, tools, who, depth)})
            grown = resp.usage.input_tokens - start_tokens
            if self.compact_at and grown >= self.compact_at and len(messages) > 3:
                messages = self.compact(agent, task, messages, who, depth, resp.usage.input_tokens)
                start_tokens = None  # measure growth again from the compacted conversation

        if depth:  # a stuck worker is reported to its parent, which can decide what to do
            raise ToolError(f"{agent.name} stopped after {agent.max_turns} turns without finishing.")
        raise StopRun(f"{agent.name} reached its limit of {agent.max_turns} turns")

    def compact(self, agent: AgentDefinition, task: str, messages: list[dict], who: str, depth: int,
                tokens: int) -> list[dict]:
        """Swaps the older turns for a summary Claude writes. The latest call and its results stay as they were."""
        older, latest = messages[:-2], messages[-2:]
        self.check_running()
        resp = create(self.client, model=self.model, max_tokens=4000, system=COMPACT_PROMPT,
                      output_config={"effort": "low"},
                      messages=[{"role": "user", "content": f"<history>\n{transcript(older)}\n</history>"}])
        self.record(f"{agent.name} (compact)", resp)
        ensure_answered(resp)
        summary = text_of(resp).strip()
        first = {"role": "user", "content": f"{task}\n\n<progress_so_far>\n{summary}\n</progress_so_far>\n"
                                            "Earlier turns were compacted into the summary above. Carry on from it."}
        self.emit({"type": "compact", "who": who, "depth": depth, "agent": agent.name, "messages": len(older),
                   "tokens": tokens, "summary": summary})
        return [first, *latest]

    def execute(self, calls: list, tools: dict[str, Tool], who: str, depth: int) -> list[dict]:
        """Runs one turn's tool calls and returns all the results, in order, for a single user message.

        As in Claude Code, consecutive read-only calls run in parallel, and a call with side effects runs alone.
        """
        def safe(block) -> bool:
            return block.name in tools and tools[block.name].read_only

        batches: list[list] = []
        for block in calls:
            if batches and safe(block) and safe(batches[-1][0]):
                batches[-1].append(block)
            else:
                batches.append([block])
        results = []
        for batch in batches:
            if len(batch) == 1:
                results.append(self.call_tool(batch[0], tools, who, depth))
                continue
            self.emit({"type": "parallel", "who": who, "depth": depth, "count": len(batch),
                       "names": [b.name for b in batch]})
            with ThreadPoolExecutor(max_workers=len(batch)) as pool:
                results += pool.map(lambda b: self.call_tool(b, tools, who, depth), batch)
        return results

    def call_tool(self, block, tools: dict[str, Tool], who: str, depth: int) -> dict:
        """Finds the tool Claude named, runs the hooks and permission check, runs the tool, and wraps the result."""
        start = time.perf_counter()

        def result(content: str, error: bool = False) -> dict:
            self.emit({"type": "result", "who": who, "depth": depth, "name": block.name, "tool_use_id": block.id,
                       "content": content, "is_error": error, "seconds": time.perf_counter() - start})
            r = {"type": "tool_result", "tool_use_id": block.id, "content": content}
            return {**r, "is_error": True} if error else r

        self.check_running()
        for hook in HOOKS["PreToolUse"]:
            if reason := hook(self, who, depth, block):
                return result(f"Blocked by a hook: {reason}", error=True)
        if block.name not in tools:
            return result(f"There is no tool called {block.name}.", error=True)
        decision, why = permission(block.name, block.input, self.permissions)
        if decision == "ask":
            decision = "allow" if self.ask(block, who, depth, why) else "deny"
            why = "a person decided"
        if decision == "deny":
            return result(f"Permission denied ({why}).", error=True)

        start = time.perf_counter()
        try:
            output = tools[block.name].run(block.input, self, depth)
        except ToolError as exc:
            return result(f"Error: {exc}", error=True)
        finally:
            with self.lock:
                self.tool_calls += 1
                if depth == 0:
                    self.tool_seconds += time.perf_counter() - start
        text = output if isinstance(output, str) else json.dumps(output)
        for hook in HOOKS["PostToolUse"]:
            text = hook(self, who, depth, block, text)
        return result(text)


def with_sources(resp) -> str:
    """The reply's text, plus the web pages it cites, if any."""
    urls = dict.fromkeys(c.url for b in resp.content if b.type == "text"
                         for c in (getattr(b, "citations", None) or []) if getattr(c, "url", None))
    answer = text_of(resp).strip()
    return answer + (f"\nSources: {', '.join(urls)}" if urls else "")


SCENARIOS = {
    "chain": "Take {n}. Multiply it by itself, add 7 to the result, check whether that is prime, then factorise it.",
    "parallel": "Profile {n}: is it prime, what are its prime factors, its digit sum and its square root?",
    "team": "For {n}, {n2} and {n3}: which are prime, and which has the largest digit sum? "
            "Give each number to its own math_agent.",
    "bash": "Ask the bash_agent to work out {n} times {n} with the expr command and to print today's date. "
            "Then check its product with your multiply tool.",
    "web": "Ask the web_agent for one notable fact about the number {n}, and at the same time check whether "
           "{n} is prime.",
    "long": "Start at {n}. Ten times in a row: add 7 to the current number, then check whether the new number "
            "is prime. Take one step at a time, each with a tool. Finally list every number you reached and "
            "say which were prime.",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("number", nargs="?", type=int, default=12)
    parser.add_argument("task", nargs="?", help="your own task, instead of a scenario")
    parser.add_argument("--scenario", choices=list(SCENARIOS), default="chain")
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--max-turns", type=int, help="requests the main agent may make (default: 10; 30 for long)")
    parser.add_argument("--compact-at", type=int, metavar="TOKENS",
                        help="compact when the conversation has grown by this many tokens (default: off; 400 for long)")
    parser.add_argument("--budget", type=float, default=0.25, help="stop when the estimated spend reaches this many dollars")
    parser.add_argument("--latency", type=float, default=0.5, help="seconds each code tool waits, like a slow API")
    parser.add_argument("--yes", action="store_true", help="approve every permission prompt without asking")
    model_argument(parser)
    args = parser.parse_args()

    def ask_in_terminal(block, who, depth, reason) -> bool:
        if args.yes:
            return True
        if not sys.stdin.isatty():
            return False  # nobody to ask, so the call is refused
        return input(f"    Allow {block.name}({json.dumps(block.input)})? ({reason}) [y/N] ").strip().lower() == "y"

    n = args.number
    task = args.task or SCENARIOS[args.scenario].format(n=n, n2=n + 5, n3=n * 30)
    long = args.scenario == "long" and not args.task
    max_turns = args.max_turns or (30 if long else 10)
    compact_at = args.compact_at if args.compact_at is not None else (400 if long else 0)
    harness = Harness(make_client(), args.model, effort=args.effort, latency=args.latency, budget=args.budget,
                      approve=ask_in_terminal, compact_at=compact_at)
    print(f"User: {task}\n")
    start = time.perf_counter()
    try:
        answer = harness.run_agent(build_agents(args.model, max_turns), task)
        outcome = "done: Claude answered without asking for another tool"
    except StopRun as exc:
        answer, outcome = None, f"stopped by the harness: {exc}"
    finally:
        shutil.rmtree(harness.sandbox, ignore_errors=True)
    wall = time.perf_counter() - start

    if answer:
        print(f"\nAssistant: {answer}")
    print(f"\nOutcome: {outcome}\n")
    print(f"{'agent':<12}{'requests':>9}{'input':>9}{'output':>9}{'cost':>10}")
    for name, u in harness.usage.items():
        print(f"{name:<12}{u['calls']:>9}{u['input']:>9,}{u['output']:>9,}{'$' + format(u['cost'], '.4f'):>10}")
    print(f"\n{harness.tool_calls} tool calls · {wall:.1f}s in total · the main agent's tools took "
          f"{harness.tool_seconds:.1f}s, which would be the wait if they had run one after another")
    print(f"Estimated cost: ${harness.spent:.4f}")


if __name__ == "__main__":
    run(main)
