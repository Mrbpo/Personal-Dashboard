# Course Radar

Course Radar 是一个只读的私人 Quercus / Canvas LMS 学习仪表盘。它按课程同步公告、Modules、Pages、Assignments、Planner、提交状态与常见文档附件，并生成跨课程的每日行动清单、风险与内容变更记录。

## 本地运行

1. 复制 `.env.example` 为 `.env.local`，填写 `CANVAS_TOKEN`、`OPENAI_API_KEY` 和可选的 `OWNER_EMAIL`。
2. 运行 `npm install`。
3. 运行 `npm run build`，并在本地预览数据库中应用 `drizzle/0000_colorful_hellcat.sql`。
4. 运行 `npm run dev`，在本地登录页使用开发账号进入。

Canvas 和 OpenAI 密钥只由服务端读取。原始附件仅在分析时临时上传给 OpenAI，分析完成后会删除；D1 不保存附件二进制内容。

## 生产环境变量

- `CANVAS_BASE_URL=https://q.utoronto.ca`
- `CANVAS_TOKEN`（密钥）
- `OPENAI_API_KEY`（密钥）
- `OPENAI_MODEL=gpt-5-mini`
- `OWNER_EMAIL`（可选的额外 owner 校验）

站点默认保持 owner-only。Canvas 集成是只读的；在仪表盘内完成或忽略任务不会写回 Canvas。
