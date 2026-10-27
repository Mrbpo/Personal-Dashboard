#!/usr/bin/env bash
# Shared administrator/daily runner. Authentication grants still flow only on stdin.
set -euo pipefail
umask 077
tool_root=/srv/study-course-video-tool
archive_root=/srv/study-course-recordings
state_root=/srv/study-course-video-state
image=${COURSE_VIDEO_IMAGE:-study-course-video:interactive1.63.0}
course_id=440904
tool_id=8084
channel_id=814427
kaf_host=kaltura-quercus-prod.utoronto.ca
asset_url=https://assets.cap2.mediaspace.kaltura.com/5.188.26.1331/public/build0/js/kmsCookie.js
gallery_url=
download=0
entry_id=
limit=0
tool_supplied=0
channel_supplied=0
discover=0
catalog=
dry_run=0
video_policy=original
subtitles_only=0
archive_r2=0
lock_fd=
gallery_probe=0
resume_report=
unattended=0
website_authorization=0
usage() {
  echo 'Usage: server-run.sh [--catalog FILE [--dry-run]] [--discover-channels | --download | --archive-r2 | --subtitles-only] [--entry-id ID] [--limit N] [--course-id N --tool-id N --channel-id N] [--kaf-host HOST] [--observed-gallery-url URL] [--observed-asset-url URL]'
  echo 'Default is metadata only. Use --download for missing/updated verified recordings.'
}
while (( $# )); do
  case "$1" in
    --download) download=1; shift ;;
    --subtitles-only) download=1; subtitles_only=1; shift ;;
    --archive-r2) download=1; archive_r2=1; shift ;;
    --unattended) unattended=1; shift ;;
    --website-authorization) website_authorization=1; shift ;;
    --lock-fd) lock_fd=${2:?}; shift 2 ;;
    --probe-gallery) gallery_probe=1; shift ;;
    --resume-evidence-report) resume_report=${2:?}; shift 2 ;;
    --discover-channels) discover=1; shift ;;
    --catalog) catalog=${2:?}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --video-policy) video_policy=${2:?}; shift 2 ;;
    --course-id) course_id=${2:?}; shift 2 ;;
    --tool-id) tool_id=${2:?}; tool_supplied=1; shift 2 ;;
    --channel-id) channel_id=${2:?}; channel_supplied=1; shift 2 ;;
    --kaf-host) kaf_host=${2:?}; shift 2 ;;
    --observed-asset-url) asset_url=${2:?}; shift 2 ;;
    --observed-gallery-url) gallery_url=${2:?}; shift 2 ;;
    --entry-id) entry_id=${2:?}; shift 2 ;;
    --limit) limit=${2:?}; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo 'Unknown option.' >&2; usage >&2; exit 2 ;;
  esac
done
(( unattended == 0 || website_authorization == 0 )) || { echo 'Choose unattended sync or website authorization.' >&2; exit 2; }
[[ $video_policy == auto || $video_policy == original || $video_policy == hd ]] ||
  { echo 'Video policy must be auto, original, or hd.' >&2; exit 2; }
[[ $archive_r2 == 0 || -z $entry_id && $limit == 0 && $subtitles_only == 0 && $discover == 0 && $video_policy == original ]] ||
  { echo 'R2 archive requires complete-course original video mode.' >&2; exit 2; }
if [[ -n $catalog ]]; then
  [[ -z $resume_report ]] || { echo 'Historical recovery requires one explicit course.' >&2; exit 2; }
  (( gallery_probe == 0 )) || { echo 'Gallery probe requires one course.' >&2; exit 2; }
  (( subtitles_only == 0 )) || { echo 'Run subtitles per explicit course after video acceptance.' >&2; exit 2; }
  [[ $discover == 0 && -z $entry_id && $limit == 0 ]] ||
    { echo 'Catalog runs cannot mix discovery, entry, or limit options.' >&2; exit 2; }
  catalog_args=(--catalog "$catalog")
  (( download == 0 )) || catalog_args+=(--download)
  (( dry_run == 0 )) || catalog_args+=(--dry-run)
  catalog_args+=(--video-policy "$video_policy")
  (( archive_r2 == 0 )) || catalog_args+=(--archive-r2)
  (( unattended == 0 )) || catalog_args+=(--unattended)
  (( website_authorization == 0 )) || catalog_args+=(--website-authorization)
  exec python3 "$tool_root/server-catalog.py" "${catalog_args[@]}"
fi
(( dry_run == 0 )) || { echo 'Dry-run requires a catalog.' >&2; exit 2; }
[[ $course_id =~ ^[1-9][0-9]*$ && $tool_id =~ ^[1-9][0-9]*$ && $channel_id =~ ^[1-9][0-9]*$ && $limit =~ ^[0-9]+$ ]] ||
  { echo 'Identifiers must be positive integers; limit must be nonnegative.' >&2; exit 2; }
[[ $kaf_host =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'Invalid observed KAF hostname.' >&2; exit 2; }
[[ -z $entry_id || $entry_id =~ ^[01]_[A-Za-z0-9]+$ ]] ||
  { echo 'Invalid observed entry ID.' >&2; exit 2; }
[[ $course_id == 440904 || $tool_supplied == 1 && ( $channel_supplied == 1 || $discover == 1 ) ]] ||
  { echo 'Another course requires its observed tool and channel IDs.' >&2; exit 2; }
[[ $discover == 0 || $download == 0 && -z $entry_id ]] ||
  { echo 'Channel discovery cannot download or select an entry.' >&2; exit 2; }
[[ $course_id == 440904 || $discover == 1 || -n $gallery_url ]] ||
  { echo 'Another course needs its actually observed gallery URL.' >&2; exit 2; }
[[ -f "$tool_root/course-video-grant.mjs" && -f "$tool_root/archive.py" && -f "$tool_root/interactive-entrypoint.sh" ]] ||
  { echo 'Server grant producer and collector are required.' >&2; exit 2; }
mkdir -p "$archive_root" "$state_root"
chmod 700 "$state_root"
if [[ -n $lock_fd ]]; then
  [[ $lock_fd =~ ^[0-9]+$ && $(readlink -f "/proc/self/fd/$lock_fd") == "$state_root/manual-run.lock" ]] ||
    { echo 'Invalid inherited manual lock.' >&2; exit 2; }
  exec 9>&"$lock_fd"
else
  exec 9>"$state_root/manual-run.lock"
fi
flock -n 9 || { echo 'A run already uses this dedicated browser.' >&2; exit 2; }
# Preserve the inherited lock through a narrow object HEAD pre/postflight.
# Local-only archives need no object-store network/config.
verify_remote_cache() {
  if python3 - "$archive_root/manifest.json" "$course_id" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
raise SystemExit(0 if any(entry.get('courseId') == sys.argv[2] and any(file.get('remote') for file in entry.get('files', [])) for entry in data.get('entries', {}).values()) else 1)
PY
  then
    bash "$tool_root/r2-archive.sh" --verify-only --course-id "$course_id" --lock-fd 9 \
      --lifecycle-evidence "$state_root/recordings-lifecycle-evidence.json"
  fi
}
(( discover )) || verify_remote_cache
args=(--course-url "https://q.utoronto.ca/courses/$course_id/external_tools/$tool_id"
      --output /archive --media-host "$kaf_host" --profile /state/browser
      --interactive-server --launch-url-stdin --login-timeout 900 --target-only)
docker_access=(-p 127.0.0.1:6080:6080)
container_name="study-course-video-manual-$$"
if (( unattended )); then
  args+=(--unattended --login-timeout 30)
  asset_url=
  docker_access=()
  container_name=study-course-video-daily
elif (( website_authorization )); then
  docker_access=(--network "${COURSE_VIDEO_NETWORK:-study_default}")
  container_name=study-course-video-auth
fi
if [[ -n $resume_report ]]; then
  [[ $resume_report == "$archive_root"/reports/*.json && -f $resume_report && $discover == 0 && $gallery_probe == 0 ]] ||
    { echo 'Historical recovery requires a saved archive course report.' >&2; exit 2; }
  args+=(--resume-evidence-report "/archive/${resume_report#"$archive_root"/}")
  asset_url= # No repeat asset verification or gallery pagination for known IDs.
fi
if (( discover )); then
  args+=(--discover-channels)
else
  [[ -n $gallery_url ]] || gallery_url="https://$kaf_host/channel/channelid/$channel_id"
  args+=(--channel-id "$channel_id" --known-gallery-url "$gallery_url")
  [[ -z $asset_url ]] || args+=(--verify-observed-asset-url "$asset_url")
fi
[[ -z $entry_id ]] || args+=(--entry-id "$entry_id")
if (( gallery_probe )); then
  (( download == 0 && discover == 0 )) || { echo 'Gallery probe is read only.' >&2; exit 2; }
  args+=(--probe --gallery-only)
fi
(( download == 0 )) || args+=(--download --limit "$limit" --inventory-first --video-policy "$video_policy" --reserve-gib 15)
(( subtitles_only == 0 )) || args+=(--subtitles-only)
# The vault/token remains in the existing worker; fresh grant flows only on stdin.
docker exec -i -e COURSE_VIDEO_COURSE_ID="$course_id" -e COURSE_VIDEO_TOOL_ID="$tool_id" \
  -e COURSE_VIDEO_CANVAS_ORIGIN=https://q.utoronto.ca \
  study-worker-1 node --experimental-strip-types --input-type=module \
  < "$tool_root/course-video-grant.mjs" |
  docker run --rm -i --init --name "$container_name" \
    --label "study.course-video.run=${COURSE_VIDEO_CONTROL_RUN_ID:-manual}" \
    --read-only --memory=1g --cpus=2 --shm-size=256m \
    --tmpfs /tmp:rw,nosuid,size=256m -e HOME=/tmp -e COURSE_VIDEO_UNATTENDED="$unattended" \
    "${docker_access[@]}" \
    -v "$archive_root:/archive" -v "$state_root:/state" \
    -v "$tool_root/archive.py:/tool/archive.py:ro" \
    -v "$tool_root/interactive-entrypoint.sh:/tool/interactive-entrypoint.sh:ro" \
    "$image" "${args[@]}"
(( discover )) || verify_remote_cache
if (( subtitles_only )); then
  python3 "$tool_root/thin-snapshot.py" --lock-fd 9
fi
if (( archive_r2 )); then
  python3 "$tool_root/verify-archive.py" --course-id "$course_id"
  bash "$tool_root/r2-archive.sh" --course-id "$course_id" --upload --release-cache --lock-fd 9 \
    --lifecycle-evidence "$state_root/recordings-lifecycle-evidence.json"
  if [[ -n ${COURSE_VIDEO_PLAYER_CATALOG:-} ]]; then
    python3 "$tool_root/export-player-catalog.py" --source "$archive_root/manifest.json" \
      --destination "$COURSE_VIDEO_PLAYER_CATALOG" --group "${COURSE_VIDEO_PLAYER_GID:-1000}"
  fi
fi
