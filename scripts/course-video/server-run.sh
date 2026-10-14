#!/usr/bin/env bash
# Administrator-triggered run only. No scheduler or secret-bearing arguments.
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
usage() {
  echo 'Usage: server-run.sh [--catalog FILE [--dry-run]] [--discover-channels | --download] [--entry-id ID] [--limit N] [--course-id N --tool-id N --channel-id N] [--kaf-host HOST] [--observed-gallery-url URL] [--observed-asset-url URL]'
  echo 'Default is metadata only. Use --download for missing/updated verified recordings.'
}
while (( $# )); do
  case "$1" in
    --download) download=1; shift ;;
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
[[ $video_policy == auto || $video_policy == original || $video_policy == hd ]] ||
  { echo 'Video policy must be auto, original, or hd.' >&2; exit 2; }
if [[ -n $catalog ]]; then
  [[ $discover == 0 && -z $entry_id && $limit == 0 ]] ||
    { echo 'Catalog runs cannot mix discovery, entry, or limit options.' >&2; exit 2; }
  catalog_args=(--catalog "$catalog")
  (( download == 0 )) || catalog_args+=(--download)
  (( dry_run == 0 )) || catalog_args+=(--dry-run)
  catalog_args+=(--video-policy "$video_policy")
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
exec 9>"$state_root/manual-run.lock"
flock -n 9 || { echo 'A run already uses this dedicated browser.' >&2; exit 2; }
args=(--course-url "https://q.utoronto.ca/courses/$course_id/external_tools/$tool_id"
      --output /archive --media-host "$kaf_host" --profile /state/browser
      --interactive-server --launch-url-stdin --login-timeout 900 --target-only)
if (( discover )); then
  args+=(--discover-channels)
else
  [[ -n $gallery_url ]] || gallery_url="https://$kaf_host/channel/channelid/$channel_id"
  args+=(--channel-id "$channel_id" --known-gallery-url "$gallery_url")
  [[ -z $asset_url ]] || args+=(--verify-observed-asset-url "$asset_url")
fi
[[ -z $entry_id ]] || args+=(--entry-id "$entry_id")
(( download == 0 )) || args+=(--download --limit "$limit" --inventory-first --video-policy "$video_policy" --reserve-gib 15)
# The vault/token remains in the existing worker; fresh grant flows only on stdin.
docker exec -i -e COURSE_VIDEO_COURSE_ID="$course_id" -e COURSE_VIDEO_TOOL_ID="$tool_id" \
  -e COURSE_VIDEO_CANVAS_ORIGIN=https://q.utoronto.ca \
  study-worker-1 node --experimental-strip-types --input-type=module \
  < "$tool_root/course-video-grant.mjs" |
  docker run --rm -i --init --name "study-course-video-manual-$$" \
    --read-only --memory=1g --cpus=2 --shm-size=256m \
    --tmpfs /tmp:rw,nosuid,size=256m -e HOME=/tmp \
    -p 127.0.0.1:6080:6080 \
    -v "$archive_root:/archive" -v "$state_root:/state" \
    -v "$tool_root/archive.py:/tool/archive.py:ro" \
    -v "$tool_root/interactive-entrypoint.sh:/tool/interactive-entrypoint.sh:ro" \
    "$image" "${args[@]}"
