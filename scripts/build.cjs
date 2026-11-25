"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("../vendor/jszip.cjs");
const root = path.resolve(__dirname, "..");
async function build() {
  const modules = ["vendor/jszip.cjs", "vendor/marked.cjs", "src/markdown.cjs", "src/exporter.cjs", "src/index.cjs"];
  const wrappers = [];
  for (const id of modules) wrappers.push(JSON.stringify(id) + ":function(module,exports,require){\n" + await fs.readFile(path.join(root, id), "utf8") + "\n}");
  const bundle = '// Bundled locally; JSZip 3.10.1 and Marked 17.0.5 licenses are included.\n' +
    '(function(hostRequire){\nconst modules={' + wrappers.join(",\n") + '};\nconst cache={};\n' +
    'function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;modules[id](module,module.exports,function(name){if(name==="siyuan")return hostRequire(name);const p=id.split("/");p.pop();for(const s of name.split("/")){if(s==="..")p.pop();else if(s!==".")p.push(s);}return load(p.join("/"));});return module.exports;}\n' +
    'module.exports=load("src/index.cjs");\n})(require);\n';
  const dir = path.join(root, "dist", "siyuan-2md");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.js"), bundle);
  const files = ["plugin.json", "index.css", "README.md", "LICENSE", "vendor/JSZip-LICENSE.md", "vendor/Marked-LICENSE.md"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  const zip = new JSZip();
  for (const file of ["index.js", ...files]) zip.file(file, await fs.readFile(path.join(dir, file)));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
  const output = path.join(root, "dist", `siyuan-2md-${manifest.version}.zip`);
  await fs.writeFile(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  // Manual installs must retain the manifest name as the plugin directory.
  const manual = new JSZip();
  for (const file of ["index.js", ...files]) manual.file(`${manifest.name}/${file}`, await fs.readFile(path.join(dir, file)));
  const manualOutput = path.join(root, "dist", `${manifest.name}-${manifest.version}-manual.zip`);
  await fs.writeFile(manualOutput, await manual.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  console.log("Built " + manualOutput);
  console.log("Built " + output);
  return output;
}
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build };
