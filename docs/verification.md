# 验证说明

## 接口依据

开发时读取官方 `v3.8.10` 标签源码核对，而不是将主分支参数当作旧版保证：

- https://github.com/siyuan-note/siyuan/blob/v3.8.10/kernel/api/export.go
- https://github.com/siyuan-note/siyuan/blob/v3.8.10/kernel/apicontract/export.go
- https://github.com/siyuan-note/siyuan/blob/v3.8.10/kernel/model/export.go
- https://github.com/siyuan-note/siyuan/blob/v3.8.10/kernel/conf/export.go
- https://github.com/siyuan-note/siyuan/blob/v3.8.10/kernel/api/network.go
- https://github.com/siyuan-note/siyuan/blob/v3.8.10/app/src/menus/navigation.ts
- 插件事件结构参考：https://github.com/siyuan-note/petal/blob/main/siyuan.d.ts
- 插件清单参考：https://github.com/siyuan-note/plugin-sample/blob/main/plugin.json

采用 `/api/export/exportMd`，显式设置 `includeSubDocs=false`、`includeRelatedDocs=false`、`blockRefMode=4`、`blockEmbedMode=0`。`/api/network/forwardProxy` 使用 GET、base64 响应、30000ms 超时；不设置鉴权或 Cookie 头。

## 自动化验证

`node --test test/*.test.cjs` 覆盖资源改写、保留代码/公式、内部附件、中文空格文件名、引用式图片、嵌套图片链接、外链去重、并发上限、错误继续、取消、路径检查、代理响应校验，以及单篇范围保护。

2026-11-24：15 项自动化测试通过。真实 Chrome 158 的离线集成测试也通过：根路径和 `/notes/` 子路径下验证了菜单筛选、ZIP 下载并解压检查、脚注图片、失败报告、取消、防重复与卸载清理。API 与插件宿主由测试替身提供，未运行真实思源内核。测试脚本为 `scripts/browser-test.cjs`，需要 Playwright；可用 `PLAYWRIGHT_MODULE_PATH` 指定模块路径、`CHROME_PATH` 指定 Chrome 可执行文件。

## 真实 Docker 验收

本工作区没有连接用户实际思源服务。自动化模拟通过不能代替真实内核及浏览器登录验证。安装后按以下顺序检查：

1. 单篇文档菜单出现按钮，笔记本及多选菜单不出现。
2. 导出有子文档的文章，ZIP 仅有一篇主 Markdown。
3. 内部图片、含空格的 PDF 和音视频附件解压后能打开；PDF 页码仍有效。
4. 公网图片收进 `assets/`；失效图片仍保留外链，说明文件记录原因。
5. 块引用、嵌入、表格、公式及 Mermaid 与原文逐项核对。
6. 取消后不出现 ZIP 下载；重复点击不启动重复任务。
7. 普通根路径与实际反向代理路径各做一次下载验证。
8. 导出前后对比原文及全局导出设置，确认未被插件修改。
