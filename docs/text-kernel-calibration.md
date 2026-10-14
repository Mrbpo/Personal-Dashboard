# 非 PDF 文本／Truth 当前内核校准（Issue #68）

本工具只复用已下载的公开资料缓存，禁止网络取新资料、模型调用和生产写入。它保留原50道Truth、原50道Hotpot多文档问题及其金标准和旧失败，不用子集宣称完整验收。SyllabusQA、QASPER、CourseAssist和受控混合课程另各保留原50题与完整缓存全文。

## 冻结与来源

```powershell
python scripts/freeze-text-calibration.py --cache D:/Desktop/Files/canvas-study-dashboard-v1-ai/data/benchmark --output data/text-calibration-frozen
```

冻结器只读SQLite缓存；输出每份来源的完整缓存文本和原logical chunk ID，不直接把SQLite业务状态复制进新数据库。每份文本绑定实际内容SHA、原来源ID、数据集公开入口和缓存文件SHA。旧报告逐字节保留；`manifest.json`记录所有输入文件大小/哈希、各语料完整数量和确切基础代码commit/文件哈希，重跑不能覆写已有冻结目录。冻结原文保留在Git忽略目录，不提交公开资料全文。

缓存文本不是重新提取的PDF；模拟PDF/Canvas/邮件/论坛内容显式标注受控fixture，不能称真实Canvas导出。缓存课程、publication time或权限不提供的信息不补造。旧题属于校准资料，不能当未见过的新正式验收集。

## 当前 Kernel 的一次隔离基线

使用**已有隔离数据库**`pdf_acceptance_20261006`和新`text_calibration_*` schema。禁止`public`或生产数据库，已存在的schema不能重用；保留上一状态记录。现有`scripts/pdf-acceptance-env.mjs`可将连接派生到隔离库，所有业务写入进一步限定到显式新schema。

```bash
DATABASE_URL=:memory: LIBRARY_DIR=/pdf-data/text-calibration-no-originals \
  KERNEL_SCHEMA=text_calibration_20261014_baseline \
  node --experimental-strip-types --import ./scripts/pdf-acceptance-env.mjs \
    scripts/benchmark-text-kernel.mjs \
    --input /text-input --output /text-reports/baseline --corpora content
```

连接由既有隔离运行环境提供，不输出数据库凭据。首次仅摄取完整Hotpot9769份文本，额外完整语料已冻结待资源核验；增加`--corpora`只选择完整语料，不筛失败题。所有内容通过`KernelService.ingestParsedDocument`生成source version/evidence/当前全文索引，50Truth fixture通过`upsertCourse`、`ingestCanvasSource`、`setTaskStatus`、`ingestEvent`生成candidate/canonical状态，不直接写事实表。

语义向量、rerank、hybrid均关闭，密钥为空、测试预算为0，`fetch`强制拒绝并记录任何网络企图。不更改生产预算或服务。PG连接不经过HTTP fetch。隔离schema完成后保留，不触碰现有PDF数据schema。

## 必须分别报告的指标

- **Truth结构值**：原50题的当前投影值、适用evidence和日期精度；不是自然语言回答准确率。
- **检索**：Hotpot必须找齐金标准来源；QASPER保留原指定论文/前80任一gold段落的较宽口径；Syllabus保留原查询带资料名称的边界；论坛和混合来源按原source ID检查。
- **回答准确率**：本无费用基线不生成新回答，明确`pending/evaluated=0`。旧AI回答原样冻结供之后审计，不拿关键词出现或引用数量当语义正确。
- **正式完整目标**：即使本次检索全部命中，也写`fullGoalPassed=false`。三不同状态100%和更大外部噪声集需算法冻结后另验；本次运行成功退出只代表基线执行完成。

原论文和大纲评分、跨课程检索、无法回答及来源冲突仍须后续完整验收。没有模型评分调用，没有收费API。

## 已执行的完整基线

2026-10-14T09:46:08Z–09:49:02Z，耗时174.941秒。复用服务器已发布的`ea57f9bc173de5a771e8fc8e1dd6b1a2fab092fb`镜像，在1CPU/768MiB临时容器中运行；期间一次观察进程内存107.9MiB，不能当峰值。数据库为既有隔离`pdf_acceptance_20261006`，新schema `text_calibration_20261014_baseline`、owner `text-calibration:text_calibration_20261014_baseline`；没有生产业务写入。

| 项目 | 实际结果 |
|---|---|
| 全量原Hotpot缓存摄取 | 9,769文档、9,769文本段、9,769 source versions及9,769 evidence，全部由当前KernelService生成 |
| 原50Truth结构值/适用证据/日期精度 | 50/50 |
| 原50Hotpot前14来源，全部金标准必须找齐 | **35/50**，15个失败完整保留 |
| 返回检索结果具有evidence/source version | 50/50题，表示来源可追溯，不表示相关性或回答正确 |
| owner隔离 | 通过 |
| 新自然语言回答／正确率 | 待验，evaluated=0 |
| 网络／付费AI | 0／0 |
| 正式100%／三状态目标 | 未完成 |

该基线输入manifest SHA256为`a72417248fde61064aa78381a6ad002fe1c49c15ce4bb71bc8edd9efb8e380f4`；原缓存文件和报告逐字节哈希，代码哈希仅规范化Win/Linux换行。真实报告保留在`/srv/study-text-calibration-20261014/reports/baseline/report.json`，输入在该目录的`input/`；本地对应Git忽略的`data/text-calibration-frozen-run/`和`data/text-calibration-baseline.json`。schema保留供后续定位，不删除或重写旧结果。

其余完整资料仅冻结未摄取：63大纲/797段、100论文/4,620段、含50论坛帖的2,141文档/2,929段，以及10课程混合2,920文档/3,654段。各保留原50题；全部JSONL约26.33MB。旧报告中的Piazza、Syllabus和QASPER分数不是本次当前PG基线结果。

此次脚本实现与纯隔离/哈希保护检查完成，真实PG基线执行完成；检索准确率未达标，代码尚待PR/CI/总调度审阅，没有部署或生产切换。
