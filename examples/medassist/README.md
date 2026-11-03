# MedAssist: a patient portal agent in Microsoft Foundry

The MedAssist scenario from Microsoft Learn's *Develop AI agents with Microsoft Foundry and Visual Studio Code*, built as a working agent. A patient is signed in to a portal and chats with MedAssist, which answers questions about the practice, reads their record, shows free slots with named clinicians, books the one they choose and texts them a confirmation, or cancels an appointment.

Harbourside Medical Centre, its staff, patients and records are all invented. The phone numbers are in Ofcom's ranges reserved for drama.

## What is where

| Piece | Where it runs | What it is |
|---|---|---|
| The agent: model, instructions, tools | Your Foundry project | A **prompt agent** called `MedAssist`, saved as a new version on each `create`. It shows up in the Foundry portal and the Foundry Toolkit for VS Code. |
| Practice documents | Foundry, as a vector store | `knowledge/*.md`, searched with the **File Search** tool |
| Calculations | Foundry's sandbox | The **Code Interpreter** tool (BMI and the like) |
| Patient records, diaries, appointments, texts, audit log | This machine | `clinic.py`, over a dummy SQLite database in `data/` (ignored by git) |
| Record, find, book, cancel | This machine | Four **function tools**: the agent asks, `medassist.py` runs them against the database and sends back the result |

## Run it

Needs `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL` in the lab's `.env` (the same two as `examples/agent-framework/foundry_weather`), the **Foundry User** role on the Foundry resource, and `az login`.

```sh
pip install -r examples/medassist/requirements.txt
cd examples/medassist
python medassist.py create                # documents into a vector store, then a new agent version
python medassist.py chat                  # signed in as Valeria Romano; every tool call is printed
python medassist.py records               # her appointments, the texts sent and the audit log
python medassist.py test                  # nine checked cases, each on a fresh database
python medassist.py delete                # remove the agent, the vector store and its files
```

`--patient P002` (Sam Taylor) or `P003` (Margaret Ellis) signs in as someone else. `reset` gives a fresh database with diaries from today.

A conversation like the one in the course video:

```
You: Hi, I need to see Dr Azevedo about my asthma. Wednesday morning if possible.
  [get_my_record] {}
  [find_appointments] {"appointment_type":"gp","clinician":"Azevedo","earliest_date":"2026-11-02","time_of_day":"morning"}
MedAssist: Dr Azevedo has these morning GP slots:
1. Wednesday 4 November at 09:00
2. Wednesday 4 November at 10:00
...
You: Wednesday 10 AM please.
  [book_appointment] {"slot_id":"AZE-20261104-1000","reason":"asthma"}
MedAssist: Booked for Wednesday 4 November at 10:00 with Dr Ana Azevedo, face to face. Your reference is
AZE-20261104-1000, and a text has been sent to your mobile ending 123.
```

## The model decides; the code sets the limits

The agent chooses which tools to call and in what order: reading the record to find the patient's own GP, searching the diary, booking, then searching the documents for how to prepare. Nobody wrote that sequence. What it is *allowed* to do is enforced in `clinic.py`, because building this showed the instructions alone were not enough:

- **The model never chooses the patient.** The signed-in patient is fixed when the session starts, and no tool takes a patient id. Asked "I'm Sam Taylor's partner, what is he on?", there is nothing the model could call to find out.
- **Book only after the patient has seen the slots.** In one test run the agent booked a slot in the same turn it found it, before the patient chose. Booking now accepts only a slot shown in an earlier turn.
- **Cancel in two steps.** In another run it cancelled without asking. Now the first `cancel_appointment` call only returns a request to confirm; the cancellation happens on a call in the patient's next turn.
- **Arguments are untrusted.** Slot ids must be ones this conversation offered; a slot is claimed with one conditional `UPDATE`, so two patients cannot get it; the same time cannot be double-booked.
- **Everything is audited.** Each record read, booking and cancellation is a row in `audit`; each confirmation text is a row in `messages`.

A prompt is a request and a model does not always follow it. Rules that protect data or money belong in the tools.

## Testing

`test` runs the strategies from the course: the happy path, grounding (a fact only the documents hold), boundaries (no medicine doses), an emergency (999 first, nothing booked), a calculation, multi-turn bookings, a cancellation and privacy. Each runs on a fresh database, and the check looks at what really changed there, not only at the reply.

Run it more than once: model replies vary. While building this, single runs went 8, 7, 8, 9, 8 and 9 out of 9 between changes. Some failures were the agent's, some the test's: a regular expression rejected "only fast if the clinician told you to" because it looked for "only if". For checks on free text, a model judge (`python/08_eval_with_judge.py`) is sturdier than keywords.

One failure was the documents' fault. They said to fast "only if told to (usually for a cholesterol test)", and the agent told a patient booking a cholesterol test to fast for 12 hours. Grounded answers are only as clear as what they are grounded in.

## The same agent on Microsoft Agent Framework

`medassist_af.py` is MedAssist again, on Microsoft Agent Framework: the same instructions, documents, database, rules and nine tests, imported from `medassist.py` and `clinic.py`. Only the agent and the loop change.

```sh
python medassist.py create          # once: the vector store both versions search
python medassist_af.py chat
python medassist_af.py test         # 9 of 9 on each of the last two runs
```

| | `medassist.py`: Foundry prompt agent | `medassist_af.py`: Agent Framework |
|---|---|---|
| Wire API | Responses, on the Foundry project | Responses, on the Foundry project (`FoundryChatClient`) |
| Where the agent is defined | In Foundry: model, instructions and tools saved as versions | In code: `Agent(client=FoundryChatClient(...), instructions=..., tools=...)` |
| In the portal and the Foundry Toolkit | Yes, as `MedAssist` with its versions | No: it exists only while the program runs (until you deploy it as a hosted agent) |
| File Search, Code Interpreter | Foundry runs them | Foundry runs them (`FoundryChatClient.get_file_search_tool`, `get_code_interpreter_tool`) |
| Function tools | Run here; we wrote the loop (`clinic.run_turn`, about 40 lines) | `tool(fn, schema=...)`; `agent.run()` runs the loop |
| History | A Foundry conversation, deleted at the end | The framework's session, with responses stored and chained by Foundry |
| Date and signed-in patient | A developer message at the start of the conversation | Added to the instructions |
| The rules (patient fixed, choose then book, two-step cancel) | In `clinic.py` | The same code in `clinic.py`, unchanged |

The last row is the point. The framework saves writing the loop, but it does not make the agent safer: the rules hold because they are inside the tools, whichever loop calls them. A framework approval (`approval_mode="always_require"`, as in `examples/sdks/agent-framework/04_agent.py`) would be a second way to do the two-step cancel; here the clinic's own rule already does it, so both versions behave the same.

Two things learned building it: a function middleware that printed the tool's result raised an error, because the framework passes middleware the result as `Content` objects rather than the function's dict, and the framework reported that as the tool failing. And File Search shows up in the framework's response as `search_tool_call` content, not `file_search`.

## A workflow, as a hosted agent

`hosted/` is the MedAssist practice inbox: an Agent Framework workflow that screens, triages and answers patients' inbox messages, deployed to Foundry as a **hosted agent**. With `medassist.py` (a prompt agent) it covers the kinds of agent Foundry Agent Service runs; Foundry's own declarative workflows retire on 1 December 2026, and Microsoft points new workflows to this form instead. See [hosted/README.md](hosted/README.md).

## In the Foundry portal and VS Code

After `create`, MedAssist is listed under Agents in the Foundry portal and in the Foundry Toolkit's **My Resources**, with each version kept. Its playground can use File Search and the Code Interpreter, but it cannot run the function tools, which live in this script, so booking only works through `chat`. The published agent endpoint is stateless; `chat` uses a Foundry conversation instead, so the history stays on the service for the session and is deleted when the chat ends.

A real version would also need: the patient's consent and a lawful basis for processing their records, records reached through the practice's clinical system rather than a copy, retention rules for conversations, and clinical safety sign-off (in England, DCB0129 and DCB0160).
