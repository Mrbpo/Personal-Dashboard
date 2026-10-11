# PDF 新资料盲测验收

关联 Issue #53；依赖 PDF 持久化与检索 PR #52。测试程序为 `scripts/benchmark-pdf-heldout.mjs`，不修改 UI，也不接触生产资料。

## 冻结资料与期望

| 资料集 | PDF 数 | 实际页数 | 题数 | 来源 |
| --- | ---: | ---: | ---: | --- |
| Stanford SEE CS229 | 20 | 226 | 50 | 官方讲义、课程信息、作业、复习资料和课堂问答 |
| MIT OCW 6.006 Spring 2020 | 57 | 351 | 50 | 官方讲义、习题课、作业与解答 |
| CMU 15-213 Fall 2015 | 30 | 1,288 | 50 | 官方课件、大纲、实验说明和习题课 |
| 合计 | 107 | 1,865 | 150 | 全部为独立于旧 19 份资料的新原件 |

三个资料组分别依据原始 PDF 建题、核对实际页码并冻结；没有读取新查询的检索成绩。问题包含解释、步骤和原因，查询不带文件名或页码。Stanford 原资料包含教师与学生的课堂问答，但这不等于验证私人 Piazza、Canvas 或邮件混合检索。公开 FAQ HTML 仅为来源说明，不计入本次 PDF 成绩。

原件 SHA-256、字节数、页数、URL 及逐页独立 pypdf 文本保存在各组 `manifest.json` 与 reference 文件中。问题记录原始摘录、文字锚点、摘录校验值和正确文件/实际页码；程序必须先核验这些内容再调用应用。

| 冻结对象 | SHA-256 |
| --- | --- |
| Stanford questions.json | `5d4a80ec8797f403f8f2c323f3ab5a53987a9c0e645039dc4be37f28695f3a23` |
| Algorithms questions.json | `7195e3e75126877383d9f4285a03bdf456deea8ebfc88bf76dc40c7657d03ef0` |
| Systems questions.json | `a1059b024cdf46724afe82d3ac2a9c1467b890ee7063ff9dff17eb31f52366bd` |
| 三组期望按程序序列化的合并值 | `28c65b8437f0535fb157a53d2b5fbed3d1f031481fa20a20f9a56de00a2c772a` |

公开原件和完整题库留在忽略的 `data/pdf-heldout/`，不提交或重新分发 PDF。Stanford / MIT 有开放教学许可；CMU 文件可公开读取，但本轮未确认再分发许可，仅供本地及隔离验收使用。

## 真实应用验收

在专用 `pdf_acceptance_20261006` PostgreSQL、`/pdf-data/benchmark.sqlite` 和 `/pdf-data/library` 中运行；测试 bootstrap 强制隔离数据库并拒绝生产原文目录。所有新资料使用独立 owner `public-pdf-heldout-20261011`，三组互为全库干扰项，旧公开资料不混入评分。既有费用账本保持不变，不创建另一账本绕过额度。

正文必须经过实际 `saveDocument → convertDocumentWithDocling → KernelService.ingestParsedDocument`，不能把独立 reference 文本直接注入数据库。原始文档身份和实际 PDF 页码保持一致。检索调用真实 `kernel.searchDocumentText` 及 `library.searchLibrary`，无课程或单文件限制，每题记录前五条、页码、证据、模式、错误与回退。

每组两个入口各 50 题，前五结果中正确文件与实际页码命中率至少 95%，且全部 107 份原件状态 ready、页序齐全、无查询错误、回退或缺失证据，才通过。缺失资料和解析失败不能删除出题目分母。

解析与检索的版本分别记录：排序基线 `f01644c` 冻结；任何之后的解析修复另披露，不把已观察失败后调参称为原版盲测。若查看成绩后改排序，须保留该次失败报告，并再准备未见的新资料验证。

### 运行方式

准备好的资料目录中应有三个组的 manifest、questions、原件及逐页 reference。服务器隔离容器由现有 `scripts/pdf-acceptance-env.mjs` 引导：

```sh
PDF_HELDOUT_DIR=/pdf-data/pdf-heldout node scripts/benchmark-pdf-heldout.mjs --validate-only
PDF_HELDOUT_DIR=/pdf-data/pdf-heldout node scripts/benchmark-pdf-heldout.mjs --native-preflight
PDF_HELDOUT_DIR=/pdf-data/pdf-heldout node scripts/benchmark-pdf-heldout.mjs --ingest
PDF_HELDOUT_DIR=/pdf-data/pdf-heldout node scripts/benchmark-pdf-heldout.mjs
```

前三项各自不会执行检索；默认检索不调用付费模型。显式 `--ai-rerank` 单独报告 AI 排序；`--group=stanford` 只缩小题目组，仍使用全部三个资料组作为干扰项。AI 开关只影响排序，不能补造缺失正文或更改答案。

程序写入 `reports/coverage.json`、`progress.json`、`keyword.json` 或 `ai.json`。失败返回非零退出码，报告保留全部原始题目和失败项。期望改变时立即拒绝运行。

## 当前真实结果：2026-10-11

- 原件/期望核验已完成：107 PDF、1,865 页、150 题。
- 原生文字预检有 92 份满足现有严格快速路径；15 份需要原始空白页核验或复杂解析。页数对应本身不代表内容完整。
- 第一轮真实导入成功提交 Stanford 与 MIT 的 77 份、577 页；其中 MIT 一份 2 页 PDF 通过 Docling，其余走原生文字。
- CMU `01-overview.pdf` 39 页整份提交触发 Docling OOM。Docker 在 `2026-10-11T21:45Z` 记录 `oom` / `die`；未发布该文件的部分正文。
- 同一原件范围 `[1,4]` 的受控探针成功，约 91 秒；容器随后内存约 1.62 GiB，限额仍为 2 GiB。这个探针不计入正式入库或搜索成绩。
- 随后的 `[5,8]` 探针也触发 OOM（`21:52Z`），证明四页不是通用安全批次；正在验证单页。不会扩大服务器内存限额或把第一次成功扩大为整份课件已解析。
- 原件抽查发现真实短页、图片正文遗漏与损坏字符映射并存，不能通过放宽字数条件或把短页标为空白来“通过”测试。

**新资料验收尚未通过；尚未查看新检索成绩。** 当前在补有限分批和持久化续跑。该工作不证明全部图片、图表、公式或 AI 最终回答正确，也不证明服务已部署或生产已切换。

## 交付状态

| 项目 | 状态 |
| --- | --- |
| 代码完成 | PDF 基础与排序修复已提交 PR #52；大文件分批解析仍在补充 |
| 测试通过 | #52 提交 `0c4fc93` 的 CI 与旧固定资料定位关口通过；本页的新三组总关口未通过 |
| 服务已部署 | 本轮只运行隔离验收；未部署新 PDF 代码到业务服务 |
| 生产已切换 | 未切换 |
