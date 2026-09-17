# Course Radar 验收矩阵

## 1 级：数据可信与安全

- Canvas Token、OpenAI Key、数据库 Token 仅存在于服务端环境。
- 读取 active courses、公告、Pages、Modules、Files、Assignments、Quizzes、Discussions、Planner 与 Submission。
- Canvas 明确的 due / unlock / lock / submission / prerequisite 状态优先于 AI。
- 每条任务保留来源 URL、证据、置信度和更新时间。
- 本地使用 SQLite 文件；未来只需将 `DATABASE_URL` 切换到远端 libSQL/Turso。
- 在线 API 使用 `Authorization: Bearer DASHBOARD_API_TOKEN`。

## 2 级：分析与计划闭环

- 内容哈希增量分析；未变化内容不重复调用 AI。
- 失踪来源标记为“疑似取消或替代”，重新出现时产生恢复记录。
- 每日计划结合截止时间、锁定时间、分值、先修状态与学习时间容量。
- AI 不可用时保留基于 Canvas 确定字段的计划。
- 支持 PDF、DOC/DOCX、PPT/PPTX、TXT、Markdown、CSV、RTF；超限或不支持文件明确降级。

## 3 级：使用体验与外部接口

- 今日总览、课程详情、变更记录、设置与同步进度均有加载、空、成功和错误状态。
- 中文界面保留英文课程原文；桌面双栏、移动单栏。
- `/api/v1/status`、`/api/v1/courses`、`/api/v1/tasks` 可作为后续在线数据库接口。
- WebMCP 的同步、今日计划、课程摘要与可见界面共用同一数据源。
