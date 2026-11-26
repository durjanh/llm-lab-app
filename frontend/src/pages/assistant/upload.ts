/* Checks attachments against the limits /info gives, before anything is sent, so the person hears why at once. */
import type { AssistantInfo } from '@/services/assistantService';

export interface Checked {
  ok: File[];
  problems: string[];
}

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(bytes < 2 ** 20 ? 2 : 0)} MB`;

/** The file's extension in lower case with its dot, or '' when it has none. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : '';
}

/**
 * Splits picked files into those that can be uploaded and a reason for each one that cannot. `already` is how many
 * files are attached to the message being written, so the count limit covers the whole message.
 */
export function checkUploads(files: File[], limits: AssistantInfo['upload'], already = 0): Checked {
  const allowed = new Set(limits.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  const ok: File[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const ext = extensionOf(f.name);
    if (!ext || !allowed.has(ext))
      problems.push(`${f.name}: this kind of file is not accepted (${ext || 'no extension'}).`);
    else if (f.size === 0) problems.push(`${f.name}: the file is empty.`);
    else if (f.size > limits.max_file_bytes)
      problems.push(`${f.name}: ${mb(f.size)} is over the ${mb(limits.max_file_bytes)} limit for one file.`);
    else if (already + ok.length >= limits.max_files)
      problems.push(`${f.name}: a message can carry at most ${limits.max_files} files.`);
    else ok.push(f);
  }
  return { ok, problems };
}

export const accept = (limits: AssistantInfo['upload']) =>
  limits.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)).join(',');

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 2 ** 20) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}
