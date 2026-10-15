# 学习内容回答的验收入口

关联 Issue #68。`lib/kernel/document-answer.ts` 提供应用内、只读的内容回答模块，不新增页面、UI、服务或事实写入。

## 输入与输出

统一入口为 `KernelService.answerStudyContent(owner, question, options, policy)`。它最多检索 14 个完整正文节点，保留调用者的语义、混合与重排选择；检索发生降级时不继续生成回答。可显式选择 `includeParents` 和 `includeImages`，默认仅用完整正文。图片模式须同时使用父上下文模式。当前标题选择及所有来源在生成前后重新验证；用户提交的 JSON、文件名、截图说明或旧搜索片段不能替代该读取。父章节最大 8192 个 Unicode codepoints，计数为原节点正文之和；超限内容明确标记不可用。

回答只能返回以下状态：
- `answered`：每个陈述都要引用本次实际输入的证据。
- `insufficient-evidence`：没有陈述，说明资料不足。
- `conflicting-evidence`：保留至少两条分别引用的相互冲突陈述。

文字引用须在原正文中实际出现，仅允许折叠空白。新生成由模型选择原文单元编号，服务端恢复逐字原文，公共回答仍返回原 support ID 和 `quote`。图片引用须对应实际传入且 SHA、长度、PNG 尺寸一致的像素，公共引文为空；caption 不算图像。返回引用身份、正文 SHA、来源版本、原定位及解析警告，避免把完整存储文本等同于正确转写。模型返回后再次调用 Kernel 读取回调，来源或输入有变化就拒绝发布回答。

旧 literal 回答的严格验证器及唯一编号解析器继续用于历史诊断：输出形状有效、引用的是本次已有文字编号、非空引文不在该正文中，但折叠空白后恰好存在于唯一一份已提供文字证据时，复制输出并修正编号。原始模型对象不变，返回 `citationRepairs` 记录陈述和引用索引、原编号及解析后的编号、双方证据身份和引文 SHA。未知编号、图片、模糊匹配、多个匹配或非法形状均不修正；修正后仍须通过完整严格验证。不删除陈述或引用，不自动请求模型重写。新生成不调用此修正器或回退到旧协议。

历史缓存的离线重放须分别记录原始生成版本和后处理版本，不能宣称已经使用新策略重新生成。引用归属修正不代表语义支持或回答完整。

## 新生成的原文单元协议

`source-quote-units-v1` 将完整已提供文字连续分片，单片不超过 1200 个 UTF-16 code units，优先自然边界且不切断有效 surrogate pair。按原顺序拼接得到逐字原文，不摘要、截断或丢弃；纯空白片也保留，但因严格验证禁止空白引文而不能被选择。输入 `evidence` 仅保留来源身份，正文只在 `quoteUnits` 出现一次。稳定编号绑定协议、正文 SHA、原始证据/定位及确切起止偏移，不依赖临时 eN 标签。

模型的 citation 仅为 `{id: 已提供的可选单元编号或真实图片编号}`，不允许自写 `quote`。服务端恢复公共回答并执行原严格验证；未知编号、重复选择、非法形状、缺少引用，以及将同一来源的不同单元冒充两个冲突来源均失败。保留原始 `providerSelections`；`selectedUnits` 分别记录选择位置、来源身份、偏移和恢复引文 SHA。`quoteUnitManifest` 记录全部文字单元的无正文清单与来源身份，含不可选空白片，并返回清单 SHA。

新提示词版本为 `grounded-document-answer-v4`，`quoteUnitProtocolVersion` 和清单 SHA 与完整输入指纹一同绑定请求身份；新返回的 `referencePolicyVersion` 也明确标识原文单元协议。旧 literal 协议标识仍保留给历史解析器。现有模型、请求次数和预算规则不变，没有额外生成、付费修复循环或隐藏回退。分片元数据会增加少量输入开销。

仅 `document-answer` 的现有预算预留改为计算完整序列化请求，包含单元元数据及 `text.format` 的 schema/enum；其他 kind 和费率不变。mini 原有 bytes/2 仍是估算，不能称为严格费用上界。任何有 hard cap 的真实试运行必须在发请求前按完整 UTF-8 payload（含 schema）、framing 和真实图像 patch 的保守界核验；不能只计算 source body，也不能等 provider 结算后才检查超帽。实际调用仍按 provider usage 结算并保留账本，不新增预算系统。

`buildDocumentAnswerRequest(prepared, {model, reasoningEffort, maxOutputTokens})` 是导出的纯组装函数，输入来自 `prepareDocumentAnswer` 的已核验上下文；实际 synthesis 使用同一个返回 body。它不读取来源、发请求或授予开发策略权限。预检应复用它，而非复制 prompt/schema 或猜测 enum 体积：对非图像 JSON 的完整 UTF-8 请求计算保守界，保留 `input_image` 结构但不把 base64 当文字 token，再加实际 PNG 尺寸 patch 和 framing 上界。返回的 `providerRequestSha256` 绑定真实序列化 payload，并参与请求身份。

通用提示要求覆盖问题相关的列表项，数量说明对象、单位、范围与配置，并保留不同解释；这只是生成义务，不是完整性证明。选中了真实单元不保证陈述逻辑正确，也不补齐未提供的表格或图像；这些仍须独立评估。

引用形状、引文存在及版本检查只能证明引用归属，不能证明陈述逻辑正确、证据足够或图表理解正确。真实题库仍须独立评分；检索命中率、全部证据覆盖、回答正确率、拒答和冲突分别报告。原 Gold、原题顺序、分母和既有 top-k 不变。

本模块只用于非结构化学习内容。截止时间、考试日期、课程关系和任务状态必须由 canonical Kernel truth 查询提供；不能通过本模块把 PDF 或邮件正文升级成权威业务状态。

## 模型与开发验收

默认使用 `gpt-5-mini`、low reasoning、4000 输出 token 和 30 秒期限，沿用实际月度账本与 200 次每日规则。没有结果缓存或自动付费重试。

隔离开发作用域通过已审核的 `withDocumentRerankRunPolicy` 环境校验复用精确开发数据库、SQLite 账本和管理员进程标记，并要求请求记录回调。本轮可用 `gpt-6-astra`、high reasoning、16384 输出 token、120 秒期限；实际计费通过 `paidOpenAI`，保留账本，不使用 bypass。每题的持久化请求和成功检查点由验收运行器管理，不能把回调存在当成已经持久化。

原始图表在 Astra 中使用 `detail: original`，mini 使用 `high`。[官方图像输入说明](https://developers.openai.com/api/docs/guides/images-vision)。模型身份、reasoning、输出上限、prompt/引用协议版本、原文单元清单 SHA 和完整输入指纹共同构成请求身份。返回的 `model` 记录 provider 的实际模型字段，`requestedModel` 记录请求模型；Astra 开发结果必须与实际 provider 模型一致，否则拒绝发布。开发模型通过不证明其他生产模型也通过。

## 当前交付边界

纯验证器和输入打包的测试不能代替真实回答测试。新模块须经 PR、评审及 CI；接入 Kernel 当前上下文接口后才运行冻结的真实问题。代码合并、CI 成功、部署和生产切换分别报告。
