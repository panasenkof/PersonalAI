/** A small Markdown subset for model answers: models write **bold**, lists and
 * headings, and showing the raw asterisks makes answers hard to read. */
export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; url?: string };
export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "bullet"; depth: number; spans: Span[] }
  | { kind: "numbered"; depth: number; number: string; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "blank" };

const INLINE = /(\*\*|__)(.+?)\1|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g;

export function parseInline(text: string, base: Omit<Span, "text"> = {}): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) spans.push({ ...base, text: text.slice(last, m.index) });
    if (m[2] !== undefined) spans.push(...parseInline(m[2], { ...base, bold: true }));
    else if (m[3] !== undefined) spans.push({ ...base, text: m[3], code: true });
    else if (m[4] !== undefined) spans.push({ ...base, text: m[4], url: m[5] });
    else if (m[6] !== undefined) spans.push(...parseInline(m[6], { ...base, italic: true }));
    last = m.index! + m[0].length;
  }
  if (last < text.length) spans.push({ ...base, text: text.slice(last) });
  return spans.filter(s => s.text);
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { if (blocks.length && blocks[blocks.length - 1].kind !== "blank") blocks.push({ kind: "blank" }); continue; }
    let m: RegExpExecArray | null;
    if ((m = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) blocks.push({ kind: "heading", level: m[1].length, spans: parseInline(m[2]) });
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) blocks.push({ kind: "rule" });
    else if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(line))) blocks.push({ kind: "bullet", depth: Math.min(3, Math.floor(m[1].length / 2)), spans: parseInline(m[2]) });
    else if ((m = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line))) blocks.push({ kind: "numbered", depth: Math.min(3, Math.floor(m[1].length / 2)), number: m[2], spans: parseInline(m[3]) });
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) blocks.push({ kind: "quote", spans: parseInline(m[1]) });
    else blocks.push({ kind: "paragraph", spans: parseInline(line) });
  }
  while (blocks.length && blocks[blocks.length - 1].kind === "blank") blocks.pop();
  return blocks;
}

/** Plain answers keep the original single-text rendering. */
export const hasMarkdown = (text: string) => /(\*\*|__|`|\[[^\]\n]+\]\(https?:|^\s*(#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>|```)|(?<![\w*])\*(?!\s)[^*\n]+?\*(?![\w*]))/m.test(text);
