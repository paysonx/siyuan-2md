"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("../vendor/jszip.cjs");
const root = path.resolve(__dirname, "..");
async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  const zip = new JSZip();
  const installation = `siyuan-2md-${manifest.version}.zip`;
  zip.file(installation, await fs.readFile(path.join(root, "dist", installation)));
  async function include(relative) {
    const full = path.join(root, relative), stat = await fs.stat(full);
    if (stat.isDirectory()) for (const child of await fs.readdir(full)) await include(relative + "/" + child);
    else zip.file("source/" + relative, await fs.readFile(full));
  }
  for (const file of ["src", "scripts", "test", "docs", "vendor", "package.json", "plugin.json", "index.css", "README.md", "LICENSE", ".gitignore"]) await include(file);
  zip.file("README.md", await fs.readFile(path.join(root, "README.md")));
  const output = path.join(root, "dist", `siyuan-2md-${manifest.version}-delivery.zip`);
  await fs.writeFile(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  console.log("Packaged " + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
