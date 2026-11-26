/* The chat composer's decisions, kept free of React so they can be tested: which effort a model gets, how models
   are grouped in the picker, and which pasted things become attachments. */

/** A model the picker offers: its name, the group it is listed under, and the efforts it takes (none: hidden). */
export interface ComposerModel {
  id: string;
  name: string;
  group: string;
  efforts: string[];
  /** A short note beside the name, such as the context window. */
  meta?: string;
}

/** The effort to use for a model: the one asked for if it takes it, else medium, else its first; '' for none. */
export function fitEffortFor(efforts: string[], wanted: string): string {
  if (!efforts.length) return '';
  if (efforts.includes(wanted)) return wanted;
  return efforts.includes('medium') ? 'medium' : efforts[0];
}

/** The models in their groups, in the order the groups first appear. */
export function groupModels(models: ComposerModel[]): { group: string; models: ComposerModel[] }[] {
  const order: string[] = [];
  for (const m of models) if (!order.includes(m.group)) order.push(m.group);
  return order.map((group) => ({ group, models: models.filter((m) => m.group === group) }));
}

/** The part of a clipboard the composer reads: files, or items that can become files. */
export interface ClipboardLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }> | null;
}

/**
 * The files in a paste, such as a screenshot. A pasted picture usually arrives named "image.png", so it is renamed
 * with the time to tell several apart. Plain text in the paste is left to the text box.
 */
export function filesFromClipboard(data: ClipboardLike | null | undefined, now: Date = new Date()): File[] {
  if (!data) return [];
  let files: File[] = data.files ? Array.from(data.files) : [];
  if (!files.length && data.items) {
    files = Array.from(data.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return files.map((f, i) => {
    const generic = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name);
    if (!generic || !f.type.startsWith('image/')) return f;
    const ext = f.type.split('/')[1].replace('jpeg', 'jpg');
    return new File([f], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`, { type: f.type });
  });
}
