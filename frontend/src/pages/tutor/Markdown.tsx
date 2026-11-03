import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

/**
 * A tutor's written explanation: Markdown with $…$ and $$…$$ maths set by KaTeX. react-markdown
 * builds React elements and ignores raw HTML, so text from the model cannot inject markup.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="tu-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
