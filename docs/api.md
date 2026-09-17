# Course Radar API

部署到独立服务器后，API 请求使用：

```http
Authorization: Bearer <DASHBOARD_API_TOKEN>
```

- `GET /api/v1/status`：连接、课程数、任务数与最近同步状态。
- `GET /api/v1/courses`：课程列表和启用状态。
- `GET /api/v1/tasks?courseId=...&status=...&includeCompleted=true`：结构化任务数据。
- `GET /api/dashboard?date=YYYY-MM-DD`：完整每日视图。
- `GET /api/courses/:courseId`：单课摘要、任务和来源。
- `GET /api/changes`：最近变更。
- `POST /api/ask`：用 `{ "question": "...", "courseId": "可选" }` 检索并询问课程资料，返回带 Canvas 来源的回答。
- `GET /api/ai-usage`：返回 OpenAI、DeepSeek 与 xAI 的安全用量摘要，不返回任何密钥。
- `GET/POST /api/shortcuts`：读取或新增私人快捷入口；新增时自动使用目标网站的 `/favicon.ico`。
- `DELETE /api/shortcuts/:id`：删除一个私人快捷入口。
- `GET /api/piazza/status`：返回 Piazza 连接状态与课程代码匹配结果，不返回会话密钥。
- `POST /api/piazza/connect`：使用 `{ "email": "...", "password": "..." }` 建立只读 Piazza 会话；密码不会保存。
- `DELETE /api/piazza/connect`：删除加密的 Piazza 会话，保留已同步的本地帖子。
- `POST /api/piazza/sync`：同步已匹配课程的最近 Piazza 帖子。
- `GET /api/calendar?start=...&end=...`：指定范围内的已导入日程。
- `POST /api/schedule/import`：上传 `.ics` 或 `.csv` 日程文件（multipart 字段名为 `file`）。
- `POST /api/sync` 以及 `POST /api/sync/courses/:courseId?runId=...`：同步。
- `PATCH /api/tasks/:taskId`：更新本站状态；传入 `syncCanvas: true` 时同步当前用户的 Canvas Planner 勾选，不会提交作业或修改成绩。

本地默认数据库为 `file:./data/course-radar-v2.db`。将 `DATABASE_URL` 与 `DATABASE_AUTH_TOKEN` 指向远端 libSQL 服务即可迁移，不需要修改接口消费者。
