# Website recording player

`/recordings` uses ArtPlayer 5.4.0 and the existing owner login. The dashboard links to it. Playback streams the private original bytes from R2 without transcoding or whole-video buffering. Background discovery and subtitle jobs are separate opt-in host services described below. This change does not deploy itself.

## Data and playback

- `GET /api/recordings`: reads the collector's current `manifest.json` afresh, groups parent/child entries within each course, and returns only player metadata/opaque IDs. Current course names come from the existing course service; unknown names fall back to the source course ID. Unknown camera/screen labels remain unknown.
- Only current `archived` entries with matching `verified/full_get_sha256` remote proofs, source hash, byte count, bucket, endpoint and exact object/version paths are playable. Historical versions are not revived when current entries fail. MP4/M4V/WebM originals are supported; other containers are counted as unavailable, not converted.
- `GET /api/recordings/:viewId/play`: authenticates the owner, resolves a version-bound opaque ID from the manifest, HEAD-checks ETag/length, and redirects with 307 to an expiring signed GET URL. Invalid/missing IDs return 404. Missing configuration/unavailable storage returns 503. Provider messages/keys are not returned.
- Browser Range requests and video data go directly to R2. The server does not buffer a whole lecture. Basic playback does not require cross-origin JS access or changing the bucket's CORS rules. Screenshot/cross-origin canvas features are disabled.
- URL lifetime is lecture duration +30 minutes, minimum 1 hour, maximum 6 hours. R2 session credentials may expire earlier. Explicit reload remints a URL while preserving position/rate; automatic reconnect loops are disabled. First play is not autoplayed. View switching preserves position/rate/play state; it does not assert frame-level synchronization.
- In-player dual view uses one main/PPT role plus a muted camera/secondary role. The secondary follows main play/pause, seek and speed; an unavailable secondary does not stall the main. Hide/swap and view selection remain explicit; unknown archive labels are not relabelled as visually verified. There is no OS floating window, Document PiP or native PiP feature.
- Fullscreen/web-fullscreen reserves 80% for video and 20% for subtitles (25/30% selectable). The corner video and controls stay in the video region. Original aspect ratio is retained; long captions wrap and may scroll. Browser-native video-only fullscreen on some mobile systems cannot guarantee this DOM layout.
- Owner-protected `GET /api/recordings/:viewId/subtitles` reports available languages and partial coverage; `?mode=en|zh|bilingual` returns a verified WebVTT bound to the current original SHA. Missing subtitle assets never trigger a model call during playback.

## Release configuration (not performed by adding these files)

Create `/srv/study/recordings-readonly.env` on the server using a dedicated R2 **Object Read only** credential for the existing archive bucket. Do not reuse the backup uploader's credential. Keep the file private and out of Git:

```dotenv
RECORDINGS_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
RECORDINGS_S3_BUCKET=BUCKET_NAME
RECORDINGS_S3_ACCESS_KEY_ID=READ_ONLY_ACCESS_KEY_ID
RECORDINGS_S3_SECRET_ACCESS_KEY=READ_ONLY_SECRET
# Optional for temporary credentials:
# RECORDINGS_S3_SESSION_TOKEN=SESSION_TOKEN
```

Apply `deploy/compose.recordings.yml` together with the normal Compose at a separately approved release. It mounts a minimal player catalog directory read-only and supplies this dedicated environment file. The current application is single-owner (`local-owner`); archive ownership is explicit via `RECORDINGS_OWNER_ID`.

The original archive manifest is root-owned mode 600. Do not assume a read-only mount makes it readable by the web container (UID 1000). The included exporter publishes only entry/file/remote-proof fields, dropping auth and history; the source permissions stay unchanged. At the approved release, run the initial export:

```sh
python3 /srv/study-course-video-tool/export-player-catalog.py \
  --destination /srv/study/recording-player/manifest.json --group 1000
```

For future normal manual `--archive-r2` runs, set `COURSE_VIDEO_PLAYER_CATALOG=/srv/study/recording-player/manifest.json` in the archive runner's environment. The opt-in hook refreshes that small catalog after successful archiving, using atomic replacement, directory 750/file 640 and the configured web group. This catalog hook itself adds no timer or download; the separately opt-in daily controller can schedule archive runs. The dedicated read credential, initial export and hook activation remain release prerequisites and have not been applied to production. Mount the directory, not the file, so replacements are observed.

The normal Compose configuration is unchanged. Without the opt-in file/credentials, existing website functions run normally and the recording endpoint reports its missing configuration. Do not make the bucket public. Signed video URLs are temporary bearer grants and must not be committed or logged in reports. Credentials never enter the client bundle.

## Limits and evidence

Optional [background subtitles](background-subtitles.md) generate English with the existing CPU ASR, then Chinese through the normal AI budget. Partial coverage and machine-generated text are labelled; original English, timing and provenance remain preserved. [Daily discovery](course-video-automation.md) and reauthorization are separate from playback. This implementation does not claim whole-course subtitles or transcript-search ingestion merely because the controls exist. Browser codec/fullscreen support still matters; see the delivery report for actual tests.

References: [ArtPlayer](https://github.com/zhw2590582/ArtPlayer), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
