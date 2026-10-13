# Quercus / Kaltura 课程录像归档（Issue #56）

## 状态和范围

这是独立的本地命令行工具，不改 UI，不在服务器安装新服务。首轮必须先用真实课程验证登录、课程频道分页及双流关系；代码和测试不等于已归档所有课程。依赖 PDF PR #52 的原文、证据及全文检索基础，并在其最新迁移 007 后增加 008。

默认只输出不含凭据的清单，**不下载视频、不读取字幕、不启动语音模型**。浏览器是独立可见 Edge 临时会话，由用户输入学校登录信息并完成 Duo。脚本只接收正常授权后 Quercus/Kaltura 请求里的临时 KS；不接收密码、不跳过 MFA、不读用户原浏览器资料、不输出 KS/签名播放地址。

示例课程入口：`https://q.utoronto.ca/courses/440904/external_tools/8084`。已观察到学校媒体域 `kaltura-quercus-prod.utoronto.ca`，必须显式加入允许范围。

## 准备与首次清单

### 当前优先：服务器授权启动

用户已要求流程放服务器。实际生产 worker 用现有 `CANVAS_TOKEN` 调用官方 `GET /api/v1/courses/440904/external_tools/sessionless_launch?id=8084&launch_type=course_navigation` 已得到 HTTP 200 和临时启动 URL；继续 GET 返回正常签名 LTI 1.1 hidden autoPOST form，非学校密码页。另一个 `/login/session_token` 入口实际返回 403，不能当成已可用。

`server-lti-probe.py` 是 stdlib HTTP-only 诊断：stdin 接受 `{ "launchUrl": "短时URL" }`，使用内存 CookieJar 原样 POST 合法 hidden fields，不输出表单值。真实 KAF POST 返回 403，固定安全 marker 为 `cloudflare=true / captcha=true`，没有明确 OAuth 签名错误标记；这表明需要继续验证普通浏览器流程，不能宣称服务器归档已经通。

可选 `server.Dockerfile` 只装固定匹配的 Playwright 1.63.0 和 Chromium headless shell，以及 yt-dlp 2026.8.19。构建 context 是 `scripts/course-video`。root 已实际构建并进行一次普通无头浏览器诊断，学校 KAF 仍返回 Cloudflare 验证 403，未成功枚举或下载；不继续用 stealth、自动求验证码或特殊代理。来源 URL 由管理员在现 worker 中正常取 grant，经 stdin 管道喂给 collector；不得把 URL 放命令行或日志。

```sh
# GRANT_JSON 由服务器现授权程序通过 stdin 提供，示例不包含密钥。
GRANT_PRODUCER | docker run --rm -i --memory=1g --cpus=2 --shm-size=256m \
  -v /srv/study-course-recordings:/archive COURSE_VIDEO_IMAGE \
  --course-url https://q.utoronto.ca/courses/440904/external_tools/8084 \
  --media-host kaltura-quercus-prod.utoronto.ca --output /archive \
  --target-only --channel-id 814427 --headless --launch-url-stdin \
  --probe --login-timeout 30
```

server collector 不重做 Canvas 网页 SSO 判断，因为 sessionless LTI 可启动 KAF 而没有 Canvas 浏览器 Cookie；也不会重新跳回要求网页登录的普通课程 URL。它观察正常 KAF JS/API 请求来判定真实会话和频道权限，阻断自动媒体流加载节省资源。普通 JS 等待一次后仍遇 Cloudflare 验证时记录 `needs_browser_verification` 并停止；无交互认证能力时不能承诺全自动。只有真实 metadata 和单 track 下载通过才能逐步启用 `--download`，字幕仍默认关闭。

### 每次人工发起的临时服务器授权窗口

用户选择采集、授权验证和下载都放在服务器，并自行约每周发起一次，**没有定时任务**。`interactive.Dockerfile` 复用已安装的 runtime，只补匹配的 full Chromium、Xvfb、x11vnc、noVNC/websockify；`interactive-entrypoint.sh` 启动临时显示器和网页像素入口，同一正常浏览器等待本人验证，collector 退出就结束所有临时进程。该工件需实际部署验证，不能等同于入口已交付。

实际派生镜像已构建。首次只读容器启动浏览器因默认 HOME 的 Crashpad 写入失败退出；同一资源配置仅增加 `HOME=/tmp` 后，正常无授权 headed 浏览器成功启动。此必要配置已写入 Dockerfile；复用已构建镜像时加 `-e HOME=/tmp` 并提供可写 `/tmp`，不必为修配置重新下载 runtime。登录验证、完整频道清单及视频下载仍需分别确认。

```sh
docker build -f interactive.Dockerfile -t study-course-video:interactive .
# 在 /srv/study-course-video-tool 构建；root 将合法 grant producer 接到此管道。
GRANT_PRODUCER | docker run --rm -i --name study-course-video-interactive \
  --memory=1500m --cpus=2 --shm-size=256m \
  -e HOME=/tmp \
  -p 127.0.0.1:6080:6080 \
  -v /srv/study-course-recordings:/archive \
  -v /srv/study-course-video-state:/state \
  study-course-video:interactive \
  --course-url https://q.utoronto.ca/courses/440904/external_tools/8084 \
  --media-host kaltura-quercus-prod.utoronto.ca --output /archive \
  --profile /state/profile --target-only --channel-id 814427 \
  --interactive-server --launch-url-stdin --probe --login-timeout 900
```

本机通过 SSH 将 `127.0.0.1:8765` 转发服务器 `127.0.0.1:6080`，再打开 `http://127.0.0.1:8765/vnc.html?autoconnect=1&resize=scale`。端口必须仅服务器本机开放，不映射公网。只有此专用服务器 profile 保存状态，不导出用户普通浏览器，也不收学校密码。Linux 使用官方 bundled Chromium，不能指定本机 Windows Edge。媒体资源在采集期间被阻断，避免播放器自动下载录像。

本人完成 Cloudflare/必要学校验证后，程序在**同一 context**采集；最长等待 900 秒，未通过就明确标记需验证并停止。实际频道/child/身份核对通过后，下一次人工运行去掉 `--probe`、增加 `--download --limit 1` 验收一个视频；该单例成功后去掉 limit 才下载频道所有未保存或已更新的 track。已有完整文件必须 SHA/版本一致才跳过；保留 `.part` 和历史，不因来源消失删除。字幕仍关闭。

保存浏览器 Cookie 不能延长学校或 Cloudflare 的服务端授权期限，也不能保证以后完全不用验证。UofT 当前官方 FAQ 的常规 remembered MFA 是 24 小时，不能按旧传闻承诺一周。[UofT UTORMFA FAQ](https://security.utoronto.ca/services/utormfa/faqs/)。当前阻塞是 KAF 的 Cloudflare，而非已经通过 API grant 的 Duo；记住 Duo 状态不能单独解决这个阻塞。

### 可选本地授权入口

Python 安装 `scripts/course-video/requirements.txt` 的依赖。若系统已有 Playwright 和 Edge，可直接用现有 Python，不需要安装第二份浏览器。只有下载视频才需要 yt-dlp；字幕下载不需要 yt-dlp。

临时与可选持久登录都明确使用本机 Edge (`channel=msedge`)，不依赖额外安装的 Chromium。下载模式在登录前检查 yt-dlp 是否已装；按每路最大已知大小和 512 MiB 余量预检磁盘，下载时再检查余量，空间不足停止并保留 `.part`。平台大小缺失时预估不等于保证足够，下载时的余量保护仍有效。

```powershell
python scripts/course-video/archive.py `
  --course-url https://q.utoronto.ca/courses/440904/external_tools/8084 `
  --media-host kaltura-quercus-prod.utoronto.ca `
  --output D:/Desktop/Files/course-recordings `
  --target-only --max-pages 10
```

看到新 Edge 后，在里面完成学校登录和 Duo。程序输出 `waiting_login / waiting_duo / authorized`。Duo 嵌套页是否可见可能受学校登录页面影响；最终授权判断以实际可读取课程 API 为准，支持 Canvas cookie-auth 的 `while(1);` 防护前缀。

默认会话只在当前进程内保存。需要中断后继续，可显式给 `--profile data/course-video/login-profile`，使用专用本地登录目录；该目录不能上传到 Git、归档目录或对象存储。会话失效标记 `needs_reauth`，重新正常登录后再运行。不要把整个浏览器资料或 Cookie 文件交给网站服务器。

## 多课程、双流和覆盖清单

移除 `--target-only`，增加 `--all-courses`，会读取用户可见的学生课程，分页扫描课程模块、页面、公告和 Kaltura 外部工具。不使用服务器保存的 Canvas/Gmail 凭据。

清单路径是输出目录的 `manifest.json`，含 course ID、录播名称、发布时间、更新日期、稳定 ID、Kaltura entry ID、时长、原课程入口、是否有当前授权可下载的格式。临时地址仅存在内存中，清单里的入口不能直接代替下载授权。

- 对观察到的频道使用 `categoryentry.list(categoryIdEqual)` 分页，核对 `totalCount` 与唯一 entry 数；缺页、数量变化、权限不足标记未完成。
- 对每个录播使用正式 `baseentry.list(parentEntryIdEqual)` 分页，独立枚举 parent/child 流，每路各自查询格式和字幕；记录关系证据。
- `track` 是 `screen / camera / unknown`，只有发布者提供明确 stream 名称时才分类；parent 不一定是摄像头，child 不一定是屏幕。没有第二路或无权限时必须查看 `streams.state`，不能宣称双流齐全。
- 通用 DOM 分页只能发现可见入口，不能证明所有课程的任意嵌入内容穷尽。因此清单保留 `coverageVerified: false`，直到真实学校 gallery 行为逐项验证。`scan.complete` 只表示本次已发现范围的操作成功。
- `scan.scopeComplete` 单独表示本次课程中观察到的频道总数、parent/child 关系和 entry 身份都已成功核对，必须实际发现频道且其分页计数一致；它不代表所有科目全局穷尽。
- 来源暂时不可见不会删除任何归档，也不取消课程任务。该版本不凭 UI 扫描自动标记缺失。

## 原始文件与字幕

先核对清单估计容量和本地空余，再加 `--download --limit 1` 做一份真实试下载。移除 `--limit` 才下载全部已发现 entry。双流各自保存，默认优先来源原始格式；若原格式没有授权下载，就不能保证拿到源文件，保留可下载格式和错误状态供核查。不会重编码，不处理 DRM。

```powershell
# 只归档平台提供的原始字幕，先一份
python scripts/course-video/archive.py --course-url COURSE_URL `
  --media-host kaltura-quercus-prod.utoronto.ca --output ARCHIVE_DIR `
  --target-only --download --subtitles-only --limit 1
```

每份媒体目录包含原文件和字幕（SRT/VTT/TTML），manifest 保存 SHA-256、大小及字幕语言。yt-dlp 使用 `.part` 继续下载，成功后才写 `archived`；重跑对现有文件核验 SHA，损坏文件不能当成已完成。更新版本放在单独目录，旧字幕即使被平台原位修改也保留原字节及历史清单。

用户当前验收顺序是 **440904 全部录像与两路视角 → 其他科目读取 → 字幕**。因此普通 `--download` 只下载视频；只有日后显式指定 `--with-captions` 或 `--subtitles-only` 才读取/下载平台字幕。为了先核对清单再下载又避免两个进程各登录一次，首次可使用 `--download --pause-after-inventory`：完成清单后同一可见浏览器保持登录，管理员读 manifest 核对后在控制台按 Enter 开始视频归档。等待过久仍可能由学校强制过期，需要正常重新授权。

缺字幕时可以额外安装 `requirements-asr.txt` 并调用 `transcribe.py VIDEO --model-path EXISTING_LOCAL_MODEL --output caption.vtt --threads 4`。使用本地 faster-whisper CPU int8、单 worker，不自动下载模型、不调付费 API、不自动翻译。原语音字幕的质量必须实际验收，不能等同于官方字幕。此次不开展全课程 ASR。模型恢复为整份重做，下载断点与 ASR 断点是不同能力。

服务器目前磁盘余量有限，大视频默认存本地显式输出目录。未来可接对象存储独立 `course-recordings/` 前缀；**不能使用带 7 天删除规则的备份前缀**。本版本没有声称已经实现或启用 S3 上传。

## 进入 Kernel 与搜索

```powershell
$env:KERNEL_DATABASE_URL = '配置好的数据库连接（不要提交）'
node --experimental-strip-types scripts/course-video-import.ts `
  --archive ARCHIVE_DIR --owner YOUR_OWNER --course-map course-map.json
```

`course-map.json` 显式将 Canvas ID 映射到已存在的 canonical course ID，例如 `{"440904":"existing-kernel-course-id"}`。未映射时留为 unscoped，adapter 不创建或改写课程。导入校验原字幕 SHA、路径不能越界，SRT/VTT/TTML 解析严格验证时间段后调用 `KernelService.ingestRecordingTranscript`，在一笔事务中保存来源版本、原文证据、cue 文本、真实毫秒起止、全文索引和当前版本。

字幕文本可使用已有 `KernelService.searchDocumentText` 查询，命中带 `content_kind=time_segment`、`start_ms/end_ms`、原 entry ID locator 和 evidence ID。底层兼容列 `page_number` 是 cue 顺序，不是 PDF 页；消费者应按 `content_kind` 呈现时间引用。此阶段没有更改 UI 的 PDF 页码标签。

ASR 生成的 VTT 可以经同一 `KernelService` 调用以 `method=local-asr` 和模型信息导入，但当前批量 manifest importer 只导入已校验的平台字幕。未实现 ASR 自动批量入库，不把它写成已经连通。

## 验证与限制

必要测试覆盖：字幕时间戳、凭据域范围和 URL 脱敏、文件损坏/断点校验、Canvas XSSI、实际 PostgreSQL 的时间证据及幂等搜索。真实大学登录、所有课程覆盖、原始双流下载、字幕完整性仍需使用用户授权的可见浏览器和真实资源验证。

官方参考：[yt-dlp Kaltura extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/kaltura.py)、[Kaltura parent/child 查询](https://knowledge.kaltura.com/help/how-to-swap-between-child-and-parent-via-api)、[字幕 API](https://www.kaltura.com/api_v3/testmeDoc/services/caption_captionasset.html)、[Kaltura BaseEntryFilter](https://www.kaltura.com/api_v3/testmeDoc/objects/KalturaBaseEntryFilter.html)。直接调用 yt-dlp 的 `kaltura:partner:entry` 会创建 widget KS，所以本工具使用浏览器已授权格式交给下载器，避免把受限课程会话替换成公共 widget session。
