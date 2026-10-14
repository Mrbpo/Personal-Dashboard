# 本地 CPU 课堂字幕样例（Issue #62）

只先处理一份600–900秒音频，不自动转写117份录像，不新增页面、服务或付费AI。基于v1.1.0 main `b23186d`，本PR独立于这次正式Release。

## 已准备的运行时与模型

- 隔离运行时：`/srv/study-course-asr-tool/venv`，faster-whisper1.2.1、CTranslate2 4.8.3、PyAV16.1.0、ONNX Runtime1.31.0。初次自动解析得到PyAV19.0.1，import正常但真实解码失败（`metadata_errors`参数已移除），因此固定兼容16.1.0；不能将import检查当转写成功。
- 模型：`/srv/study-course-asr-state/models/faster-whisper-small.en`。
- 官方repository `Systran/faster-whisper-small.en`，固定revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f`，四文件486,098,798字节。
- `model.bin`483,545,366字节，官方LFS与实际SHA256均为 `62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a`。`download-manifest.json`记录所有文件哈希，`runtime-packages.txt`保留依赖版本。
- 专用工具与状态目录总约0.96GB。模型、音频、字幕、私人清单不入Git。

模型准备工具：`python3 scripts/course-video/prepare-asr-model.py --output LOCAL_MODEL_DIRECTORY`，只请求固定revision的四个文件。依赖按`requirements-asr.txt`准备；没有GPU/CUDA或PyTorch要求。[模型文件](https://huggingface.co/Systran/faster-whisper-small.en/tree/d1d751a5f8271d482d14ca55d9e2deeebbae577f)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)。

## 转写边界与命令

先等待总调度确认网站发布健康，再从已核验原片提取一份600–900秒音频。原片仍保留R2，不重编码或重新核验整库。提供的`source-video-sha256`必须来自该原片的已核验清单。

```bash
systemd-run --scope \
  -p CPUQuota=200% -p MemoryMax=2500M -p MemorySwapMax=0 \
  /usr/bin/time -v timeout 900 \
  env HF_HUB_OFFLINE=1 OMP_NUM_THREADS=2 \
  /srv/study-course-asr-tool/venv/bin/python \
  /srv/study-course-asr-tool/transcribe.py \
  /srv/study-course-asr-state/sample-600-900.wav \
  --model-path /srv/study-course-asr-state/models/faster-whisper-small.en \
  --source-video-sha256 ORIGINAL_SHA_FROM_VERIFIED_MANIFEST \
  --clip-start-ms 600000 --clip-end-ms 900000 \
  --output /srv/study-course-asr-state/sample-600-900.vtt \
  --language en --threads 2
```

只单任务、两线程、CPU int8、beam5、VAD，本地文件模型、禁止隐式下载。执行前核对音频长度与声明片段相符；记录耗时/峰值内存。官方small int8基准在8线程12700K上峰值1477MB，不能当本服务器实测时长或准确率。[官方基准](https://github.com/SYSTRAN/faster-whisper#small-model-on-cpu)。

## 导入与真实定位

`transcribe.py`输出VTT和同名`.provenance.json`，包含`method=local-asr`、模型/revision/hash、原片SHA、音频SHA、字幕SHA、片段原片起止、`timestampBasis=clip-relative`。字幕仍从片段0开始，导入时加600000ms；`source-absolute`只校验界限，不再偏移。超出原片/声明片段、缺原片或模型身份、SHA不符均拒绝。

为该录像的私有manifest新增字幕文件项：`kind=caption`、`method=local-asr`、`format=vtt`、`captionId`、`language=en`、`sha256`、`path`与`provenancePath`。记录保留原video文件的SHA，即使cache已释放。路径都须位于archive根内。现有`course-video-import.ts --archive PATH --owner OWNER [--course-map JSON_FILE]`通过KernelService导入；旧平台字幕保持`platform-caption`，ASR必须显式标记，不能从未标记的ASR侧车静默退回平台身份。

稳定ASR来源进入录播版本身份；模型revision、模型hash、片段或音频身份变化时保留新来源版本，普通PDF与旧平台字幕身份保持不变。不新增SQL迁移，复用009时间片段索引。生产导入须使用已发布的本PR实现，不能把安装运行时当成网站已经接入。

适配层与Kernel入口共用完整ASR来源校验；直接调用`KernelService.ingestRecordingTranscript`也必须提供匹配的model/revision/hash/片段来源。Kernel接受的cues必须已经是原片绝对时间，只验证范围、不再偏移；`timestampBasis`描述原始VTT的时间基准。平台字幕携带ASR来源或缺少ASR来源的`local-asr`均拒绝。

## 样例验收

2026-10-14 唯一样例已实际运行：BIOA01 `0_l0mx1vr8` 原片600–900秒，300.0秒单声道16kHz音频9,600,078字节。PyAV16.1修复后复用同一音频，不再取原片/模型。CPU转写126.09秒，任务time126.36秒、平均177%CPU、最大RSS965,608KiB（约943MiB）；49条英语字幕，运行结束可用内存约4.86GiB。没有付费AI或生产PG写。

真实VTT和侧车已通过离线导入normalizer与Kernel文档准备检查：原片SHA `ef7dd5af95a4f3ecd56932ae86c97600c60c61986a2dd052ae283039a8d189f8`，model revision/hash有效，原片时间600430–900000ms，首引用10:00.430–10:02.430、末引用14:58.060–15:00.000，证据confidence0.6。可运行`node --experimental-strip-types scripts/validate-asr-sample.ts PRIVATE_SAMPLE_DIRECTORY`复核小型字幕/侧车，脚本不写PG或输出课堂正文。此前失败不是识别结果；正确固定依赖后才有真实转写输出。

已将样例VTT、来源侧车、单entry导入manifest、原片R2引用、模型receipt、runtime版本和运行结果独立保存在`/srv/study/data/course-recording-archive/asr-sample-62/`：7个小文件共11,276字节，由现有每日加密备份覆盖，未另做备份。与平台字幕清单分开，平台扫描不能覆盖此派生来源。9.6MB音频保留在私有ASR状态目录，清单记录原片SHA/R2键及600–900秒、16kHz单声道PCM重建参数；486MB模型不进入备份，按固定revision/SHA重建。原片仍使用已核验R2引用，不重复复制。

自动检查VTT格式、原片时间范围、source/model身份和Kernel/library owner-scoped检索返回的evidence与实际时间。CI中的合成字幕只验证数据链，不证明课堂ASR准确率。

人工核听五分钟中的专业词、数字、否定语，并对三个30秒片段整理参考稿计算WER。没有人工ground truth前只报告转写运行及检索链结果，不声称准确率达标；不以从ASR自身生成的查询当识别准确率证据。首次结果不理想时先停留在这一份样例，不自动扩展整个资料库。
