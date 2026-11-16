# Microsoft Power Automate

Power Automate is Microsoft's low-code automation service in the Power Platform. A cloud flow has a trigger and
actions. Under the designer, every cloud flow is a Logic Apps workflow definition (JSON), which is what an export holds.

## What is here

`flow.definition.json` is that definition, wrapped the way an exported flow wraps it (`properties.definition`).
`build_flow.py` writes it from the shared prompts. It has:

- Trigger: **When an HTTP request is received** (`Request`, kind `Http`), with a schema for `{emails: [...]}`.
- Three variables (`results`, `category`, `urgency`), then **Apply to each** (`Foreach`) over the emails, one at a time.
- **HTTP** action to the Anthropic Messages API (`x-api-key` from the secure parameter `AnthropicApiKey`, so the key is
  not in the file), **Parse JSON**, then **Condition** actions: spam goes to a drop record, high urgency to an escalation
  record, anything else to a second HTTP action that drafts the reply.
- **HTTP** action "Log to CRM" with `retryPolicy`: fixed, 3 tries, 5 seconds apart. The two Claude calls use an
  exponential retry policy (4 tries).
- **Response** with the results, and the retry count taken from the action's `retryHistory`.

## How to import it

A flow definition is not imported on its own. Either:

1. Build the flow in Power Automate (make.powerautomate.com) from the actions above, then in the code view (or by
   exporting a package and editing `definition.json`) paste `properties.definition`. Create the key as an environment
   variable of type Secret in a solution, and bind the `AnthropicApiKey` parameter to it.
2. Put the flow in a solution, export it as a zip, replace the flow's `definition.json` with this one and import it.

The HTTP action is a premium connector, so it needs a Power Automate Premium licence (or a Microsoft 365 plan with
the right Power Platform rights) and a Data Loss Prevention policy that allows HTTP. Instead of calling Anthropic you
can use the Azure OpenAI connector, or the AI Builder "Create text with GPT" action, with the same Condition shape.

## As an Azure Logic App

The same definition runs as a Logic App (Consumption): create the workflow, open Code view, paste
`properties.definition`, and supply the `AnthropicApiKey` and `CrmUrl` parameters (from Key Vault in practice). Logic
Apps and Power Automate share the engine, but Power Automate's managed connectors use `$connections`, which differ.
`az` is signed in on this machine, but no Azure resources were created: the Logic App was not deployed or run.

## Copilot Studio agent flows (AB-100)

Copilot Studio has its own flow type, the **agent flow**: a Power Automate cloud flow that lives inside an agent and
that the agent's topics or tools call (or that a trigger starts) to take actions. Relevant points for AB-100:

- An agent decides, a flow executes. The flow gives the agent a deterministic, auditable way to do something (look
  up an order, raise a ticket) with inputs and outputs it declares. Triage like this one could be an agent flow with
  the classification done by the agent's own model instead of an HTTP call.
- Agent flows use the same triggers, actions, connectors, retry policies and DLP rules as cloud flows, and they can be
  run on demand from the agent, on a schedule, or on an event.
- Licensing differs: agent flow runs are billed through Copilot Credits (or included Power Platform capacity), not
  only the Power Automate seat licence. Check the current licensing guide, as it has changed more than once.

## Limits and notes

- Not run. `run.py` checks the JSON (schema, trigger, action types, retry policies, `runAfter` wiring, every
  `body('X')` and `parameters('X')` reference, no literal key, prompts equal to `shared.py`) and then prints SKIP.
- The definition follows the Logic Apps schema as I know it, but it was not imported into a tenant, so a field name
  Power Automate dislikes would only show up on import. Treat it as a faithful starting point.
- The flaky CRM step needs a CRM endpoint that fails once, so the retry is configured but its count is not verified.

Ran on 2026-11-15: SKIP, needs a Power Automate licence (Microsoft 365 tenant). The definition validated.
