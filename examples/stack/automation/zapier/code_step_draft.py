# "Code by Zapier" (Run Python), step 4 of the Zap, inside Path C: draft a short reply with Claude.
# Input data fields: api_key, model, from, subject, body.
system = (
    "You write short, polite customer replies, three sentences at most, in plain British English. "
    "Use only the facts in the email and the FAQ. Do not invent policies. "
    "FAQ: Annual leave: you can carry up to 5 unused days into the next year; the rest are lost on 31 March."
)
text = "From: %s\nSubject: %s\n\n%s" % (input_data["from"], input_data["subject"], input_data["body"])
reply = requests.post(
    "https://api.anthropic.com/v1/messages",
    headers={"x-api-key": input_data["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
    json={"model": input_data.get("model", "claude-haiku-5-5"), "max_tokens": 150, "thinking": {"type": "disabled"},
          "system": system, "messages": [{"role": "user", "content": text}]},
    timeout=30,
)
reply.raise_for_status()
output = {"reply": "".join(b.get("text", "") for b in reply.json()["content"] if b["type"] == "text").strip()}
