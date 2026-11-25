"use strict";
const { Plugin, showMessage } = require("siyuan");
const { KernelClient, exportDocument, appBase } = require("./exporter.cjs");

function selectedDocument(detail) {
  if (!detail || detail.type !== "doc") return null;
  const items = detail.items;
  if (items?.length > 1 || (!items?.length && detail.elements?.length !== 1)) return null;
  const id = items?.[0]?.id || detail.elements?.[0]?.getAttribute("data-node-id");
  return /^\d{14}-[a-z0-9]{7}$/.test(id || "") ? id : null;
}

class MarkdownExportPlugin extends Plugin {
  onload() {
    this.tasks = new Map(); this.panels = new Set(); this.urls = new Set(); this.closeTimers = new Set();
    this.onMenu = event => {
      const id = selectedDocument(event.detail);
      if (!id) return;
      event.detail.menu.addItem({
        icon: "iconDownload", label: "导出 Markdown", click: () => { void this.startExport(id); },
      });
    };
    this.eventBus.on("open-menu-doctree", this.onMenu);
  }
  onunload() {
    this.eventBus.off("open-menu-doctree", this.onMenu);
    for (const task of this.tasks.values()) task.abort();
    for (const timer of this.closeTimers) clearTimeout(timer);
    this.closeTimers.clear();
    for (const panel of this.panels) panel.remove();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.panels.clear(); this.urls.clear();
  }
  makePanel(controller) {
    const panel = document.createElement("section");
    panel.className = "siyuan-2md-panel";
    panel.setAttribute("aria-label", "Markdown 导出");
    // Static template only; document titles, URLs and server errors use textContent.
    panel.innerHTML = '<div class="siyuan-2md-heading">导出 Markdown</div><div class="siyuan-2md-status" role="status" aria-live="polite">准备文档…</div><progress aria-label="导出进度"></progress><details hidden><summary>查看导出说明</summary><pre></pre></details><div class="siyuan-2md-actions"><a hidden></a><button type="button" class="b3-button b3-button--outline">取消</button></div>';
    const button = panel.querySelector("button");
    button.onclick = () => { controller.abort(); button.disabled = true; button.textContent = "正在取消…"; };
    document.body.append(panel); this.panels.add(panel);
    return panel;
  }
  async startExport(id) {
    if (this.tasks.has(id)) { showMessage("这篇文章正在导出，请勿重复操作。"); return; }
    // Official exports use title-based temporary paths; serialize within this plugin.
    if (this.tasks.size) { showMessage("请先完成或取消当前导出，再导出另一篇文章。"); return; }
    // Retain one completed download only; releasing it avoids retaining large Blobs.
    for (const previous of [...this.panels]) previous.querySelector("button").click();
    const controller = new AbortController(); this.tasks.set(id, controller);
    const panel = this.makePanel(controller);
    const status = panel.querySelector(".siyuan-2md-status"), bar = panel.querySelector("progress");
    let downloadURL, closeTimer, downloaded = false;
    try {
      const client = new KernelClient(appBase(window.location.href));
      const result = await exportDocument({ id, client, signal: controller.signal, onProgress: progress => {
        status.textContent = progress.stage + (progress.total !== undefined ? `（${progress.processed}/${progress.total}）` : "…");
        if (progress.total !== undefined) { bar.max = progress.total || 1; bar.value = progress.processed; }
        else if (progress.percent !== undefined) { bar.max = 100; bar.value = progress.percent; }
        else bar.removeAttribute("value");
      } });
      if (controller.signal.aborted) return;
      downloadURL = URL.createObjectURL(result.blob); this.urls.add(downloadURL);
      const link = panel.querySelector("a");
      link.href = downloadURL; link.download = result.filename;
      status.textContent = result.warnings.length ? `已触发下载，有 ${result.warnings.length} 项需要检查。` : "已触发浏览器下载。";
      bar.max = 1; bar.value = 1;
      if (result.warnings.length) {
        panel.querySelector("details").hidden = false;
        panel.querySelector("pre").textContent = result.warnings.join("\n\n");
      }
      link.click();
      downloaded = true;
    } catch (error) {
      status.textContent = controller.signal.aborted ? "已取消导出。" : "导出失败：" + error.message;
      bar.hidden = true;
    } finally {
      this.tasks.delete(id);
      const button = panel.querySelector("button");
      button.disabled = false; button.textContent = "关闭";
      button.onclick = () => {
        clearTimeout(closeTimer); this.closeTimers.delete(closeTimer);
        panel.remove(); this.panels.delete(panel);
        if (downloadURL) { URL.revokeObjectURL(downloadURL); this.urls.delete(downloadURL); }
      };
      if (downloaded) {
        closeTimer = setTimeout(() => button.onclick(), 1000);
        this.closeTimers.add(closeTimer);
      }
    }
  }
}
module.exports = MarkdownExportPlugin;
module.exports.selectedDocument = selectedDocument;
