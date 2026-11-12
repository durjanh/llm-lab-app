/* Light syntax highlighting for code samples written as plain text: strings, comments and Python keywords, as the
   spans the lab's code blocks already colour (.s, .c, .k). The result is escaped HTML for CodeBlock. */

const KEYWORDS = new Set([
  'and',
  'as',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'elif',
  'else',
  'except',
  'False',
  'for',
  'from',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'not',
  'or',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
]);

const TOKEN = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(#[^\n]*)|\b([A-Za-z_]+)\b/g;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Highlighted HTML for a code sample. Keywords are marked only in Python. */
export function highlight(source: string, language: 'python' | 'shell' | 'json' = 'python'): string {
  let out = '';
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    out += escape(source.slice(last, m.index));
    if (m[1]) out += `<span class="s">${escape(m[1])}</span>`;
    else if (m[2]) out += `<span class="c">${escape(m[2])}</span>`;
    else out += language === 'python' && KEYWORDS.has(m[3]) ? `<span class="k">${m[3]}</span>` : m[3];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + escape(source.slice(last));
}
