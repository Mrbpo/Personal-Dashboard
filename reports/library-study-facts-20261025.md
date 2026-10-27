# 资料库选文件问答与课程事实：阶段交付

日期：2026-10-25（America/Toronto）。Issue：#250。

代码提交：`a8edd5647136adcb26458461a4ee1d73d9f37aa6`。基线：`b1431ff1ea28860cd51dbd34b5d6cd88de181dcc`。独立分支 `codex/library-study-facts`；28 个代码／测试文件，+1357/-60。这是已有候选分支上的增量交付，不合并大型 PR #186，不部署生产。

## 1. 四项状态

| 项目 | 当前结论 |
| --- | --- |
| 代码完成 | P1 选资料问答闭环已实现；P2 事实查询、有效性和保守候选入库已实现。P2 的广泛文档提取与跨来源身份关联、P3 复杂内容可靠性、P4 完整验收尚未完成。 |
| 测试通过 | 针对性回归 47/47；最后新增有效性边界后的该模块为 21/21。真实 HTTP 的功能检查及一条真实 PDF 问答通过；不等于完整内容验收。 |
| 服务已部署 | **否**。只运行过隔离临时 PostgreSQL 和本地网站；验证结束均已关闭。 |
| 生产已切换 | **否**。未迁移生产、未修改生产环境配置、未切换读写、未合并 PR。 |

三组连续完整内容验收仍为 **0/3**；没有修改旧 Gold、旧评分或历史报告。

## 2. 已实现的用户闭环

- `/study` 和已有 `/library/[id]` 共用 `components/library-study-panel.tsx`，没有新增页面或视觉体系。
- 选择资料库现有 PDF，最多 8 份；支持 `auto / document / facts / combined`。
- SQLite 仅保存对话范围与版本，不成为课程事实权威副本。每轮保存实际模式、范围版本及来源引用。
- PDF 问答只检索选中文件；未选择、无权限、删除或未解析完成时明确失败，不扩大到全库。
- 事实查询调用 PostgreSQL 的 `KernelService.answerCourseFacts`，不受选中 PDF 限制；组合模式分别取证后返回。
- 切换资料使用乐观版本检查；生成期间拒绝修改范围，后续追问不继承其他范围的证据。
- 引用保留证据链接，并提供实际物理页的阅读器链接，例如 `?page=7`。
- 新对话按 owner/requestId 持久绑定，丢失响应后重试复用原对话和已完成回答。改题或改范围复用旧 requestId 会返回 409。
- 旧生产实现和 backend 配置回退保留；新链失败不自动切旧算法。

主要代码：`lib/study-session.ts`、`lib/tutor.ts`、`app/api/v1/study/route.ts`、`app/api/tutor/route.ts`；阅读器和学习页共用上述组件。`lib/library.ts` 在 kernel 模式按真实 PostgreSQL 文档就绪状态展示，并停止混入旧 SQLite 搜索结果。

## 3. 课程事实、有效性与 PDF 候选

- `lib/kernel/course-facts.ts` 从 canonical fact/version/evidence 读取，校验 owner、当前采纳值、来源版本与 PDF 定位；不从任务缓存拼出权威事实。
- `lib/kernel/fact-validity.ts` 分开计算生效时间、版本、确认、来源消失、同步新鲜度、课程／学期结束与任务状态。
- 默认保留未完成的逾期任务，并显示未来 16 天；明确取消的截止信息排除。来源消失或学期结束不能自动完成／取消任务。
- 日期精度保持原值；仅日期使用已确认课程时区比较，不写入虚构 23:59。时区未知时保留未知状态。
- API 支持 `history` 和带偏移的 `asOf`；仅有明确有效时间的事实能承担历史生效结论，覆盖不足会报告。
- 迁移 018 给旧 evidence 的有效性依据默认 `unknown`，不把历史抓取时间追认为生效时间；有效性投影可重建。
- `lib/kernel/document-course-facts.ts` 只提取明确的作业、提交、考试、评分和政策行；记录原始片段、页码、UTF-16 范围、内容／源哈希、解析器和提取版本。不处理不可靠表格，不猜年月、时区或公式。
- 迁移 019 关联候选与原页证据。所有 PDF 提取结果强制 pending，复用现有 CLI 和裁决审计；不直接改任务、截止日期或事件。
- 租约与文档当前版本在注册事务内再次检查；过期租约、隐藏／更新来源拒绝入库，幂等重放不重复生成。
- worker 复用现有持久任务：PDF 候选按版本增量，状态投影按小时／每日幂等入队，无定时模型重读。

管理员可对一个已入库文档执行：

```text
npm run kernel:review -- queue-document-facts <document-id>
npm run kernel:review -- list
npm run kernel:review -- show <candidate-id>
npm run kernel:review -- accept <candidate-id> "核对原文后的采纳理由"
```

保持默认关闭的配置：`KERNEL_DOCUMENT_FACTS=true` 才启用候选任务；`KERNEL_COURSE_FACTS_ENABLED=true` 且 backend=kernel 才启用周期投影。新迁移须先按既有迁移流程应用；本次只应用到临时测试库。

**限制：**这是窄范围确定性提取，不是通用 syllabus 理解。非 ISO 日期仍为原文／未知；跨来源身份不确定时仍待裁决，尚未完成任意 PDF 与已有 Canvas 任务的自动关联及延期裁决。课程自然语言别名／模糊对象识别也没有全面验收。

## 4. 有明确假设的修复

| 问题及假设 | 修改 | 最小验证与结论 |
| --- | --- | --- |
| 原生文本 PDF 有正文却无页结构，问答读取父页失败；不是检索未命中 | `service.ts` 为 PDF 保存基本物理页结构，不虚构章节／关系 | 同一原件正文不变，页上下文读取成功；后续真实 HTTP 可以生成。未证明表格／公式结构正确。 |
| 生产候选模型只允许开发专用标记，真实 API 在生成前失败 | `study-answer.ts`、`document-answer.ts`、`ai-budget.ts` 统一显式服务器开关 | `STUDY_ALLOW_CANDIDATE_GENERATION=true`，不设置开发后门标记，真实网站 API 成功。默认关闭，原预算、计费和调用边界保留。 |
| POST 已成功但追加 GET 失败会丢失 thread；响应丢失可能重复生成 | 直接使用 POST 顶层状态；新增事务性 owner/requestId 绑定 | 并发单元检查只建一条对话；实际 HTTP 两次 POST 返回同一回答，改题返回 409，0 AI。 |
| 日期-only 的 canonical due 不带时区，窗口误排除 | 只读 canonical 课程时区用于比较，不改存储值 | 单元检查精度／原值不变；真实事实 API 能返回对应作业。 |
| 未完成逾期任务被固定过去 16 天窗口裁掉 | 不限制逾期任务年龄，未来部分仍限制 16 天 | 新增旧逾期及明确取消边界，最终模块 21/21。 |

最后一项初测失败源于新增夹具使用了不存在的 `canvasStatus='cancelled'` 约定；改为系统已有的明确 canonical `cancelled=true` 证据。初次失败日志保留，未改历史测试答案。

## 5. 真实验证与费用

所有原始回执位于本工作树 `data/`，不随公开仓库提交：

| 回执 | 实际结果 |
| --- | --- |
| `final-focused-tests.log` | 47 pass、0 fail、0 skipped，含真实隔离 PG 候选注册／重放／租约检查；不含不存在的 `tests/ai-budget.test.ts`。 |
| `validity-final-tests.log` | 新增边界后的有效性模块 21 pass、0 fail。此前新增夹具失败另存 `validity-cancel-fixture-initial-failure.log`。 |
| `http-functional-results.json` | 资料目录、读范围、跨选中文档的事实路由、刷新持久化、旧 revision 409、无资料 400、不可用资料 422 等检查，0 AI。 |
| `http-idempotency-history-results.json` | 重试同一对话／回答、无重复消息、变更 payload 409、历史参数入回答记录，0 AI。 |
| `pdf-fact-review-results.json` | 合成 PDF 产生 3 条 pending，明确人工采纳 1 条提交要求；事实查询返回，原页证据 GET 200，0 AI。 |
| `paid-content-response*.json` | 第一条原 g3-c20 问题先被配置／结构守卫阻断；最后只完成 selector，生成前受模型守卫阻断。**没有通过，不做付费重试。** |
| `paid-subset-response.json`、`paid-subset-citation-check.json` | 第二条问题 HTTP 200：50 小时是否为 150 小时子集；两条断言人工对照原 PDF 第 7 页成立，唯一引用 GET 200。非盲测。 |
| `model-cost-closure.json` | 本轮 **5 次付费调用，US$0.08026775，0 未结算**；包含第一题已收费 selector。上限原为 2 题、10 调用、US$1。 |
| `final-typecheck.log`、`final-changed-lint.log` | 类型检查通过；本次最后变更的 lint 通过。更广文件检查仅有既存 unused 警告，不宣称全仓零警告。 |

真实 PDF 复用已保存公开论文原件，SHA256 `2ce7f777991bccbb153473a59ea523323cf58c63103477d6b1d2cf03cf920ea5`，14 页。为隔离实例用 pypdf 读取该原件并通过正常内核入库，解析版本明确为隔离导入；**不是 Docling 内容忠实度验收，也不是与历史冻结配置相同的成绩**。

冻结配置：backend=kernel；selector=`gpt-5.4-mini`，generator=`gpt-6.1-sol`，generation reasoning=medium；select-then-answer、selected-once、question-scope、producer-neighbors-v1；关闭 semantic/hybrid/AI rerank；严格使用已选文档。最后的重试／列表边界变更在真实 PDF 回答后完成，未付费重跑原题；不得将该回答宣称为最终冻结配置三组验收。

Key 仅只读现有服务器环境并传入测试进程内存，未写到开发文件、日志或仓库。测试网站已退出，临时 PG 容器和专用 SSH 隧道已关闭；保存 `isolated-kernel-snapshot.sql` 与本地 SQLite／原件／回执用于续作，原生产服务未关闭。

本地界面证据：`data/ui-pdf-study.png`、`data/ui-pdf-study-panel.png`、`data/ui-pdf-answer.png`。

## 6. 未完成项与下一步

1. 审阅增量 PR／CI；保持未合并、未部署。
2. 用现有真实 PDF 的明确原页失败验证课程候选与任务关联，先核对后续成功记录；不重跑已修复 g3-c03 等样本。
3. 复杂表格、公式、图形关系仍须按具体区域归因，unknown 保留；不通过自由视觉改写弥补。
4. 本轮只验证一个真实内容问题，不能给出总体检索召回、结构关系、拒答或最终正确率。多文件综合的功能边界已有检查，内容正确性仍待真实样本。
5. P4 使用冻结代码／资料／模型，通过真实网站 API 完成原定三组完整验收，分别报告六项指标。未达到前不发布生产。

本次没有创建新评测框架、重新跑历史大批测试、重建全库、改动录像／绘画功能或重做生产备份工程。
