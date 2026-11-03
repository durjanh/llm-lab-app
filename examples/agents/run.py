"""Run the example agents: SalesDesk, ResearchDesk and DayPlanner, each a Microsoft Foundry prompt agent.

    python run.py sales create        # save the agent (and any documents) in your Foundry project
    python run.py sales chat          # talk to it; every tool call is shown
    python run.py sales test          # its checked cases, each on a fresh database
    python run.py sales test 2 4      # only cases 2 and 4
    python run.py sales records       # what is in its database now
    python run.py sales reset         # a fresh database
    python run.py sales delete        # remove it from Foundry
    python run.py all create|test|delete

Agents: sales, research, planner. Reads FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL from the lab's .env; sign in with
`az login`.
"""
from __future__ import annotations

import argparse

import agentkit
import planner_agent
import research_agent
import sales_agent

AGENTS = {"sales": sales_agent.SPEC, "research": research_agent.SPEC, "planner": planner_agent.SPEC}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("agent", choices=[*AGENTS, "all"])
    parser.add_argument("command", choices=["create", "chat", "test", "records", "reset", "delete"])
    parser.add_argument("cases", nargs="*", type=int, help="test only these case numbers")
    args = parser.parse_args()
    specs = list(AGENTS.values()) if args.agent == "all" else [AGENTS[args.agent]]
    if args.agent == "all" and args.command in ("chat", "records", "reset"):
        parser.error(f"{args.command} works on one agent at a time")
    totals = []
    for spec in specs:
        path = agentkit.DATA / f"{spec.key}.db"
        if args.command == "create":
            agentkit.create(spec)
        elif args.command == "chat":
            agentkit.chat(spec)
        elif args.command == "test":
            totals.append((spec.name, agentkit.test(spec, args.cases or None), len(args.cases or spec.tests)))
        elif args.command == "records":
            if not path.exists():
                spec.create_database(path)
            spec.records(path)
        elif args.command == "reset":
            spec.create_database(path)
            print(f"New database at {path}")
        elif args.command == "delete":
            agentkit.delete(spec)
    if len(totals) > 1:
        print("\n" + "\n".join(f"{name}: {passed} of {n}" for name, passed, n in totals))


if __name__ == "__main__":
    main()
