# 既有 Docling 缓存重读

[Issue #68](https://github.com/Mrbpo/Personal-Dashboard/issues/68)。仅管理员命令，不新增页面、服务或存储。

旧解析器可能丢弃 `text` 为空而 `orig` 有内容的公式节点。当前 decoder 可以恢复这些原始抽取文本；升级代码不会自动改变已经发布的文档版本。本工具重读已有缓存，不请求 Docling、AI 或向量模型，也不会自动迁移 schema。

## 先审计，再显式发布

```sh
npm run pdf:replay-cache -- --owner OWNER --document DOCUMENT --report /private/replay-audit.json
npm run pdf:replay-cache -- --owner OWNER --document DOCUMENT --expected-version CURRENT_VERSION \
  --review-report /private/replay-audit.json --report /private/replay-applied.json --apply
```

省略 `--document` 可以按 owner 审计，使用 `--limit`（默认 20，最多 500）及 `--offset` 分页；发布只允许明确的一份文档及已审计 current version。输出报告含原文，必须放在私有位置，不提交仓库或公开分享。失败返回非零退出码；不会在失败时转为重新解析或继续写不完整版本。

工具核验原件 SHA 和真实原页数、完整批次计划、来源/owner/options 身份、缓存 SHA，以及按既有 `copyIndices` 重建的派生 PDF SHA。缺失结果仅在原页确实无绘制内容和注释时允许为空白；不把空白扫描当真空白。必须保留完整且连续的真实页码。增强、原生或人工修复页不允许降级为 raw Docling；没有完整派生批次证据的文档拒绝自动重读。

发布前重新审计并比较审阅哈希，通过 KernelService 的事务锁和精确 current-head CAS，整份原件一次发布。旧版本、来源和 evidence 保留；未变页保留方法、parser/model，改变页标记 `cached-docling-redecode`，记录所依据的旧证据及完整批次身份。当前 head 已变则拒绝覆盖；重复审计正文及警告均一致时显示 unchanged，不制造新版本。工具不改 SQLite 原缓存，不删除原件，不复活旧解析任务，不在命令中排向量工作。

`orig` 可能按线性文字顺序串联分数、求和上下界及下标，恢复它不等于获得忠实 LaTeX。未核验公式警告会保留；不能根据检索命中声称所有数学表达正确。一次缓存恢复也不能证明三套资料连续三种状态达到 100%。

## 可选原生空白观察

`DOCLING_NATIVE_WHITESPACE=source-v1` 与 `LOCAL_OCR=true` 可以在审计、发布中复用正常入库的[同一原生空白规则](pdf-native-whitespace.md)，无需重新提交 Docling 或改写旧 optionsHash。默认仍关闭；此前已保存 native-whitespace 派生的正文在关闭开关或提取不可用时拒绝 raw 降级。已有派生页的非空白字符与当前 raw 解码不一致时须另行审阅，不能自动覆盖。

审计保持只读：报告包含候选页面、差异和新 receipt hash，完整原生观察暂存在进程内，发布重新核验后才写 CAS。审阅报告跨开关/配置/解析代码变化会失效，必须重新审计；不要修改旧报告冒充新审阅。发布保留旧原件、批次、证据和引用，新 receipt 参与既有历史 GC 保留。相同观察/正文重放不新增版本；仅新增观察元数据也须明确版本记录，不能称为正文修复或内容正确率提升。

本工具代码及隔离验证的状态随 PR 更新；未执行生产部署或生产缓存批量发布。实际修复需总调度先固定基线、审阅差异，然后选择隔离验证或正式发布窗口。

## 本轮隔离验证记录

- 三项针对性检查在独立临时 PostgreSQL schema 中全部通过（3/3，无跳过）：缓存完整性/真实空白、损坏或改变身份拒绝、精确 CAS/历史证据/幂等。没有网络模型请求。
- 默认审计核验一份公开课程原件的 10 页及全部派生批次，然后按已审阅 current version 仅发布该份隔离文档；9 页原始公式抽取文本发生变化，未变页的方法和旧证据保留。没有全库恢复或生产发布，也未生成向量。
- 隔离验收库从 schema 8 显式迁至当前 main 的 9 后才 apply；迁移前后所有文档头、页/版本/证据及向量指纹一致，仅 schema 版本变化。原 schema 8 冻结报告保留。CLI 仍要求与当前代码精确匹配的 schema，不放宽闸门或自行迁移。
- 私有原始报告在实施工作树 ignored `data/replay-check/`；不含在 Git 提交中。缓存恢复不等于数学忠实度或 100% 检索已验收。代码完成，针对性验证通过；生产服务未部署此工具，生产内容未执行重读。
