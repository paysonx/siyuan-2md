"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("../vendor/jszip.cjs");
const { scanMarkdown, rewriteMarkdown } = require("../src/markdown.cjs");
const { exportDocument, KernelClient, EXPORT_OPTIONS, safeName, appBase, exportURL, resourcePath, zipBlob } = require("../src/exporter.cjs");
const ID = "20261124123456-abcdefg";
const png = Uint8Array.from([137,80,78,71,13,10,26,10]);
async function fixture(markdown, files = {}, options = {}) {
  const zip = new JSZip(); zip.file(options.mdName || "测试.md", markdown);
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const calls = [], imageCalls = [];
  const client = {
    base: new URL("https://notes.example/siyuan/"),
    async post(path, body) { calls.push({ path, body }); return path.endsWith('getBlockKramdown') ? { kramdown: options.original || markdown } : { zip: "/export/test.zip" }; },
    async binary(url) { if (url.includes("/export/")) return bytes; throw new Error("HTTP 404"); },
    async image(url, signal) { imageCalls.push(url); if (options.image) return options.image(url, signal); return { data: png, extension: "png" }; },
  };
  return { client, calls, imageCalls };
}
async function unpack(result) { return JSZip.loadAsync(await result.blob.arrayBuffer()); }

test("Markdown lexer preserves code/math and handles references, quotes, lists, tables and HTML", () => {
  const md = '# Title\n\n![a](https://x/a.png "title")\n\n`![a](https://x/a.png)`\n\n```md\n![a](https://x/a.png)\n```\n\n$$![a](https://x/a.png)$$\n\n> quote\n> ![b][image]\n\n- task\n  ![c](assets/c.png)\n\n| A | B |\n|---|---|\n| ![d](assets/d.png) | hi |\n\n<img src="assets/e.png">\n\n[image]: https://x/b.png\n';
  const scan = scanMarkdown(md);
  assert.equal(scan.resources.length, 5);
  const replacements = new Map(scan.resources.map((r, i) => [r.href, "assets/" + i + ".png"]));
  const out = rewriteMarkdown(md, scan.resources, replacements);
  assert.match(out, /!\[a\]\(assets\/0.png "title"\)/);
  assert.match(out, /`!\[a\]\(https:\/\/x\/a.png\)`/);
  assert.match(out, /```md\n!\[a\]\(https:\/\/x\/a.png\)\n```/);
  assert.match(out, /\$\$!\[a\]\(https:\/\/x\/a.png\)\$\$/);
  assert.match(out, /> !\[b\]\(assets\/1.png\)/);
  assert.match(out, /  !\[c\]\(assets\/2.png\)/);
  assert.match(out, /<img src="assets\/4.png">/);
});
test("nested linked image rewrites both destinations without changing label", () => {
  const md = '[![cover](https://x/cover.png)](assets/book.pdf#page=2)';
  const scan = scanMarkdown(md);
  const out = rewriteMarkdown(md, scan.resources, new Map([
    ['https://x/cover.png', { path: 'assets/cover.png' }],
    ['assets/book.pdf#page=2', { path: 'assets/book.pdf', suffix: '#page=2' }],
  ]));
  assert.equal(out, '[![cover](assets/cover.png)](assets/book.pdf#page=2)');
});
test("footnote images are localized without treating footnote markers as file links", () => {
  const md = '引用[^1]\n\n[^1]: ![a](https://x/a.png)\n    ![b](assets/b.png)\n\n正文\n';
  const scan = scanMarkdown(md);
  assert.equal(scan.resources.length, 2);
  assert.deepEqual(scan.resources.map(r => r.href), ['https://x/a.png', 'assets/b.png']);
  const out = rewriteMarkdown(md, scan.resources, new Map([['https://x/a.png', 'assets/a.png']]));
  assert.match(out, /引用\[\^1\]/);
  assert.match(out, /\[\^1\]: !\[a\]\(assets\/a.png\)/);
});
test("HTML comments and raw code elements never download their sample links", () => {
  const scan = scanMarkdown('<!-- <img src="https://x/a.png"> -->\n<code>![a](https://x/a.png)</code>\n<script>var a = \'<img src="https://x/a.png">\';</script>');
  assert.equal(scan.resources.length, 0);
});
test("escaped literals, indented code and shortcut references", () => {
  const md = '\\![a](https://x/a.png)\n\n    ![a](https://x/a.png)\n\n![ref]\n\n[ref]: https://x/b.png';
  const scan = scanMarkdown(md);
  assert.equal(scan.resources.filter(r => r.image).length, 1);
  const out = rewriteMarkdown(md, scan.resources, new Map([['https://x/b.png', 'assets/b.png']]));
  assert.match(out, /!\[ref\]\(assets\/b.png\)/);
});
test("single-document export preserves attachments, deduplicates images, skips external media", async () => {
  const f = await fixture('![本地](assets/图片%20一.png)\n![外链](https://x/a.png)\n![重复](https://x/a.png)\n[PDF](assets/a.pdf#page=3)\n<audio src="https://x/song.mp3"></audio>\n\n```mermaid\ngraph TD; A-->B\n```', { 'assets/图片 一.png': png, 'assets/a.pdf': '%PDF-test' });
  const progress = [];
  const result = await exportDocument({ id: ID, client: f.client, onProgress: p => progress.push(p) });
  const zip = await unpack(result), md = await zip.file('测试.md').async('string');
  assert.equal(f.imageCalls.length, 1);
  assert.deepEqual(f.calls.find(c => c.path.endsWith('exportMd')).body, { id: ID, ...EXPORT_OPTIONS });
  assert.equal(result.filename, '测试.zip');
  assert.equal(result.warnings.length, 0);
  assert.ok(zip.file('assets/图片 一.png'));
  assert.ok(zip.file('assets/a.pdf'));
  assert.match(md, /assets\/a.pdf#page=3/);
  assert.match(md, /https:\/\/x\/song.mp3/);
  assert.match(md, /```mermaid\ngraph TD; A-->B\n```/);
  assert.ok(progress.some(p => p.stage === '打包下载'));
});
test("failures keep original links, include a report and still finish", async () => {
  const f = await fixture('![bad](https://x/bad.png)\n[missing](assets/missing.pdf)', {}, { image() { throw new Error('HTTP 403'); } });
  const result = await exportDocument({ id: ID, client: f.client });
  const zip = await unpack(result);
  assert.equal(result.warnings.length, 2);
  assert.match(await zip.file('测试.md').async('string'), /https:\/\/x\/bad.png/);
  assert.match(await zip.file('导出说明.txt').async('string'), /HTTP 403/);
});
test("nested document directory is flattened, attachment markdown is not mistaken for a second article", async () => {
  const f = await fixture('[file](assets/readme.md)\n![a](../assets/a.png)', { 'folder/assets/readme.md': 'attachment', 'assets/a.png': png }, { mdName: 'folder/文章.md' });
  const result = await exportDocument({ id: ID, client: f.client });
  const zip = await unpack(result);
  assert.ok(zip.file('文章.md')); assert.ok(zip.file('assets/readme.md'));
  assert.match(await zip.file('文章.md').async('string'), /!\[a\]\(assets\/a.png\)/);
});
test("multi-document ZIP is rejected", async () => {
  const f = await fixture('hello', { 'child.md': 'unexpected child' });
  await assert.rejects(exportDocument({ id: ID, client: f.client }), /实际得到 2 篇/);
});
test("source widgets and database blocks produce a conversion warning even if removed by the kernel", async () => {
  const f = await fixture('静态正文', {}, { original: '<div data-type="NodeAttributeView" data-av-id="x"></div>\n<iframe src="/widgets/a"></iframe>' });
  const result = await exportDocument({ id: ID, client: f.client });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join('\n'), /数据库/);
  assert.match(result.warnings.join('\n'), /挂件/);
});
test("concurrent downloads are limited to three", async () => {
  let active = 0, maximum = 0;
  const f = await fixture(Array.from({ length: 8 }, (_, i) => `![x](https://x/${i}.png)`).join('\n'), {}, {
    async image() { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 5)); active--; return { data: png, extension: 'png' }; },
  });
  await exportDocument({ id: ID, client: f.client });
  assert.equal(maximum, 3);
});
test("cancellation stops export instead of producing a partial download", async () => {
  const controller = new AbortController();
  const f = await fixture('![a](https://x/a.png)', {}, { image() { controller.abort(); return { data: png, extension: 'png' }; } });
  await assert.rejects(exportDocument({ id: ID, client: f.client, signal: controller.signal }), { name: 'AbortError' });
  const zip = new JSZip(); zip.file('a.txt', 'abc'.repeat(100000));
  const c = new AbortController();
  await assert.rejects(zipBlob(zip, c.signal, () => c.abort()), { name: 'AbortError' });
});
test("kernel proxy enforces timeout parameters, response MIME and size", async () => {
  let request;
  const fetcher = async (url, init) => { request = { url, ...init }; return Response.json({ code: 0, data: { status: 200, contentType: 'image/png', body: btoa(String.fromCharCode(...png)) } }); };
  const client = new KernelClient('https://notes.example/siyuan/', fetcher);
  const result = await client.image('https://x/a.png');
  assert.equal(result.extension, 'png');
  const body = JSON.parse(request.body);
  assert.equal(body.timeout, 30000); assert.equal(body.responseEncoding, 'base64');
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.url, 'https://notes.example/siyuan/api/network/forwardProxy');
  client.fetcher = async () => Response.json({ code: 0, data: { status: 200, contentType: 'text/html', body: btoa('<html>login</html>') } });
  await assert.rejects(client.image('https://x/a.png'), /不是支持的图片/);
  client.fetcher = async () => Response.json({ code: 0, data: { status: 200, contentType: 'image/png', body: 'a'.repeat(27962033) } });
  await assert.rejects(client.image('https://x/a.png'), /超过 20 MB/);
});
test("timeouts and login pages have actionable errors", async () => {
  const client = new KernelClient('https://notes.example/', async () => new Response('<html>login</html>'));
  await assert.rejects(client.post('api/test', {}), /登录状态/);
  await assert.rejects(client.withTimeout(undefined, 5, signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))))), /请求超时/);
});
test("safe names and reverse proxy paths", () => {
  assert.equal(safeName('CON'), '_CON'); assert.equal(safeName('a/b:c?'), 'a_b_c_');
  assert.equal(appBase('https://notes.example/siyuan/stage/build/desktop/?x=1').href, 'https://notes.example/siyuan/');
  assert.equal(exportURL('https://notes.example/siyuan/', '/export/测试.zip'), 'https://notes.example/siyuan/export/%E6%B5%8B%E8%AF%95.zip');
  assert.throws(() => exportURL('https://notes.example/', 'https://evil.test/a.zip'));
  assert.throws(() => exportURL('https://notes.example/', '/export/../secret'));
  assert.equal(resourcePath('https://notes.example/siyuan/assets/a.png', 'test.md', 'https://notes.example/siyuan/').local, 'assets/a.png');
  assert.equal(resourcePath('https://notes.example/siyuan/assets/%invalid.png', 'test.md', 'https://notes.example/siyuan/').unsupported, true);
});
