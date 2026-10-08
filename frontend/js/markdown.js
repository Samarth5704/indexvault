// A tiny, safe Markdown renderer for the notes widget. Builds DOM nodes (never
// innerHTML), so typed text can't inject markup. Supports: # headings, paragraphs,
// - / * / 1. lists, > quotes, ``` code blocks, **bold**, *italic*, `code`,
// [links](https://…) (http/https only) and --- rules.

import { h } from "./dom.js";

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(h("strong", inline(t.slice(2, -2))));
    else if (t.startsWith("`")) out.push(h("code", t.slice(1, -1)));
    else if (t.startsWith("[")) {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      out.push(/^https?:\/\//i.test(href) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, inline(label)) : t);
    } else out.push(h("em", inline(t.slice(1, -1))));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src) {
  const root = h("div.md");
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      root.append(h("pre", h("code", code.join("\n"))));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { root.append(h(`h${heading[1].length + 3}`, inline(heading[2]))); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { root.append(h("hr")); i++; continue; }
    const listRe = /^\s*([-*]|\d+\.)\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = h(ordered ? "ol" : "ul");
      for (; i < lines.length && listRe.test(lines[i]); i++) list.append(h("li", inline(lines[i].match(listRe)[2])));
      root.append(list);
      continue;
    }
    if (line.startsWith(">")) {
      const quote = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^>\s?/, ""));
      root.append(h("blockquote", inline(quote.join(" "))));
      continue;
    }
    const para = [line];
    for (i++; i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i]);
    root.append(h("p", inline(para.join(" "))));
  }
  return root;
}
