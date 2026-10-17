# 原页字体与数学边界审计

Refs #68。这是管理员离线审计/派生暂存工具，不是自动纠错或知识库发布入口。

```powershell
node --experimental-strip-types scripts/audit-pdf-source-fidelity.ts --original original.pdf --evidence source-fonts.json --text recognized.txt --report audit.json
```

显式增加 `--stage derived.json` 才生成派生暂存。禁止 `--apply`；工具不读写数据库、不调用模型、不改识别缓存。

输出必须是新文件。CLI 在读取/写入前核对真实路径和文件身份，拒绝输出与输入、两个输出之间的路径或链接别名，使用独占创建，不能覆盖已有报告、源文件或缓存。

## 来源证据与拒绝条件

输入 `PdfSourceMathEvidence` 必须来自原 PDF 的字体/字形工具及人工核验：原件 SHA、真实页数/页码、页尺寸、编号区域 bbox，区域内字形的符号、字体、粗体状态、bbox、脚标及向量阅读顺序证明。现有 Python/pdfplumber 可以生成证据，不增加应用镜像包。文件哈希只绑定来源身份，不能证明任意人提供的字形 JSON 是真实的；此入口只供可信管理员使用。

只在同一编号区域唯一命中已有数学环境，且待修改基符号/脚标完整顺序一一对应时恢复字体。编号重复、数量或脚标/顺序不同、字体未知、页码/哈希不符或操作重叠均拒绝派生。希腊字母用 `\boldsymbol`，拉丁字母用 `\mathbf`；不修改其它符号、上下界、约束或数学解释。整页符号总数一致不构成对应证明。

完整控制序列不匹配其中的普通字母；脚标必须完整解析，命令、运算或不支持的复杂脚标拒绝对应，不截取前缀或假定无脚标。每个数学环境只能有一个编号，内部/外部编号冲突或重复均拒绝，不能由两个来源区域共享同一个环境。

编号只在相同印刷编号紧邻唯一已有环境时移入；该环境可规范为 display。集合括号只在结构上完整包围一个已有 inline 环境时合入数学边界。派生文件记录原字节 SHA、证据 SHA、原识别全文 SHA、新全文 SHA、具体替换范围与操作，明确标记不是模型原文、需要人工审阅，不能绕过 `applyPageRepair` 原缓存验证。

## 本页校准与交付限制

公开 MIT 原页的 6 处向量恢复由 4 个独立编号区域各自证明；另外规范一处编号/display和一处集合边界。8 个原式逐式核对及现有 KaTeX 渲染通过，删除仅批准的字体/边界标记后，数学字符序列与 v3 原识别完全相同。原 PDF、v2/v3 原缓存、源字形、派生暂存、渲染结果及检查在忽略目录 `data/ml16-vision/` 保存，费用为零。

这只是单页校准，不能认证其他 PDF 或整体 100% 检索。代码与针对性检查可审阅；服务未部署，生产未切换，派生暂存未发布/索引。若要最终发布，须另明确管理员入口范围，重新核验当前 CAS、原缓存/字形和逐页派生 provenance；本工具没有这种权限。

## Docling 增强公式的原字符保护（Issue #143）

`assessPdfFormulaPreservation` 只对明确支持的有限 LaTeX 子集比较字符顺序。它忽略空白、字体排版、脚本语法和非字面分组；保留数字、prime、运算符和 `\{`／`\}` 真正显示的集合括号。因此字面集合的嵌套／顺序变化也不能通过。未知命令（包括当前未支持的分式、根号、矩阵）、歧义来源或过长输入返回 `unassessed`，不猜测对应关系。裸 `%`、`#`、`~` 属于注释、参数或活动字符语法，不当作字面字符核对；`\%`、`\#` 可作为明确的字面字符比较。

Docling 正文、表格引用和图片区域文字引用的 formula 节点共用该门；文本模式或旧 raw 缓存重读不能绕过。有完整 `orig` 时，增强字符不一致或无法核对都会保留完整原串并告警，不把它包装成已验证 LaTeX；失败的机器 `text` 仍在原始 Docling JSON。`formulaEnriched=false` 只影响 LaTeX 包装与增强状态告警，不关闭字符保护。没有 `orig` 的机器公式仍保留原来的未核验告警，不能声称来源已验证。相同字符流也不证明上下标、字体、运算优先级或数学语义正确；原抽取本身错误不会被本检查修好。

公式和文本 parser 身份分别改为 `docling-v3-source-preserved-search`、`docling-v3-source-preserved-text-search`，使新的 options/cache 身份与旧结果区分。历史 PostgreSQL 版本和 raw 不回写；SQLite 旧 `docling-v2-search`／`docling-v2-text-search` 仍仅作历史预览候选，不冒认为新 parser。此改动不后台重跑 PDF、模型或整组验收。

历史预览先按页选定一个缓存版本，再限制最多 1000 页，多个版本不挤掉后页。两个当前 Docling 版本均可阻止就绪文档因预览而重复排队；旧 v2 不算当前版本。未完成或显式重解析尚未结束时，仍保留原先 `pdf-page-v2` 预览优先级。

## Type1 singleton 占位映射（Issue #187）

原 Type1 预检仍按嵌入 FontFile 的 literal Encoding 认定 `prime`／
`negationslash`，不根据字体名、字符槽或页面答案推断。新增分支仅在完整可解析的
单字节有界 codespace 中，允许把该源代码唯一 singleton `bfrange` 的 `FFFD`
占位 destination 精确改为已有受信 glyph-name 映射。其他代码共享 FFFD 不构成
源位置歧义；它们保持原字节，不被批量替换。目标为非 singleton、非 FFFD、
bfchar 与 range 重叠、缺失、超界、未知语法、array range 或未证实的 Encoding override
均拒绝派生。既有 bfchar 的唯一源／唯一逆向及 already-correct no-op 门不放宽。

仅这个 singleton-FFFD 路径还可接受只含 `Type=Encoding` 与 `Differences`
的受限字典：完整数组最多 512 项，代码为 0–255 整数、name 按规范顺序递增、
每个显式代码唯一，而且每个被纠正代码必须明确映射同一嵌入 glyph 名。
不推断 BaseEncoding，缺失、不同、重复、越界、未知项或其他字典键均拒绝；
name Encoding 及旧 bfchar 的覆盖仍拒绝。原字典不改，复制后独立核其结构哈希。
range 分支只使用完整验证过的 lexical view，不再扫描注释中的 bfchar 示例。

复用原 CMap parser 的显式 bounded 参数及原 lexical/destination 定位工具；其他
调用默认仍要求原 `00–ff` codespace。完整 CMap、FontFile 与各页内容流的前后
哈希证明保留，原 PDF 与旧失败记录不改。此修复只解决确定性字体预检的已定位
阻碍，不认证 glyph 绘制、公式结构、全文保真或摄取／问答已经通过。
