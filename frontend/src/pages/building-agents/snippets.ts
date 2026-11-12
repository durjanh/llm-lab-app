/* The code on the page, as plain text from the repository (trimmed where marked), highlighted for CodeBlock. */
import { highlight } from '@/components/highlight';

export const request = highlight(`# examples/hotel/hotel.py: one request to the Messages API
client = make_client()            # python/common.py: Claude, GPT or the local model, by name
response = client.messages.create(
    model="claude-haiku-5-5",
    max_tokens=2000,
    system=system,                # the instructions
    tools=TOOLS,                  # JSON schemas: see the next section
    messages=chat.history,        # the whole conversation, every time
)`);

export const response = highlight(
  `{
  "stop_reason": "tool_use",
  "content": [
    {"type": "text", "text": "I'll check that for you."},
    {"type": "tool_use",
     "id": "toolu_…",
     "name": "check_availability",
     "input": {"check_in": "2026-11-12", "check_out": "2026-11-13", "adults": 2}}
  ],
  "usage": {"input_tokens": …, "output_tokens": …}
}`,
  'json',
);

export const toolSchema = highlight(`# examples/medassist/clinic.py
BOOK_APPOINTMENT = {
    "type": "function", "name": "book_appointment",
    "description": "Book a slot that find_appointments offered, for the signed-in patient, once they have chosen it. "
                   "Texts them a confirmation.",
    "parameters": {
        "type": "object",
        "properties": {"slot_id": {"type": "string"},
                       "reason": {"type": "string", "description": "a few words, in the patient's own words"}},
        "required": ["slot_id", "reason"], "additionalProperties": False,
    },
    "strict": True,
}`);

export const loopClaude = highlight(`# examples/hotel/hotel.py: claude_turn (trimmed)
chat.history.append({"role": "user", "content": [{"type": "text", "text": text}]})
for _ in range(max_rounds):
    response = create(model=model, max_tokens=2000, system=system, tools=TOOLS, messages=chat.history)
    chat.history.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in response.content]})
    uses = [b for b in response.content if b.type == "tool_use"]
    if not uses:                                            # no tool call: this is the answer
        return "".join(b.text for b in response.content if b.type == "text"), steps
    results = []
    for b in uses:
        result = chat.call(b.name, dict(b.input))          # our Python method: the rules live there
        results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(result),
                        **({"is_error": True} if "error" in result else {})})
    chat.history.append({"role": "user", "content": results})
return "(The agent stopped: too many tool calls in one turn.)", steps`);

export const loopHarness = highlight(`# python/11_harness_loop.py: run_agent (trimmed)
for turn in range(1, agent.max_turns + 1):
    self.check_running()                                    # the stop button and the budget
    resp = create(self.client, model=self.model, max_tokens=16000, system=agent.prompt,
                  tools=definitions, messages=messages, output_config={"effort": self.effort})
    cost = self.record(agent.name, resp)                    # every response priced
    messages.append({"role": "assistant", "content": resp.content})
    ensure_answered(resp)                                   # a refusal or max_tokens stops here
    if resp.stop_reason == "pause_turn":                    # a server tool paused; send the turn back
        continue
    calls = [b for b in resp.content if b.type == "tool_use"]
    if resp.stop_reason != "tool_use" or not calls:
        return with_sources(resp)
    messages.append({"role": "user", "content": self.execute(calls, tools, who, depth)})
    grown = resp.usage.input_tokens - start_tokens
    if self.compact_at and grown >= self.compact_at and len(messages) > 3:
        messages = self.compact(agent, task, messages, who, depth, resp.usage.input_tokens)`);

export const loopFramework = highlight(`# examples/medassist/medassist_af.py (trimmed)
tools = [FoundryChatClient.get_file_search_tool(vector_store_ids=[store_id]),
         FoundryChatClient.get_code_interpreter_tool()]
# The same names, descriptions and JSON schemas the prompt agent has; the function is the clinic's method.
tools += [tool(function(t["name"]), name=t["name"], description=t["description"], schema=t["parameters"])
          for t in clinic.FUNCTION_TOOLS]
client = FoundryChatClient(project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"], model=os.environ["FOUNDRY_MODEL"],
                           credential=DefaultAzureCredential(),
                           function_invocation_configuration={"max_iterations": MAX_ITERATIONS})
agent = Agent(client=client, name=name, instructions=..., tools=tools,
              middleware=[NewTurn(session), TidyStream()])

response = await agent.run(text, session=af_session)       # the loop is inside this call`);

export const loopFoundry = highlight(`# examples/medassist/clinic.py: run_turn (trimmed), on Foundry's Responses API
session.turn += 1                                           # the tools' rules count turns
response = respond(text)
for _ in range(max_rounds):
    outputs = []
    for item in response.output:
        if item.type == "function_call":                    # Responses API: function_call, not tool_use
            args = json.loads(item.arguments)
            result = session.call(item.name, args)
            outputs.append({"type": "function_call_output", "call_id": item.call_id,
                            "output": json.dumps(result)})
    if not outputs:
        return reply_text(response), steps
    response = respond(outputs)
return "(MedAssist stopped: too many tool calls in one turn.)", steps`);

export const rules = highlight(`# examples/medassist/clinic.py: Session (trimmed)
def book_appointment(self, slot_id: str, reason: str) -> dict:
    if slot_id not in self.offered:
        return {"error": "Book only a slot that find_appointments offered in this conversation."}
    if self.offered[slot_id] == self.turn:
        return {"error": "Not booked: the patient has not seen these slots yet. Show them as a numbered list "
                         "and book the one the patient chooses."}
    claimed = self.db.execute(  # claims the slot only if it is still free, in one statement
        "UPDATE slots SET patient_id = ?, reason = ?, booked_at = ? WHERE id = ? AND patient_id IS NULL",
        (self.patient_id, reason[:200], datetime.now().isoformat(timespec="seconds"), slot_id)).rowcount
    if not claimed:
        return {"error": "Someone else has just booked that slot. Find another."}
    ...

def cancel_appointment(self, appointment_id: str) -> dict:
    ...
    if self.cancelling.get(appointment_id, self.turn) == self.turn:   # first call: ask, do nothing
        self.cancelling[appointment_id] = self.turn
        return {"cancelled": False, "confirm_first": "Ask the patient to confirm cancelling ..."}
    self.db.execute("UPDATE slots SET patient_id = NULL, reason = NULL, booked_at = NULL WHERE id = ?",
                    (appointment_id,))`);

export const testCase = highlight(`# examples/medassist/medassist.py: one of nine live cases
("Booking: own GP, slots shown, the chosen one booked and texted",
 ["I'd like to see my own doctor next week, in the morning if possible.",
  "The second one, please. It's about my asthma getting worse at night."],
 lambda reply, turns, s: "get_my_record" in turns[0] and "find_appointments" in turns[0]
 and len(booked_by(s, "AZE")) == 1 and texts(s) == 1 and "Azevedo" in reply),`);

export const testCommands = highlight(
  `cd examples/medassist
python medassist.py test        # nine live cases on Foundry, each on a fresh database
python medassist_af.py test     # the same cases on Agent Framework
cd ../.. && pytest backend      # offline, with fakes for Foundry and Azure: no key, no cost`,
  'shell',
);
