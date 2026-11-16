// Pipedream Node.js code step 2: save the results and log to a CRM. The CRM is flaky on purpose, so the first call fails.
// $.flow.rerun(delay, context, maxAttempts) is Pipedream's own way to run the same step again; $.context.run.runs is the
// attempt number. The step then sends the custom HTTP response with $.respond.
import { writeFileSync } from "node:fs";

const flakyCrm = async (results, attempt) => {
  if (attempt === 1) throw new Error("CRM unavailable (deliberate first-call failure)");
  return results.length;
};

export default {
  name: "Log to CRM and respond",
  version: "0.0.1",
  type: "action",
  async run({ steps, $ }) {
    const results = steps.triage.$return_value;
    const attempt = $.context.run.runs;
    try {
      await flakyCrm(results, attempt);
    } catch (err) {
      console.log(`attempt ${attempt} failed: ${err.message}`);
      return $.flow.rerun(1000, null, 3); // up to 3 more runs of this step, one second apart
    }
    $.export("flaky_attempts", attempt);
    // In Pipedream the results would go to a data store or the CRM; the local runner reads them from the response.
    if (process.env.STACK_OUT) writeFileSync(`${process.env.STACK_OUT}/results.json`, JSON.stringify({ results, flaky_attempts: attempt }, null, 2));
    await $.respond({ status: 200, headers: { "content-type": "application/json" }, body: { results, flaky_attempts: attempt } });
  },
};
