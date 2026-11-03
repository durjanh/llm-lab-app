/* Code samples, kept as highlighted HTML. */
export const s1 =
  '<span class="c"># Count tokens exactly as Claude will see them</span>\n<span class="k">from</span> anthropic <span class="k">import</span> Anthropic\n\nclient = Anthropic()\nresp = client.messages.count_tokens(\n    model=<span class="s">"claude-opus-5-5"</span>,\n    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: open(<span class="s">"prompt.txt"</span>).read()}],\n)\nprint(resp.input_tokens)';
