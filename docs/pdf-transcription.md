# PDF 转写与检索：管理员指南

## 数据保存

- 原始 PDF 仍保存在 `LIBRARY_DIR` 的内容哈希 blob 中，文档名称、归属、课程、来源和哈希保留在现有 `library_documents` metadata。转写不会替换原件。
- PostgreSQL 保存完整逐页正文：`document_texts` 记录文档和当前版本，`document_text_versions` 保存解析器版本、文本哈希、页数及警告，`document_text_pages` 保存全文和实际 PDF 页码。印刷页码或幻灯片编号不代替 PDF 页码。
- 每页关联 `evidence`；来源版本保留原文件哈希、`library://<hash>` 原件引用和实际提取方法等 metadata。证据摘录可以截短，但全文页表不能截短。重新解析保留旧版本，在短事务中提交新版本并切换当前版本。
- `document_text_chunks` 是可重建的检索索引；`KernelService.rebuildDocumentSearch(owner, documentId)` 可从 PostgreSQL 当前全文页重建，不需要重新请求 AI。网站 PDF 预览和全文搜索优先读取内核，搜索返回文件、页码及证据引用。SQLite 页和 chunk 是兼容缓存，不能作为新的全文权威层。

## 解析方式与额度

设置应用和 worker 的 `KERNEL_DATABASE_URL`、现有 `DATABASE_URL` / `LIBRARY_DIR` 及 `DOCLING_URL` 后，先检查 PDF 原生文字层：文字覆盖足够完整时直接使用逐页原文，不再整份 OCR。`DOCLING_NATIVE_TEXT_FASTPATH=false` 可关闭此路径。稀疏页眉或图片扫描不能仅凭存在文字层跳过解析。

原生文字不足时，默认由 Docling 提取正文、OCR 和表格；阅读顺序依据文档树，页码依据 PDF provenance。管理员可明确设置 `PDF_SCAN_TRANSCRIPTION_BACKEND=ai`，让扫描页使用受限视觉转写，而非默认开启额外付费识别。视觉转写上限为每文档 24 页、每 UTC 日 60 页，仍受现有 AI 预算限制；超过 24 页会在请求前拒绝，应分册。完整处理的成功页缓存用于续跑。

视觉结果的 `complete` 表示全页区域是否已处理。局部无法辨认的字、公式或图表保留原位 `[无法可靠辨认]`，`uncertain_spans` 保存区域和原因，并在页前添加警告；允许保留其他可靠内容，不能猜写或宣称字句全部准确。整页区域遗漏、提供方输出截断、`complete=false` 或无效警告格式仍拒绝缓存和发布。Docling 失败、部分成功、缺页及无法确认的空白页也不能静默标记成功。

默认公式路径为 `DOCLING_FORMULA_BACKEND=ai`：复用现有受限 AI 识别器，仅追加原页可见公式的 LaTeX，保留正文。文档额度为 24 个公式页，UTC 日额度为 60 页，另受现有 AI 预算限制；额度不能通过重试绕过。成功结果按文档、页码及该页正文哈希缓存；失败或不完整结果保留警告，不作为成功缓存。

没有凭据、超出额度、网络失败或公式无法看清时，正文仍可检索，公式必须核对原 PDF。`docling-v2-search` 表示使用了公式增强流程，不是数学正确性的证明；须同时查看版本警告及原页。

| 配置 | 行为 |
| --- | --- |
| 默认，或 `DOCLING_FORMULA_BACKEND=ai` | 原生文字快速路径或 Docling 正文/OCR/表格，加受限 AI 公式增强 |
| `DOCLING_FORMULA_ENRICHMENT=false` | 仅正文模式，版本 `docling-v2-text-search`，保留公式未验证警告 |
| `DOCLING_FORMULA_BACKEND=docling` | 本地 CPU 公式增强；须有正确的 `codeformulav2` 模型及 `DOCLING_FORMULA_PRESET=codeformulav2` |
| `PDF_SCAN_TRANSCRIPTION_BACKEND=ai` | 原生文字不足时整页视觉转写，包含正文和可辨认公式；不再叠加单页公式增强 |
| `PDF_VISUAL_TILED_INPUT=true` | 将同一原页提供为四个有重叠的放大视图；拼接为一页并保持原 PDF 页码，不按四页计来源 |
| `PDF_VISUAL_IMAGE_INPUT=true` | 有本地渲染器时将原页渲染为图片输入，避免 PDF 文字层丢失绝对值等符号；该模式优先于四视图，渲染失败退回原页 PDF |

`DOCLING_FORMULA_ENRICHMENT=false` 只关闭独立公式增强，不关闭已明确配置的 AI 整页视觉转写。零付费正文处理须同时使用默认 `PDF_SCAN_TRANSCRIPTION_BACKEND=docling`；不能将正文模式误称为数学验收成功。

本轮真实 CPU 公式试验中，12 页超过约 15 分钟的轮询窗口；2 GB 配置还出现模型内存不足，因此本地 CPU 公式路径不能作为默认方案。扫描资料的正文/OCR 在临时 3 GB 配置下也曾 OOM，不能宣称提高到 3 GB 即可使用。本地 Compose 与服务器资源均恢复为原来的 2 GB。正式启用扫描 Docling 前仍须解决资源阻塞并实际验收。

## 管理员批量回填

在已配置数据库、原件目录和 Docling 的应用运行环境执行：

```sh
npm run pdf:reindex -- --owner <owner-id> --limit 20 --offset 0
npm run pdf:reindex -- --owner <owner-id> --course <course-id> --limit 20 --offset 20
# 仅由已保存的全文重建检索索引，不重新解析、不调用 AI。
npm run pdf:reindex -- --owner <owner-id> --rebuild-search --limit 500
```

`--owner` 必填；`--course` 可选；`--limit` 为 1–500，默认 20；`--offset` 默认 0。输出包含本批文档、`nextOffset` 和总数。按稳定文档列表分批运行；回填期间新增或删除文档会改变 offset，应核对文档 ID。命令在有 `DOCLING_URL` 时仅入队，不代表解析完成。不要删除旧文字或手工修改事实表。

任务保存在 PostgreSQL `ingestion_jobs`，幂等键包含文档 ID、原件哈希和解析器版本；管理员回填可重新唤起已完成或失败的任务。worker 续租，重启后接管过期租约。任务保存入队时的公式、扫描后端及来源哈希；与缓存指纹不一致的配置不能混用旧进度。

原生正文不足时，Docling 默认串行解析 **1 个原始 PDF 页**。`DOCLING_BATCH_PAGES` 仅允许 1–4，增加批量必须实际验证资源：当前 2 GiB 环境中，39 页课件整份及范围 5–8 都触发 OOM，不能把一次范围 1–4 成功视为四页普遍安全。

`payload.doclingProgress` 保存原件/用户/文档身份、配置指纹、固定范围计划、当前远程任务 ID 和已验证批次 blob 校验值。草稿结果不进入全文页、证据或检索；恢复时核对身份、校验值及准确原始页码，损坏或丢失的草稿仅重新解析该范围。旧 `payload.doclingTaskId` 只可续轮询原来的整份任务，不能当成第一批页范围；旧任务丢失后才改走新的有限批次。

原文完整 1..N 页通过后，一次短事务发布全文、证据和当前版本，并在该事务内锁定和验证任务租约；失效 worker 不能发布。原件 blob 在解析前及发布前核验。批次结果仅是可重建的缓存，但仍在任务中被引用时垃圾回收不得删除；公式增强仍在整份原件上进行一次，不能按批次获得额外的 24/60 页额度。直接无任务调用只保留兼容行为，不提供 PostgreSQL 进度恢复保证；正式 worker 和隔离验收使用持久化任务。

失败重解析保留之前有效的全文、搜索和预览，同时记录任务错误及文档警告。检查任务状态、文档版本、警告与实际页数，而不是仅检查命令退出成功或 SQLite `ready`。管理员可使用现有任务重试入口；批量回填也可重试终态任务。

## 验收与交付状态

公开多文档检索及三页公式样本的执行方法见 [pdf-search-benchmark.md](pdf-search-benchmark.md)。正文命中、公式逐式核对分别报告；没有结果时不填写通过率，也不能把单页样本扩大为全库数学准确率。

| 状态 | 本轮证据与限制 |
| --- | --- |
| 代码完成 | 本地工作树已实现转写、持久化、检索及回填代码，待总调度最终审阅；不代表已合并 |
| 测试通过 | 旧固定资料修复后前五文件/实际页码命中为 98%/100%/100%，无异常或回退；分批针对性真实 PostgreSQL 检查 16/16 通过、无跳过。新三组 107 份/1,865 页完整关口仍未完成；公式严格符号仍是 7/9，不能宣称全部通过 |
| 服务已部署 | **未部署本轮代码**；隔离试验不是应用部署 |
| 生产已切换 | **未切换**；生产读写不能凭脚本或配置文件视为完成 |

GitHub 鉴权已恢复，PDF 改动进入草稿 PR #52；其 `0c4fc93` 检查通过，后续分批改动仍须对应最新提交的 CI。新资料盲测工具另在草稿 PR #54。本指南及部署配置均不是上线证据。

## 可选语义重排

`KernelService.searchDocumentText(owner, query, {semantic:true})` 对当前用户、课程、版本内的最多 80 个关键词候选页重排；不是遍历全库向量。每页最多 6000 字符、每批 32 页，使用 768 维 `text-embedding-3-small`，受每日 200 次请求及现有预算限制。查询缓存按用户隔离，页面缓存绑定版本与输入哈希；修改原文后旧缓存不会参与新版本排序。缓存仅是可重建索引，原文与证据仍在 PostgreSQL。

默认内核文档查询不调用模型；旧资料库只有显式 `kernelSemantic:true` 或配置 `KERNEL_DOCUMENT_SEMANTIC=true` 才启用新页重排，未经全部关口验证的评分策略不默认启用。重排失败返回关键词结果，并标记 `retrieval_mode=keyword-fallback`；严格检索不调用模型。重排仅能调整已召回页面，不能修复完全没有关键词重合的漏召回。报告须分别记录两种模式，回退不能算作语义成功。

`aiRerank:true` 为另一个显式实验选项：最多 20 个词法/语义候选页、每页前 6000 字符，只请求原有页面身份的完整排列，使用 `gpt-5-mini`，每日最多 200 次、每次 30 秒及现有预算。成功缓存绑定用户、查询、候选版本/正文哈希、模型与提示版本；原文、证据和当前版本再次校验。向量不可用时仍可使用关键词候选完成 AI 排序，并在 `degraded_reason` 保留向量失败原因；AI 也失败时才回退关键词结果。输出不能生成事实或替代原文。这条路径尚未通过全部真实验收，不自动启用。
