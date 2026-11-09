/* What each workflow type is for. The guidance follows Microsoft's agent design patterns guide and Agent Framework docs. */

export interface Pattern {
  id: string;
  group: 'Orchestrations' | 'Graph edges' | 'Capabilities';
  title: string;
  aka?: string;
  what: string;
  use: string;
  avoid: string;
  file: string;
  /** The lines that make it this type of workflow, from the example file. */
  code: string;
  /** Agents in a handoff all receive every message, so the handoffs say who is acting, not the steps. */
  routeDriven?: boolean;
}

export const GROUPS = ['Orchestrations', 'Graph edges', 'Capabilities'] as const;

export const PATTERNS: Pattern[] = [
  {
    id: 'sequential',
    group: 'Orchestrations',
    title: 'Sequential',
    aka: 'pipeline, prompt chaining, linear delegation',
    what: 'Agents run in a fixed order. Each one reads what came before and adds to it.',
    use: 'Each stage depends on the last, as in draft, review, polish.',
    avoid: 'Stages could run at once, or the work may need to go back a step.',
    file: '01_sequential.py',
    code: `SequentialBuilder(participants=[researcher, writer, editor]).build()`,
  },
  {
    id: 'concurrent',
    group: 'Orchestrations',
    title: 'Concurrent',
    aka: 'parallel, fan-out/fan-in, scatter-gather, map-reduce',
    what: 'Several agents work on the same task at once, independently. Something then combines their answers.',
    use: 'You want independent views, or the time matters more than the token bill.',
    avoid: 'Agents depend on each other, your quota is tight, or you have no rule for settling disagreement.',
    file: '02_concurrent.py',
    code: `ConcurrentBuilder(participants=[finance, risk, support_lead])
    .with_aggregator(decide)   # the chair settles disagreement
    .build()`,
  },
  {
    id: 'handoff',
    group: 'Orchestrations',
    title: 'Handoff',
    aka: 'routing, triage, transfer, dispatch',
    what: 'The active agent either deals with the task or passes full control to a better-placed agent.',
    use: 'You cannot tell which specialist is needed until the work is under way.',
    avoid:
      'The input alone tells you the route (use routing below), or agents could pass work back and forth for ever.',
    file: '04_handoff.py',
    code: `HandoffBuilder(participants=[triage, billing, returns], termination_condition=resolved)
    .with_start_agent(triage)
    .add_handoff(triage, [billing, returns])
    .add_handoff(billing, [returns])
    .with_autonomous_mode(turn_limits={"triage": 2, "billing": 3, "returns": 3})
    .build()`,
    routeDriven: true,
  },
  {
    id: 'group_chat',
    group: 'Orchestrations',
    title: 'Group chat',
    aka: 'roundtable, collaborative, debate, council',
    what: 'Agents share one conversation, and a manager picks who speaks next.',
    use: 'Brainstorming or reaching agreement between different points of view.',
    avoid: 'A simple pipeline would do, or latency matters. Microsoft advises three agents or fewer.',
    file: '05_group_chat.py',
    code: `GroupChatBuilder(participants=[customer_voice, operations, copywriter],
                 orchestrator_agent=manager,
                 max_rounds=6).build()`,
  },
  {
    id: 'maker_checker',
    group: 'Orchestrations',
    title: 'Maker-checker loop',
    aka: 'evaluator-optimizer, generator-verifier, critic loop, reflection',
    what: 'One agent writes and another judges against stated criteria, round after round, until it passes or hits a limit.',
    use: 'You can state what "good" means. It needs acceptance criteria, an iteration cap and a fallback.',
    avoid: 'The criteria are vague, so the checker has nothing firm to judge against.',
    file: '06_maker_checker.py',
    code: `.add_edge(maker, checker)
.add_switch_case_edge_group(checker, [
    Case(condition=lambda d: d.approved, target=publish),
    Case(condition=lambda d: d.round >= CAP, target=escalate),   # a person takes over
    Default(target=maker)])`,
  },
  {
    id: 'magentic',
    group: 'Orchestrations',
    title: 'Magentic',
    aka: 'dynamic orchestration, task-ledger orchestration, adaptive planning',
    what: 'A manager writes a plan, updates a progress ledger after every step, picks who acts next and replans if the work stalls.',
    use: 'An open-ended problem with no known route, where you want a plan you can review.',
    avoid:
      'The route is known or time is short. It was the slowest and dearest here: about two cents a run, against under half a cent for every other type.',
    file: '07_magentic.py',
    code: `MagenticBuilder(participants=[analyst, ops_expert], manager_agent=manager,
                max_round_count=6, max_stall_count=2, max_reset_count=1).build()`,
  },
  {
    id: 'orchestrator_workers',
    group: 'Orchestrations',
    title: 'Orchestrator and workers',
    aka: 'supervisor, agents as tools, subagents',
    what: 'The orchestrator stays in charge and calls each worker like a function. Each worker starts empty and returns only its answer.',
    use: 'You want one agent accountable and its context kept small. This is how Claude Code uses subagents.',
    avoid: 'A worker needs the whole conversation, or should take over completely (use handoff).',
    file: '08_orchestrator_workers.py',
    code: `tools = [worker.as_tool(name=name, description=prompt) for ...]
orchestrator = lab.agent("orchestrator", "...", tools=tools)`,
  },
  {
    id: 'fan_out_fan_in_edges',
    group: 'Graph edges',
    title: 'Fan-out and fan-in edges',
    aka: 'the graph underneath Concurrent',
    what: 'A fan-out edge sends one message to every target. A fan-in edge waits for all of them and delivers a list.',
    use: 'Branches are different kinds of work. Here one reviewer is plain code and two are models.',
    avoid: 'Only some branches should run: a fan-in waits for every source (use multi-selection).',
    file: '03_fan_out_fan_in_edges.py',
    code: `.add_fan_out_edges(start, [rule_check, tone, legal])
.add_fan_in_edges([rule_check, tone, legal], join)`,
  },
  {
    id: 'routing',
    group: 'Graph edges',
    title: 'Routing: switch-case and multi-selection',
    aka: 'deterministic routing, conditional edges',
    what: 'A model reads the message into a typed ticket, then plain code picks the route. Switch-case picks one target; multi-selection picks any subset.',
    use: 'The route can be worked out from the input. It is cheaper and easier to test than agents handing off.',
    avoid: 'The right route only becomes clear part way through the work.',
    file: '09_routing.py',
    code: `.add_switch_case_edge_group(intake, [Case(condition=lambda t: t.urgent, target=urgent),
                                     Default(target=sorter)])
.add_multi_selection_edge_group(sorter, teams,
    selection_func=lambda t, ids: [i for i in ids if i in t.teams])`,
  },
  {
    id: 'plan_approve_run',
    group: 'Capabilities',
    title: 'Plan, approve, run',
    aka: 'human in the loop, plan mode',
    what: 'The workflow stops at request_info and holds its state until a person answers. Only the agent past the gate has the tool that acts.',
    use: 'Anything that changes data or cannot be undone.',
    avoid: 'Low-risk steps, where a person approving each one soon stops reading.',
    file: '10_plan_approve_run.py',
    code: `await ctx.request_info(PlanReview(text=plan), bool)     # the workflow stops here

@response_handler
async def answered(self, request, approved: bool, ctx): ...`,
  },
  {
    id: 'checkpoint_resume',
    group: 'Capabilities',
    title: 'Checkpoint and resume',
    aka: 'durable workflows',
    what: 'State is saved after every superstep. A crashed run resumes from there, in a new workflow object, without repeating finished work.',
    use: 'Long or expensive runs, or a person may take days to answer.',
    avoid: 'Short runs that are cheaper to start again.',
    file: '11_checkpoint_resume.py',
    code: `WorkflowBuilder(start_executor=draft, checkpoint_storage=FileCheckpointStorage(folder))
latest = await storage.get_latest(workflow_name=workflow.name)
new_workflow.run(checkpoint_id=latest.checkpoint_id, stream=True)`,
  },
  {
    id: 'sub_workflow',
    group: 'Capabilities',
    title: 'Sub-workflow',
    aka: 'nested workflows, composition',
    what: 'A finished workflow becomes one step of a bigger one. The outer graph sees a single node.',
    use: 'A team of steps you want to build, test and reuse on its own.',
    avoid: 'A single use: one flat graph is easier to read.',
    file: '12_sub_workflow.py',
    code: `team = WorkflowBuilder(start_executor=writer, name="review_team").add_edge(writer, critic).build()
inner = WorkflowExecutor(team, id="review_team")   # now it is one node`,
  },
  {
    id: 'declarative',
    group: 'Capabilities',
    title: 'Declarative (YAML)',
    aka: 'workflow as configuration',
    what: 'The steps and routing live in a YAML file, with Power Fx expressions for conditions. The program only loads it and supplies the agents.',
    use: 'People need to change a flow without a code release, or review it as data.',
    avoid:
      'The logic is really code. The expression language is small, and mistakes appear at run time, not when you build.',
    file: '13_declarative.py and returns_desk.yaml',
    code: `- kind: InvokeAzureAgent
  id: classify
  agent: classifier
  input: =Local.message
  resultProperty: Local.category
  output: { autoSend: false }

- kind: ConditionGroup
  id: route
  conditions:
    - id: is_safety
      condition: =Upper(Trim(Local.category)) = "SAFETY"
      actions:
        - kind: SendActivity
          id: safety_reply
          activity: "Please stop using the bike and do not charge the battery."`,
  },
];

export const CHOOSER: [string, string, string][] = [
  ['One prompt or one agent with tools can do it', 'No orchestration at all', ''],
  ['The steps always run in the same order', 'Sequential', 'sequential'],
  ['You want independent views on the same input', 'Concurrent', 'concurrent'],
  ['The route can be read from the input', 'Routing', 'routing'],
  ['The right specialist only shows up during the work', 'Handoff', 'handoff'],
  ['Viewpoints need to argue their way to agreement', 'Group chat', 'group_chat'],
  ['You can state exactly what passing looks like', 'Maker-checker loop', 'maker_checker'],
  ['Nobody knows the route, and you can afford to explore', 'Magentic', 'magentic'],
  ['One agent should stay in charge and keep its context small', 'Orchestrator and workers', 'orchestrator_workers'],
  ['An action cannot be undone', 'Plan, approve, run', 'plan_approve_run'],
  ['A run is long or costly to repeat', 'Checkpoint and resume', 'checkpoint_resume'],
  ['People must change the flow without a code release', 'Declarative (YAML)', 'declarative'],
];

export const RUN_MODES: [string, string, string, string][] = [
  ['Hands-off', 'Runs without asking, inside a sandbox.', 'Auto mode', '/coding-agent'],
  ['Ask each time', 'Stops for every change.', 'Default and accept-edits modes', '/coding-agent'],
  [
    'Plan first',
    'Reads and proposes, and cannot change anything.',
    'Plan mode, or Plan, approve, run below',
    '/coding-agent',
  ],
  [
    'Orchestrator with subagents',
    'A main agent gives jobs to workers with empty contexts.',
    'Team scenario',
    '/harness',
  ],
];
