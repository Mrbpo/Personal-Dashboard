# Personal Dashboard · 学习工作台

> **本项目主要由 ChatGPT 编写，开发过程中使用 Codex 完成代码实现、修复与测试。** 项目维护者负责提出需求、决定方向和实际使用验收。AI 生成的代码与回答仍需验证。

一个面向个人学习的自托管工作台：将 Quercus / Canvas、Piazza、邮件和课程文件集中归档，查看作业截止时间，并根据资料进行检索与问答。项目早期名为 **Course Radar**，代码和数据库文件名中仍保留这一名称。

项目正在从分散的功能模块迁移到统一内核。当前仓库同时包含既有网站与持续开发的 PDF 检索、问答能力；**代码合并、CI 通过、实际部署和内容验收是不同的状态**，不能据此假定所有新能力已在生产启用。

## 主要功能

| 功能 | 内容与入口 |
| --- | --- |
| 课程与作业 | 同步 Canvas 课程、公告、页面、资料和提交状态，查看截止日期与日历。首页 `/`、课程 `/courses/[courseId]`。 |
| 学习问答 | 查询课程资料，保存会话与来源引用。入口 `/study`；v1 接口 `/api/v1/study`。 |
| 资料库与 PDF | 保存原件和版本、解析与索引文档，阅读 PDF 并做批注。入口 `/library`。 |
| Piazza 与邮件 | 归档帖子和邮件，提供检索、摘要及课程关联。入口 `/piazza`、`/mail`；连接需单独配置。 |
| 手写学习 | 分页绘画、文字记录、向 AI 提问与画册保存。入口 `/sketch`。 |
| 内核管理 | 查看课程、任务、事件、事实证据，处理候选事实。入口 `/kernel`。 |
| 课程录像工具 | 管理员按需发起课程录像归档，保留视角、清单及可用字幕。工具位于 `scripts/course-video/`，不是安装后自动可用的通用下载服务。 |

Canvas 同步不替用户提交作业或修改成绩；任务完成操作在支持时会同步 Canvas Planner。Piazza 使用非官方读取接口，学校登录、Duo 或平台验证仍可能需要人工完成。

## 核心架构

应用使用 **Next.js + React + TypeScript**，内核是应用内的 `KernelService`，不另拆网络微服务。

下图描述统一内核的数据流，部分旧模块仍在迁移接入中。

```text
Canvas / Piazza / Gmail / Calendar / 文件
                  ↓
       来源适配与标准化、版本记录
                  ↓
        证据 → 候选事实 → 裁决
                  ↓
      PostgreSQL：确定性事实与历史
                  ↓
          KernelService → 网站 / API

PDF 原件 → Docling 等解析流程 → 页面文本 / 结构 / 图像证据
                                      ↓
                               检索索引 → 问答与引用
```

- **PostgreSQL 是核心事实的权威存储**：课程、学期、任务、事件、实体、事实、证据及来源状态。冲突和历史保留在内核中，来源消失不直接等同于任务取消。
- **SQLite 与文件存储仍在使用**：保存邮件、帖子等原文，以及绘画、批注、设置和部分旧索引；不能只备份 PostgreSQL。
- **检索索引可以重建**：全文与向量检索用于定位内容，不替代确定性事实的存储。
- **PDF 原件是内容依据**：解析文本、表格、公式及图形关系均为衍生表示。复杂内容可能解析不完整，来源定位和原图证据用于核查，不能把模型重写当作原文。
- **AI 不直接拥有业务状态**：负责提取、候选生成和回答；核心事实通过内核验证与裁决后更新。

本阶段不要求部署 RAGFlow 或 Graphiti。PDF 结构忠实度、跨文档问答和引用准确性仍在专项验收中，项目不承诺所有文档均可无误解析或回答。

## 本地开发

### 1. 准备依赖

- Node.js **22.13 或更新版本**、npm。
- 一个可连接的 PostgreSQL 数据库，安装 `pgvector` 扩展，并允许迁移账号创建该扩展。仓库的容器构建使用 PostgreSQL 18.6，见 [数据库镜像](deploy/postgres-vector.Dockerfile)。
- 完整 PDF 解析需要额外启动 Docling Serve；部署配置见 [内核运行手册](docs/v1-kernel-runbook.md)。

```sh
git clone https://github.com/Mrbpo/Personal-Dashboard.git
cd Personal-Dashboard
npm ci
```

### 2. 配置本地环境

在项目根目录自行创建 `.env.local`，将以下示例替换为自己的数据库连接。仓库没有 `.env.example`。

```dotenv
KERNEL_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/study_kernel
DATABASE_URL=file:./data/course-radar-v2.db
LOCAL_DEV_BYPASS_AUTH=true
AUTO_SYNC_ENABLED=false
```

以上仅用于本机开发。开发服务绕过登录时应仅监听本机地址；部署时必须关闭绕过，并配置访问控制。

可按需要补充：

| 配置 | 用途 |
| --- | --- |
| `CANVAS_TOKEN` | 连接 Quercus / Canvas；需要自动同步时再启用 `AUTO_SYNC_ENABLED`。 |
| `DOCLING_URL` | 可访问的 Docling Serve 地址，用于 PDF 解析。 |
| `OPENAI_API_KEY` | 部分 AI、向量及重排功能使用；服务与预算也可在网站设置中管理。 |
| `OWNER_ACCESS_KEY`、`SESSION_SECRET` | 部署时的访问密码与会话签名密钥。 |
| `DASHBOARD_API_TOKEN` | 外部 API 客户端认证，具体接口见 API 文档。 |

不配置 AI 不等于停用课程和任务数据库，但 AI 问答及相关索引功能需要可用服务。邮件 OAuth、Piazza 和录像授权各有单独的连接步骤。

### 3. 初始化与启动

首次使用空数据库时执行迁移，再启动网站：

```sh
node --env-file=.env.local --experimental-strip-types scripts/kernel-migrate.ts
node --env-file=.env.local scripts/dev-local.mjs --hostname 127.0.0.1
```

这里显式加载 `.env.local`，让开发启动器也能读取同步开关。打开 <http://127.0.0.1:3000>。另开终端，在同一项目目录启动后台 worker，处理摄取、解析与索引任务：

```sh
node --env-file=.env.local --experimental-strip-types scripts/worker.ts
```

以上步骤初始化本地环境，不会迁移线上数据。旧数据导入、生产认证、备份和切换请按运行手册操作。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [API 说明](docs/api.md) | 网站与外部客户端接口。 |
| [内核运行手册](docs/v1-kernel-runbook.md) | PostgreSQL、Docling、迁移、事实裁决、备份与生产切换。 |
| [PDF 转写](docs/pdf-transcription.md) / [内容忠实度](docs/pdf-source-fidelity.md) | PDF 解析、来源证据及验证边界。 |
| [后台任务](docs/worker-queue.md) | 租约、恢复、重试及索引调度。 |
| [课程录像归档](docs/course-recording-archive.md) | 授权、原片归档、字幕与覆盖限制；其中批次记录不代表当前全量状态。 |
| [协作流程](docs/project-workflow.md) | Issue → 独立分支 / 工作树 → PR → CI 与评审。 |
| [发布指南](docs/release-guide.md) | 正式发布与部署步骤。 |

专题文档可能记录某次实验或历史部署，阅读时请核对日期、分支和适用范围。普通 PR 不等于生产发布，CI 也不等于 PDF 内容正确率达标。

## 参与与使用

建议先用 Issue 描述问题或需求，再通过独立分支提交 PR。请附验证方法、实际结果和仍未解决的问题；不要提交课程原件、数据库、登录会话或 API 密钥。

本仓库是个人学习项目，不是 Quercus、Canvas、Piazza 或 Kaltura 的官方产品。源码公开不代表课程资料公开；连接与归档功能应只用于自己有权访问的内容。
