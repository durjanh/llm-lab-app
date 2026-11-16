// Pipedream Node.js code step 1 of the workflow "Email triage" (trigger: HTTP / Webhook, "Return a custom response").
// Paste it into a Node.js code step, or publish it as a component. The key is a Pipedream project environment
// variable (ANTHROPIC_API_KEY), read at run time. The step receives {emails: [...]} from the trigger.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.STACK_CLAUDE_MODEL || "claude-haiku-5-5";
const CLASSIFY_SYSTEM = "You triage customer emails. Reply with JSON only, no other text: {\"category\": \"emergency|refund|question|complaint|spam\", \"urgency\": \"high|normal|low\"}. urgency is high only when someone's health or safety is at risk (for example no heating with a baby). Refunds, ordinary questions and complaints about service are normal or low. Spam is low.";
const REPLY_SYSTEM = "You write short, polite customer replies, three sentences at most, in plain British English. Use only the facts in the email and the FAQ. Do not invent policies. FAQ: Annual leave: you can carry up to 5 unused days into the next year; the rest are lost on 31 March.";

const emailText = (e) => `From: ${e.from}\nSubject: ${e.subject}\n\n${e.body}`;

export default {
  name: "Triage emails",
  version: "0.0.1",
  type: "action",
  async run({ steps, $ }) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const ask = async (system, user, max_tokens) => {
      const reply = await client.messages.create({
        model: MODEL, max_tokens, thinking: { type: "disabled" }, system,
        messages: [{ role: "user", content: user }],
      });
      return reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    };

    const results = [];
    for (const email of steps.trigger.event.body.emails) {
      const found = (await ask(CLASSIFY_SYSTEM, emailText(email), 200)).match(/\{[\s\S]*?\}/);
      const c = found ? JSON.parse(found[0]) : {};
      const category = String(c.category || "").toLowerCase();
      const urgency = String(c.urgency || "").toLowerCase();
      const record = { id: email.id, subject: email.subject, category, urgency };
      if (category === "spam") {
        results.push({ ...record, action: "drop" });
      } else if (urgency === "high") {
        results.push({ ...record, action: "escalate",
          escalation: `ESCALATE to on-call team: ${email.subject} (${email.from})` });
      } else {
        results.push({ ...record, action: "reply", reply: (await ask(REPLY_SYSTEM, emailText(email), 150)).trim() });
      }
    }
    $.export("results", results);
    return results;
  },
};
