# Quercus / Kaltura 课程录像归档（Issue #56）

## 状态和范围

这是独立的本地命令行工具，不改 UI，不在服务器安装新服务。首轮必须先用真实课程验证登录、课程频道分页及双流关系；代码和测试不等于已归档所有课程。依赖 PDF PR #52 的原文、证据及全文检索基础，并在其最新迁移 007 后增加 008。

默认只输出不含凭据的清单，**不下载视频、不启动语音模型**。浏览器是独立可见 Edge 临时会话，由用户输入学校登录信息并完成 Duo。脚本只接收正常授权后 Quercus/Kaltura 请求里的临时 KS；不接收密码、不跳过 MFA、不读用户原浏览器资料、不输出 KS/签名播放地址。

示例课程入口：`https://q.utoronto.ca/courses/440904/external_tools/8084`。已观察到学校媒体域 `kaltura-quercus-prod.utoronto.ca`，必须显式加入允许范围。

## 准备与首次清单

Python 安装 `scripts/course-video/requirements.txt` 的依赖。若系统已有 Playwright 和 Edge，可直接用现有 Python，不需要安装第二份浏览器。只有下载视频才需要 yt-dlp；字幕下载不需要 yt-dlp。

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
