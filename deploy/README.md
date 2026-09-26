# 私有服务器上线手册（尚未执行）

v1 PostgreSQL kernel 的单独部署、迁移、备份和验收步骤见 [v1 kernel runbook](../docs/v1-kernel-runbook.md)。

本地上传、版本号和正式发布命令见 [发布操作说明](../docs/release-guide.md)。设置页支持按语义版本号检查更新；检查本身不会部署。

## 先决条件

- 用户确认 GitHub 账户归属、私有仓库、加拿大 Linux 服务器与域名。尚未创建仓库、购买、推送或发布。
- 服务器需 Docker Engine + Compose、curl、flock、age；安装与报价需在选定供应商后核对。Windows 当前没有 Docker，不能把本地检查当成容器验收。
- 仅允许正式 Release 发布；main 普通提交、PR、draft、prerelease 不部署。为 main 设置保护规则；禁止改写已发布标签。
- GitHub secrets：DEPLOY_HOST、DEPLOY_USER、DEPLOY_SSH_KEY、DEPLOY_KNOWN_HOSTS。主机指纹通过可信渠道核对，不能部署时自动信任首次发现的主机。

## 主机目录及权限

代码镜像与持久化目录分离。以下文件须由主机管理员建立，部署账户不可修改脚本、Compose 或 runtime.env。

- `/srv/study/data`：数据库、私有服务配置、上传文件。容器 node 用户 UID 1000 可读写；不可公开分享。
- `/srv/study/assets`：独立传送现有私人装饰素材，挂载到 vic3-theme；首次上线检查全部页面所用素材，不只看目录非空。
- `/srv/study/status`：部署状态，只读挂入网站。
- `/srv/study/backups`：仅管理员可读，7 天加密备份。
- `/srv/study/compose.yml`、`Caddyfile`、`receive.sh`、`backup.sh`、`daily-backup.sh`、`verify-backup.sh`：从本目录复制，root 拥有，不可由网站修改。
- `/srv/study/runtime.env`：至少设置 SITE_DOMAIN、OWNER_ACCESS_KEY、SESSION_SECRET；使用独立强随机值，权限 0600。业务 API 在网页设置中配置；不把本地 Codex 登录资料上传。

在主机使用 age-keygen 建立 `/srv/study/backup.identity`，将对应公钥保存到 `/srv/study/backup.recipient`。私钥 root-only，同时离线保存一份；丢失私钥不能恢复备份。不要把私钥放入 GitHub secrets 或镜像。

SSH 必须使用专用部署账户及 `restrict` + forced command。固定入口只接受 `deploy <40位提交SHA>`。若需要 sudo，sudoers 仅允许 root 拥有的这个入口；通过显式 sudo 保留 SSH_ORIGINAL_COMMAND 后由脚本再次校验，不给予普通 shell 或任意 Docker 命令权限。此权限配置必须由管理员测试。

## 首次上线及更新

1. 检查 `.gitignore`、`.dockerignore` 和待提交文件清单，私人素材、课程原件、邮箱、数据库和 `.env` 不得进入仓库。不要整目录盲目上传。
2. 初始化 main 私有远程仓库并配置上述 secrets。部署程序和 Compose 使用受信任的固定版本，不能由网页请求改写。
3. 先在隔离服务器演练测试成功/失败、并发 Release、回滚、缺素材、数据库迁移失败。
4. 发布正式 Release。工作流检查该提交属于 main，然后测试、类型检查、迁移检查、生产构建；通过受限 SSH 传送 SHA 镜像。
5. 程序停止写入进程并备份，执行新增式迁移，再启动网站及 worker。检查网站、数据库版本和新版 worker 心跳。失败回退程序，**不自动还原旧数据库**。
6. `study-backup.service` 和 `.timer` 安装到 systemd 后手动测试，再启用。每天 Toronto 02:30 做一致性备份；短暂停止写入服务。03:00 是增量索引。
7. 用桌面和手机验收，云端连续运行 24 小时后才切换主站。此前本机继续是主节点；切换时停止本机同步。独立数据库之间的租约不能阻止两台机器重复抓取，必须配置唯一主节点。

## 恢复与数据删除

`verify-backup.sh` 解密到新建临时目录，以断网容器只读运行 SQLite integrity_check，不覆盖当前数据。该脚本尚未在服务器演练；它不是完整业务恢复验收。

真实恢复：先停止网站和 worker，额外保留当前数据，解密到独立恢复目录，检查数据库和文件引用、OAuth 密钥，再由管理员明确选择切换目录。绝不能以代码回滚为由覆盖新用户数据。

备份只保留最近 7 天，清理在成功备份后执行。服务停机导致清理未运行时，旧备份会延后清除。离线另存的副本由用户自行管理。资料删除立即禁止检索；未引用的原始 blob 在至少 24 小时宽限期后由夜间任务清理；其他会话仍引用的文件保留。备份副本仍需等待上述保留期结束。

## 已知待验收项

- Docker/SSH/HTTPS/systemd 实际运行、失败回滚、完整恢复和 24 小时稳定性。
- Google Gmail 授权测试状态、个人应用限制和只读权限审批；真实邮箱授权由用户完成。
- 整体 API 的限流与 CSRF 审核，所有历史接口也需纳入上线检查。
- PDF 已实现逐页检查点，Linux worker 启用本地 OCR，失败回退 AI；OCR 质量需真实扫描件验收。索引蓝绿切换仍未实现。
- 对话记忆为最近 24 条、持久化滚动摘要与相关旧对话检索；显示未压缩数量，不是无限记忆。支持预设查询和用户明确填写的公开搜索词。
- Gmail 已支持全归档分页与线程摘要。学习附件仍由用户选择课程后解析，不自动把私人邮件纳入课程对话。

以上是实施状态，不代表生产已经上线。
