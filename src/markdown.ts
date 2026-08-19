/**
 * HTML → Markdown. Pure function. No network, no DOM.
 * Strips scripts/styles/comments; keeps headings, lists, links, emphasis.
 */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

type Attrs = Record<string, string>;

type TextNode = { kind: "text"; value: string };
type ElementNode = {
  kind: "element";
  tag: string;
  attrs: Attrs;
  children: HtmlNode[];
};
type HtmlNode = TextNode | ElementNode;

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function parseAttrs(raw: string): Attrs {
  const attrs: Attrs = {};
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|noscript|iframe)\b[^>]*\/?>/gi, "");

  const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:\s+[^>]*?)?)\s*\/?>|([^<]+)/g;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(cleaned)) !== null) {
    const parent = stack[stack.length - 1];
    if (token[0].startsWith("<!--")) {
      continue;
    }
    if (token[3] !== undefined) {
      parent.children.push({ kind: "text", value: decodeEntities(token[3]) });
      continue;
    }
    const tag = token[1].toLowerCase();
    const isClose = token[0].startsWith("</");
    const selfClosing = token[0].endsWith("/>") || VOID_TAGS.has(tag);
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: ElementNode = {
      kind: "element",
      tag,
      attrs: parseAttrs(token[2] ?? ""),
      children: [],
    };
    parent.children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }
  return root.children;
}

function collapseWs(text: string): string {
  return text.replace(/[ \t\f\v\r\n]+/g, " ");
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]#])/g, "\\$1");
}

function inline(nodes: HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += escapeMd(collapseWs(node.value));
      continue;
    }
    switch (node.tag) {
      case "br":
        out += "\n";
        break;
      case "strong":
      case "b":
        out += `**${inline(node.children).trim()}**`;
        break;
      case "em":
      case "i":
        out += `*${inline(node.children).trim()}*`;
        break;
      case "code":
        out += `\`${inline(node.children).replace(/`/g, "")}\``;
        break;
      case "a": {
        const href = node.attrs.href ?? "";
        const label = inline(node.children).trim() || href;
        out += href ? `[${label}](${href})` : label;
        break;
      }
      case "script":
      case "style":
      case "noscript":
      case "iframe":
        break;
      default:
        out += inline(node.children);
    }
  }
  return out;
}

function isBlock(tag: string): boolean {
  return (
    tag === "p" ||
    tag === "div" ||
    tag === "section" ||
    tag === "article" ||
    tag === "header" ||
    tag === "footer" ||
    tag === "main" ||
    tag === "aside" ||
    tag === "blockquote" ||
    tag === "pre" ||
    tag === "ul" ||
    tag === "ol" ||
    tag === "li" ||
    tag === "h1" ||
    tag === "h2" ||
    tag === "h3" ||
    tag === "h4" ||
    tag === "h5" ||
    tag === "h6" ||
    tag === "hr" ||
    tag === "table" ||
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tr"
  );
}

function blocks(nodes: HtmlNode[], listPrefix = ""): string[] {
  const lines: string[] = [];
  let inlineBuf = "";

  const flushInline = () => {
    const text = collapseWs(inlineBuf).trim();
    inlineBuf = "";
    if (text !== "") {
      lines.push(text);
    }
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      inlineBuf += escapeMd(collapseWs(node.value));
      continue;
    }
    if (node.tag === "script" || node.tag === "style" || node.tag === "noscript") {
      continue;
    }
    if (!isBlock(node.tag)) {
      inlineBuf += inline([node]);
      continue;
    }
    flushInline();
    if (node.tag === "br") {
      continue;
    }
    if (node.tag === "hr") {
      lines.push("---");
      continue;
    }
    const heading = /^h([1-6])$/.exec(node.tag);
    if (heading) {
      const hashes = "#".repeat(Number(heading[1]));
      const title = inline(node.children).trim();
      if (title !== "") {
        lines.push(`${hashes} ${title}`);
      }
      continue;
    }
    if (node.tag === "blockquote") {
      for (const line of blocks(node.children)) {
        lines.push(`> ${line}`);
      }
      continue;
    }
    if (node.tag === "pre") {
      const code = node.children
        .map((child) => (child.kind === "text" ? child.value : inline([child])))
        .join("")
        .replace(/\n$/, "");
      lines.push("```");
      lines.push(code);
      lines.push("```");
      continue;
    }
    if (node.tag === "ul" || node.tag === "ol") {
      let index = 1;
      for (const child of node.children) {
        if (child.kind !== "element" || child.tag !== "li") {
          continue;
        }
        const marker = node.tag === "ol" ? `${index}.` : "-";
        index += 1;
        const itemBlocks = blocks(child.children, `${listPrefix}  `);
        if (itemBlocks.length === 0) {
          lines.push(`${listPrefix}${marker} `);
          continue;
        }
        lines.push(`${listPrefix}${marker} ${itemBlocks[0]}`);
        for (const extra of itemBlocks.slice(1)) {
          lines.push(`${listPrefix}  ${extra}`);
        }
      }
      continue;
    }
    if (node.tag === "li") {
      const itemBlocks = blocks(node.children, `${listPrefix}  `);
      const marker = "-";
      if (itemBlocks.length === 0) {
        lines.push(`${listPrefix}${marker} `);
      } else {
        lines.push(`${listPrefix}${marker} ${itemBlocks[0]}`);
        for (const extra of itemBlocks.slice(1)) {
          lines.push(`${listPrefix}  ${extra}`);
        }
      }
      continue;
    }
    lines.push(...blocks(node.children, listPrefix));
  }
  flushInline();
  return lines;
}

export function toMarkdown(html: string): string {
  if (html === "") {
    return "";
  }
  const tree = parseHtml(html);
  const lines = blocks(tree);
  return lines
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
