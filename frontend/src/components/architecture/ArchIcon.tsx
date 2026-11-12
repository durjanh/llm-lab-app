import { LINE_ICONS } from './lineIcons';
import './arch-diagram.css';

/** The Azure service icons, bundled by Vite: file name (without .svg) → URL. */
const AZURE_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('./icons/*.svg', { eager: true, query: '?url', import: 'default' })).map(
    ([path, url]) => [path.replace(/^.*\/(.*)\.svg$/, '$1'), url as string],
  ),
);

/** An Azure icon by file name, or one of our line icons as "line:<name>", drawn in the current text colour. */
export function ArchIcon({ name, size = 32 }: { name: string; size?: number }) {
  if (name.startsWith('line:')) {
    return (
      <span
        className="arch-icon line"
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: LINE_ICONS[name.slice(5)] ?? '' }}
      />
    );
  }
  return <img className="arch-icon" src={AZURE_ICONS[name]} alt="" width={size} height={size} />;
}
