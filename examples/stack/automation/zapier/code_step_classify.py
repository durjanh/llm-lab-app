# "Code by Zapier" (Run Python), step 2 of the Zap: classify one email and pick the branch for Paths.
# Input data fields (set in the step): api_key, model, from, subject, body.
# Zapier gives this code `input_data` (a dict of strings) and `requests`, and reads the `output` dict afterwards.
import json
import re

system = (
    "You triage customer emails. Reply with JSON only, no other text: "
    '{"category": "emergency|refund|question|complaint|spam", "urgency": "high|normal|low"}. '
    "urgency is high only when someone's health or safety is at risk (for example no heating with a baby). "
    "Refunds, ordinary questions and complaints about service are normal or low. Spam is low."
)
text = "From: %s\nSubject: %s\n\n%s" % (input_data["from"], input_data["subject"], input_data["body"])
reply = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers={"x-api-key": input_data["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
    json={"model": input_data.get("model", "claude-haiku-5-5"), "max_tokens": 200, "thinking": {"type": "disabled"},
          "system": system, "messages": [{"role": "user", "content": text}]},
    timeout=30,
)
reply.raise_for_status()
answer = "".join(b.get("text", "") for b in reply.json()["content"] if b["type"] == "text")
found = re.search(r"\{.*?\}", answer, re.S)
c = json.loads(found.group(0)) if found else {}
category, urgency = str(c.get("category", "")).lower(), str(c.get("urgency", "")).lower()
# Paths reads this: "drop" ends the Zap, "escalate" posts to the on-call webhook, "reply" goes on to step 4.
route = "drop" if category == "spam" else "escalate" if urgency == "high" else "reply"
output = {"category": category, "urgency": urgency, "route": route}
