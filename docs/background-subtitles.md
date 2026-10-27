# Background bilingual subtitles

This is an **opt-in host job**, not a deployed service. No new model, network microservice or production migration is introduced. The daily/manual archive controller writes `subtitle-queue.json`; it never waits for ASR or translation. Website playback only reads completed assets.

## Processing and bounds

- The host worker holds `subtitle-worker.lock` for one job. Controller/worker share `subtitle-queue.lock` only for brief queue read/update, so daily discovery is not held for a lecture's transcription time.
- Each current, verified original video SHA is a distinct job. Running leases expire after 40 minutes and can be reclaimed after worker restart. Failed jobs are retained for administrator inspection; they are not retried automatically.
- Only HEAD/ETag/size checks reuse the original full-GET archive proof. The original remains unchanged in private R2. A server-only expiring GET grant feeds ffmpeg directly into a 16 kHz mono audio cache; no permanent video download or re-encode is created.
- Existing pinned faster-whisper small.en, CPU int8, beam5/VAD and two threads are reused. No model download occurs. Five-minute chunk VTT/provenance checkpoints bind original video SHA, model revision/hash, audio SHA and exact clip window. Verified chunks are reused; the existing 600–900-second sample is reused when those identities match. Silence chunks remain explicit empty observations.
- Chunk times shift into original-video time exactly once. Whole English VTT and ASR provenance are saved before translation. The Chinese translation CLI uses `--budget-mode runtime`, the normal application AI ledger/monthly budget, and explicit invocation bounds of 30 requests/US$1. No development-budget bypass is used by the worker.
- English is published first even if the normal translation budget stops Chinese generation. Existing partial/full published bundles are preserved under a content-hashed history name before replacement. The player explicitly reports missing Chinese and partial coverage; it does not manufacture subtitles.
- A known pre-request runtime budget rejection is deferred only when the CLI emits its fixed budget marker and its last source-matching ledger record is `rejected`, charged exactly zero, with a future timezone-aware `retryAt`. The queue waits until that time and the next daily/manual wake; it does not spin. Ambiguous network requests, unconfirmed charges and invalid translations still stop for inspection rather than retrying.
- After that durable English publication, only worker-created WAV derivatives are removed to keep disk use bounded; chunk VTTs, all provenance, raw source references and translation checkpoints remain. On resume, complete verified chunk caches avoid extracting audio again. Original R2 videos and the existing sample/audio are never deleted.
- One process handles one video at a time, at most 30 minutes per invocation, two ASR threads, 2.5 GB host memory; the separate translation container has 512 MB/one CPU and runs after ASR. Keep 3 GiB available memory and 15 GiB free disk. Time-bound jobs retain checkpoints and may continue in the next invocation; low-resource jobs defer without a `PathExists` retry spin. The next daily/manual sync wakes deferred work.

## Release prerequisites (not executed by these files)

1. Install the existing archive/control tool and `subtitle-worker.py` into `/srv/study-course-video-tool`; install the two subtitle unit files under `/etc/systemd/system` only during an approved release.
2. Keep the already prepared runtime/model at `/srv/study-course-asr-tool` and `/srv/study-course-asr-state/models/faster-whisper-small.en`. ffmpeg/ffprobe and the existing AWS CLI must be available on the host.
3. Set `COURSE_VIDEO_APP_IMAGE=study-cabinet:APPROVED_RELEASE` in `/srv/study/course-video-control.env`. That image must contain `scripts/recording-subtitles.ts` and the new subtitle validators. An old website image is not treated as compatible.
4. The host unit reads the existing server-only `/srv/study/backup-s3.env` for R2 access. Those credentials are not supplied to the web service or CPU transcription child. Translation uses a temporary container with the normal `/srv/study/runtime.env` and application data/vault for the existing budget ledger. No key is printed or copied off-server.
5. Publish assets under `/srv/study/data/recording-subtitles/{videoSHA}.json` (directory root:web-group 750, files640) and configure the website's `RECORDINGS_SUBTITLE_DIR`. Source archive and previous ASR sample permissions remain unchanged.
6. After isolated queue/ASR/translation verification and approved deployment, enable `course-subtitle-worker.path`. The path watches only the controller's `subtitle-pending` marker; it is not a second daily scheduler. It removes the marker when claiming and creates it only when pending work should run again.

State and chunks remain on the existing host ASR directory. Final subtitle assets fall under the normal application data backup scope; this change does not create another backup system. Raw chunks are rebuildable from the immutable R2 original, not an additional truth source.

## Validation limits

The focused tests cover lease recovery/failure stop, strict chunk cache identity, and absolute-time merging with a wrong-window rejection. They do **not** prove real speech recognition or translation accuracy, live queue recovery, host service deployment, or whole-course coverage. Human review of technical terms, numbers and negation remains necessary; generated subtitles are labelled machine-generated. Deployment and live processing status must be reported separately from these code/tests.
