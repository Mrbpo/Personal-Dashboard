# Git 上传、正式发布与版本检测

## Windows 双击方式（推荐）

项目根目录提供三个和 QQBot 类似的入口：`01-上传代码到GitHub.cmd`、`02-检查正式版本.cmd`、`03-发布正式版本.cmd`。直接双击即可。它们会自动寻找系统 Git；未安装时也会尝试使用 Codex 随附的 Git。上传脚本会先显示变化，只有依次输入大写 `STAGE` 和 `UPLOAD` 才会上传。发布脚本要求再输入大写 `RELEASE`。

双击脚本使用固定私有仓库 `Mrbpo/Personal-Dashboard`。如果以后迁移仓库，需要同步修改脚本配置。Codex 缓存被清理且系统没有 Git 时，仍需安装 Git for Windows。

这些脚本已创建，但不会自动创建仓库、购买服务器、推送或部署。请在项目根目录打开 PowerShell。需要 Node.js 22.13+、Git、GitHub CLI（gh），并运行 `gh auth login` 完成你自己的登录。不要把令牌写进命令、仓库 URL 或说明文档。

## 三个入口

| 目的 | 预览/检测命令 | 真正执行 |
| --- | --- | --- |
| 上传 main | `npm run git:upload` | `npm run git:upload -- --apply --message "更新说明"` |
| 发布正式 Release | `npm run release:publish` | `npm run release:publish -- --apply` |
| 检测新版本 | `npm run version:check` | 只读，不安装 |

上传和发布默认预览，但会读取 GitHub 检查仓库和权限。`--apply` 才提交/推送或发布。脚本不自动暂存文件，不强推，不改写标签，不上传 Release 附件。失败返回退出码 1；成功检测（无论有无更新）返回 0，以 JSON 的 updateAvailable 判断更新。

## 1. 首次上传

1. 在 GitHub 创建空的 **Private** 仓库（建议 canvas-study-dashboard），先不要添加 README。
2. 本项目已有 Git 历史，无需再 git init。设置远程（替换 YOUR_ACCOUNT）：

```powershell
git remote add origin https://github.com/YOUR_ACCOUNT/canvas-study-dashboard.git
git remote -v
git status --short
```

若 origin 已存在，先核实，不要直接覆盖。脚本只接受 github.com 私有仓库，且当前分支必须为 main。

3. 在编辑器的源代码管理界面逐个审核并暂存所需文件，包括有意删除的旧代码。不要直接 `git add .`。确认 `.github/workflows`、Dockerfile、deploy、scripts、package 文件和全部业务源代码均已包含。
4. 本地 `.env`、数据库、邮件、课程原件和浏览器登录资料不进入 Git。PNG 已按你的要求允许上传；JPG、PDF、Word、压缩包仍会被保守阻止。PNG 会进入 Git 历史，因此必须确认没有截图中的姓名、邮箱、课程内容、令牌或不允许分发的素材。普通 SVG 也需人工检查。历史中出现受禁路径会阻止上传，**删除工作区文件不能清除 Git 历史**。遇到拦截请先审查，不要强行绕过，也不要删除本地原件。密钥扫描是辅助检查，不保证发现所有凭据格式；GitHub secret scanning 可以作为额外防线。

```powershell
npm run git:upload
npm run git:upload -- --apply --message "Prepare private deployment"
```

只上传 main，不触发正式部署。GitHub Checks 会运行验证。脚本没有自动解决分支冲突；远程领先时正常 push 会拒绝，不会强推。

## 2. 设置版本号

唯一版本号来源为 package.json，当前为 0.1.0。正式标签必须是 vX.Y.Z，不接受 beta、rc 或任意字符串。使用 npm 同步更新 package-lock.json，不自动打标签：

```powershell
npm version 0.2.0 --no-git-tag-version
```

修复通常增加末位（0.1.1），新增功能增加中间位（0.2.0），重大不兼容变更增加首位。每次发布必须高于现有正式版本；不要改写旧版本。首次可以发布现有 v0.1.0，无需为了发布强行升到 1.0.0。

审核并暂存两个 package 文件及代码，运行上传脚本。发布时整个工作区必须干净，本地 HEAD 必须与远程 main 相同。

## 3. 正式发布（会触发部署）

先完成 deploy/README.md 中的服务器准备：Docker、固定部署入口、持久化目录、私人素材、加密备份、HTTPS、唯一同步主节点。配置 GitHub Actions Secrets：DEPLOY_HOST、DEPLOY_USER、DEPLOY_SSH_KEY、DEPLOY_KNOWN_HOSTS。主机指纹必须可信核对。

```powershell
npm test
npx tsc --noEmit
npm run build
npm run release:publish
npm run release:publish -- --apply
```

脚本使用当前 package 版本、远程 main 的确切提交创建正式 Release，并自动生成发布说明；GitHub 创建对应标签。已存在 Release/标签会拒绝覆盖。如果网络超时，先去 GitHub 核对是否已经发布，不要重复创建或删标签重试。

链路：正式 Release → 校验标签与 package 版本、main 历史 → 测试/构建 → 备份/部署 → 健康检查 → 启用或代码回滚。普通提交、PR、草稿和预发布版本不部署。**Release 创建成功不等于网站部署成功**；请查看 Actions 结果和设置页部署状态。

镜像仍以提交 SHA 标识，版本号用于人与更新检测；二者用途不同。仅允许向后兼容迁移自动上线。代码回滚不会还原旧数据库，不覆盖新数据。

## 4. 版本对照与更新检测

离线比较（不需要 GitHub）：

```powershell
npm run version:check -- --current 0.1.0 --latest v0.2.0
```

查询 origin 仓库，默认与本地 package 版本比较：

```powershell
npm run version:check
```

查询指定仓库，与服务器实际版本比较：

```powershell
npm run version:check -- --repo YOUR_ACCOUNT/canvas-study-dashboard --current 0.1.0
```

本地 package 版本不一定等于线上版本！先从网站“设置 → 系统更新”查看运行版本。脚本分页读取 Release，忽略草稿/预发布/非标准版本，选**版本号最高**的正式发布，而不是日期最新的发布。

| status | 含义 |
| --- | --- |
| update-available | 存在更高版本，updateAvailable=true |
| up-to-date | 与最高正式版本相同 |
| ahead | 当前版本更高，不自动降级 |
| no-release | 尚无可比较的正式版本 |
| error | 权限、网络或输入错误；不是“已是最新” |

网页版：服务设置配置 GITHUB_REPOSITORY 和限定该仓库的 GITHUB_ACTIONS_TOKEN，令牌需要 Contents: read（读取私有 Release）及 Actions: write（部署重试）。点击“检查更新”手动检测；不会因检测而安装。显示新版本后可确认部署，失败版本可重试同一标签。生产检测读取镜像内 package 版本，不读取本地电脑版本；检查接口仅所有者可访问。网页单次最多检查 2000 条发布记录，超出或任何请求失败明确报错。

检测只说明存在更高正式版本，不承诺其测试已通过或可兼容当前数据库；最终以 CI 和部署检查为准。手动指定旧标签是管理操作，慎用。

## 5. 尚需实际验收

尚未连接你的 GitHub 仓库、发布 Release 或部署服务器。需完成真实的权限、SSH、容器、备份恢复、失败回滚、桌面/手机及 24 小时运行验收。现有项目其他上线限制见 deploy/README.md 和 docs/integration-status.md。

官方参考：[GitHub CLI 发布参数](https://cli.github.com/manual/gh_release_create)、[GitHub Release API](https://docs.github.com/en/rest/releases/releases)。
