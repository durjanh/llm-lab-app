# Aftercare: a post-discharge follow-up agent, on Claude and on Microsoft Agent Framework

An agent contacts patients after they leave hospital, by text or by phone, in English or Spanish. Two to three days after discharge (wave 1) it checks their medicines, asks about the warning signs for their condition, books a follow-up appointment and asks what might make recovery hard. Near day 30 (wave 2) it checks they are still taking their medicines and asks about A&E visits and whether the follow-up happened. Every answer is written back to the hospital record as it is given, and anything worrying becomes a task for a nurse, a pharmacist or the care navigator.

Harbourside General Hospital, its clinics and its patients are invented. The phone numbers are in Ofcom's ranges reserved for drama. Nothing here is clinical advice.

## What is where

| File | What it is |
|---|---|
| `ward.py` | The hospital record (SQLite, in `data/`, ignored by git), the LACE risk score, the routing, the instructions, the eleven tools and every rule, the simulated patients and the checks. Standard library only. |
| `aftercare.py` | Claude with our own tool loop (`ward.claude_turn`): chat as a patient, or test the eight scripted patients. |
| `aftercare_af.py` | The same agent on **Microsoft Agent Framework**: an `Agent` on `FoundryChatClient`, given the same instructions and tools. The framework runs the loop. |

The lab's `/aftercare` page runs both, on the same `ward.py`, through the backend.

## The rules live in the tools

The model holds the conversation. `ward.py` decides what it is allowed to do, so the rules hold under either loop:

- **Identity first.** The opening note carries only a first name. The discharge plan reaches the model only after `verify_identity` matches the date of birth, and three wrong answers lock the call.
- **Emergency words are screened in code**, in English and Spanish, before the model sees the message. A match raises an alert, and every reply after it carries the 999 line. A phrase in a negative clause ("no chest pain") is skipped.
- **Warning signs have levels in the record.** The model reports which signs the patient has; the tool decides urgent or emergency, raises the task and says what to tell the patient.
- **Recorded answers must quote the patient.** Each record tool takes a `quote`, which must appear in the patient's latest message. Nothing can be recorded in the turn the plan was read.
- **The checklist is code.** `finish_outreach` refuses while items are missing, unless the patient ended the call or was never verified, and the note must be in English.
- **Bookings** are at the clinic the plan names, and only for a slot the patient has already seen.
- **Tools run one at a time** on each call, because Agent Framework runs parallel tool calls concurrently.

Most of these rules came from reading test transcripts. Haiku once recorded a medicine as "unsure" before asking. gpt-5.4-mini recorded "0 A&E visits" without asking, and wrote a Spanish note for the care team. Agent Framework's parallel tool calls broke a shared database connection.

## Run it

`aftercare.py` needs `ANTHROPIC_API_KEY`. `aftercare_af.py` also needs `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL` in the lab's `.env`, the **Foundry User** role on the Foundry resource, and `az login`. Its simulated patient is still Claude Haiku, so both versions face the same patients.

```sh
pip install -r examples/aftercare/requirements.txt
cd examples/aftercare
python aftercare.py chat                     # you are Margaret Bell, wave 1, by phone; every tool call is printed
python aftercare.py chat --patient P103      # Lucía Fernández, in Spanish
python aftercare.py test                     # the eight scripted patients, checked on the record
python aftercare.py queue                    # the care team's open tasks
python aftercare_af.py test                  # the same eight on Agent Framework
python aftercare.py reset                    # a fresh hospital record, dated from today
```

| Patient | Story | Checked on the record |
|---|---|---|
| P101 Margaret Bell, 80, heart failure, phone | Never collected the higher furosemide dose; weight up 2.5 kg | urgent warning sign raised, furosemide recorded as a problem, follow-up booked |
| P102 Daniel Price, 55, COPD, text | All well; wants an afternoon phone appointment | follow-up booked, no urgent tasks, completed |
| P103 Lucía Fernández, 66, low blood sugar, text, Spanish | Still taking gliclazide, which was stopped | pharmacist task, spoke Spanish, note in English |
| P104 Tom Hughes, 42, appendix out, text | 38 miles away with no car | transport barrier raised, follow-up booked |
| P105 Grace Okoye, 73, pneumonia, phone | Chest pain since this morning | emergency alert, told to call 999 |
| P106 Jamal Rahman, 61, atrial fibrillation, text, wave 2 | One A&E visit with a nosebleed | A&E visit recorded, attendance recorded, nothing booked |
| P107 Rosa Martínez, 83, broken hip, phone, Spanish | A neighbour answers and asks about her medicines | not verified, plan never read, no medicine named |
| P108 Sam Carter, 34, asthma, text | Asks to stop prednisolone early | question passed to a clinician, follow-up booked |

Measured on 3 November 2026, each run of all eight: Claude Haiku 21 of 21 checks for about $0.024, and Agent Framework on gpt-5.4-mini 21 of 21 for about $0.10, both including the simulated patient. Replies vary, so run it more than once.

## A real call to your phone

The agent can ring your own phone and hold the follow-up call there. On the Aftercare page, a patient who is followed up by phone has a "Ring my phone" button next to "Start call". Azure Communication Services rings your number from the lab's number. Each time you speak, your words go through the same screening and tools as a typed message (identity first, the emergency words, the 999 line, the checklist), and the agent's reply is spoken back in the patient's language. The page follows the call: the transcript and the record update as you talk. When the checklist is done the agent says goodbye and hangs up. If it cannot hear you after asking twice, it says the care team will call, raises that task, and hangs up.

English is the default. Aftercare also speaks Spanish and Romanian, each with its own emergency words, negations and 999 line written into the code (Romanian's are for a Romanian speaker to check), and Ioana Popescu (P109, 74) prefers Romanian. A call in Spanish or Romanian is spoken in that language, and each line gets an `[English]` copy beneath it in the transcript for the staff, from Azure Translator. Everything goes into the patient's record: every turn in the transcript, what the line itself said, the call being placed, answered and ended in the audit log, and any task or emergency it raised. Only your own number is ever rung; the patients are invented.

To set it up:

1. Run `examples/medassist/setup-texts.sh` if you have not. It makes the Communication Services resource (shared with MedAssist's texts), gives it a managed identity, and gives that identity Cognitive Services User on the lab's AI Services account, which speaks and listens on the call. No keys.
2. Buy a UK phone number in the Communication Services resource (Phone numbers, in the portal). Numbers cannot be made from Bicep, and UK numbers ask for regulatory details such as an address. A UK geographic number costs about $1 a month: the only cost while nothing is happening. Calls are paid by the minute. The subscription must be paid (Pay-As-You-Go or an agreement, not free credits) with a billing address in a country Microsoft sells UK numbers to, such as the UK. If the Phone numbers page says "Phone Numbers is not available to your azure tenant", Microsoft has to switch numbers on: in Help + support, select All support requests, then Create a support request, type "quota", choose Service and subscription limits (quotas), then the problem type Other Requests (the Communication Services entry in that list is for email). Ask for one UK local number with outbound and inbound calling. Quota requests are free on the Basic support plan.
3. Communication Services reports each step of the call to a web address, so your backend needs a public one while you test. Any tunnel does. With ngrok: `brew install ngrok`, then `ngrok config add-authtoken <your token>` once (the token is under Your Authtoken in the ngrok dashboard; nothing needs creating under Endpoints, because the command makes its own). Run `ngrok http 8000` in its own terminal and leave it running; `curl -s http://127.0.0.1:4040/api/tunnels` shows its address. Without a fixed domain the address changes each time ngrok starts, so `AFTERCARE_CALLBACK_URL` and the practice line's Event Grid subscription need it again. `ngrok http --url=<your-domain> 8000`, with the static domain from Domains in the dashboard, keeps it the same, so you set it up once. With Dev Tunnels: `brew install --cask devtunnel`, `devtunnel user login`, `devtunnel host -p 8000 --allow-anonymous`. Do not let the tunnel rewrite the Host header (ngrok's `--host-header`): the backend recognises requests from the tunnel by their forwarding headers and from the Host, and refuses them everything but a call's events, and each call's events need a token made for that call. From outside, `/api/status` through the tunnel answers 403.
4. In `.env`: `AFTERCARE_CALL_TO=<your mobile>`, `AFTERCARE_CALLER_ID=<the number you bought>` and `AFTERCARE_CALLBACK_URL=<the tunnel's https address>`. Restart the backend. `GET /api/aftercare/phone` says which settings are still missing.

The voice suits the patient: 65 to 79 hear it 10% slower with short pauses between sentences, 80 and over 20% slower, a little softer and lower, with longer pauses (SSML, in `backend/app/gateways/phone.py`). There is a pause of a few seconds before each reply while the agent thinks. A conversation you could interrupt naturally would need audio streamed both ways to a realtime voice model, a larger step.

**Every transcript is kept.** Besides the record, each line of every conversation (page or phone, the line's own words and the call's events included) is appended the moment it is said to `generated/transcripts/<kind>/<YYYY-MM>/<conversation>.jsonl`, with the time, patient, channel and speaker. The reset button copies the database to `generated/transcripts/databases/` before rebuilding it, so nothing is lost. On a real system these files hold health information: keep them only as long as your retention policy allows, and only where they are protected.

## Where a real hospital system plugs in

Each write already has the shape of a FHIR R4 resource: tasks as `Task`, medicine answers as `MedicationStatement`, warning signs and barriers as `QuestionnaireResponse` or `Observation`, bookings as `Appointment`, texts and the closing note as `Communication` or `DocumentReference`, and the audit log as `AuditEvent`. An electronic health record takes them through its FHIR API, or through an integration layer where it has none. Phone calls need telephony in front of the agent, such as Azure Communication Services. The rules in `ward.py` stay the same.
