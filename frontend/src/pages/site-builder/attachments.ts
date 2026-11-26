/* What a site builder message may carry, checked in the browser first so the person hears why at once. The server
   checks it all again. */
import type { ComposerModel } from '@/components/chat/ChatComposer';
import { isLocalModel, modelLabel, modelNameStart } from '@/lib/models';
import type { ModelCaps, SiteUpload } from '@/services/sitesService';

export const MAX_ATTACHMENTS = 6;
const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const DATA = ['.csv', '.json', '.md', '.txt', '.html', '.css', '.js', '.svg'];
const PDF = ['.pdf'];
export const LIMITS = { image: 5 * 2 ** 20, data: 300_000, pdf: 10 * 2 ** 20 } as const;
export const ACCEPT = [...IMAGE, ...DATA, ...PDF].join(',');

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
};

export function kindOf(name: string): 'image' | 'data' | 'pdf' | null {
  const ext = extOf(name);
  if (IMAGE.includes(ext)) return 'image';
  if (DATA.includes(ext)) return 'data';
  if (PDF.includes(ext)) return 'pdf';
  return null;
}

const sizeText = (bytes: number) =>
  bytes < 2 ** 20 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;

/** Splits picked or pasted files into those that can be uploaded and a reason for each that cannot. */
export function checkFiles(files: File[], already: number): { ok: File[]; problems: string[] } {
  const ok: File[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const kind = kindOf(f.name);
    if (!kind) problems.push(`${f.name}: attach a picture, a data or text file, or a PDF.`);
    else if (f.size === 0) problems.push(`${f.name}: the file is empty.`);
    else if (f.size > LIMITS[kind])
      problems.push(
        `${f.name}: ${sizeText(f.size)} is over the ${sizeText(LIMITS[kind])} limit for ${kind === 'image' ? 'a picture' : kind === 'pdf' ? 'a PDF' : 'a data file, which is copied into the site'}.`,
      );
    else if (already + ok.length >= MAX_ATTACHMENTS)
      problems.push(`${f.name}: a message can carry at most ${MAX_ATTACHMENTS} files.`);
    else ok.push(f);
  }
  return { ok, problems };
}

/** Why the chosen model cannot take what is attached, or null when it can. */
export function blockedFor(
  attached: Pick<SiteUpload, 'kind' | 'name'>[],
  caps: ModelCaps | undefined,
  model: string,
): string | null {
  if (!caps) return null;
  const pdf = attached.find((a) => a.kind === 'pdf');
  if (pdf && !caps.pdf)
    return `${modelNameStart(model)} cannot read PDFs. Choose a Claude model, or attach the pages as pictures.`;
  const picture = attached.find((a) => a.kind === 'image');
  if (picture && caps.images === false)
    return `${modelNameStart(model)} cannot read pictures. Choose Claude or GPT for this message.`;
  return null;
}

/** A warning that does not stop sending: a model that may or may not read pictures. */
export function noticeFor(
  attached: Pick<SiteUpload, 'kind'>[],
  caps: ModelCaps | undefined,
  model: string,
): string | null {
  if (caps?.images === null && attached.some((a) => a.kind === 'image'))
    return `${modelNameStart(model)} may not read pictures. If it cannot, the message stops with a clear note; Claude and GPT can.`;
  return null;
}

/** The lab's models as the shared picker lists them, grouped like the Assistant's, with their effort levels. */
export function pickerModels(models: string[], caps: Record<string, ModelCaps>): ComposerModel[] {
  return models.map((id) => ({
    id,
    name: modelLabel(id),
    group: id.startsWith('claude-') ? 'Claude' : isLocalModel(id) ? 'On this machine' : 'GPT on Azure',
    efforts: caps[id]?.efforts ?? [],
  }));
}
