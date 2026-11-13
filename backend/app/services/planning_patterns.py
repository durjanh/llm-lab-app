"""ReAct and planning patterns: one task, run by several agent patterns side by side, each with its full trace and cost.

The tools work on an invented shop (Northwind Supplies), so every answer has a known right value and code marks it.
The patterns:
- tool loop: native tool use with no written reasoning, the baseline most production agents use today;
- ReAct: the same loop, but the model writes a short Thought before every action (Yao et al., 2022);
- plan-and-execute: a planner writes a numbered plan, an executor does one step at a time, and a replanner revises
  the rest of the plan when a step fails;
- reflexion: attempt, a critic checks the attempt against the task's checks, then one more attempt with the critique.

Each pattern runs in its own thread, publishes its steps as they happen, and stops at a step cap or the run's budget.
"""
from __future__ import annotations

import ast
import contextvars
import operator
import re
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

from ..core.errors import ApiError, describe, to_api_error
from ..gateways.claude import ClaudeGateway
from ..shared import DEFAULT_MODEL, text_of
from .runs import Run, RunStreamer
from .spend import SpendTracker

PATTERNS = ["tool_loop", "react", "plan_execute", "reflexion"]
PATTERN_NAMES = {"tool_loop": "Tool loop", "react": "ReAct", "plan_execute": "Plan and execute",
                 "reflexion": "Reflexion"}
MAX_STEPS = 14  # model calls per pattern
MAX_STEPS_PLAN = 24  # plan and execute needs a call to plan, two or more per step, and one to answer
MAX_REPLANS = 2
MAX_TOKENS = 1200

# ---------- the invented shop ----------

TODAY = date(2026, 3, 16)  # a Monday; fixed, so date answers can be checked

PRODUCTS: dict[str, dict[str, Any]] = {
    "P-100": {"name": "Desk Lamp", "price": 34.50, "stock": 120},
    "P-200": {"name": "Office Chair", "price": 149.00, "stock": 18},
    "P-300": {"name": "Standing Desk", "price": 319.00, "stock": 6},
    "P-400": {"name": "Monitor Arm", "price": 64.00, "stock": 40},
    "P-500": {"name": "Cable Tray", "price": 18.75, "stock": 0},
}

ORDERS: dict[str, dict[str, Any]] = {
    "N-1042": {"customer": "Harbour Design Ltd", "placed": "2026-03-02", "delivered": "2026-03-06",
               "status": "delivered", "lines": [{"product": "P-200", "quantity": 2, "price_paid": 149.00},
                                                {"product": "P-100", "quantity": 4, "price_paid": 34.50}]},
    "N-1057": {"customer": "Quayside Accountants", "placed": "2026-03-16", "delivered": None,
               "status": "awaiting dispatch", "lines": [{"product": "P-300", "quantity": 8, "price_paid": 319.00},
                                                        {"product": "P-400", "quantity": 8, "price_paid": 64.00}]},
    "N-1063": {"customer": "R. Okafor", "placed": "2026-02-20", "delivered": "2026-02-25", "status": "delivered",
               "lines": [{"product": "P-300", "quantity": 1, "price_paid": 289.00}]},  # bought in the February sale
}

POLICIES: dict[str, str] = {
    "Returns": "Items can be returned within 30 days of delivery. The refund is the price paid, as shown on the "
               "order, not the current catalogue price. Opened items are accepted in their original packaging.",
    "Bulk discount": "Any order line of 10 or more units of the same product gets 10% off that line. Lines of fewer "
                     "than 10 units are charged at the full price.",
    "Delivery": "Delivery is free when the goods total after discounts is over £500 before VAT; otherwise it costs "
                "£25. Standard delivery takes 5 working days from dispatch. Orders are dispatched only in full.",
    "VAT": "All prices are before VAT. VAT at 20% applies to goods and to delivery.",
    "Stock": "Stock levels come from the warehouse system. Restocks from suppliers arrive in 3 working days.",
}

# ---------- the tools ----------

TOOLS: list[dict[str, Any]] = [
    {"name": "calculator", "description": "Evaluates arithmetic: + - * / ( ) and round(x, n). Use it for every sum.",
     "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}},
    {"name": "lookup_product", "description": "A product's id, name, current catalogue price (GBP, before VAT) and "
                                              "stock, by id (P-100) or name.",
     "input_schema": {"type": "object", "properties": {"product": {"type": "string"}}, "required": ["product"]}},
    {"name": "lookup_order", "description": "An order's customer, dates, status and lines (product id, quantity, "
                                            "price paid per unit), by order id such as N-1042.",
     "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}},
    {"name": "stock_check", "description": "Live stock for a product id, from the warehouse system.",
     "input_schema": {"type": "object", "properties": {"product_id": {"type": "string"}}, "required": ["product_id"]}},
    {"name": "dates", "description": "Date arithmetic. operation: today | add_working_days (date, days) | "
                                     "days_between (date, other_date) | weekday (date). Dates are YYYY-MM-DD.",
     "input_schema": {"type": "object", "properties": {
         "operation": {"type": "string", "enum": ["today", "add_working_days", "days_between", "weekday"]},
         "date": {"type": "string"}, "days": {"type": "integer"}, "other_date": {"type": "string"}},
         "required": ["operation"]}},
    {"name": "search_policies", "description": "Searches the shop's policies (returns, bulk discount, delivery, VAT, "
                                               "stock) and returns the best matching sections.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
]
FINAL = {"name": "final_answer", "description": "Gives the final answer to the task. Call it once, at the end.",
         "input_schema": {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}}
STEP_DONE = {"name": "step_result", "description": "Reports the result of the current plan step. ok is false when a "
                                                   "tool failed or the step could not be done.",
             "input_schema": {"type": "object", "properties": {"ok": {"type": "boolean"}, "result": {"type": "string"}},
                              "required": ["ok", "result"]}}

_OPS: dict[type, Callable[..., float]] = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
                                          ast.Div: operator.truediv, ast.USub: operator.neg, ast.UAdd: operator.pos}


def calculate(expression: str) -> float:
    """Arithmetic only: numbers, + - * /, brackets and round(). Anything else is refused."""
    def walk(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](walk(node.left), walk(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](walk(node.operand))
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "round"
                and 1 <= len(node.args) <= 2 and not node.keywords):
            args = [walk(a) for a in node.args]
            return float(round(args[0], int(args[1]))) if len(args) == 2 else float(round(args[0]))
        raise ValueError("only numbers, + - * / ( ) and round() are allowed")
    if len(expression) > 300:
        raise ValueError("the expression is too long")
    cleaned = re.sub(r"(?<=\d),(?=\d{3}\b)", "", expression.replace("£", ""))  # 1,035 is a number; round(x, 2) is not
    return walk(ast.parse(cleaned, mode="eval"))


def _working_days(start: date, days: int) -> date:
    d, step = start, 1 if days >= 0 else -1
    for _ in range(abs(days)):
        d += timedelta(days=step)
        while d.weekday() >= 5:
            d += timedelta(days=step)
    return d


class Shop:
    """The tools for one pattern's run. With flaky set, the warehouse system fails the first stock check."""

    def __init__(self, flaky: bool = False):
        self.flaky, self.stock_calls = flaky, 0

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            return getattr(self, f"_{name}")(**args)
        except (AttributeError, TypeError):
            return {"error": f"No tool {name} with those inputs."}
        except (ValueError, SyntaxError, ZeroDivisionError) as exc:
            return {"error": str(exc) or type(exc).__name__}

    def _calculator(self, expression: str) -> dict[str, Any]:
        value = calculate(expression)
        return {"expression": expression, "result": round(value, 6)}

    def _lookup_product(self, product: str) -> dict[str, Any]:
        key = product.strip().upper()
        for pid, p in PRODUCTS.items():
            if key == pid or product.strip().lower().rstrip("s") == p["name"].lower():
                return {"id": pid, "name": p["name"], "current_price": p["price"], "stock": p["stock"]}
        return {"error": f"No product {product!r}. Products: " + ", ".join(p["name"] for p in PRODUCTS.values())}

    def _lookup_order(self, order_id: str) -> dict[str, Any]:
        order = ORDERS.get(order_id.strip().upper())
        if not order:
            return {"error": f"No order {order_id!r}."}
        lines = [{**line, "name": PRODUCTS[line["product"]]["name"]} for line in order["lines"]]
        return {"order_id": order_id.strip().upper(), **order, "lines": lines}

    def _stock_check(self, product_id: str) -> dict[str, Any]:
        self.stock_calls += 1
        if self.flaky and self.stock_calls == 1:
            return {"error": "The warehouse system timed out (temporary). Try again."}
        p = PRODUCTS.get(product_id.strip().upper())
        return {"product_id": product_id.strip().upper(), "name": p["name"], "in_stock": p["stock"]} if p else \
            {"error": f"No product {product_id!r}."}

    def _dates(self, operation: str, date: str = "", days: int = 0, other_date: str = "") -> dict[str, Any]:
        if operation == "today":
            return {"today": TODAY.isoformat(), "weekday": TODAY.strftime("%A")}
        d = _parse_date(date)
        if operation == "add_working_days":
            out = _working_days(d, days)
            return {"date": out.isoformat(), "weekday": out.strftime("%A")}
        if operation == "days_between":
            return {"days": (_parse_date(other_date) - d).days}
        if operation == "weekday":
            return {"weekday": d.strftime("%A")}
        raise ValueError(f"unknown operation {operation!r}")

    def _search_policies(self, query: str) -> dict[str, Any]:
        words = {w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 2}
        scored = sorted(POLICIES.items(), key=lambda kv: -len(words & set(re.findall(r"[a-z]+", (kv[0] + " " + kv[1]).lower()))))
        return {"sections": [{"title": t, "text": body} for t, body in scored[:2]]}


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(f"{value!r} is not a date in YYYY-MM-DD form") from None


# ---------- the tasks, with their right answers ----------

def _amounts(text: str) -> list[float]:
    return [float(m.replace(",", "")) for m in re.findall(r"\d[\d,]*\.?\d*", text)]


def _has_amount(text: str, value: float) -> bool:
    return any(abs(a - value) < 0.006 for a in _amounts(text))


def _has_date(text: str, d: date) -> bool:
    t = text.lower()
    return d.isoformat() in t or re.search(rf"\b{d.day}(st|nd|rd|th)?\s+{d.strftime('%B').lower()}\b", t) is not None \
        or re.search(rf"\b{d.strftime('%B').lower()}\s+{d.day}\b", t) is not None


TASKS: list[dict[str, Any]] = [
    {"id": "basket", "level": "Easy", "title": "Price a basket",
     "prompt": "What do 3 Desk Lamps and 2 Office Chairs cost in total, before VAT?",
     "expected": "£401.50", "checks": ["Prices come from lookup_product, sums from the calculator."],
     "check": lambda a: (_has_amount(a, 401.50), "needs £401.50")},
    {"id": "order-vat", "level": "Easy", "title": "An order with VAT",
     "prompt": "What is the total of order N-1042 including 20% VAT?",
     "expected": "£523.20", "checks": ["Use the prices paid on the order.", "VAT is added once, at 20%."],
     "check": lambda a: (_has_amount(a, 523.20), "needs £523.20")},
    {"id": "stock", "level": "Medium", "title": "A tool fails first", "flaky": True,
     "prompt": "Can order N-1057 be sent in full from stock today? If not, which product is short and by how many "
               "units?",
     "expected": "No: Standing Desk, short by 2",
     "checks": ["Stock levels must come from stock_check, the live warehouse system.",
                "Name the product that is short and the number of units missing."],
     "check": lambda a: ("standing desk" in a.lower() and re.search(r"\b(2|two)\b", a.lower()) is not None,
                         "needs Standing Desk, short by 2")},
    {"id": "delivery", "level": "Medium", "title": "Working days",
     "prompt": "Order N-1057 is short of stock. The missing stock arrives from the supplier in 3 working days from "
               "today, the order is then dispatched in full the same day, and standard delivery takes 5 working "
               "days. On what date will it be delivered?",
     "expected": "Thursday 26 March 2026",
     "checks": ["Count working days (Monday to Friday) with the dates tool, starting from today's date."],
     "check": lambda a: (_has_date(a, date(2026, 3, 26)), "needs 26 March 2026")},
    {"id": "refund", "level": "Hard", "title": "A refund with a trap",
     "prompt": "A customer wants to return the Standing Desk from order N-1063 today. Can they get a refund under the "
               "returns policy, and how much?",
     "expected": "Yes, £289.00 (the price paid, not today's £319.00)",
     "checks": ["Follow the returns policy's wording exactly: check the time limit and which price is refunded.",
                "Every amount must come from a tool result."],
     "check": lambda a: (_has_amount(a, 289.00), "needs a refund of £289.00, the price paid")},
    {"id": "bulk", "level": "Hard", "title": "A bulk quote",
     "prompt": "Quote for 12 Office Chairs, 30 Desk Lamps and 8 Monitor Arms: apply the bulk discount policy, then "
               "delivery, then 20% VAT. What is the total?",
     "expected": "£3,663.24",
     "checks": ["Apply each policy as written: the discount per line, the delivery threshold, VAT on goods and "
                "delivery.", "Sums from the calculator."],
     "check": lambda a: (_has_amount(a, 3663.24), "needs £3,663.24")},
]
TASKS_BY_ID = {t["id"]: t for t in TASKS}


# ---------- the prompts ----------

WORLD = (f"You work for Northwind Supplies, an invented office furniture shop. Today is {TODAY.isoformat()} "
         f"({TODAY.strftime('%A')}). Use the tools for every fact and every sum; never guess a price, stock level, "
         "date or policy.")

SYSTEMS = {
    "tool_loop": WORLD + " Call tools as needed, without commentary, then call final_answer with a short answer "
                         "that states the figures.",
    "react": WORLD + " Work in the ReAct style. Before every tool call, write one or two sentences starting "
                     "'Thought:' saying what you know so far and what you need next. After each observation, think "
                     "again before the next action. Finish with final_answer, a short answer that states the figures.",
}

PLAN_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["steps"], "properties": {
    "steps": {"type": "array", "items": {"type": "string"}, "description": "short imperative steps, in order"}}}
PLANNER = WORLD + """ You are the planner. Write a short numbered plan (at most 7 steps) for the task. Each step does
one thing with one tool, or one calculation; put lookups that do not depend on each other in one step. The last
step works out the final figure. Do not do the steps.
Tools available: """ + ", ".join(t["name"] for t in TOOLS) + "."
REPLANNER = WORLD + """ You are the replanner. A step of the plan failed. Given the task, the steps done so far with
their results, and the failure, write the remaining steps (at most 6), starting with how to get past the failure (for
example, try a temporary failure once more, or get the fact another way). Do not repeat steps already done."""
EXECUTOR = WORLD + """ You are the executor. Do only the current step of the plan, using the tools, then call
step_result with what you found, including the figures. If a tool returns an error during this step, do not retry
it here: call step_result with ok false and the error, and the replanner will decide what to do. A step that says to
try a tool again is a new attempt: do it."""
SOLVER = WORLD + """ You are given a task and the results of each step of a plan. Write the final answer from those
results only: short, stating the figures. If the results are not enough, say what is missing."""
ANSWER_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["answer"],
                 "properties": {"answer": {"type": "string"}}}
CRITIC_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["verdict", "problems"], "properties": {
    "verdict": {"type": "string", "enum": ["pass", "revise"]},
    "problems": {"type": "array", "items": {"type": "string"}}}}
CRITIC = """You check an agent's work before it is given to a customer. You get the task, the task's checks, every
tool call the agent made with its result, and its answer. Check each claim against the tool results and the checks:
a figure not supported by a tool result, a policy applied differently from its wording, a sum done without the
calculator, a step skipped. Verdict "pass" only if nothing is wrong; otherwise "revise" with each problem in a
sentence. Do not work out the answer yourself."""


class StopPattern(Exception):
    """The pattern reached its step cap, the run's budget, or the page went away."""


class Pattern:
    """One pattern's run: its tools, its counters, and the events it publishes, tagged with its name."""

    def __init__(self, name: str, task: dict[str, Any], model: str, svc: "PlanningPatternsService", run: Run,
                 budget: "Budget"):
        self.name, self.task, self.model, self.svc, self.run, self.budget = name, task, model, svc, run, budget
        self.shop = Shop(flaky=bool(task.get("flaky")))
        self.calls = self.tool_calls = self.input_tokens = self.output_tokens = 0
        self.cost = 0.0
        self.trace: list[dict[str, Any]] = []  # tool calls and results, for the critic

    def emit(self, kind: str, **fields: Any) -> None:
        self.run.publish({"type": "step", "pattern": self.name, "kind": kind, **fields})

    def call(self, role: str, system: str, messages: list[dict], tools: list[dict] | None = None,
             schema: dict | None = None) -> Any:
        if self.run.cancelled.is_set():
            raise StopPattern("The page went away.")
        cap = MAX_STEPS_PLAN if self.name == "plan_execute" else MAX_STEPS
        if self.calls >= cap:
            raise StopPattern(f"Stopped at the step cap ({cap} model calls).")
        if self.budget.spent >= self.budget.cap:
            raise StopPattern(f"Stopped: the run reached its budget (${self.budget.cap:.2f}).")
        params: dict[str, Any] = {"model": self.model, "max_tokens": MAX_TOKENS, "system": system, "messages": messages}
        if tools:
            params["tools"] = tools
        if schema:
            params["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
        try:
            response = self.svc.claude.create(**params)
        except Exception as exc:
            raise to_api_error(exc) from exc
        cost = self.svc.spend.charge(response, self.model) or 0.0
        self.calls += 1
        self.cost += cost
        self.budget.add(cost)
        usage = response.usage
        self.input_tokens += getattr(usage, "input_tokens", 0) or 0
        self.output_tokens += getattr(usage, "output_tokens", 0) or 0
        self.emit("call", role=role, calls=self.calls, cost_usd=round(self.cost, 6),
                  tokens=self.input_tokens + self.output_tokens)
        return response

    def use_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        self.tool_calls += 1
        self.emit("action", tool=name, input=args)
        result = self.shop.run(name, args)
        self.trace.append({"tool": name, "input": args, "result": result})
        self.emit("observation", tool=name, result=result, ok="error" not in result)
        return result

    # ----- a tool-use loop, shared by the tool loop, ReAct and reflexion's attempts -----

    def loop(self, system: str, prompt: str, *, thoughts: bool) -> str:
        messages: list[dict] = [{"role": "user", "content": prompt}]
        while True:
            response = self.call("agent", system, messages, TOOLS + [FINAL])
            content, results, answer = [], [], None
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    content.append({"type": "text", "text": block.text})
                    self.emit("thought" if thoughts else "text", text=block.text.strip())
                elif block.type == "tool_use":
                    content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                    if block.name == "final_answer":
                        answer = str(block.input.get("answer", ""))
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": "Recorded."})
                    else:
                        if thoughts and not any(c["type"] == "text" for c in content[:-1]):
                            self.emit("note", text="Acted without writing a Thought first.")
                        out = self.use_tool(block.name, dict(block.input))
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": _json(out),
                                        **({"is_error": True} if "error" in out else {})})
            if answer is not None:
                return answer
            if not results:  # ended without final_answer: its text is the answer
                return text_of(response).strip()
            messages = messages + [{"role": "assistant", "content": content}, {"role": "user", "content": results}]

    # ----- the four patterns -----

    def tool_loop(self) -> str:
        return self.loop(SYSTEMS["tool_loop"], self.task["prompt"], thoughts=False)

    def react(self) -> str:
        return self.loop(SYSTEMS["react"], self.task["prompt"], thoughts=True)

    def plan_execute(self) -> str:
        plan = self._plan(PLANNER, f"Task: {self.task['prompt']}")
        self.emit("plan", steps=list(plan), revision=0)
        done: list[dict[str, Any]] = []
        replans = 0
        while plan:
            step = plan.pop(0)
            ok, result = self._execute(step, done, plan)
            done.append({"step": step, "ok": ok, "result": result})
            if not ok:
                if replans >= MAX_REPLANS:
                    self.emit("note", text=f"The step failed again after {MAX_REPLANS} replans; going on without it.")
                    continue
                replans += 1
                history = "\n".join(f"- {d['step']}: {'done' if d['ok'] else 'FAILED'}: {d['result']}" for d in done)
                plan = self._plan(REPLANNER, f"Task: {self.task['prompt']}\n\nSteps so far:\n{history}\n\n"
                                             f"Remaining plan before the failure:\n" + "\n".join(plan))
                self.emit("plan", steps=list(plan), revision=replans)
        results = "\n".join(f"{i}. {d['step']}: {d['result']}" for i, d in enumerate(done, 1))
        response = self.call("solver", SOLVER, [{"role": "user", "content":
                                                 f"Task: {self.task['prompt']}\n\nStep results:\n{results}"}],
                             schema=ANSWER_SCHEMA)
        return str(_parse_json(text_of(response)).get("answer", text_of(response))).strip()

    def _plan(self, system: str, prompt: str) -> list[str]:
        response = self.call("planner", system, [{"role": "user", "content": prompt}], schema=PLAN_SCHEMA)
        steps = [str(s).strip() for s in _parse_json(text_of(response)).get("steps", []) if str(s).strip()]
        return [re.sub(r"^\d+[.)]\s*", "", s) for s in steps[:7]]

    def _execute(self, step: str, done: list[dict[str, Any]], rest: list[str]) -> tuple[bool, str]:
        self.emit("step", text=step)
        so_far = "\n".join(f"- {d['step']}: {d['result']}" for d in done) or "(none yet)"
        messages: list[dict] = [{"role": "user", "content": f"Task: {self.task['prompt']}\n\nResults so far:\n{so_far}"
                                                            f"\n\nCurrent step: {step}"}]
        for _ in range(4):  # tool calls within one step
            response = self.call("executor", EXECUTOR, messages, TOOLS + [STEP_DONE])
            content, results, failed = [], [], False
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                    if block.name == "step_result":
                        ok, result = bool(block.input.get("ok")), str(block.input.get("result", ""))
                        self.emit("step_done", ok=ok, text=result)
                        return ok, result
                    out = self.use_tool(block.name, dict(block.input))
                    failed = failed or "error" in out
                    results.append({"type": "tool_result", "tool_use_id": block.id, "content": _json(out),
                                    **({"is_error": True} if "error" in out else {})})
            if not results:
                text = text_of(response).strip()
                self.emit("step_done", ok=not failed, text=text)
                return not failed, text
            messages = messages + [{"role": "assistant", "content": content}, {"role": "user", "content": results}]
        self.emit("step_done", ok=False, text="The step did not finish in 4 tool calls.")
        return False, "The step did not finish in 4 tool calls."

    def reflexion(self) -> str:
        answer = self.loop(SYSTEMS["react"], self.task["prompt"], thoughts=True)
        self.emit("attempt", text=answer, attempt=1)
        trace = "\n".join(f"- {t['tool']}({_json(t['input'])}) -> {_json(t['result'])}" for t in self.trace) or "(none)"
        checks = "\n".join(f"- {c}" for c in self.task["checks"])
        response = self.call("critic", CRITIC, [{"role": "user", "content":
                                                 f"Task: {self.task['prompt']}\n\nChecks:\n{checks}\n\nTool calls:\n"
                                                 f"{trace}\n\nAnswer: {answer}"}], schema=CRITIC_SCHEMA)
        verdict = _parse_json(text_of(response))
        problems = [str(p) for p in verdict.get("problems", [])]
        self.emit("critique", verdict=verdict.get("verdict", "pass"), problems=problems)
        if verdict.get("verdict") != "revise":
            return answer
        reflection = "\n".join(f"- {p}" for p in problems)
        return self.loop(SYSTEMS["react"], f"{self.task['prompt']}\n\nYour previous answer was: {answer}\n"
                                           f"A reviewer found these problems:\n{reflection}\n\nWork it out again, "
                                           "fixing them.", thoughts=True)


class Budget:
    """What the patterns of one run have spent together, against the run's cap."""

    def __init__(self, cap: float):
        self.cap, self.spent = cap, 0.0
        self._lock = threading.Lock()

    def add(self, cost: float) -> None:
        with self._lock:
            self.spent += cost


def _json(value: Any) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def _parse_json(text: str) -> dict[str, Any]:
    import json
    match = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        return {}


class PlanningPatternsService:
    def __init__(self, claude: ClaudeGateway, spend: SpendTracker, streamer: RunStreamer | None = None,
                 parallel: bool = True):
        self.claude, self.spend, self.streamer, self.parallel = claude, spend, streamer, parallel

    def info(self) -> dict[str, Any]:
        return {"tasks": [{k: t[k] for k in ("id", "level", "title", "prompt", "expected", "checks")} | {
                    "flaky": bool(t.get("flaky"))} for t in TASKS],
                "patterns": [{"id": p, "name": PATTERN_NAMES[p]} for p in PATTERNS],
                "tools": [{"name": t["name"], "description": t["description"]} for t in TOOLS],
                "policies": POLICIES, "today": TODAY.isoformat(), "max_steps": MAX_STEPS, "max_steps_plan": MAX_STEPS_PLAN,
                "products": [{"id": k, **v} for k, v in PRODUCTS.items()],
                "orders": [{"id": k, **v} for k, v in ORDERS.items()]}

    def _one(self, name: str, task: dict[str, Any], model: str, run: Run, budget: Budget) -> dict[str, Any]:
        p = Pattern(name, task, model, self, run, budget)
        started = time.perf_counter()
        answer, stopped = "", None
        p.emit("start")
        try:
            answer = getattr(p, name)()
        except StopPattern as exc:
            stopped = str(exc)
        except ApiError as exc:
            stopped = exc.message
        except Exception as exc:  # one pattern's failure must not end the others
            stopped = describe(exc)
        passed, detail = task["check"](answer) if answer else (False, "no answer")
        result = {"type": "result", "pattern": name, "answer": answer, "passed": bool(passed),
                  "detail": "" if passed else detail, "stopped": stopped, "model_calls": p.calls,
                  "tool_calls": p.tool_calls, "input_tokens": p.input_tokens, "output_tokens": p.output_tokens,
                  "seconds": round(time.perf_counter() - started, 2), "cost_usd": round(p.cost, 6)}
        run.publish(result)
        return result

    def run(self, task_id: str, patterns: list[str], model: str | None, budget_usd: float) -> Iterator[str]:
        if self.streamer is None:
            raise ApiError(503, "not_configured", "Streaming is not set up on this server.")
        task = TASKS_BY_ID.get(task_id)
        if not task:
            raise ApiError(404, "not_found", "No such task.")
        chosen = [p for p in PATTERNS if p in patterns]
        if not chosen:
            raise ApiError(400, "invalid_request", "Choose at least one pattern.")
        model = model or DEFAULT_MODEL
        run, budget = Run(), Budget(budget_usd)

        def work() -> None:
            run.publish({"type": "started", "task": task_id, "patterns": chosen, "model": model,
                         "budget_usd": budget_usd})
            if self.parallel and len(chosen) > 1:
                with ThreadPoolExecutor(max_workers=len(chosen)) as pool:
                    futures = [pool.submit(contextvars.copy_context().run, self._one, name, task, model, run, budget)
                               for name in chosen]
                    results = [f.result() for f in futures]
            else:
                results = [self._one(name, task, model, run, budget) for name in chosen]
            run.publish({"type": "done", "spent_usd": round(budget.spent, 6),
                         "passed": [r["pattern"] for r in results if r["passed"]]})

        return self.streamer.lines(run, work)
