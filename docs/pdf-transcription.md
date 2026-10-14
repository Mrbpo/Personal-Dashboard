# PDF 转写与检索：管理员指南

## 数据保存

- 原始 PDF 仍保存在 `LIBRARY_DIR` 的内容哈希 blob 中，文档名称、归属、课程、来源和哈希保留在现有 `library_documents` metadata。转写不会替换原件。
- PostgreSQL 保存完整逐页正文：`document_texts` 记录文档和当前版本，`document_text_versions` 保存解析器版本、文本哈希、页数及警告，`document_text_pages` 保存全文和实际 PDF 页码。印刷页码或幻灯片编号不代替 PDF 页码。
- 每页关联 `evidence`；来源版本保留原文件哈希、`library://<hash>` 原件引用和实际提取方法等 metadata。证据摘录可以截短，但全文页表不能截短。重新解析保留旧版本，在短事务中提交新版本并切换当前版本。 稳定质量 metadata（规范化警告、提取方法及局部修复 provenance）参与解析/来源版本身份；同正文新增警告也须新版本与证据，不能被幂等冲突吞掉。获取时间与远程任务 ID 不参与身份，同输入重放不会生成版本。既有版本不会因代码升级自动改写；纯正文哈希不含警告，完全相同原页的向量仍可合法复用。
- `document_text_chunks` 是可重建的检索索引；`KernelService.rebuildDocumentSearch(owner, documentId)` 可从 PostgreSQL 当前全文页重建，不需要重新请求 AI。网站 PDF 预览和全文搜索优先读取内核，搜索返回文件、页码及证据引用。SQLite 页和 chunk 是兼容缓存，不能作为新的全文权威层。

## 解析方式与额度

设置应用和 worker 的 `KERNEL_DATABASE_URL`、现有 `DATABASE_URL` / `LIBRARY_DIR` 及 `DOCLING_URL` 后，先检查 PDF 原生文字层：文字覆盖足够完整时直接使用逐页原文，不再整份 OCR。`DOCLING_NATIVE_TEXT_FASTPATH=false` 可关闭此路径。稀疏页眉或图片扫描不能仅凭存在文字层跳过解析。

原生文字不足时，默认由 Docling 提取正文、OCR 和表格；阅读顺序依据文档树，页码依据 PDF provenance。管理员可明确设置 `PDF_SCAN_TRANSCRIPTION_BACKEND=ai`，让扫描页使用受限视觉转写，而非默认开启额外付费识别。视觉转写上限为每文档 24 页、每 UTC 日 60 页，仍受现有 AI 预算限制；超过 24 页会在请求前拒绝，应分册。完整处理的成功页缓存用于续跑。

视觉结果的 `complete` 表示全页区域是否已处理。局部无法辨认的字、公式或图表保留原位 `[无法可靠辨认]`，`uncertain_spans` 保存区域和原因，并在页前添加警告；允许保留其他可靠内容，不能猜写或宣称字句全部准确。整页区域遗漏、提供方输出截断、`complete=false` 或无效警告格式仍拒绝缓存和发布。Docling 失败、部分成功、缺页及无法确认的空白页也不能静默标记成功。

默认公式路径为 `DOCLING_FORMULA_BACKEND=ai`：复用现有受限 AI 识别器，仅追加原页可见公式的 LaTeX，保留正文。文档额度为 24 个公式页，UTC 日额度为 60 页，另受现有 AI 预算限制；额度不能通过重试绕过。成功结果按文档、页码及该页正文哈希缓存；失败或不完整结果保留警告，不作为成功缓存。

没有凭据、超出额度、网络失败或公式无法看清时，正文仍可检索，公式必须核对原 PDF。`docling-v2-search` 表示使用了公式增强流程，不是数学正确性的证明；须同时查看版本警告及原页。

Docling 节点非空 `text` 优先；为空时保留非空 `orig` 原始抽取文本，不能将已经抽取的公式静默丢掉。原始公式回退不添加 LaTeX 显示定界符，并记录“未验证 LaTeX、符号和上下标”警告。非空机器公式也默认记录符号和上下标未核验警告，不能凭启用了增强或输出看似有效 LaTeX 宣称原式正确；真正逐式核验须另有明确 provenance。该默认警告适用于后续解析，不会追写已经保存的旧版本。原始回退不等于启动了公式增强，也不保证数学阅读顺序或内联符号完整。新代码通过可选 `parser_warnings` 将当前版本警告传给 `DocumentTextHit`、严格/普通资料搜索、API/引用及问答/导师的实际模型输入，旧来源默认 `[]`。固定 developer 指令禁止把未验证抽取式断言为精确原式或补造缺失符号，已支持的普通正文可正常回答。该链路代码尚未生产发布；精确公式仍须核对原 PDF，字段存在不代表模型已通过真实数学忠实验收。

| 配置 | 行为 |
| --- | --- |
| 默认，或 `DOCLING_FORMULA_BACKEND=ai` | 原生文字快速路径或 Docling 正文/OCR/表格，加受限 AI 公式增强 |
| `DOCLING_FORMULA_ENRICHMENT=false` | 仅正文模式，版本 `docling-v2-text-search`，保留公式未验证警告 |
| `DOCLING_FORMULA_BACKEND=docling` | 本地 CPU 公式增强；须有正确的 `codeformulav2` 模型及 `DOCLING_FORMULA_PRESET=codeformulav2` |
| `PDF_SCAN_TRANSCRIPTION_BACKEND=ai` | 原生文字不足时整页视觉转写，包含正文和可辨认公式；不再叠加单页公式增强 |
| `PDF_VISUAL_TILED_INPUT=true` | 将同一原页提供为四个有重叠的放大视图；拼接为一页并保持原 PDF 页码，不按四页计来源 |
| `PDF_VISUAL_IMAGE_INPUT=true` | 有本地渲染器时将原页渲染为图片输入，避免 PDF 文字层丢失绝对值等符号；该模式优先于四视图，渲染失败退回原页 PDF |

`DOCLING_FORMULA_ENRICHMENT=false` 只关闭独立公式增强，不关闭已明确配置的 AI 整页视觉转写。零付费正文处理须同时使用默认 `PDF_SCAN_TRANSCRIPTION_BACKEND=docling`；不能将正文模式误称为数学验收成功。

### 官方公式模型资产与持久缓存

`codeformulav2` 需要 [官方 CodeFormulaV2 模型](https://huggingface.co/docling-project/CodeFormulaV2)；公开、非受限访问，许可证为 `cdla-permissive-2.0`。本次准备锁定 commit `ecedbe111d15c2dc60bfd4a823cbe80127b58af4`，共 **13 个文件 / 639,800,205 bytes**；`model.safetensors` 为 630,993,616 bytes，官方 SHA-256 为 `4b04e77af34c4e682a7ab1617628340d658f3c3dcd12456dd2a7fff805cf79d2`。其余文件的官方 Git blob 校验值与本地 SHA/大小也核验，清单位于服务器 `/srv/study/docling-models/code-formula-assets.json`。按固定 revision 的官方 `resolve/<revision>/<file>` 下载完整文件，不使用会变化的 `main` 作为验收版本。

现有官方安装的 `docling-tools models download code_formula --output-dir <cache-root>` 可以选择公式资产，[官方离线模型说明](https://docling-project.github.io/docling/usage/advanced_options/)给出缓存准备机制；当前 CLI 不提供 revision 参数。固定版本准备须明确指定官方 revision，并核对完整文件清单和校验值，不能把仅建立目录或添加挂载当作安装成功。无需新增推理组件，也不全局开启公式增强。

服务器 host 持久资产为 `/srv/study/docling-models/docling-project--CodeFormulaV2`，缓存根目录 mode `0700`、owner UID `1001`，与现有 Docling 运行用户一致。Compose 仅将该子目录只读挂到 `/opt/app-root/src/.cache/docling/models/docling-project--CodeFormulaV2`，保留镜像自带 layout/OCR 等兄弟目录；明确 `DOCLING_SERVE_ARTIFACTS_PATH` 为同一父目录。**host 资产已经实际准备；PDF 应用正式发布尚未进行**。早期先将模型复制进既有容器；随后为了单页 FP32 诊断，仅受控重建 Docling 并通过只覆盖该服务的 overlay 实际挂载同一模型子目录及官方管理员 named preset 配置。PG、web 和 worker 容器保持原样。该隔离诊断运行配置不等于整批 PDF 应用已部署。资产可按固定官方 revision 重新下载，不需要加入冗余数据备份；原件、数据库和恢复配置的现有备份要求不变。

修复前的单页任务在约 5 秒内报告 `CodeFormulaV2 not found in artifacts_path`，未发生 OOM，未输出转写；安装资产不等于公式忠实验收通过。CPU、内存及逐式准确率必须由受控原页探测另行报告，不凭权重存在宣称生产可用。

安装后的 BF16 单页任务最终 `success`，实际 `processing_time=1112.06` 秒（约 18.5 分钟）；早期两个 300 秒观察窗口只记录运行中，不是 conversion failure。5 秒采样的 `memory.current` 最高约 2.82 GiB / 4 GiB，OOM/重启为零；当时 cgroup 历史峰值不能归为该任务。原图核验发现公式 (3) 将加一移入下标、公式 (8) 改变条件下标及帽号，Beta 定义段也存在重复/缺括号；虽然 26 个 ψ 字符重新出现，仍未通过忠实度，结果没有发布。完整结果和人工核验保留在隔离资料目录 `hw4-formula-model-ready.result.json` / `hw4-bf16-manual-review.json`。

虚拟 CPU 无 AVX512_BF16 / AMX_BF16 指令，已安装的默认 CodeFormulaV2 Transformers preset 使用 BF16；实际推理约占三个核。这个配置可解释性能风险，不能断言是唯一原因。管理员通过官方 `DOCLING_SERVE_CONFIG_FILE` 提供 named preset `codeformulav2_cpu_fp32`，仅将原模型 `extra_config.torch_dtype` 改为 `float32`，保持默认 preset 及禁止客户端 custom JSON 的设置。服务健康检查通过，模型 revision、原件/派生输入 SHA、页面及其他请求选项均不变。

FP32 同一单页只提交一次；首个 300 秒观察结束时仍 `started`，后续只读 GET 取得同一任务成功结果，实际 `processing_time=374.77` 秒（约 6.25 分钟），比 BF16 约快 2.97 倍。这个单页 A/B 不能代表全库速度。此次新容器实测 `memory.peak` 达 4 GiB，`memory.events.max=581`，但 `oom=oom_kill=0`、重启为零，表明更高的内存压力。8 个公式节点及全部正文 `text` 与 BF16 完全相同；再次对照原图，公式 (3)、(8) 和 Beta 定义的上述错误仍然存在。因此本页数学忠实度仍未通过，不能用成功速度或 ψ 数量替代准确率。原结果只留在 staging，没有再次提交、没有 OpenAI 调用、没有更改知识库当前版本。完整结果、收据及人工核验位于隔离资料目录 `hw4-fp32.result.json`、`hw4-fp32.receipt.json`、`hw4-fp32-manual-review.json`；named 配置与单服务 overlay 亦保存在该目录。FP32 不作为默认应用配置，该 probe 不能证明全库 CPU 公式增强可用。

早期 4 GB 主机 / 2 GB 容器试验记录（历史）：12 页 CPU 公式识别超过约 15 分钟的轮询窗口，2 GB 配置还出现模型内存不足；扫描资料的正文/OCR 在临时 3 GB 配置下也曾 OOM，不能宣称提高到 3 GB 即可使用。当时曾恢复为 2 GB 容器。**当前为升级后的 8 GB 主机 / 4 GiB 容器**，已完成公开隔离正文资料发布；公式模型的本次单页耗时与未完成忠实验收见上，不把早期资源值当作现状，也不默认启用全库 CPU 公式识别。

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

原生正文不足时，Docling 默认串行解析 **1 个原始 PDF 页**。从原件明确复制页索引，生成仅包含本批页的临时 PDF，传输局部范围 `1..批次页数`；严格验证局部页码后，按复制索引映射回原始页码。原件身份和哈希不变，不把临时 PDF 注册为新的资料。`DOCLING_BATCH_PAGES` 仅允许 1–4，增加批量必须实际验证资源：当前 2 GiB 环境中，整份课件、带整份原件的范围 5–8，以及带整份原件的单页范围 1–1 都触发 OOM；不能把一次范围 1–4 成功视为四页普遍安全。

派生单页传输仍不等于资源问题解决：正式任务的原始第 1 页派生输入（63,296 bytes）也在默认模型配置下触发 OOM（2026-10-11 22:20:32 UTC），服务重启后轮询返回 404，进度保持 0/39。Docling v1.35.0 的实际默认设置核验为两个 local worker、模型不共享、启动预加载、缓存两个转换器；这些设置可能增加模型副本，但尚不能断定它们是唯一 OOM 原因。[官方配置说明](https://github.com/docling-project/docling-serve/blob/v1.35.0/docs/configuration.md)。Compose 改为一个 worker、共享模型、关闭预加载和单转换器缓存；服务器已临时应用相同低并发配置、通过健康检查并恢复隔离任务，资源上限不变，完整解析仍待验证。

`payload.doclingProgress` 保存原件/用户/文档身份、配置指纹、固定范围计划、复制页索引、临时输入哈希、当前远程任务 ID 和已验证批次 blob 校验值。临时输入使用固定元数据，恢复时重建并核对字节哈希及索引。草稿结果不进入全文页、证据或检索；恢复时核对身份、校验值及准确原始页码，损坏或丢失的草稿仅重新解析该范围。传输指纹为 `docling-derived-v1`，拒绝复用旧的整份原件范围进度。旧 `payload.doclingTaskId` 只可续轮询原来的整份任务，不能当成第一批页范围；旧任务丢失后才改走新的有限批次。

原文完整 1..N 页通过后，一次短事务发布全文、证据和当前版本，并在该事务内锁定和验证任务租约；失效 worker 不能发布。原件 blob 在解析前及发布前核验。批次结果仅是可重建的缓存，但仍在任务中被引用时垃圾回收不得删除；公式增强仍在整份原件上进行一次，不能按批次获得额外的 24/60 页额度。直接无任务调用只保留兼容行为，不提供 PostgreSQL 进度恢复保证；正式 worker 和隔离验收使用持久化任务。

解析器重启后，旧远程任务可能返回 404。已有任务且仍持有经核验的派生输入时，可以清除失效远程 ID，仅重新提交当前未完成批次一次；新提交任务再次 404 时仍报错。已验证的页级缓存不重解析，legacy 无输入任务不允许重新提交整份 PDF。

失败重解析保留之前有效的全文、搜索和预览，同时记录任务错误及文档警告。检查任务状态、文档版本、警告与实际页数，而不是仅检查命令退出成功或 SQLite `ready`。管理员可使用现有任务重试入口；批量回填也可重试终态任务。

## 验收与交付状态

公开多文档检索及三页公式样本的执行方法见 [pdf-search-benchmark.md](pdf-search-benchmark.md)。正文命中、公式逐式核对分别报告；没有结果时不填写通过率，也不能把单页样本扩大为全库数学准确率。

截至 2026-10-14，公开隔离资料库已完整发布 **228 份 / 2935 原始页**（新 121 份与旧 107 份干扰资料），没有因此认证全库数学转写。最新完整 fresh 基准记录为 92% / 98% / 100%，三组均需达到 95% 的关口尚未通过；后续小样校准不是完整关口成绩。两页既有 Docling `orig` 缓存经原件/结果/派生输入 SHA 核验后零请求恢复并通过 CAS 发布完整新版本；仅两页变化，16 个原始公式块恢复，ψ 等内联符号仍不完整。四次已失败的视觉识别及 $0.014309 成本仍保留，未发布不忠实结果。详细记录见 [pdf-page-repair.md](pdf-page-repair.md)。下列早期进度与探针按发生时记录，不能当作当前库未完成的证据。

| 状态 | 本轮证据与限制 |
| --- | --- |
| 代码完成 | 转写、持久化、检索、回填及通用原始文本回退已实现，位于 PR #52 待总调度最终审阅；不代表已合并 |
| 测试通过 | 原始文本回退 focused decoder 检查 10/10，类型与 targeted lint 通过；此前真实 PostgreSQL 针对性检查及完整正文发布证据保留。fresh 三组检索关口仍未全部通过；两页数学符号仍不完整，不能宣称全库公式通过 |
| 服务已部署 | **未部署 PDF 应用代码**；仅 Docling 低并发运行配置已实际应用并健康，隔离转写试验不是应用发布 |
| 生产已切换 | **未切换**；生产读写不能凭脚本或配置文件视为完成 |

GitHub 鉴权已恢复，PDF 改动进入草稿 PR #52；派生单页传输 `4effee6` 两项 CI 通过，之后的低并发配置补充仍需对应最新提交 CI。派生页传输的针对性 PostgreSQL 检查 16/16 通过，无跳过；外部 Docling 在这些自动检查中为模拟响应。实际原始第 1 页和含大图片的第 17 页派生输入探针解析成功，分别约 40.3 和 25.4 秒，但正式任务第 1 页后来 OOM，因此尚不能证明整份 39 页或全部复杂资料已完成。新资料盲测工具另在草稿 PR #54，其 `c39646a` 两项 CI 通过。本指南及部署配置均不是上线证据。

2026-10-12 更新：`1680a95` / `2fdce71` CI 通过。39、87、40 页三份复杂 PDF 完整提交；后续文档在 24/54 暂存页处正常停机升级，快照记录共 96 份/1,338 页正式正文。服务器已升级到 8 GB / 4 vCPU，Docling 限额为 4 GiB，并把低并发设置持久写入服务器的基础 Compose，避免日常备份恢复默认配置。网站恢复的仍是 `6325c5e`；PDF 应用代码尚未发布。全量新资料解析与三组检索总关口继续进行。

PDF 发布范围已与 PR #50 的待验收问答页面和提示词拆开。当前重排失败会在相同范围内重新查询当前关键词证据一次，避免将模型等待期间失效的旧正文作为回退结果；同一获取时间使用相同的稳定文档 ID 决胜规则，避免 PostgreSQL 与兼容缓存互相排除。三个新增真实 PostgreSQL 案例通过，无跳过；只执行本次新增案例，没有重复旧套件。两个远程任务丢失的模拟回归案例也通过。CI 改为 PR 分支检查及 main 提交检查，避免同一次 PR 推送触发两份重复检查。

## 可选语义重排

`KernelService.searchDocumentText(owner, query, {semantic:true})` 对当前用户、课程、版本内的最多 80 个关键词候选页重排；不是遍历全库向量。每页最多 6000 字符、每批 32 页，使用 768 维 `text-embedding-3-small`，受每日 200 次请求及现有预算限制。查询缓存按用户隔离，页面缓存绑定版本与输入哈希；修改原文后旧缓存不会参与新版本排序。缓存仅是可重建索引，原文与证据仍在 PostgreSQL。

默认内核文档查询不调用模型；旧资料库只有显式 `kernelSemantic:true` 或配置 `KERNEL_DOCUMENT_SEMANTIC=true` 才启用新页重排，未经全部关口验证的评分策略不默认启用。重排失败返回关键词结果，并标记 `retrieval_mode=keyword-fallback`；严格检索不调用模型。重排仅能调整已召回页面，不能修复完全没有关键词重合的漏召回。报告须分别记录两种模式，回退不能算作语义成功。

`aiRerank:true` 为另一个显式实验选项：最多 20 个词法/语义候选页、每页前 6000 字符，只请求原有页面身份的完整排列，使用 `gpt-5-mini`，每日最多 200 次、每次 30 秒及现有预算。成功缓存绑定用户、查询、候选版本/正文哈希、模型与提示版本；原文、证据和当前版本再次校验。向量不可用时仍可使用关键词候选完成 AI 排序，并在 `degraded_reason` 保留向量失败原因；AI 也失败时才回退关键词结果。输出不能生成事实或替代原文。这条路径尚未通过全部真实验收，不自动启用。
