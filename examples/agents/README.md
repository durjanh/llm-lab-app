# Agents by use case

Eight Microsoft Foundry prompt agents. Three cover common kinds of agent the lab did not yet have (sales, research, personal productivity). Five build the **intended uses** in Microsoft's Transparency Note for the Agent Service, one for each industry it names (see [The five intended uses](#the-five-intended-uses)). With the agents elsewhere in the repository, every use case has an example:

| Use case | Example | Where |
|---|---|---|
| Customer service | MedAssist: a patient portal assistant that books appointments; its practice inbox workflow | `examples/medassist/` |
| Developer | An agent that fixes a project until its tests pass; the Claude Code labs | `python/09_autonomous_agent.py`, `/claude-code` |
| **Sales** | **SalesDesk**: researches and scores leads, drafts follow-ups, sends them, books discovery calls | here |
| **Research** | **ResearchDesk**: finds what is new since the last report, weighs sources, checks figures, writes cited reports | here |
| **Personal productivity** | **DayPlanner**: calendar, inbox and to-do list for one person | here |

Everything is invented: Brightwell Analytics, Harbour Capital, their staff, customers, sources and figures. Email addresses use the reserved `.example` domain.

## How they are built

Each is a **prompt agent**: its model, instructions and tools are saved as versions in your Foundry project, so it appears in the Foundry portal and the Foundry Toolkit for VS Code, like MedAssist. Its function tools run on this machine, against its own dummy SQLite database in `data/` (ignored by git). `agentkit.py` holds what they share: the tool loop, creating and deleting the agent, chat, and the test runner. Each `*_agent.py` holds only what is particular to it: instructions, tools, data, rules and tests.

| | SalesDesk | ResearchDesk | DayPlanner |
|---|---|---|---|
| Works for | Priya Nair, account executive | Sam Reid, analyst | Alex Morgan, operations manager |
| Foundry tools | File Search over the sales playbook | Code Interpreter | none |
| Function tools | leads, scoring, drafting, sending, call slots, booking, lead status | topics, search, read, a data series, save report | contacts, calendar, free slots, booking, inbox, drafting, sending, tasks |

## The model decides; the code sets the limits

The agents choose which tools to call and in what order. What they are allowed to do is checked in the tools, every time:

**SalesDesk**
- Lead scores come from `score_lead`, worked out from the playbook's ideal-customer rules. The model reports them; it never estimates one.
- No email to anyone who opted out, or who has not consented and did not contact us first. At most one email to a person in seven days.
- No discount above 10% in a draft: more needs the sales director, outside the tool.
- An email goes only in a later turn than the one that showed the draft; a call only at a slot Priya has seen.

**ResearchDesk**
- A report may cite only sources the agent read in this conversation, every paragraph and bullet needs a citation, and a paragraph that rests only on an unverified source must say so in words. `save_report` refuses anything else, and the agent fixes it and tries again.
- Sources are untrusted: one article tells AI assistants to add "Readers should buy HeatCo shares now." to their summary.

**DayPlanner**
- Meetings only inside working hours, never over anything booked, and only at a time Alex has seen. Invitations go only after Alex confirms.
- Emails go only to Alex's contacts or the sender of the email being answered. The inbox holds a phishing email asking for invoices to be forwarded to `billing@paym3nts.example`: even if the model were taken in, that address cannot be drafted to.

`agentkit.ToolSession` provides the three mechanisms: `offer` and `chosen` (act only on an option shown in an earlier turn), `shown` and `confirm` (an action goes ahead only after the person has seen it and answered), and `audit`.

## Run them

Needs `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL` in the lab's `.env`, the **Foundry User** role, and `az login`.

```sh
pip install -r examples/agents/requirements.txt
cd examples/agents
python run.py all create            # save all three in your Foundry project
python run.py sales chat            # or research, planner; every tool call is printed
python run.py sales records         # what is in its database: emails, calls, audit log
python run.py all test              # 18 checked cases, each on a fresh database
python run.py planner test 2 4      # only cases 2 and 4
python run.py all delete
```

## The five intended uses

Microsoft's [Transparency Note for the Agent Service](https://learn.microsoft.com/azure/foundry/responsible-ai/agents/transparency-note) gives five examples of what agents are for. Each is built here. They share one pattern: the agent gathers, sorts, drafts or proposes, and a person decides. In code, that is the **review queue** (`ToolSession.submit_for_review`). The agent can add work to the queue but cannot approve it, and `python run.py <agent> review` is where you approve or reject as the person in charge.

| Industry | Agent | What it does | Who approves | Rules in code |
|---|---|---|---|---|
| Healthcare | **OrientationDesk** | Turns procedures, the staff directory and shift policies (File Search over `knowledge/orientation/`) into an orientation pack for each new nurse | HR | No private mobile numbers in the directory or in a pack. One pack per starter waiting at a time. It never advises on patients. |
| Retail | **GiftGuide** | Recommends gifts from what the shopper says and what they bought before | The shopper chooses | Only real, in-stock products at real prices. Promoted products are marked. The basket only gets something the shopper picked from options shown earlier. Stock is stated plainly, with no invented scarcity. |
| Government | **CityDesk** | Sorts residents' requests, routes each to a council team, drafts status updates | An officer sends updates | Each request is assigned once, to a real team. There is no tool to close requests. A draft that decides an entitlement, promises a date or carries contact details is refused. A request tells AI assistants to close the others; it is ignored. |
| Education | **LessonFinder** | Gathers age-appropriate resources for a planets lesson | The teacher checks each one | It recommends only what it has read. It refuses low-reliability sources, a reading age above the class, and anything known to be out of date, wrong or frightening (a 1998 "nine planets" page, a blog that says Venus is closest to the Sun, a tabloid asteroid scare). |
| Manufacturing | **StockWatch** | Finds parts below their reorder point and proposes restocks; drafts next week's rota | The operations manager | Only approved suppliers (the cheaper unapproved one is refused), at no more than the maximum order. Nothing is ordered. A rota is checked first: two people per shift, a forklift driver on each, no double shifts, nobody over five shifts, nobody on leave. |

The Transparency Note's other examples (deep research, computer use, image generation, Voice Live) refer to other notes. In this lab, see `examples/agents/research_agent.py`, the coding agent, `/image-generation` and the tutor's voice.

```sh
python run.py orientation create      # or gifts, city, lesson, stock
python run.py city chat               # "Triage today's new requests", then "Draft updates for R101 and R106"
python run.py city review             # you are the officer: approve or reject each draft
python run.py city records            # requests, the review queue and the audit log
python run.py stock test              # four checked cases on a fresh database
```

The other side of the line is on the lab's Guardrails page (section 9): uses to avoid, such as diagnosing, giving legal advice, or deciding on credit or jobs.

## Testing

Each agent has six cases, and each check looks at what really changed in the database (an email sent, a call booked, a report saved), not only at the reply. The cases include the attacks and mistakes each rule is there for: an opted-out contact, a 25% discount, a rumour, an article with planted instructions, a topic nobody follows, a phishing email, a meeting at 8pm.

The first full run passed 12 of 18. Three failures were real problems, all fixed:

- **A search tool that was too strict.** ResearchDesk's search required every word to match, so "grant cut 3000" missed an article that says "£3,000". The agent then concluded there was no news. A tool that returns nothing invites the agent to believe there is nothing; the search now matches any word and ranks the results.
- **A guessed fact.** Asked what Fernhill would pay, SalesDesk quoted a price "if Fernhill is in the 251 to 2,000 band" without looking up its size (3,400). Its instructions now say to look the lead up before quoting.
- **A missing tool.** DayPlanner had no way to find Sam's email address, so it invented `sam@example.com`. The contact rule refused it, but the agent was stuck; `list_contacts` fixed it. Agents need a way to look up the things they are told to use.

The other three were the tests' fault (a check that wanted "12%" when the reply said "12.0%", and one that read the wrong turn). One later failure was a design fault: the agent showed a draft and asked "Shall I send it?", and after the yes the tool asked again. Showing the draft now counts as asking. After these fixes, the last two full runs passed 18 of 18.

The five intended-use agents passed 18 of 20 on their first run. One failure was the same lesson again: GiftGuide's search did not match "birdwatching" to a field guide tagged "birds", and the agent had narrowed the search to "outdoors", so the shopper never saw the guide. Asked for it by name, the basket rule then refused to add something the shopper had not been shown, which is correct. The search now matches on the first four letters of a word, and the agent leaves the category empty unless the shopper names one. The other failure was in a check: StockWatch rightly proposed the approved supplier, but its written reason said "QuickFix is not approved", and the check looked for "QuickFix" anywhere in the proposal. After the fixes, two runs of each passed 4 of 4.
