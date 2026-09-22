# Course Radar

Course Radar 是一个本地优先、只读连接 Quercus / Canvas LMS 的私人学习数据库。它同步课程内容和提交状态，保留来源与变更历史，并生成每日行动清单。

## 本地运行

```powershell
npm install
npm run dev
```

默认打开 `http://localhost:3000`，数据保存在 `data/course-radar-v2.db`。开发启动器会在没有设置 `CANVAS_TOKEN` 时读取相邻的 `QuercusModuleDownloader/.env`，只把 Token 注入本地服务进程，不复制到项目、数据库或浏览器。只要本地服务保持运行，它会在启动后自动同步，并每 15 分钟再次检查；可用 `AUTO_SYNC_INTERVAL_MINUTES` 调整间隔。

也可以复制 `.env.example` 为 `.env.local` 并自行配置。`OPENAI_API_KEY` 不存在时，确定的截止日期、提交状态和基础 To-do 仍然正常工作。

## 独立部署与在线数据库

项目不依赖 GPT Sites。默认数据库是本地 SQLite；以后将 `DATABASE_URL` 和 `DATABASE_AUTH_TOKEN` 指向远端 libSQL/Turso 即可让同一套界面和 API 使用在线数据库。

生产环境必须设置：

- `OWNER_ACCESS_KEY`：网页登录密码
- `SESSION_SECRET`：登录 Cookie 签名密钥
- `DASHBOARD_API_TOKEN`：外部数据库/API 客户端的 Bearer Token
- `CANVAS_TOKEN`：Quercus 只读访问 Token
- `OPENAI_API_KEY`：可选的 AI 内容分析密钥
- `LOCAL_DEV_BYPASS_AUTH=false`

接口说明见 `docs/api.md`，完整验收范围见 `docs/acceptance-matrix.md`。

首页月历会显示 Canvas 截止日期；AI 能给出合理开工建议的任务会以横条展示“建议开始 → 截止”。Canvas 的 `unlock_at` 只用于判断能否开始，不会被误画成学习开始日。“导入日程”支持 `.ics`（Canvas、Google Calendar、Outlook 等可导出）和带有 `title,start,end,description` 列的 `.csv` 文件。

首页“直接问课程内容”会先检索本地保存的公告、Modules、Pages、作业说明与文件分析结果，再把命中的少量原文交给 AI 生成带来源编号的回答。回答中的来源可以直接打开 Canvas 原文；资料不足或课程存在歧义时不会自动猜测。

设置页可以连接使用 Piazza 内部账号登录的账户。连接器只调用读取课程、Feed 和帖子的接口，按课程基础代码自动匹配（例如 `CHMA10H3` 与 `CHMA10`），并把最近帖子放入对应课程和课程问答搜索。密码只用于当次登录，数据库仅保存用 `SESSION_SECRET` 加密的会话；不会读取成员名单，也不会发布、回复或修改内容。由于这是 Piazza 的非官方接口，登录失效后需要在设置页重新连接；本地服务连接后默认每 30 分钟同步一次。

`/piazza` 提供按网站时区保存的每日摘要及当天全部帖子，并可按课程搜索历史问答。未匹配 Canvas 的 Piazza 课程也会独立归档。问答结果只包含 Piazza 明确标记的教师回答，其他学生回复和未回答问题不会被当作确切答案。摘要在同步后自动刷新；已有旧归档需要后续同步重新读取，才能识别回答类型。历史帖子仍按每轮最多 90 条逐步补齐。

任务完成状态默认同时更新 Course Radar 与 Canvas Planner；它不会替你提交作业或修改成绩。不支持 Planner 勾选的内容只会保存在本站，并在界面上明确提示。

首页现在是整个私人工作台的总 Dashboard：全站检索会覆盖 Canvas、Piazza 和已导入日程；学习中心只是其中一个模块。快捷入口可以自行添加网站，并直接尝试显示网站自己的 favicon。AI 用量区支持 OpenAI、DeepSeek 与 xAI：DeepSeek 普通 API Key 可以显示余额；OpenAI 的组织累计用量需要 `OPENAI_ADMIN_KEY`；xAI 的完整余额与账单用量需要 `XAI_MANAGEMENT_KEY` 和 `XAI_TEAM_ID`。所有密钥仍只从服务器环境变量读取。
