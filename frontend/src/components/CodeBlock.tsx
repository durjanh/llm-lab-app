import { useRef, useState, type HTMLAttributes } from 'react';

interface Props extends HTMLAttributes<HTMLPreElement> {
  /** Syntax-highlighted code as trusted HTML from the page's snippets file. */
  html: string;
}

/** A code sample with a Copy button. */
export function CodeBlock({ html, className, ...rest }: Props) {
  const code = useRef<HTMLElement>(null);
  const [label, setLabel] = useState('Copy');

  async function copy() {
    try {
      await navigator.clipboard.writeText(code.current?.innerText ?? '');
      setLabel('Copied');
    } catch {
      setLabel('Select and copy');
    }
    setTimeout(() => setLabel('Copy'), 1500);
  }

  return (
    <pre className={className ? `code ${className}` : 'code'} data-copy="1" {...rest}>
      <code ref={code} dangerouslySetInnerHTML={{ __html: html }} />
      <button className="copy" type="button" onClick={copy}>
        {label}
      </button>
    </pre>
  );
}
