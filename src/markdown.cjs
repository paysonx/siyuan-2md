"use strict";
const { Marked } = require("../vendor/marked.cjs");
// SiYuan's reference export uses footnotes, which are not part of base GFM.
const parser = new Marked({ gfm: true, extensions: [{
  name: "footnoteDefinition", level: "block",
  start(src) { return src.match(/^\[\^[^\]\n]+\]:/m)?.index; },
  tokenizer(src) {
    if (!/^\[\^[^\]\n]+\]:/.test(src)) return;
    const lines = src.match(/[^\n]*\n|[^\n]+$/g) || [];
    let count = 1;
    while (count < lines.length) {
      if (/^(?: {4}|\t)/.test(lines[count])) { count++; continue; }
      if (/^\s*$/.test(lines[count]) && /^(?: {4}|\t)/.test(lines[count + 1] || "")) { count++; continue; }
      break;
    }
    const raw = lines.slice(0, count).join("");
    const text = raw.replace(/^\[\^[^\]\n]+\]:[ \t]*/, "").replace(/^(?: {4}|\t)/gm, "");
    return { type: "footnoteDefinition", raw, text, tokens: this.lexer.blockTokens(text) };
  },
}, {
  name: "footnoteReference", level: "inline",
  start(src) { return src.indexOf("[^"); },
  tokenizer(src) {
    const match = /^\[\^[^\]\n]+\]/.exec(src);
    if (match) return { type: "footnoteReference", raw: match[0] };
  },
}] });

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, key) => {
    const names = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (key[0] !== "#") return names[key.toLowerCase()] || all;
    const n = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

// Source maps retain the original Markdown, including list/blockquote prefixes.
function mapFragment(fragment, source, map, from = 0) {
  const exact = source.indexOf(fragment, from);
  if (exact >= 0) return { map: map.slice(exact, exact + fragment.length), end: exact + fragment.length };
  const result = [];
  let at = from;
  for (const c of fragment.split("")) {
    at = source.indexOf(c, at);
    if (at < 0) return null;
    result.push(map[at++]);
  }
  return { map: result, end: at };
}

function labelEnd(raw) {
  let depth = 0;
  for (let i = raw[0] === "!" ? 1 : 0; i < raw.length; i++) {
    if (raw[i] === "\\") { i++; continue; }
    if (raw[i] === "[") depth++;
    if (raw[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

function scanMarkdown(markdown) {
  // Mask formula source so image-like TeX is never interpreted as Markdown.
  const source = markdown.replace(/<!--[\s\S]*?-->|<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|\$\$[\s\S]*?\$\$|(?<![\\$])\$(?!\s)(?:\\.|[^$\n])+?\$(?!\$)/gi,
    text => text.replace(/[^\n]/g, " "));
  const resources = [], warnings = [];
  const indices = Array.from({ length: source.length }, (_, i) => i);
  const add = (map, start, end, item) => {
    if (start >= end || map[start] === undefined || map[end - 1] === undefined) return;
    // Replacing a span containing removed quote/list prefixes would damage formatting.
    if (map[end - 1] - map[start] !== end - start - 1) {
      warnings.push("跨行资源链接未自动改写，请检查：" + item.href); return;
    }
    resources.push({ ...item, start: map[start], end: map[end - 1] + 1 });
  };
  const html = (raw, map) => {
    const tags = /<(img|a|audio|video|source|object|iframe)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    for (const tag of raw.matchAll(tags)) {
      const name = tag[1].toLowerCase();
      for (const attr of tag[0].matchAll(/\b(src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const value = attr[2] ?? attr[3] ?? attr[4];
        const key = attr[1].toLowerCase();
        if (!((name === "a" && key === "href") || (name === "object" && key === "data") || key === "src" || key === "poster")) continue;
        const pos = tag.index + attr.index + attr[0].indexOf("=") + 1;
        const start = raw.indexOf(value, pos);
        add(map, start, start + value.length, { href: decodeEntities(value), image: name === "img" || key === "poster", format: "html" });
      }
      if (/\bsrcset\s*=/i.test(tag[0])) warnings.push("HTML srcset 多分辨率图片未展开；请检查离线显示。" );
      if (name === "iframe") warnings.push("内嵌网页需要网络，无法转换为离线 Markdown 正文。" );
    }
  };
  function visit(tokens, text, map) {
    let cursor = 0;
    for (const token of tokens || []) {
      if (!token.raw) continue;
      const match = mapFragment(token.raw, text, map, cursor);
      if (!match) { warnings.push("部分特殊排版未能定位资源，请检查导出结果。"); continue; }
      cursor = match.end;
      const raw = token.raw, positions = match.map;
      if (["code", "codespan", "escape", "def"].includes(token.type)) continue;
      if (token.type === "image" || token.type === "link") {
        const close = labelEnd(raw);
        if (close >= 0) {
          add(positions, close + 1, raw.length, {
            href: decodeEntities(token.href), image: token.type === "image", format: "markdown", title: token.title,
          });
          // Shortcut references have no suffix: insert at the closing bracket.
          if (close + 1 === raw.length) resources.push({ href: decodeEntities(token.href), image: token.type === "image", format: "markdown", title: token.title, start: positions[close] + 1, end: positions[close] + 1 });
          if (token.type === "link" && token.tokens) {
            const begin = raw.indexOf("[") + 1;
            visit(token.tokens, raw.slice(begin, close), positions.slice(begin, close));
          }
        }
        continue;
      }
      if (token.type === "html") { html(raw, positions); continue; }
      if (token.type === "list") { visit(token.items, raw, positions); continue; }
      if (token.type === "table") {
        let at = 0;
        for (const cell of [...token.header, ...token.rows.flat()]) {
          const mapped = mapFragment(cell.text, raw, positions, at);
          if (mapped) { visit(cell.tokens, cell.text, mapped.map); at = mapped.end; }
        }
        continue;
      }
      if (token.tokens) {
        const childText = token.text ?? raw;
        const mapped = mapFragment(childText, raw, positions);
        if (mapped) visit(token.tokens, childText, mapped.map);
      }
    }
  }
  visit(parser.lexer(source), source, indices);
  if (/siyuan:\/\/blocks\//.test(markdown)) warnings.push("部分文档或块链接仍需在思源中打开，未导出关联整篇文档。");
  if (/data-type=["'](?:NodeAttributeView|NodeWidget|NodeBlockQueryEmbed|NodeIFrame)/.test(markdown) || /\{\{select\b/i.test(markdown)) warnings.push("检测到未完全转换的思源特殊块，请对照原文检查。");
  return { resources, warnings };
}

function rewriteMarkdown(markdown, resources, replacements) {
  const edits = resources.flatMap(resource => {
    const target = replacements.get(resource.href);
    if (!target) return [];
    const path = typeof target === "string" ? target : target.path;
    const suffix = typeof target === "string" ? "" : (target.suffix || "");
    const href = path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16))).join("/") + suffix;
    const title = resource.title ? ' "' + resource.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : "";
    return [{ ...resource, text: resource.format === "html" ? href.replace(/&/g, "&amp;").replace(/"/g, "&quot;") : "(" + href + title + ")" }];
  }).sort((a, b) => b.start - a.start);
  let boundary = markdown.length + 1;
  for (const edit of edits) {
    if (edit.end > boundary) continue;
    markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
    boundary = edit.start;
  }
  return markdown;
}
module.exports = { scanMarkdown, rewriteMarkdown, decodeEntities };
