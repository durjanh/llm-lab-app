// Runs the two step files outside Pipedream. It fakes the parts of Pipedream they use: `steps`, `$.export`,
// `$.respond`, `$.context.run.runs` and `$.flow.rerun` (which runs the step again). The Claude calls are real.
// Usage: node local.js   (prints one JSON line: the HTTP response the workflow would send)
import triage from "./triage.js";
import logToCrm from "./log_to_crm.js";
import { shared } from "./emails.js";

const steps = { trigger: { event: { body: { emails: shared } } } };

async function runStep(component) {
  let runs = 1;
  for (;;) {
    let rerun = null, response = null;
    const $ = {
      context: { run: { runs } },
      export: () => {},
      respond: async (r) => { response = r; },
      flow: { rerun: (delay, _ctx, max) => { rerun = { delay, max }; } },
    };
    const value = await component.run({ steps, $ });
    if (!rerun) return { value, response };
    if (runs > rerun.max) throw new Error("rerun limit reached");
    await new Promise((r) => setTimeout(r, Math.min(rerun.delay, 200)));
    runs += 1;
  }
}

steps.triage = { $return_value: (await runStep(triage)).value };
const { response } = await runStep(logToCrm);
console.log("RESPONSE " + JSON.stringify(response.body));
