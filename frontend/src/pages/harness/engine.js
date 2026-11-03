import { Site } from '@/lib/site';
import { mountLoop } from './loop';
import { mountSkills } from './skills';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { setInterval } = life;  // stopped when you leave the page
  const { $, $$, esc, fmtInt } = Site;

  const COMPONENTS = [
    ['The loop', 'Calls the model, runs the tools it asks for, feeds the results back, and repeats.', 'One answer, then nothing.'],
    ['Tools and permissions', 'Defines what the agent can do, in a sandbox, with allow-lists for risky actions.', 'The agent can only talk, or can do anything at all.'],
    ['Context management', 'Chooses what goes into each request: summaries, trimmed tool output, retrieved files.', 'The window fills up and the run crashes, or the agent forgets.'],
    ['Progress and state', 'Keeps the plan and progress in a file or task list outside the model\'s memory.', 'After a summary or restart, the agent repeats or skips work.'],
    ['Verification', 'Checks the work against a definition of done, such as tests, before accepting "finished".', 'The agent declares success too early.'],
    ['Limits and recovery', 'Caps turns, money and time; retries flaky tools with backoff.', 'Runaway loops and surprise bills.'],
    ['Human checkpoints', 'Pauses for approval before irreversible actions.', 'An unreviewed deploy, payment or email.'],
    ['Observability', 'Logs every call, tool result and decision for debugging and evaluation.', 'No way to tell why it did what it did.']
  ];
  $('#components').innerHTML = COMPONENTS.map(([h, d, m]) => `<div><h4>${h}</h4>${d}<div class="miss">Without it: ${m}</div></div>`).join('');

  const OPTS = [
    ['verify', 'Verification gate', 'The harness runs the tests itself before it accepts "done".', true],
    ['progress', 'Progress file', 'The plan lives in TODO.md, outside the context.', true],
    ['compact', 'Context compaction', 'Older steps are summarised when the window is 70% full.', true],
    ['retry', 'Retries with backoff', 'Timeouts are retried by the harness before the model sees them.', true],
    ['limits', 'Turn and budget limits', 'Stop after 25 turns or $1.00 and ask for help.', true],
    ['approval', 'Human approval for deploys', 'A person must approve the merge and deploy.', true],
    ['flaky', 'Environment: flaky test runner', 'The test runner sometimes times out.', false]
  ];
  const opt = Object.fromEntries(OPTS.map(o => [o[0], o[3]]));
  $('#toggles').innerHTML = OPTS.map(([k, t, d]) => `<label><input type="checkbox" data-k="${k}" ${opt[k] ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`).join('');
  $('#toggles').addEventListener('change', e => { opt[e.target.dataset.k] = e.target.checked; build(); idx = -1; stopPlay(); render(); });

  // ---------- simulation ----------
  const LIMIT = 20000, MAX_TURNS = 25, BUDGET = 1.0;
  const TODO = ['Reproduce the failures', 'Find the cause', 'Fix the code', 'Verify every test passes', 'Merge and deploy'];
  let events = [], outcome = null;
  function build() {
    events = []; outcome = null;
    const st = { ctx: 3200, turns: 0, cost: 0, done: new Set(), lostPlan: false };
    const snap = () => ({ ctx: st.ctx, turns: st.turns, cost: st.cost, done: [...st.done], lostPlan: st.lostPlan });
    const call = () => { st.turns++; st.cost += (st.ctx * 4 + 400 * 20) / 1e6; };
    const ev = (kind, title, detail, add = 0, isCall = true) => { if (isCall) call(); st.ctx += add; events.push({ kind, title, detail, ...snap() }); };
    const fin = (cls, title, text) => { outcome = { cls, title, text }; events.push({ kind: cls === 'good' ? 'done' : cls === 'warn' ? 'done' : 'error', title, detail: text, final: true, ...snap() }); };

    events.push({ kind: 'say', title: 'Task arrives', detail: 'Make the three failing billing tests pass, then merge and deploy.', ...snap() });
    ev('plan', 'Model plans the work', opt.progress ? 'Writes a five-step plan to TODO.md, a file the harness keeps outside the context.' : 'Keeps a five-step plan in its own reply, inside the context.', 400);
    // flaky environment
    if (opt.flaky) {
      if (opt.retry) { ev('tool', 'run_tests', 'The runner times out. The harness waits 2 seconds and retries automatically; the second attempt works.', 0); }
      else {
        ev('error', 'run_tests times out', 'The error goes straight back to the model, which tries again.', 300);
        let n = 0;
        while (true) {
          n++;
          if (opt.limits && (st.turns >= MAX_TURNS || st.cost >= BUDGET)) { fin('warn', 'Stopped by the harness, asking for help', `The test runner kept timing out. After ${st.turns} turns the limit stopped the run and reported: "Test runner unavailable; needs a human." Nothing was deployed. Adding retries with backoff would likely have recovered.`); return; }
          if (!opt.limits && n > 55) { fin('bad', 'Runaway loop', `With no turn or budget limit the agent retried ${st.turns} times, spending about $${st.cost.toFixed(2)}, until someone noticed and killed it.`); return; }
          ev('error', 'run_tests times out again', `Attempt ${n + 1}. The model keeps retrying the same call.`, 300);
          if (opt.compact && st.ctx > 0.7 * LIMIT) st.ctx = 4200;
          else if (!opt.compact && st.ctx > LIMIT) { fin('bad', 'Context window full', 'The retry messages filled the context and the API rejected the next request.'); return; }
        }
      }
    }
    ev('result', 'Tests: 3 failed', 'test_discount, test_split_bill and test_refund_negative fail.', 800, false);
    st.done.add(0);
    ev('tool', 'read_file billing.py', 'Reads the module under test.', 2500);
    ev('tool', 'search "round("', 'Finds money rounded to whole pounds in two functions.', 400);
    st.done.add(1);
    ev('tool', 'edit billing.py', 'Rounds to pence instead of pounds.', 300);
    ev('tool', 'run_tests', 'Runs the tests again.', 0);
    ev('result', 'Tests: 2 passed, 1 failed', 'test_refund_negative still fails.', 600, false);
    if (!opt.verify) {
      ev('say', 'Model: "Fixed the rounding bug. All done."', 'It saw two tests turn green and declared victory. Nothing in the harness checks the claim.', 200);
      if (!opt.approval) { fin('bad', 'Shipped a broken fix', 'The run ended on the model\'s word with one test still failing, and the change was merged and deployed with no human review.'); }
      else fin('bad', 'Declared done too early', 'The model stopped with one test still failing. The reviewer was asked to approve a deploy based on the model\'s summary, which said everything passed.');
      return;
    }
    ev('tool', 'read_file test_billing.py', 'Reads the remaining failing test to understand the edge case.', 5000);
    ev('tool', 'read_file refunds.py', 'Refunds are negative amounts; the rounding helper breaks on them.', 4000);
    {
      if (!opt.compact) {
        if (st.ctx + 3000 > LIMIT) { ev('tool', 'read_file payments.py', 'Reads one more related module.', 3000); fin('bad', 'Context window full', `The context reached ${fmtInt(st.ctx)} tokens, over the ${fmtInt(LIMIT)} limit, and the API rejected the next request. Long runs need compaction or trimmed tool output.`); return; }
      } else {
        const before = st.ctx; st.ctx = 4200;
        events.push({ kind: 'compact', title: 'Harness compacts the context', detail: `At ${fmtInt(before)} tokens, over 70% of the window, older steps are replaced by a summary.`, ...snap() });
        if (opt.progress) events.push({ kind: 'plan', title: 'Model re-reads TODO.md', detail: 'Remaining: fix negative refunds, verify, deploy. It carries straight on.', ...snap() });
        else {
          st.lostPlan = true;
          ev('say', 'Model: "Let me check the current state."', 'The summary kept "fixed rounding" but lost which test still failed and why, so the agent repeats work.', 200);
          ev('tool', 'run_tests', 'Runs the tests again to rediscover the failure.', 600);
          ev('tool', 'read_file test_billing.py', 'Reads the same file a second time.', 5000);
          ev('tool', 'read_file refunds.py', 'And this one again.', 4000);
          st.ctx = 6000;
          events.push({ kind: 'compact', title: 'Harness compacts again', detail: 'The repeated reading filled the window a second time.', ...snap() });
        }
      }
    }
    ev('tool', 'edit refunds.py', 'Handles negative amounts before rounding.', 300);
    st.done.add(2);
    ev('tool', 'run_tests', 'Runs the tests.', 0);
    ev('result', 'Tests: 3 passed', 'Every billing test passes.', 500, false);
    ev('say', 'Model calls finish("All three tests pass.")', 'The model believes it is done.', 200);
    events.push({ kind: 'gate', title: 'Verification gate: harness runs the full suite', detail: 'All 214 tests pass, including the three. The claim is accepted.', ...snap() });
    st.done.add(3);
    if (opt.approval) { events.push({ kind: 'approval', title: 'Approval requested', detail: 'A person sees the diff and test results, and approves the merge and deploy.', ...snap() }); }
    ev('tool', 'merge_and_deploy', opt.approval ? 'Runs after approval.' : 'Runs immediately. No person has seen the change.', 300);
    st.done.add(4);
    if (!opt.approval) fin('warn', 'Done, but deployed unreviewed', `The tests pass and the job is finished in ${st.turns} turns for about $${st.cost.toFixed(2)}. This time it worked, but the agent pushed to production with nobody checking, which is a risk you have chosen to accept.`);
    else if (st.lostPlan) fin('warn', 'Done, with wasted work', `Finished correctly in ${st.turns} turns for about $${st.cost.toFixed(2)}, but without a progress file the agent forgot its place after compaction and repeated several steps.`);
    else fin('good', 'Done, verified and approved', `All todos complete, the harness verified the tests, and a person approved the deploy. ${st.turns} turns, about $${st.cost.toFixed(2)}.`);
  }

  // ---------- rendering ----------
  let idx = -1, timer = null;
  const ICON = { plan: 'P', tool: 'T', result: 'R', gate: '✓', compact: 'C', approval: 'A', error: '!', done: '★', say: 'M' };
  function render() {
    $('#back').disabled = idx < 0; $('#next').disabled = idx >= events.length - 1;
    $('#timeline').innerHTML = events.map((e, i) => `<li class="${i === idx ? 'cur' : i > idx ? 'future' : ''}"><span class="ic k-${e.kind}">${ICON[e.kind]}</span><span><b>${esc(e.title)}</b><div class="detail">${esc(e.detail)}</div></span><span class="meta">turn ${e.turns}<br>${fmtInt(e.ctx)} tok</span></li>`).join('');
    const cur = $('#timeline li.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
    const e = events[Math.max(0, idx)];
    $('#todoTitle').textContent = opt.progress ? 'TODO.md, kept by the harness' : 'Plan, kept only in the context';
    $('#todos').innerHTML = idx < 1 ? '<span class="small muted">No plan yet.</span>' : (e.lostPlan && !opt.progress ? '<div class="small" style="color:var(--bad)">Plan details lost in the summary.</div>' : '') + TODO.map((t, i) => `<div class="todo ${e.done.includes(i) ? 'done' : ''}">${e.done.includes(i) ? '☑' : '☐'} ${t}</div>`).join('');
    const pct = Math.min(100, 100 * e.ctx / LIMIT);
    $('#ctxBar').style.width = pct + '%'; $('#ctxBar').classList.toggle('hot', e.ctx > 0.7 * LIMIT);
    $('#ctxTxt').textContent = `${fmtInt(e.ctx)} of ${fmtInt(LIMIT)} tokens, an illustrative window. The line marks 70%.`;
    $('#spendTxt').innerHTML = `Turns <b>${e.turns}</b>${opt.limits ? ` of ${MAX_TURNS} allowed` : ', no limit'} · Spend about <b>$${e.cost.toFixed(2)}</b>${opt.limits ? ` of $${BUDGET.toFixed(2)}` : ', no cap'}`;
    const o = $('#outcome');
    if (idx === events.length - 1 && outcome) { o.className = 'outcome ' + outcome.cls; o.innerHTML = `<b>${esc(outcome.title)}.</b> ${esc(outcome.text)}`; }
    else { o.className = 'outcome'; o.textContent = idx < 0 ? 'Press Next or Play to start the run.' : `Step ${idx + 1} of ${events.length}.`; }
  }
  function go(d) { idx = Math.max(-1, Math.min(events.length - 1, idx + d)); render(); }
  function stopPlay() { clearInterval(timer); timer = null; $('#play').textContent = 'Play'; }
  $('#next').addEventListener('click', () => { stopPlay(); go(1); });
  $('#back').addEventListener('click', () => { stopPlay(); go(-1); });
  $('#reset').addEventListener('click', () => { stopPlay(); idx = -1; render(); });
  $('#play').addEventListener('click', () => {
    if (timer) return stopPlay();
    if (idx >= events.length - 1) idx = -1;
    $('#play').textContent = 'Pause'; go(1);
    timer = setInterval(() => { if (idx >= events.length - 1) return stopPlay(); go(1); }, 1100);
  });
  build(); render();
  mountLoop(life);
  mountSkills(life);
}
