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

/**
 * A model's full name for a picker or a label: "Claude Sonnet 5.5", "GPT-5.4 mini", "Local · qwen3.5:9b".
 * modelName() is the short form for sentences ("the local model will not see screenshots").
 */
export function modelLabel(model: string): string {
  const claude = model.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  if (model.startsWith('gpt-')) {
    const [version, ...rest] = model.slice(4).split('-');
    return [`GPT-${version}`, ...rest].join(' ');
  }
  if (isLocalModel(model)) return `Local · ${model.replace(/^ai\//, '')}`;
  return model;
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

/** The model a page starts on: the lab's default (the local model, when one is set up) if the page offers it, else
 * the first it offers. Pages whose work needs Claude-only features offer only Claude models, so they start on Claude. */
export function startingModel(defaultModel: string | undefined, offered: string[]): string {
  return defaultModel && offered.includes(defaultModel) ? defaultModel : (offered[0] ?? '');
}
