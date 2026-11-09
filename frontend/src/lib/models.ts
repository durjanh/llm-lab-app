/**
 * Which model is doing the work, in words. Pages offer Claude, GPT and, when one is set up, an open model running on this
 * machine (LLM_LAB_LOCAL_MODEL), so a message that names the model must follow the one chosen.
 */
export function isLocalModel(model: string | undefined): boolean {
  return !!model && !model.startsWith('claude-') && !model.startsWith('gpt-');
}

/** "Claude", "GPT" or "the local model", for use mid-sentence. */
export function modelName(model: string | undefined): string {
  if (model?.startsWith('gpt-')) return 'GPT';
  return isLocalModel(model) ? 'the local model' : 'Claude';
}

/** The same, for the start of a sentence. */
export function modelNameStart(model: string | undefined): string {
  const name = modelName(model);
  return name[0].toUpperCase() + name.slice(1);
}

/** Where a skill's code runs for this model: Anthropic's container for Claude, the lab's sandbox otherwise. */
export function skillsPlace(model: string | undefined): string {
  return !model || model.startsWith('claude-') ? "Claude's container" : "the lab's sandbox";
}
