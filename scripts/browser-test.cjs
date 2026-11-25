"use strict";
// Run against real headless Chromium with fully offline intercepted SiYuan APIs.
// Set PLAYWRIGHT_MODULE_PATH when Playwright is not installed in this project.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const JSZip = require("../vendor/jszip.cjs");
const { build } = require("./build.cjs");
const root = path.resolve(__dirname, "..");
const ID = "20261124123456-abcdefg";
async function main() {
  await build();
  const input = new JSZip();
  input.file("浏览器测试.md", '# 浏览器测试\n\n![本地](assets/local.png)\n![外链](https://images.example/ok.png)\n![失效](https://images.example/bad.png)\n[附件](assets/manual.pdf#page=2)\n\n引用[^1]\n\n[^1]: ![引用图片](https://images.example/ok.png)');
  input.file("assets/local.png", new Uint8Array([137,80,78,71,13,10,26,10]));
  input.file("assets/manual.pdf", "%PDF-test");
  const zipBytes = await input.generateAsync({ type: "nodebuffer" });
  let exportCalls = 0, slow = false;
  const seen = [];
  const routeHandler = async route => {
    const request = route.request();
    const send = (body, contentType = "application/json", status = 200) => route.fulfill({ status, contentType, body });
    try {
      const pathname = new URL(request.url()).pathname;
      const local = pathname.replace(/^\/notes/, "");
      if (local === "/index.js" || local === "/index.css") {
        await send(await fs.readFile(path.join(root, "dist", "siyuan-2md", local.slice(1))), local.endsWith(".js") ? "text/javascript" : "text/css"); return;
      }
      if (local === "/export/fixture.zip") { await send(zipBytes, "application/zip"); return; }
      if (local.startsWith("/api/")) {
        const body = request.postDataJSON(); seen.push({ pathname, body });
        let data;
        if (local.endsWith("getBlockKramdown")) data = { kramdown: "普通正文" };
        else if (local.endsWith("exportMd")) {
          exportCalls++; assert.equal(body.includeSubDocs, false); assert.equal(body.includeRelatedDocs, false);
          if (slow) await new Promise(resolve => setTimeout(resolve, 300));
          data = { zip: "/export/fixture.zip" };
        } else if (local.endsWith("forwardProxy")) data = body.url.includes("bad") ? { status: 403, body: "", contentType: "text/html" } : { status: 200, body: "iVBORw0KGgo=", contentType: "image/png" };
        else { await send("", "text/plain", 404); return; }
        await send(JSON.stringify({ code: 0, data })); return;
      }
      const prefix = pathname.startsWith("/notes/") ? "/notes" : "";
      await send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}/index.css"><main><h1>SiYuan 插件浏览器测试</h1><div id="menu"></div></main><script>
        const listeners = new Map(); window.messages=[];
        window.require = name => { if(name !== 'siyuan') throw Error('Unexpected host dependency: '+name); return {Plugin: class {constructor(){this.eventBus={on:(n,f)=>listeners.set(n,f),off:(n,f)=>{if(listeners.get(n)===f)listeners.delete(n)}}}},showMessage: text=>messages.push(text)}; };
        window.module={exports:{}};
        window.emitMenu=(type='doc')=>{document.querySelector('#menu').replaceChildren();listeners.get('open-menu-doctree')?.({detail:{type,items:[{id:'${ID}'}],menu:{addItem(item){const b=document.createElement('button');b.textContent=item.label;b.onclick=item.click;document.querySelector('#menu').append(b)}}}})};
        window.listenerCount=()=>listeners.size;
      </script><script src="${prefix}/index.js"></script><script>window.plugin=new module.exports();plugin.onload();emitMenu();</script>`, "text/html; charset=utf-8");
    } catch (error) { await send(String(error), "text/plain", 500).catch(() => {}); }
  };
  const origin = "https://siyuan-test.invalid";
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const prefix of ["", "/notes"]) {
      const context = await browser.newContext({ acceptDownloads: true });
      await context.route("**/*", routeHandler);
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + prefix + "/stage/build/desktop/");
      assert.equal(await page.getByRole("button", { name: "导出 Markdown", exact: true }).count(), 1);
      await page.evaluate(() => emitMenu('notebook'));
      assert.equal(await page.locator('#menu button').count(), 0);
      await page.evaluate(() => emitMenu('docs'));
      assert.equal(await page.locator('#menu button').count(), 0);
      await page.evaluate(() => emitMenu());
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "浏览器测试.zip");
      const output = await JSZip.loadAsync(await fs.readFile(await download.path()));
      assert.ok(output.file("assets/manual.pdf"));
      const md = await output.file("浏览器测试.md").async("string");
      assert.match(md, /assets\/remote-/); assert.match(md, /https:\/\/images.example\/bad.png/);
      assert.match(md, /\[\^1\]: !\[引用图片\]\(assets\/remote-/);
      assert.match(await output.file("导出说明.txt").async("string"), /403/);
      assert.equal(await page.getByRole("link", { name: "重新下载 ZIP" }).count(), 1);
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      assert.equal(await page.locator(".siyuan-2md-panel").count(), 0);
      slow = true;
      const before = exportCalls; let cancelledDownloads = 0;
      page.on("download", () => cancelledDownloads++);
      await page.evaluate(() => { void plugin.startExport('20261124123456-abcdefg'); void plugin.startExport('20261124123456-abcdefg'); });
      await page.waitForFunction(() => messages.some(text => text.includes('重复')));
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByText("已取消导出。", { exact: true }).waitFor();
      assert.ok(exportCalls - before <= 1);
      assert.equal(cancelledDownloads, 0);
      await page.evaluate(() => plugin.onunload());
      assert.equal(await page.evaluate(() => listenerCount()), 0);
      assert.equal(await page.locator('.siyuan-2md-panel').count(), 0);
      assert.deepEqual(errors, []);
      console.log(`PASS real Chromium: ${prefix || '/'} menu, ZIP download/content, failure report, cancel, dedup, unload`);
      slow = false; await context.close();
    }
    assert.ok(seen.some(item => item.pathname === '/notes/api/network/forwardProxy'));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
