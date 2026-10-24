# 学习内容回答的验收入口

## 最终验收前的来源版本预检（Issue #218）

`node scripts/study-source-preflight.mjs --manifest <source-manifest.json> --metadata <cached-pdf-metadata.json> --output <new-report.json> --final`

该只读命令复用现有 `documents` 来源清单和原生 PDF 元数据缓存，绑定实际 PDF SHA，分别报告论文编号、观测版本、标题提示及作者来源对齐状态。编号匹配不能掩盖标题提示缺失；标题匹配、观测到 v1、下载成功或自声明 `officialAnnotationPdfVersionMatch` 均不能证明作者标注对应版本。仅支持来自独立作者来源的显式 `authorSourcePdfSha256` 或 `authorSourcePdfRevision` 作为正向绑定，不能将刚下载的 SHA/观测版本复制到这两个字段来制造通过。

当前工具针对现有 arXiv 题集的缓存格式，不是其他课程来源的通用解析器。它只检查来源前提，原准确率阈值、冻结样本分母及混合课程资料验收要求均保持不变。

未知或不一致时，`--final` 写出诊断后以退出码 2 拒绝最终验收；不能随后继续付费运行并宣称已满足此前提。省略 `--final` 仅用于保留未知状态的校准调查。输出使用新文件，拒绝覆盖。来源绑定通过仍不代表 PDF 忠实度、结构、检索、答案、引用或拒答通过；这些成绩独立统计。

不删除或替换不匹配样本，不改原始题目、Gold 或旧分数。应保留原件及获取版本，补充正确版本时使用新的来源/解析记录和新的冻结配置；历史结果继续按原资料解释。标题提示缺失也可能源于 TeX 或排版，不能自动判为错误文件。

关联 Issue #68。`lib/kernel/document-answer.ts` 提供应用内、只读的内容回答模块，不新增页面、UI、服务或事实写入。

## 输入与输出

统一入口为 `KernelService.answerStudyContent(owner, question, options, policy)`。它最多检索 14 个完整正文节点，保留调用者的语义、混合与重排选择；检索发生降级时不继续生成回答。可显式选择 `includeParents` 和 `includeImages`，默认仅用完整正文。图片模式须同时使用父上下文模式。当前标题选择及所有来源在生成前后重新验证；用户提交的 JSON、文件名、截图说明或旧搜索片段不能替代该读取。父章节最大 8192 个 Unicode codepoints，计数为原节点正文之和；超限内容明确标记不可用。

完整来源名称的字面提及支持NFKC、可省略的终端PDF扩展名，以及闭集TeX重音符号（acute、grave、diaeresis、circumflex、tilde、macron、dot）的Unicode等价拼写。只转换单个Latin字母的已知重音，不执行或展开其它TeX命令、不去重音、不折叠大小写或模糊匹配。返回位置始终指向原NFKC问题片段，focus仅移除该片段。发现结果仍保留原始存储名称、ID及版本；多个文档等价时保持ambiguous，显式selectedDocumentTitle仍严格匹配存储名称。跨来源提及也使用同一规则。此为来源标签的排版等价，不证明PDF版本或作者标注材料相同，也不证明答案正确；候选查询只读受owner、可见性、课程及显式范围约束的元数据。

回答只能返回以下状态：
- `answered`：每个陈述都要引用本次实际输入的证据。
- `insufficient-evidence`：没有陈述，说明资料不足。
- `conflicting-evidence`：保留至少两条分别引用的相互冲突陈述。

文字引用须在原正文中实际出现，仅允许折叠空白。新生成由模型选择原文单元编号，服务端恢复逐字原文，公共回答仍返回原 support ID 和 `quote`。图片引用须对应实际传入且 SHA、长度、PNG 尺寸一致的像素，公共引文为空；caption 不算图像。返回引用身份、正文 SHA、来源版本、原定位及解析警告，避免把完整存储文本等同于正确转写。模型返回后再次调用 Kernel 读取回调，来源或输入有变化就拒绝发布回答。

旧 literal 回答的严格验证器及唯一编号解析器继续用于历史诊断：输出形状有效、引用的是本次已有文字编号、非空引文不在该正文中，但折叠空白后恰好存在于唯一一份已提供文字证据时，复制输出并修正编号。原始模型对象不变，返回 `citationRepairs` 记录陈述和引用索引、原编号及解析后的编号、双方证据身份和引文 SHA。未知编号、图片、模糊匹配、多个匹配或非法形状均不修正；修正后仍须通过完整严格验证。不删除陈述或引用，不自动请求模型重写。新生成不调用此修正器或回退到旧协议。

历史缓存的离线重放须分别记录原始生成版本和后处理版本，不能宣称已经使用新策略重新生成。引用归属修正不代表语义支持或回答完整。

## 新生成的原文单元协议

`source-quote-units-v1` 将完整已提供文字连续分片，单片不超过 1200 个 UTF-16 code units，优先自然边界且不切断有效 surrogate pair。按原顺序拼接得到逐字原文，不摘要、截断或丢弃；纯空白片也保留，但因严格验证禁止空白引文而不能被选择。输入 `evidence` 仅保留来源身份，正文只在 `quoteUnits` 出现一次。稳定编号绑定协议、正文 SHA、原始证据/定位及确切起止偏移，不依赖临时 eN 标签。

单元编号为 `q:` 加身份 SHA 的前 24 个 hex 字符；来源、正文和引文的完整 SHA 仍保留在审计清单中，编号重复或碰撞会明确失败。请求 builder 在任何 beforeAttempt/预算预留前检查：全 schema 的 enum 不超过 1000 项（含 status 的 3 项）；引用 enum 超过 250 项时，总字符串长度不超过 15000 字符。这遵循 [OpenAI 官方 Structured Outputs 限制](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)。超限拒绝整个请求，不截掉单元或放宽引用规则。

模型的 citation 仅为 `{id: 已提供的可选单元编号或真实图片编号}`，不允许自写 `quote`。服务端恢复公共回答并执行原严格验证；未知编号、重复选择、非法形状、缺少引用，以及将同一来源的不同单元冒充两个冲突来源均失败。保留原始 `providerSelections`；`selectedUnits` 分别记录选择位置、来源身份、偏移和恢复引文 SHA。`quoteUnitManifest` 记录全部文字单元的无正文清单与来源身份，含不可选空白片，并返回清单 SHA。

当前提示词版本为 `grounded-document-answer-v5`，`quoteUnitProtocolVersion` 和清单 SHA 与完整输入指纹一同绑定请求身份；新返回的 `referencePolicyVersion` 也明确标识原文单元协议。旧 literal 协议标识仍保留给历史解析器。没有额外生成、付费修复循环或隐藏回退。分片元数据会增加少量输入开销。

仅 `document-answer` 的现有预算预留改为计算完整序列化请求，包含单元元数据及 `text.format` 的 schema/enum；其他 kind 和费率不变。mini 原有 bytes/2 仍是估算，不能称为严格费用上界。任何有 hard cap 的真实试运行必须在发请求前按完整 UTF-8 payload（含 schema）、framing 和真实图像 patch 的保守界核验；不能只计算 source body，也不能等 provider 结算后才检查超帽。实际调用仍按 provider usage 结算并保留账本，不新增预算系统。

`buildDocumentAnswerRequest(prepared, {model, reasoningEffort, maxOutputTokens})` 是导出的纯组装函数，输入来自 `prepareDocumentAnswer` 的已核验上下文；实际 synthesis 使用同一个返回 body。它不读取来源、发请求或授予开发策略权限。预检应复用它，而非复制 prompt/schema 或猜测 enum 体积：对非图像 JSON 的完整 UTF-8 请求计算保守界，保留 `input_image` 结构但不把 base64 当文字 token，再加实际 PNG 尺寸 patch 和 framing 上界。返回的 `providerRequestSha256` 绑定真实序列化 payload，并参与请求身份。

通用提示要求覆盖问题相关的列表项，数量说明对象、单位、范围与配置，并保留不同解释；这只是生成义务，不是完整性证明。选中了真实单元不保证陈述逻辑正确，也不补齐未提供的表格或图像；这些仍须独立评估。

引用形状、引文存在及版本检查只能证明引用归属，不能证明陈述逻辑正确、证据足够或图表理解正确。真实题库仍须独立评分；检索命中率、全部证据覆盖、回答正确率、拒答和冲突分别报告。原 Gold、原题顺序、分母和既有 top-k 不变。

本模块只用于非结构化学习内容。截止时间、考试日期、课程关系和任务状态必须由 canonical Kernel truth 查询提供；不能通过本模块把 PDF 或邮件正文升级成权威业务状态。

## 模型与开发验收

默认使用 `gpt-5-mini`、low reasoning、4000 输出 token 和 30 秒期限，沿用实际月度账本与 200 次每日规则。没有结果缓存或自动付费重试。

隔离开发作用域通过已审核的 `withDocumentRerankRunPolicy` 环境校验复用精确开发数据库、SQLite 账本和管理员进程标记，并要求请求记录回调。开发默认使用 `gpt-5-mini`、low reasoning、4000 输出 token、30 秒期限；先冻结小批范围及 hard cap，复用已成功的阶段与缓存。旧 Astra 高档运行仅保留为历史证据；高档模型只用于有具体理由且范围明确的少数难题，不能默认整批使用或自动升级。实际计费通过 `paidOpenAI`，保留账本，不使用 bypass。每题的持久化请求和成功检查点由验收运行器管理，不能把回调存在当成已经持久化。

Issue #107 允许在上述显式开发策略中选择 `model: 'gpt-5.4-mini'`，通过原有 `KernelService.answerStudyContent` 或 `answerSelectedStudySource` 调用；不修改请求 body 来冒充模型支持。两条入口均在来源读取或检索前验证策略。完整来源入口仍固定 low/4000/30s，普通调用仍仅允许旧 mini；不新增 UI 模型开关，不修改生产设置或重排模型。纯 `buildDocumentAnswerRequest` 可离线预检新模型，但不能授予执行权限。

原始图表在 Astra 中使用 `detail: original`，两个 mini 均使用 `high`。[官方图像输入说明](https://developers.openai.com/api/docs/guides/images-vision)规定 5.4-mini high 不放大图片，最多 2500 个 32px patch、最长边 2048，patch token 乘数为 1.2。设原图 `P = ceil(width/32) * ceil(height/32)`，其图像 token 不超过 `ceil(1.2 * min(P,2500))`；现完整来源清单按每图 `2P+1` 计入的上界仍更保守，包含 1px 小图，现图片限额保持。此论证仅针对本入口实际的 high 请求，不外推 PDF parser 的 original 模式，也不把预算 bytes/2 估算当作严格费用上界。完整请求仍包括 schema/enum、图片结构、framing 和已验证的原始 PNG。

模型身份、reasoning、输出上限、prompt/引用协议版本、原文单元清单 SHA 和完整输入指纹共同构成请求身份。返回的 `model` 记录 provider 的实际模型字段，`requestedModel` 记录请求模型；请求 SHA 绑定实际 body。Astra 保留既有严格模型校验；5.4-mini 只接受官方明确列出的 `gpt-5.4-mini` 或 `gpt-5.4-mini-2026-03-17`，缺失、其他模型或未知日期快照均拒绝，不重试或自动换模型。此时账本保留预留款待核对，不按所请求的较低费率擅自结算。

`paidOpenAI` 增加标准 5.4-mini 费率：每百万输入 US$0.75、输出 US$4.50、上下文 400000，依据[官方模型与快照说明](https://developers.openai.com/api/docs/models/gpt-5.4-mini)。已有 `AI_MODEL_RATES` 显式覆盖仍保留；此前实验提供了同费率，现应用不再依赖实验脚本补费率。月限额、普通 200/day、开发最多 1000/day、真实 usage 账本均不改变。沿用现通用计费以标准输入价保守计入 cached input，不宣称精确体现缓存折扣；不扩至 Batch、Flex 或区域处理费率。配置和 mock 检查通过不等于语义、文件保真度或其他生产模型通过。

## 开发用逐陈述引用审计

Issue #109 增加 `KernelService.auditSelectedStudySourceClaim(owner, question, expectedSource, binding, policy)`。这是显式开发诊断入口，暂仅支持上述完整选定来源回答。`binding` 必须含原回答的 `inputFingerprint`、`quoteUnitManifestSha256`、完整 `providerSelections` 和 `claimIndex`，不接受调用方提供的引文或 PNG。Kernel 按 owner 与当前来源版本读取完整正文及真实图片，严格恢复整个原选择对象后，只将该陈述与它实际引用的原文单元和图片送入审计。引用不能被换成更有利的证据；来源、正文、图片或结构在请求前后变化均失败。

`citation-local-audit-v1` 固定使用 `gpt-5.4-mini`、low、1000 输出 token、high 图片和 30 秒期限。沿用精确隔离开发环境、每日/月度账本、模型快照 allowlist 和 `beforeAttempt` 请求记录要求；纯 builder 不提供执行权限。`policy.recordResponse` 必须先持久化真实原始 HTTP body、状态、请求身份和 SHA，后续才检查模型身份、JSON/schema 与来源是否仍当前。回调应采用持久化且避免重复覆盖的记录；仅提供一个函数不能证明实际落盘。HTTP 错误、非法 JSON、错误模型或 schema 不应丢失已收到的 raw；超时没有可伪造的响应，既有账本预留保留待核对。一个调用仅发一个请求，不自动重试、改答案或补找引用。

输出将单条陈述映射为 `c0`、原引用顺序映射为固定的 `r0...rN`，要求每个实际引用都有 finding；返回 `supported`、`unsupported` 或 `uncertain`、简短理由及对象/单位/范围对齐诊断，并绑定原陈述、引用、来源 SHA 和原始选择。`unsupported` 只表示这些引用不足或冲突，不表示陈述在全文中必然为假。它不检查全回答完整性、不读取未引用的纠正材料，也不将模型理由写入事实、候选或权威状态。不新增页面、默认回答拦截、数据库表或网络服务。

开发 pilot 复用既有 10 条真实请求与原始响应：5 条已知引用不足、5 条控制样本，其最终判断与独立审阅相符；原费用 US$0.018954，不重跑。这是见过的校准样本，不是新的盲测或整体准确率。case 11 的某条子理由把 mixed impact 说成 small，存在过度解读，不能将诊断理由当作事实保证；case 2 的局部审计也未看到原实体表，不能声称它独立发现了完整的实体/句子计数事实。原 A50 分数、Gold 和历史输出均不修改。

## 当前交付边界

纯验证器和输入打包的测试不能代替真实回答测试。新模块须经 PR、评审及 CI；接入 Kernel 当前上下文接口后才运行冻结的真实问题。代码合并、CI 成功、部署和生产切换分别报告。
