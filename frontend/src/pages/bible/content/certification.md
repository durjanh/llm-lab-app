## Claude Certified Architect – Foundations Exam Map (`/claude-architect`)
**In one line:** Anthropic's architect exam guide, task by task, each linked to the lab page that practises it and marked honestly as runs here, partly, explained or not yet.

**Key terms**
- **Domain**: one of the exam's five weighted areas: agentic architecture, tool design and MCP, Claude Code configuration, prompt engineering and structured output, and context management and reliability.
- **Task statement**: one of the 30 skills the guide says it tests, such as "design escalation rules" or "configure CLAUDE.md for a team".
- **Scenario**: one of six worked situations (a support agent, a coding workflow, a research team, Claude Code in CI, developer productivity, structured extraction). Four are drawn for each sitting.
- **Format**: 60 questions in 120 minutes, scored out of 1,000, with 720 to pass.

**Questions they could ask**
- **Q:** How did you check the lab covers the exam rather than just the topics you liked?
  **A:** I worked from the published guide, not memory. Every one of the 30 task statements is a row, linked to the page that practises it, and marked with what is really there. "Partly" names what is missing. That made the gaps visible, so I built the scenario labs, such as the support desk, research team, extraction and review passes, to close them.
- **Q:** Which part of the exam is the least obvious?
  **A:** Claude Code configuration: where instructions live (user, project, folder rules), when to use plan mode, and how commands and skills are shared. It is configuration rather than code, so it is easy to underestimate. The Claude Code pages now cover it section by section.
- **Q:** Why are the three Claude exam maps one component?
  **A:** They have the same shape (domains, weights, objectives, links, status), so one component keeps them consistent and lets them link to each other. Only the data differs.

**What I built:** `pages/claude-architect/examMap.tsx` renders the format, domain weights, scenarios, all 30 task statements with filters by status, the guide's preparation exercises, and the topics the lab covers beyond the exam. The Associate, Developer and Professional maps reuse it.

## Claude Certified Associate Exam Map (`/claude-associate`)
**In one line:** the exam for people who use Claude in the apps, not code: all 30 objectives across seven domains, each linked to where it is shown.

**Key terms**
- **Projects**: a workspace in claude.ai with its own instructions and files, kept across chats.
- **Artifacts**: content Claude makes in its own pane, such as a document, a page or a chart, that can be edited and shared.
- **Research**: Claude searching many sources and writing a cited report.
- **Connectors**: links to tools such as Google Drive or Slack, so Claude can read and act on them.

**Questions they could ask**
- **Q:** How can a coding lab help with an exam for non-developers?
  **A:** Most objectives are about judgement: which feature fits a job, which model fits a task, how to check an answer and when not to use AI. The Claude at work page practises those with live tools. Objectives that only exist inside claude.ai, such as Projects and connectors, are marked as practised there, not pretended.
- **Q:** What is the most common mistake people make with Claude at work?
  **A:** Trusting a fluent answer without checking it against the source. The page's checker sorts each claim into supported, contradicted or unverifiable, and the review verdict can only be raised by code, never lowered.

**What I built:** a static exam map on the shared component, with links into `/claude-at-work`, `/prompting` and the safety pages.

## Claude Certified Developer Exam Map (`/claude-developer`)
**In one line:** the developer exam's eight domains and 25 weighted skills, each linked to the labs that run it.

**Key terms**
- **Applications and integration**: a third of the exam: calling the API, tools, streaming, errors and retries.
- **Weighted skill**: a skill with its share of the questions, so preparation can follow the weights.
- **Format**: 53 questions in 120 minutes, 720 to pass.

**Questions they could ask**
- **Q:** How is this exam different from the architect one?
  **A:** The developer exam is about building correct calls: the Messages API, tool use, structured output, streaming, prompt caching and handling errors. The architect exam is about choosing and combining those pieces safely at scale. Claude Code is only 3% of the developer exam.
- **Q:** What would you study first?
  **A:** Applications and integration, because it is the biggest weight: the request and response shapes, tool loops driven by `stop_reason`, and retries for 429 and 529. The Live Claude, Agents and Building agents pages run all of it.

**What I built:** the exam map on the shared component, from Anthropic's guide (version 1.0, July 2026).

## Claude Certified Architect – Professional Exam Map (`/claude-professional`)
**In one line:** the senior architect exam: solution design, integration, governance, compliance, stakeholders and the life cycle, 38 objectives across seven domains.

**Key terms**
- **Governance**: who may build and run AI systems, how they are reviewed, and how decisions are recorded.
- **Architecture decision record (ADR)**: a short note of a decision, its context, the options and why one was chosen.
- **Life cycle**: discovery, design, build, evaluate, release, monitor and retire.

**Questions they could ask**
- **Q:** What does the professional level add?
  **A:** Working with an organisation, not just code: understanding the business need, choosing the pattern, proving value, meeting compliance rules such as GDPR and HIPAA, and keeping the system healthy after release. The Delivery and governance page is the worked example, using MedAssist.

**What I built:** the exam map on the shared component, linking to `/delivery`, `/observability`, `/guardrails` and the Azure pages.

## Claude at Work (`/claude-at-work`)
**In one line:** the practical side of the Associate exam: which Claude feature fits which job, and live tools for writing prompts, rewriting for an audience, checking answers and deciding whether a task is a good use.

**Key terms**
- **Feature fit**: chat for a quick question, a Project for ongoing work with shared files, an Artifact for something to edit or share, Research for a cited report, connectors to reach other tools.
- **Model fit**: Haiku for fast, simple, high-volume work, Sonnet for most work, Opus for the hardest reasoning.
- **Source check**: sorting each claim in an answer into supported, contradicted or unverifiable against the source.
- **Escalation**: handing a task to a person when it involves sensitive data, a high-stakes decision or unclear rules.

**Questions they could ask**
- **Q:** How would you teach a team to use Claude well?
  **A:** Start from their tasks, not the features. For each kind of task, a prompt template with the goal, context, format and constraints; then the habit of checking answers against the source, and clear rules for what must not go in. The page's tools do each of those live.
- **Q:** Why can code raise the review verdict but never lower it?
  **A:** The model might call a risky answer safe. Code checks things it can be sure of, such as a contradicted claim or a figure missing from the source, and when it finds one it raises the verdict to "needs review". It never makes a verdict more lenient, so a mistake in the model's judgement cannot hide a problem code found.
- **Q:** Is every task a good use of AI?
  **A:** No. The page's checker gives a verdict, names data issues (personal or confidential data), offers a redacted description of the task, and says when to escalate instead.

**What I built:** static sections with sources and a check date, and five paid tools on the backend: a prompt template per task type, one answer rewritten for two or three audiences, a source checker, and a "good use?" verdict.

## AI Tech Stack Map (`/ai-stack`)
**In one line:** all 89 tools from a widely shared AI tech stack chart, each marked as on a lab page, running as an example, waiting for an account, or explained, with the result of its run.

**Key terms**
- **Area**: models, agent frameworks, RAG, embeddings, MCP servers, AI security, observability, memory, agent SDKs, automation and vector databases.
- **Same task, same data**: every tool in an area does the same job on the same invented handbook and 12 gold questions, so results compare.
- **SKIP**: a tool that needs an account says what to set instead of failing.

**Questions they could ask**
- **Q:** How do you choose between so many frameworks?
  **A:** By running them on the same task. In `examples/sdks/`, sixteen SDKs do the same five tasks (structured output, tools, MCP, an agent with human approval, multi-agent), each in its own environment, and a cheatsheet compares them. The differences are mostly in how much they hide, not in what they can do.
- **Q:** Why does each example have its own environment?
  **A:** The SDKs pin conflicting packages. One environment each, with a runner that writes `RESULTS.md`, keeps them independent and repeatable.

**What I built:** `examples/stack/` (one folder per tool, `CONVENTIONS.md` as the contract, `run_all.py`) and the static page that maps the chart to it.

## AB-100 Exam Map (`/ab-100`)
**In one line:** Microsoft's Agentic AI Business Solutions Architect exam: all 74 skills in the study guide, each linked to the labs or marked as practised in Copilot Studio, Microsoft 365 Copilot, Dynamics 365 or Power Platform.

**Key terms**
- **Agentic business solution**: agents built into business processes, in Microsoft's low-code tools or with Microsoft Foundry.
- **Copilot Studio**: Microsoft's low-code tool for building agents.

**Questions they could ask**
- **Q:** How does this differ from AI-103?
  **A:** AI-103 is about building with Azure AI services and Foundry in code. AB-100 is about designing agent solutions for a business, often in low-code tools, so many of its skills are practised in those products rather than in this lab. The map says which.

**What I built:** a static exam map from the study guide (skills measured as of 16 November 2026).

## GenAI Engineering Roadmap (`/roadmap`)
**In one line:** what to learn, in three levels (beginner, intermediate, advanced), each topic linked to the lab pages that explain or build it.

**Questions they could ask**
- **Q:** Where should someone new to building with LLMs start?
  **A:** With how a model picks the next token and what a token costs, then prompting and structured output, then retrieval, then tools and agents. Evaluation comes earlier than most people think: without a way to measure, every later change is guesswork.

**What I built:** a static page; each topic links to the lab pages.
