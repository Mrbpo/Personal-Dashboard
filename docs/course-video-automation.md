# Daily recording discovery and reauthorization

This extends the existing archive runner. Installing these files does not enable a timer, deploy a service, prove a school session is reusable, or change production.

## Operation

- `course-video-daily.timer` starts one fixed `sync` action at **04:00 America/Toronto** daily (with catch-up after downtime).
- Sync uses the existing explicit `core-courses.catalog.json`, normal Chromium and its dedicated saved profile. Xvfb stays local but VNC/noVNC are not started in unattended mode. It waits at most30seconds for login and one ordinary10second JavaScript verification; it never solves a challenge, bypasses Duo or changes browser identity to evade access controls.
- A known authorization failure stops the remaining catalog instead of launching the same expired session once per course. Further automatic daily attempts stay stopped until an explicit website request. Network/parse/storage failures remain `failed`, not falsely classified as expired login.
- Successful archives retain original bytes, existing exact-version SHA/remote proofs, unchanged-file reuse, `.part` recovery, the manual browser lock and15GiB reserve. New script flags do not invent permanent download links or silently re-download all149streams.
- After a run, verified original hashes are merged into a durable subtitle notification queue. No ASR/translation call runs inside the recording sync. Full saved bilingual subtitle windows are recognized; the earlier10–15minute sample does not mark the full lecture complete.

## Website/host contract

Protected host root: `/srv/study-course-video-control`. Mount it read-only at `/app/course-video-control`; mount only its `requests/` subdirectory read-write at `/app/course-video-control/requests`. Set `COURSE_VIDEO_CONTROL_DIR=/app/course-video-control` in the web container. The web service receives neither the Docker socket nor root commands.

The authenticated same-origin website writes an atomic, bounded request to `requests/request.json`:

```json
{"id":"c552462f-78e5-4dcf-986e-46bef448bd52","action":"reauthorize","requestedAt":"2026-10-26T12:00:00Z"}
```

Only `sync` and `reauthorize` are valid; there are no user-controlled URLs, paths, shell arguments, models or credentials. `course-video-control.path` wakes the fixed host service. The controller moves requests into root-only `private/` before opening them, rejects symlinks/nonregular files, limits them to2KiB, validates the UUID and timestamp (not older than24hours), and retains claimed inputs for audit. Duplicate starts acknowledge the request without replacing an active run.

`status.json` is an atomic root-owned, web-readable projection:

```json
{"state":"needs_auth","reasonCode":"AUTHORIZATION_REQUIRED","updatedAt":"2026-10-26T12:00:00+00:00","lastSuccessAt":null,"counts":{"archivedVideos":149,"pendingSubtitles":149},"authorizationActive":false,"requestId":"c552462f-78e5-4dcf-986e-46bef448bd52","currentCourseId":"440904"}
```

States: `running`, `completed`, `needs_auth`, `failed` (the website can use `idle` before the first run). Reasons: `SYNC_RUNNING`, `REAUTHORIZING`, `SYNC_COMPLETED`, `AUTHORIZATION_REQUIRED`, `CANVAS_ACCESS_REQUIRED`, `SYNC_FAILED`, `RUNNER_STOPPED`. The Canvas-specific reason means the configured Canvas token/permissions need checking in settings; a Duo browser alone cannot repair a missing/rejected Canvas API token. No raw provider errors or signing URLs are returned. `lastSuccessAt` survives failed or rejected runs.

An explicit `reauthorize` action starts the normal interactive runner in a temporary container named `study-course-video-auth`, on `COURSE_VIDEO_NETWORK` (default `study_default`), with **no published host port**. Caddy must protect `/recordings/authorize/*` using the application owner-auth check before stripping that prefix and proxying to `study-course-video-auth:6080`, including WebSocket upgrades. The noVNC URL must use `path=recordings/authorize/websockify`. `authorizationActive` becomes true only after the actual ready event. The window ends with the runner; controller cleanup stops only a temporary container carrying that exact run UUID label. Never expose6080or5900publicly.

## Subtitle queue

`subtitle-queue.json` contains `{schemaVersion:1,jobs:[{id:SHA,videoSha256:SHA,courseId,entryId,state,createdAt,...workerMetadata}]}`. One job per original video hash; normal states are `pending/running/completed/failed`. It carries no token, source URL or R2 key. Controller and worker both lock `subtitle-queue.lock` only around read/merge/claim/update; ASR must not hold that lock. Expired, missing, malformed or timezone-less running leases return to pending at the next sync, preserving checkpoints and `notBefore`; active leases and failed jobs remain unchanged. `subtitle-pending` is touched when pending jobs remain, for the separate worker's path trigger. The worker is responsible for bounded processing, leases, budget limits and failure stops. No subtitle-generation success is implied by enqueueing.

## Release setup (administrator only, not executed by this change)

1. Install the changed archive/controller scripts under `/srv/study-course-video-tool` alongside the existing fixed catalog, model/runtime and R2 tools. Do not replace existing profiles, manifests, private credentials or proofs.
2. Create root-protected control directories with the web group (normally1000): root750, `private/`700, `requests/`2770root:webgroup. Status and queue replacements are640root:webgroup. Do not put the root controller in a web-writable script directory.
3. Supply optional root-owned `/srv/study/course-video-control.env` with nonsecret configuration: `COURSE_VIDEO_CONTROL_DIR=/srv/study-course-video-control`, `COURSE_VIDEO_NETWORK=study_default`, `COURSE_VIDEO_WEB_GID=1000`, `COURSE_VIDEO_SUBTITLE_DIR=/srv/study/data/recording-subtitles`, and the existing optional player catalog export variables. Normal R2/Canvas credentials stay in their existing host/worker boundary.
4. Apply the website's optional control mounts and authenticated Caddy route. Verify logged-out HTTP and WebSocket requests are refused before enabling authorization access.
5. Install the provided `.service/.path/.timer` units, reload systemd, and only in an approved release enable `course-video-control.path` and `course-video-daily.timer`. Each action has a two-hour outer bound; no repeated automatic launch/reauth loop.
6. Run one real unattended check against an existing session, one observed expired-session stop, and one normal human reauthorization/resume. Those real external-session checks remain required; local unit or syntax tests cannot substitute for them.

Validation scope for this implementation: five focused controller tests (request boundaries, failure classification, queue dedupe/state preservation, partial/full subtitle coverage, interrupted-worker lease recovery), Python compilation and shell syntax where available. No new live course scan, download, model call, systemd installation or production permission change was performed by the automation subtask.
