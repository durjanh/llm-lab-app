"""A simple reflex agent: fixed condition-action rules over an inbox, with no model and no memory.

Companion to the Agents & tools lab. Each email is checked against an ordered list of rules. The first rule whose
keywords appear decides the action. Nothing is remembered between emails and nothing is understood, so it is fast,
free and gives the same answer every time, and it fails in four predictable ways, each shown here:
- a keyword read without its meaning ("this is not urgent" fires the urgent rule),
- a follow-up it cannot place, because it has no memory of the earlier conversation,
- a reworded question that matches no rule,
- two rules that both match, where the order of the list decides.

Every email carries the action a person would choose, so the rules are scored. With --compare the same inbox goes to
a model (Claude by default), one email per call with a structured answer, and both are scored side by side with time and cost.

    python 20_reflex_agent.py                # rules only: costs nothing
    python 20_reflex_agent.py --compare      # the same inbox through a model as well
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass

from common import create, cost_usd, ensure_answered, make_client, model_argument, run, text_of

ACTIONS = [
    "auto_reply:opening_hours",
    "auto_reply:delivery",
    "auto_reply:password_help",
    "forward:billing",
    "escalate:on_call",
    "mark_spam",
    "unsubscribe",
    "leave_for_person",
]
TEMPLATES = {
    "auto_reply:opening_hours": "We are open 9:00 to 17:30, Monday to Saturday.",
    "auto_reply:delivery": "We deliver across the UK and Ireland. Orders arrive in 2 to 4 working days.",
    "auto_reply:password_help": "Use 'Forgot password' on the sign-in page. Check your spam folder for the link.",
}


@dataclass(frozen=True)
class Rule:
    name: str
    keywords: tuple[str, ...]  # any of these, in the subject or body, lower case
    action: str


# Order matters: the first rule that matches wins. Urgent sits above billing so a broken till is never queued.
RULES = [
    Rule("spam", ("winner", "claim your prize", "crypto giveaway"), "mark_spam"),
    Rule("urgent", ("urgent", "asap", "emergency"), "escalate:on_call"),
    Rule("billing", ("invoice", "refund", "payment"), "forward:billing"),
    Rule("unsubscribe", ("unsubscribe", "stop emailing"), "unsubscribe"),
    Rule("opening hours", ("opening hours", "what time do you open", "when are you open"), "auto_reply:opening_hours"),
    Rule("delivery", ("delivery", "shipping", "deliver to"), "auto_reply:delivery"),
    Rule("password", ("password", "can't sign in", "cannot sign in"), "auto_reply:password_help"),
]
DEFAULT_ACTION = "leave_for_person"  # what happens when no rule matches


@dataclass(frozen=True)
class Email:
    id: int
    sender: str
    subject: str
    body: str
    expected: str  # what a person would do
    lesson: str = ""  # why the rules get it wrong, when they do


INBOX = [
    Email(1, "jo.baker@mail.example", "Saturday", "Hi, what are your opening hours on Saturday? Thanks, Jo",
          "auto_reply:opening_hours"),
    Email(2, "accounts@northmill-supplies.example", "Invoice INV-2201",
          "Please find invoice INV-2201 for October attached. Payment is due in 30 days.", "forward:billing"),
    Email(3, "promo@lucky-draw.example", "You are a WINNER", "Claim your prize today. Reply with your bank details.",
          "mark_spam"),
    Email(4, "sam.ito@mail.example", "Newsletter", "Please unsubscribe me from the newsletter.", "unsubscribe"),
    Email(5, "leeds.shop@harbourgoods.example", "URGENT: card terminal down",
          "The card terminal at the Leeds shop stopped working ten minutes ago. Customers are queueing.",
          "escalate:on_call"),
    Email(6, "ana.lopez@mail.example", "Gift wrapping",
          "Quick question, and this is not urgent at all: do you gift wrap? I'm ordering for December.",
          "leave_for_person", "keyword without meaning: 'not urgent' still contains 'urgent'"),
    Email(7, "dev.shah@mail.example", "Re: the refund I asked about yesterday",
          "Any news? Your colleague Ruth said yesterday it would be sorted today.",
          "leave_for_person", "no memory: a follow-up to Ruth's promise, treated as a new billing request"),
    Email(8, "niamh.byrne@mail.example", "Orders to Dublin",
          "Do you post orders to Dublin, and how long does it take?",
          "auto_reply:delivery", "no rule: the delivery question is reworded, so no keyword matches"),
    Email(9, "li.wei@mail.example", "Payment failed, urgent",
          "My card payment failed twice on checkout. I need to pay today so the order ships. Can billing help?",
          "forward:billing", "rule order: urgent and billing both match, and urgent comes first"),
    Email(10, "tom.reid@mail.example", "Can't sign in",
          "I can't sign in. The password reset email never arrives.", "auto_reply:password_help"),
]


def matching_rules(email: Email) -> list[Rule]:
    """Every rule whose keywords appear in the email, in list order."""
    text = f"{email.subject}\n{email.body}".lower()
    return [rule for rule in RULES if any(word in text for word in rule.keywords)]


def decide(email: Email) -> tuple[str, str | None, list[str]]:
    """The reflex: (action, rule that fired or None, every rule that matched). Only the current email is looked at."""
    matches = matching_rules(email)
    if not matches:
        return DEFAULT_ACTION, None, []
    return matches[0].action, matches[0].name, [rule.name for rule in matches]


def outcome(email: Email, action: str, rule: str | None) -> str:
    """correct, misfired (a rule fired and chose wrong) or no rule (nothing matched and the email was wanted)."""
    if action == email.expected:
        return "correct"
    return "no rule" if rule is None else "misfired"


def score(outcomes: list[str]) -> dict[str, int]:
    return {kind: outcomes.count(kind) for kind in ("correct", "misfired", "no rule")}


SYSTEM = """You sort a small shop's customer inbox. Choose exactly one action for each email.
- auto_reply:opening_hours, auto_reply:delivery, auto_reply:password_help: the question is fully answered by that
  standard reply.
- forward:billing: invoices, payments, refunds and charges that need the billing team.
- escalate:on_call: something is broken right now and hurting customers or the shops.
- mark_spam: unsolicited, scams, phishing.
- unsubscribe: the sender asks to stop receiving emails.
- leave_for_person: anything else, including follow-ups to an earlier conversation with a named colleague."""

ANSWER_FORMAT = {"format": {"type": "json_schema", "schema": {
    "type": "object",
    "properties": {"action": {"type": "string", "enum": ACTIONS}, "reason": {"type": "string"}},
    "required": ["action", "reason"], "additionalProperties": False}}}


def ask_model(client, model: str, email: Email) -> tuple[str, str, float]:
    """One email, one call: the model's action, its reason and the estimated cost."""
    prompt = f"From: {email.sender}\nSubject: {email.subject}\n\n{email.body}"
    response = create(client, model=model, max_tokens=2000, system=SYSTEM, output_config=ANSWER_FORMAT,
                      messages=[{"role": "user", "content": prompt}])
    ensure_answered(response)
    answer = json.loads(text_of(response))
    return answer["action"], answer["reason"], cost_usd(response.usage, model) or 0.0


def mark(action: str, email: Email) -> str:
    """The action, with an x when a person would have chosen differently."""
    return action if action == email.expected else f"{action} x"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--compare", action="store_true", help="also send each email to the model and compare")
    model_argument(parser)
    args = parser.parse_args()

    print("Rules, in order (first match wins):")
    for i, rule in enumerate(RULES, 1):
        print(f"  {i}. {rule.name:<14} {', '.join(rule.keywords)!s:<55} -> {rule.action}")
    print(f"  no match       -> {DEFAULT_ACTION}\n")

    started = time.perf_counter()
    decisions = [decide(email) for email in INBOX]
    rules_ms = (time.perf_counter() - started) * 1000
    rule_outcomes = []
    for email, (action, rule, matched) in zip(INBOX, decisions):
        result = outcome(email, action, rule)
        rule_outcomes.append(result)
        print(f"#{email.id} {email.sender}\n   Subject: {email.subject}\n   {email.body}")
        fired = f"rule '{rule}'" + (f" (also matched: {', '.join(matched[1:])})" if len(matched) > 1 else "") \
            if rule else "no rule matched"
        print(f"   {fired} -> {action}" + (f"\n   Reply: {TEMPLATES[action]}" if action in TEMPLATES else ""))
        if result != "correct":
            print(f"   {result.upper()}: a person would choose {email.expected}. Why: {email.lesson}")
        print()

    totals = score(rule_outcomes)
    print(f"Rules: {totals['correct']} correct, {totals['misfired']} misfired, {totals['no rule']} matched no rule, "
          f"out of {len(INBOX)}. Time {rules_ms:.2f} ms. Cost $0. The same inbox gives the same answers every run.")
    if not args.compare:
        print("\nAdd --compare to send the same inbox to a model.")
        return

    client = make_client()
    print(f"\nThe same inbox through {args.model}, one call per email:\n")
    print(f"{'#':>3}  {'expected':<26} {'rules':<26} {'LLM':<26}")
    llm_outcomes, total_cost, started = [], 0.0, time.perf_counter()
    reasons = []
    for email, (rule_action, _, _) in zip(INBOX, decisions):
        action, reason, cost = ask_model(client, args.model, email)
        total_cost += cost
        llm_outcomes.append("correct" if action == email.expected else "misfired")
        reasons.append((email.id, reason))
        print(f"{email.id:>3}  {email.expected:<26} {mark(rule_action, email):<26} {mark(action, email):<26}")
    llm_s = time.perf_counter() - started
    print("\nThe model's reasons:")
    for email_id, reason in reasons:
        print(f"  #{email_id}: {reason}")
    llm_right = llm_outcomes.count("correct")
    print(f"\nRules:  {totals['correct']}/{len(INBOX)} correct · {rules_ms:.2f} ms · $0")
    print(f"LLM:    {llm_right}/{len(INBOX)} correct · {llm_s:.1f} s · ${total_cost:.4f}")
    print("Rules are fast, free and predictable but read words, not meaning. The LLM handles negation, rewording and "
          "follow-ups, costs money and time per email, and can answer differently on another run.")


if __name__ == "__main__":
    run(main)
