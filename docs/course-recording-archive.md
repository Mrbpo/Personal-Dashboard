# Quercus / Kaltura 课程录像归档（Issue #56）

## 状态和范围

这是独立命令行工具，支持本地入口和临时服务器容器，不改网站 UI、不增加常驻网络服务。首轮必须先用真实课程验证登录、课程频道分页及双流关系；代码和测试不等于已归档所有课程。依赖 PDF PR #52 的原文、证据及全文检索基础，并在其最新迁移 007 后增加 008。

默认只输出不含凭据的清单，**不下载视频、不读取字幕、不启动语音模型**。本地入口使用独立可见 Edge；当前服务器入口使用官方 Canvas sessionless LTI grant 和专用 Chromium。脚本只接收正常授权后 Quercus/Kaltura 请求里的临时 KS；不接收密码、不跳过 MFA、不读用户原浏览器资料、不输出 KS/签名播放地址。

### 本轮真实归档验收

五核心课程首次 catalog 已实际执行。化学和数学的原生 gallery 最初只显示 15 张卡，随后通过正常滚动触发页面自身的分页，分别核对到 16 和 29 场，不能以第一页可见数量宣称全量。每场只访问一次规范 entry，使用正式父子列表验证附属视角。

| 课程 | 原生场次 | 已验证媒体路数 | 实际归档 | 文件字节 | 解码验收 |
| --- | ---: | ---: | ---: | ---: | --- |
| BIOA01 / 440904 | 4 | 8 | 8/8 | 5,358,260,822 | 复用此前通过的 8 份，无重复解码 |
| CHMA10 / 443350 | 16 | 31 | 31/31 | 22,717,514,447 | 新 31 份 ffprobe + 单帧全部通过 |
| MATA29 / 452689 | 29 | 58 | 0/58 | 0 | 元数据完整；容量阻塞，未下载 |
| PHYA11 / 458777 | 10 | 20 | 20/20 | 21,759,843,605 | 新 20 份 ffprobe + 单帧全部通过 |
| STAB22 / 463664 | 0 | 0 | healthy empty | 0 | 实际原生 0 Media，无虚构媒体 |

已落盘 59 路共 49,835,618,874 字节，保留平台原始文件、音频及可用双视角，没有重编码或有损压缩。化学有一场上传资料正式子流列表为空，因此为 16 + 15 路，不虚构第二视角。本轮服务器专用工具已实际运行，但不是原网站视频功能上线。字幕、字幕全文入库和站内查询的真实课程验收仍待录像之后进行。

数学原始文件估计还需 70,835,180,544 字节。化学归档后空余约 54.3 GB，预留网站、PDF 和备份暂存至少 15 GiB 后，仍缺约 32.6 GB。当前默认 `--video-policy original`：没有授权原始格式或容量不足即停止，不自动改成低清格式。未启用 R2，未删旧文件，未降低分辨率；对象存储及释放本地缓存须另获明确授权。不能把数学元数据完整写成五课文件全部完成。

每课结果保存在 `/srv/study-course-recordings/reports/course-*.json`，含该课原生会员/父子关系、scan、archive 和格式预算，避免下一课覆盖全局 `manifest.scan` 导致误读。新文件解码证据保存 `decode-COURSE_ID.json` 和 SHA 身份的 `decoder-ledger.json`；已通过的相同字节不重复解码。仅条目元数据更新时间变化时，只有可靠 flavor 版本/更新时间/大小一致、字幕一致且现有文件 SHA 通过，才复用视频；否则仍保存新版本。首次 BIO 元数据更新形成的一份同 SHA 历史副本仍保留。

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

用户选择采集、授权验证和下载都放在服务器，并自行约每周发起一次，**没有定时任务**。`interactive.Dockerfile` 复用已安装的 runtime，只补匹配的 full Chromium、Xvfb、x11vnc、noVNC/websockify；`interactive-entrypoint.sh` 启动临时显示器和网页像素入口，同一正常浏览器等待本人验证，collector 退出就结束所有临时进程。入口已实际启动并查看，完整归档状态见后面的实测说明。

实际派生镜像已构建。首次只读容器启动浏览器因默认 HOME 的 Crashpad 写入失败退出；增加 `HOME=/tmp` 后成功启动。此必要配置已写入 Dockerfile；复用已构建镜像时加 `-e HOME=/tmp` 并提供可写 `/tmp`，不必为修配置重新下载 runtime。正常 headed KAF 和 gallery 现已显示；完整频道清单、子流关系及实际文件仍需分别验收。

```sh
docker build -f interactive.Dockerfile -t study-course-video:interactive1.63.0 .
# 在 /srv/study-course-video-tool 构建；root 将合法 grant producer 接到此管道。
GRANT_PRODUCER | docker run --rm -i --name study-course-video-interactive \
  --init --memory=1g --cpus=2 --shm-size=256m \
  -e HOME=/tmp \
  -p 127.0.0.1:6080:6080 \
  -v /srv/study-course-recordings:/archive \
  -v /srv/study-course-video-state:/state \
  study-course-video:interactive1.63.0 \
  --course-url https://q.utoronto.ca/courses/440904/external_tools/8084 \
  --media-host kaltura-quercus-prod.utoronto.ca --output /archive \
  --profile /state/browser --target-only --channel-id 814427 \
  --interactive-server --launch-url-stdin --probe --login-timeout 900
```

本机通过 SSH 将 `127.0.0.1:8765` 转发服务器 `127.0.0.1:6080`，再打开 `http://127.0.0.1:8765/vnc.html?autoconnect=1&resize=scale`。端口必须仅服务器本机开放，不映射公网。只有此专用服务器 profile 保存状态，不导出用户普通浏览器，也不收学校密码。Linux 使用官方 bundled Chromium，不能指定本机 Windows Edge。媒体资源在采集期间被阻断，避免播放器自动下载录像。

本人完成 Cloudflare/必要学校验证后，程序在**同一 context**采集；最长等待 900 秒，未通过就明确标记需验证并停止。单条真实验收使用后面的 `--entry-id` 参数；频道及 child 范围核对通过后才去掉该参数和 limit，归档全部未保存或已更新的 track。已有完整文件必须 SHA/版本一致才跳过；保留 `.part` 和历史，不因来源消失删除。字幕仍关闭。

保存浏览器 Cookie 不能延长学校或 Cloudflare 的服务端授权期限，也不能保证以后完全不用验证。UofT 当前官方 FAQ 的常规 remembered MFA 是 24 小时，不能按旧传闻承诺一周。[UofT UTORMFA FAQ](https://security.utoronto.ca/services/utormfa/faqs/)。当前服务器正常浏览器已通过上述验证，剩余验收是实际元数据、文件和双流范围；HTTP-only / headless 的历史 403 不等于现阶段仍被 Duo 阻塞。

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

### 当前服务器实测

临时 noVNC 入口已实际构建、启动并通过 SSH 隧道查看。只读容器需要可写 `/tmp` 和 `HOME=/tmp`；背景 collector 通过独立 FD 3 接收合法 grant，避免 POSIX shell 清空 stdin。正常 headed LTI 启动现已返回 KAF 200。公开 CDN 最初的 Cloudflare 检查导致脚本未加载；同一 context 对已观察的公开 `kmsCookie.js` 做一次正常顶层浏览器验证，得到 200 / JavaScript 后返回已观察的频道，真实窗口已显示 **4 Media、LECTURE 1–4 四张卡片**，没有可见 Next。没有自动解题或改写浏览器保护头。

频道 `categoryentry.list` 对 viewer KS 实测返回 `SERVICE_FORBIDDEN`。工具保留这一证据，以已授权 KAF 原生可视总数和对应频道卡片 ID 去重数量一致作为会员验证的另一入口；总数大于当前卡片数时必须完成原生分页，否则不完整。播放器另外四个 entry 只是子流候选，不能计为另外四节课。父子关系及每个 entry 身份仍须独立核对。

对上述服务器 collector 命令去掉 `--probe`，追加以下已观察地址和单条试验参数。单条只访问这张卡片获取适用会话，不要求 viewer 无权调用的管理员列表接口；严格核验 entry ID、flavor entry ID 和下载域名。`scopeComplete` 始终为 false，不能把一份文件成功报告为全课完成。

```sh
--known-gallery-url https://kaltura-quercus-prod.utoronto.ca/channel/channelid/814427 \
--verify-observed-asset-url https://assets.cap2.mediaspace.kaltura.com/5.188.26.1331/public/build0/js/kmsCookie.js \
--entry-id 0_l0mx1vr8 --download --limit 1
```

仅元数据验收则去掉 `--download --limit 1`。公开资产地址必须已观察，不猜版本或替代路径。单条服务器实测现已成功：`440904:0_l0mx1vr8` 返回身份一致的时长 3055 秒，归档 MP4 为 207,558,864 字节，文件 `ftyp` 头与 SHA 校验通过。存放 `/srv/study-course-recordings/440904/0_l0mx1vr8/version-1791926345/original.mp4`。真实 ffprobe 为 3054.538594 秒、H.264 1920×1080 和 AAC；ffmpeg 解码第 10 秒一帧退出 0。这只证明单条文件，不证明全部双流。字幕仍关闭，原网站未切换。

全课拓扑清单去掉 `--entry-id`、`--download`、`--limit`，保留同一个 gallery 和公开资产参数。正式父子列表无权限时，只对播放器已经观察的候选逐条读取元数据，并严格核对 `parentEntryId` 属于上述四个父录像。通过的关系保存原字段、获取时间、API host、版本作为证据，才允许进入归档范围；相同标题或时长不用于合并。此替代路径仍将全量子流覆盖标为未证实，不会把可见候选等同于穷尽。范围核对后增加 `--download` 归档已验证视角；第一条版本和 SHA 一致时直接跳过，不重复下载。

实际整课元数据已经退出 0：`scanComplete=true`、`scopeComplete=true`、8 个身份校验通过的 entry。此次正式 `baseentry.list(parentEntryIdEqual)` 成功，4 个父录像各有一个已核对的子流，非猜测关联：

| 父录像 | 子流 |
| --- | --- |
| `0_iptvn6i4` | `0_0ggqv361` |
| `0_73lcxb7r` | `0_jpfly7x5` |
| `0_l0mx1vr8` | `0_udo2h43p` |
| `0_n1wtlnwk` | `0_ugt8kqvu` |

每路返回两个格式，第一讲父录像时长 3054 秒，其余 3055 秒；屏幕/摄像头标签仍为 `unknown`，不得仅凭 parent/child 位置猜画面内容。最大格式估计总容量 5,358,257,152 字节，服务器空余约 105 GB。整课实际文件归档和各视角画面仍须单独确认；元数据完整不等于所有文件已落盘。元数据运行的最终摘要显示 `archiveStatus=not_requested`，不会把上一次单文件归档摘要当成此次完成结果。

随后整课视频归档实际退出 0：`scanComplete=true`、`scopeComplete=true`、8/8 `archived`，没有 needs_reauth 或 retryable_failure；总文件大小 5,358,260,822 字节。第一份复用已经通过的校验，新七份均经 ffprobe 和单帧解码，都是 H.264 1920×1080 + AAC，真实时长约 3054.49–3054.98 秒。第 4 讲主录像的第 120 秒是 DNA EDITING 幻灯片/电脑画面，子流 `0_udo2h43p` 同时点是课堂摄像头画面，两个视角已有真实图像证据。私人课堂截图不进 Git。该完成范围是此次明确观察到的 440904 频道四场录播，不代表其他课程或未来新增录像也已归档。

移除 `--target-only`，增加 `--all-courses`，会读取用户可见的学生课程，分页扫描课程模块、页面、公告和 Kaltura 外部工具。不使用服务器保存的 Canvas/Gmail 凭据。

清单路径是输出目录的 `manifest.json`，含 course ID、录播名称、发布时间、更新日期、稳定 ID、Kaltura entry ID、时长、原课程入口、是否有当前授权可下载的格式。临时地址仅存在内存中，清单里的入口不能直接代替下载授权。

- 对观察到的频道优先使用 `categoryentry.list(categoryIdEqual)` 分页核对 `totalCount`；viewer 无权限时使用已授权原生 gallery 的可视总数、频道卡片和分页核对。缺页、数量变化、无法获得该条适用会话时标记未完成。
- 对每个录播使用正式 `baseentry.list(parentEntryIdEqual)` 分页，独立枚举 parent/child 流，每路各自查询格式和字幕；记录关系证据。
- `track` 是 `screen / camera / unknown`，只有发布者提供明确 stream 名称时才分类；parent 不一定是摄像头，child 不一定是屏幕。没有第二路或无权限时必须查看 `streams.state`，不能宣称双流齐全。
- 通用 DOM 分页只能发现可见入口，不能证明所有课程的任意嵌入内容穷尽。因此清单保留 `coverageVerified: false`，直到真实学校 gallery 行为逐项验证。`scan.complete` 只表示本次已发现范围的操作成功。
- `scan.scopeComplete` 单独表示本次课程中观察到的频道总数、parent/child 关系和 entry 身份都已成功核对，必须实际发现频道且其分页计数一致；它不代表所有科目全局穷尽。
- 来源暂时不可见不会删除任何归档，也不取消课程任务。该版本不凭 UI 扫描自动标记缺失。

## 原始文件与字幕

### 管理员手动差量入口

仓库的 `course-video-grant.mjs`、`server-run.sh`、collector 和 entrypoint 已放到 `/srv/study-course-video-tool`，使用现已构建的临时 interactive 镜像。新 producer 接收数值 course/tool ID，在既有 worker 中读取 vault，校验 Canvas origin；授权 URL 只通过内部 stdin 管道进入 collector，不写文件、不输出终端。服务器实际 `bash -n` 和帮助输出通过，非法 course ID 在启动前被拒绝；新 producer 实际取得同 Canvas origin 的 grant，验收只输出成功布尔值。没有为入口包装重复整课下载。整课归档的运行已经证明第一条版本和 SHA 一致时跳过，不再次下载；其他课读取将在同一手动入口继续验收。

```sh
# 默认整课拓扑清单；不下载。
bash /srv/study-course-video-tool/server-run.sh
# 人工发起，自动补缺/补更新；版本和 SHA 一致的文件跳过。
bash /srv/study-course-video-tool/server-run.sh --download
# 单条试验仍明确为 partial。
bash /srv/study-course-video-tool/server-run.sh --download --entry-id 0_l0mx1vr8 --limit 1
# 其他课程只读发现真实频道链接；不知道 channel 时不用猜。
bash /srv/study-course-video-tool/server-run.sh --discover-channels --course-id COURSE_ID --tool-id OBSERVED_TOOL_ID
# 配置清单验证：不访问网络、不下载。
bash /srv/study-course-video-tool/server-run.sh --catalog /srv/study-course-video-tool/core-courses.catalog.json --dry-run
# 一次人工发起，依配置顺序补缺；失败课记录后继续下一课。
bash /srv/study-course-video-tool/server-run.sh --catalog /srv/study-course-video-tool/core-courses.catalog.json --download
```

默认 scope 是实测课程 440904 / tool 8084 / channel 814427；其他课程须提供真实数值 `--course-id`、`--tool-id`、`--channel-id` 和已观察的公共 `--observed-asset-url`，不得猜频道或 CDN 版本。默认镜像是服务器已验证的 `study-course-video:interactive1.63.0`，可由管理员通过 `COURSE_VIDEO_IMAGE` 指定已构建版本；使用已验证的 1 GB 内存、2 CPU、256 MiB tmp 和 init 配置。工具使用 dedicated profile 的非阻塞文件锁，拒绝并发使用该浏览器。每次获取 fresh grant，不设置计划任务；结束关闭容器，之后可再次手动运行。需要本人验证时才通过前述 SSH 隧道打开临时网页。完整双流覆盖未通过时 exit 2 和 scopeIncomplete 仍保留，即使一些已验证文件已经成功归档。

`--discover-channels` 不访问猜测的 gallery、元数据列表 API 或视频；在正常 LTI 启动后只读取实际 frame/anchor 中出现的频道路径，保存独立 `channel-discovery-COURSE_ID.json`，不覆盖已经验收的归档清单。明确 `/channel/channelid/N`、匹配当前课程的 `/channel/COURSE_ID/N` 与媒体 href 的 category 候选会分别记录来源；候选不等于课程会员验证。没有可读链接时退出 2 并明确未发现，不能静默宣称所有课成功。

只读实测已读到 CHMA10（443350 / 811203）、MATA29（452689 / 812430）、PHYA11（458777 / 814239）的实际 `/channel/COURSE_ID/CHANNEL_ID` frame 路径及媒体链接。STAB22（463664 / 814363）最初因未识别这种路径误报未发现；仅复验这一课后实际退出 0，读取 `/channel/463664/814363`、原生 **0 Media**、`observedEmpty=true`。没有重复前三课。可视链接数不作为全量录像数；空课来自实际原生标签，不从零链接推断空课或身份失效。元数据完整流程对明确的总数零保存 healthy empty，不删除既有归档。

管理员显式维护的 `core-courses.catalog.json` 包含以上四课和已完成 BIO 的真实 course/tool/channel/gallery 地址，不自动扩展辅助课或旧学期。`server-catalog.py` 先完整校验配置，再以 subprocess argv 顺序调用同一个已安装入口，每课 fresh grant、共享专用 profile；某课失败仍继续下一课，逐课保存报告，最后汇总并退出非零。真实服务器 bash 静态检查、五条清单 dry-run 和首次实际 catalog 均已执行；实际各课结果见前表，尚未完成数学文件归档。没有网站按钮、计划任务或额外服务。

下载入口在同一授权 context 中先核对清单和格式总容量，再下载缺失或实际版本变化的文件，预留至少 15 GiB；每份文件和下载过程也检查剩余空间。`--limit 1` 用于首次真实试下载，移除 `--limit` 才下载全部已发现 entry。双流各自保存，默认要求来源原始格式；原格式无下载权限则停止，保留可下载格式和错误状态供核查。`auto / hd` 仅为管理员明确选择的可选策略，当前用户要求原始文件，不启用这些策略；任何策略都不重编码，不处理 DRM。

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
