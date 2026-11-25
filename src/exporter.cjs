"use strict";
const JSZip = require("../vendor/jszip.cjs");
const { scanMarkdown, rewriteMarkdown } = require("./markdown.cjs");

const EXPORT_OPTIONS = Object.freeze({
  includeSubDocs: false, includeRelatedDocs: false, addTitle: true,
  blockRefMode: 4, blockEmbedMode: 0, fileAnnotationRefMode: 0,
  blockRefTextLeft: "", blockRefTextRight: "", inlineMemo: true,
  markdownYFM: false, removeAssetsID: false, headingNumber: false,
});
const IMAGE_LIMIT = 20 * 1024 * 1024;
const IMAGE_TIMEOUT = 30000;
function checkAbort(signal) { if (signal?.aborted) throw new DOMException("已取消导出", "AbortError"); }
function safeName(name) {
  let s = String(name).normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  s = [...s].slice(0, 100).join("");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = "_" + s;
  return s || "未命名文章";
}
function safeZipPath(path) {
  return typeof path === "string" && path.length > 0 && !/^[\\/]|^[a-z]:/i.test(path) &&
    !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..");
}
function appBase(href) {
  const url = new URL(href);
  const index = url.pathname.indexOf("/stage/");
  url.pathname = index >= 0 ? url.pathname.slice(0, index + 1) : url.pathname.replace(/[^/]*$/, "");
  url.search = ""; url.hash = "";
  return url;
}
function endpoint(base, path) { return new URL(path.replace(/^\//, ""), base).href; }
function exportURL(base, path) {
  if (typeof path !== "string" || !path.startsWith("/export/") || path.includes("\\")) throw new Error("思源未返回有效的导出下载地址");
  const url = new URL(endpoint(base, path));
  if (!url.pathname.startsWith(new URL(endpoint(base, "export/")).pathname)) throw new Error("导出地址超出了允许的目录");
  return url.href;
}

class KernelClient {
  constructor(base, fetcher = globalThis.fetch.bind(globalThis)) { this.base = new URL(base); this.fetcher = fetcher; }
  async withTimeout(signal, timeout, fn) {
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try { return await fn(controller.signal); }
    catch (error) {
      checkAbort(signal);
      if (controller.signal.aborted) throw new Error("请求超时（" + Math.round(timeout / 1000) + " 秒）");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  async post(path, body, signal, timeout = 120000) {
    return this.withTimeout(signal, timeout, async requestSignal => {
      const response = await this.fetcher(endpoint(this.base, path), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: requestSignal,
      });
      if (!response.ok) throw new Error("思源接口 HTTP " + response.status);
      let result;
      try { result = await response.json(); } catch { throw new Error("思源返回了非 JSON 响应，请检查登录状态与反向代理"); }
      if (result.code !== 0) throw new Error(result.msg || "思源接口错误：" + result.code);
      return result.data;
    });
  }
  async binary(url, signal) {
    return this.withTimeout(signal, 120000, async requestSignal => {
      const response = await this.fetcher(url, { credentials: "same-origin", signal: requestSignal });
      if (!response.ok) throw new Error("下载失败：HTTP " + response.status);
      if (/text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("下载地址返回了网页，请检查登录状态或代理配置");
      return new Uint8Array(await response.arrayBuffer());
    });
  }
  async image(url, signal) {
    const result = await this.post("api/network/forwardProxy", {
      url, method: "GET", timeout: IMAGE_TIMEOUT, responseEncoding: "base64", payloadEncoding: "text", payload: "",
      headers: [{ Accept: "image/*" }],
    }, signal, IMAGE_TIMEOUT);
    if (!result || result.status < 200 || result.status >= 300) throw new Error("图片服务器 HTTP " + result?.status);
    if (typeof result.body !== "string") throw new Error("图片响应格式无效");
    if (result.body.length > Math.ceil(IMAGE_LIMIT / 3) * 4) throw new Error("图片超过 20 MB");
    const binary = atob(result.body);
    if (binary.length > IMAGE_LIMIT) throw new Error("图片超过 20 MB");
    const data = Uint8Array.from(binary, c => c.charCodeAt(0));
    const type = (result.contentType || "").split(";")[0].toLowerCase();
    const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
    let extension = extensions[type];
    if (!extension && (!type || type === "application/octet-stream")) {
      const signature = new TextDecoder("latin1").decode(data.slice(0, 16));
      if (data[0] === 137 && signature.slice(1, 4) === "PNG") extension = "png";
      else if (data[0] === 255 && data[1] === 216) extension = "jpg";
      else if (signature.startsWith("GIF8")) extension = "gif";
      else if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") extension = "webp";
    }
    if (!extension || !data.length) throw new Error("返回内容不是支持的图片（可能为登录或防盗链页面）");
    return { data, extension };
  }
}

function resourcePath(href, mdPath, base) {
  if (/^(?:data:|#)/i.test(href)) return { skip: true };
  if (/^siyuan:/i.test(href)) return { skip: true };
  let url;
  try { url = new URL(href, new URL(mdPath, "https://archive.invalid/")); } catch { return { unsupported: true }; }
  if (/^https?:$/.test(url.protocol) && url.hostname !== "archive.invalid") {
    const baseURL = new URL(base);
    const prefix = baseURL.pathname + "assets/";
    if (url.origin === baseURL.origin && url.pathname.startsWith(prefix)) {
      try { return { local: decodeURIComponent(url.pathname.slice(baseURL.pathname.length)), suffix: url.search + url.hash }; }
      catch { return { unsupported: true }; }
    }
    return { external: url.href };
  }
  if (url.hostname !== "archive.invalid") return { unsupported: true };
  try {
    const path = decodeURIComponent(url.pathname.slice(1));
    return { local: path, suffix: url.search + url.hash };
  } catch { return { unsupported: true }; }
}

async function pooled(items, concurrency, fn, signal) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { checkAbort(signal); const index = cursor++; await fn(items[index], index); }
  }));
}
function zipBlob(zip, signal, progress = () => {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = zip.generateInternalStream({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true });
    let done = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => { if (done) return; done = true; stream.pause(); chunks.length = 0; cleanup(); reject(new DOMException("已取消导出", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk, metadata) => { if (!done) { chunks.push(chunk); progress(metadata.percent); } });
    stream.on("error", error => { if (!done) { done = true; cleanup(); reject(error); } });
    stream.on("end", () => { if (!done) { done = true; cleanup(); resolve(new Blob(chunks, { type: "application/zip" })); } });
    if (signal?.aborted) abort(); else stream.resume();
  });
}

async function exportDocument({ id, client, signal, onProgress = () => {} }) {
  if (!/^\d{14}-[a-z0-9]{7}$/.test(id)) throw new Error("无效的文档 ID");
  checkAbort(signal);
  onProgress({ stage: "准备文档" });
  const warnings = [];
  try {
    const original = await client.post("api/block/getBlockKramdown", { id }, signal, 15000);
    const source = original?.kramdown || "";
    if (/data-type=["']NodeAttributeView|data-av-id=/i.test(source)) warnings.push("原文包含数据库，Markdown 只能保留官方导出的静态内容，视图和交互请在思源中查看。");
    if (/<(?:iframe|widget)\b|data-type=["']NodeWidget|\/widgets\//i.test(source)) warnings.push("原文包含挂件或内嵌网页，可能无法转换为离线正文，请对照原文检查。");
    if (/\{\{\s*(?:select|\/\/|return\b)|data-type=["']NodeBlockQueryEmbed/i.test(source)) warnings.push("原文包含动态嵌入，导出仅保留本次内核能够解析的结果，不包含动态查询能力。");
  } catch (error) {
    checkAbort(signal);
    warnings.push("未能检查原文中的特殊块：" + error.message + "。请对照原文检查数据库、挂件和嵌入内容。");
  }
  const response = await client.post("api/export/exportMd", { id, ...EXPORT_OPTIONS }, signal);
  const bytes = await client.binary(exportURL(client.base, response?.zip), signal);
  checkAbort(signal);
  const input = await JSZip.loadAsync(bytes);
  const entries = Object.values(input.files).filter(file => !file.dir);
  for (const entry of entries) if (!safeZipPath(entry.name) || (entry.unsafeOriginalName && !safeZipPath(entry.unsafeOriginalName))) throw new Error("导出包包含不安全的路径");
  const docs = entries.filter(file => /\.md$/i.test(file.name) && !/(^|\/)assets\//i.test(file.name));
  if (docs.length !== 1) throw new Error("预期单篇 Markdown，实际得到 " + docs.length + " 篇；已停止，避免误导出其他文档");
  const doc = docs[0];
  const name = safeName(doc.name.split("/").pop().slice(0, -3));
  const markdown = (await doc.async("string")).replace(/\r\n?/g, "\n");
  checkAbort(signal);
  const output = new JSZip(); output.folder("assets");
  const paths = new Map(), used = new Set();
  function allocate(proposed) {
    let path = proposed, n = 1;
    while (used.has(path.toLowerCase())) {
      const dot = proposed.lastIndexOf(".");
      path = dot > proposed.lastIndexOf("/") ? proposed.slice(0, dot) + "-" + n++ + proposed.slice(dot) : proposed + "-" + n++;
    }
    used.add(path.toLowerCase()); return path;
  }
  for (const entry of entries) {
    checkAbort(signal);
    if (entry === doc) continue;
    const asset = entry.name.match(/(?:^|\/)assets\/(.+)$/);
    if (!asset) { warnings.push("官方导出包中的额外文件未纳入单篇导出：" + entry.name); continue; }
    const target = allocate("assets/" + asset[1].split("/").map(safeName).join("/"));
    const data = await entry.async("uint8array");
    output.file(target, data); paths.set(entry.name, target);
  }
  const scan = scanMarkdown(markdown);
  warnings.push(...scan.warnings);
  const replacements = new Map();
  const byHref = new Map();
  for (const resource of scan.resources) {
    const existing = byHref.get(resource.href);
    if (existing) existing.image ||= resource.image;
    else byHref.set(resource.href, { href: resource.href, image: resource.image });
  }
  const unique = [...byHref.values()];
  let processed = 0;
  const work = unique.map(resource => ({ ...resource, info: resourcePath(resource.href, doc.name, client.base) }))
    .filter(r => !r.info.skip && (!r.info.external || r.image));
  onProgress({ stage: "处理资源", processed, total: work.length });
  await pooled(work, 3, async (resource, index) => {
    const { href, info } = resource;
    try {
      checkAbort(signal);
      if (info.unsupported) throw new Error("不支持的资源地址");
      if (info.external) {
        const image = await client.image(info.external, signal);
        checkAbort(signal);
        const target = allocate("assets/remote-" + String(index + 1).padStart(4, "0") + "." + image.extension);
        output.file(target, image.data);
        replacements.set(href, { path: target, suffix: new URL(info.external).hash });
      } else if (paths.has(info.local)) {
        replacements.set(href, { path: paths.get(info.local), suffix: info.suffix });
      } else {
        // Only retrieve SiYuan assets; never arbitrary files on the Docker host.
        const asset = info.local?.match(/(?:^|\/)assets\/(.+)$/);
        if (!asset || !safeZipPath(asset[1])) throw new Error("导出包内没有该资源");
        const original = "assets/" + asset[1];
        const data = await client.binary(endpoint(client.base, original.split("/").map(encodeURIComponent).join("/")), signal);
        checkAbort(signal);
        const target = allocate("assets/" + asset[1].split("/").map(safeName).join("/"));
        output.file(target, data); paths.set(info.local, target);
        replacements.set(href, { path: target, suffix: info.suffix });
      }
    } catch (error) {
      checkAbort(signal);
      warnings.push(href + "\n  原因：" + error.message + "；已保留原链接。");
    } finally {
      processed++;
      if (!signal?.aborted) onProgress({ stage: "处理资源", processed, total: work.length });
    }
  }, signal);
  checkAbort(signal);
  output.file(name + ".md", rewriteMarkdown(markdown, scan.resources, replacements));
  const notes = [...new Set(warnings)];
  if (notes.length) output.file("导出说明.txt", "Markdown 导出说明\n\n原笔记未修改。以下内容请检查：\n\n" + notes.map((w, i) => (i + 1) + ". " + w).join("\n\n") + "\n");
  onProgress({ stage: "打包下载", percent: 0 });
  const blob = await zipBlob(output, signal, percent => onProgress({ stage: "打包下载", percent }));
  checkAbort(signal);
  return { blob, filename: name + ".zip", warnings: notes, resourceCount: processed };
}
module.exports = { KernelClient, exportDocument, EXPORT_OPTIONS, IMAGE_LIMIT, IMAGE_TIMEOUT, safeName, safeZipPath, appBase, endpoint, exportURL, resourcePath, pooled, zipBlob };
