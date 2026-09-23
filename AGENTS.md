<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 项目协作

- 已决定实施的代码、文档或配置改动先建立 GitHub Issue；纯讨论或研究可留在总调度对话。
- 每个实施任务在 WEb 项目中使用独立 Codex 任务、Git 工作树和分支；通过关联 Issue 的 PR 提交，不直接修改 `main`。
- PR 写明改动、验证、风险和适用的 UI 截图；CI 与总调度审阅通过后才合并。正式 Release 按现有发布机制单独处理。
- 遇到实质阻碍、PR 就绪及任务完成时，主动向总调度任务回报证据和链接；不设置定时自动化。
- 详细步骤与总调度任务 ID 见 [docs/project-workflow.md](docs/project-workflow.md)。
