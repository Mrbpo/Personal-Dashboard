#!/usr/bin/env python3
"""Administrator-selected sequential runs; no scheduling or secret storage."""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from archive import atomic_json


def validated_catalog(path):
    records = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(records, list) or not records:
        raise ValueError("INVALID_CATALOG")
    result, seen = [], set()
    for item in records:
        if not isinstance(item, dict):
            raise ValueError("INVALID_CATALOG_RECORD")
        ids = [str(item.get(key, "")) for key in ("courseId", "toolId", "channelId")]
        if any(not re.fullmatch(r"[1-9][0-9]*", value) for value in ids):
            raise ValueError("INVALID_CATALOG_IDENTIFIERS")
        course, tool, channel = ids
        gallery = urlparse(str(item.get("galleryUrl", "")))
        if (gallery.scheme != "https" or gallery.hostname != "kaltura-quercus-prod.utoronto.ca"
                or gallery.port or gallery.username or gallery.password or gallery.query or gallery.fragment
                or gallery.path not in {f"/channel/{course}/{channel}", f"/channel/channelid/{channel}"}):
            raise ValueError("INVALID_OBSERVED_GALLERY_URL")
        if tuple(ids) in seen:
            raise ValueError("DUPLICATE_CATALOG_TARGET")
        seen.add(tuple(ids))
        result.append({"courseId": course, "toolId": tool, "channelId": channel,
                       "galleryUrl": gallery.geturl()})
    return result


HISTORICAL_VISIBILITY_SECONDS = 7 * 86400
VISIBLE_ARCHIVE_COMPLETE = 3


def historical_archive_accounts_for_gap(report):
    """Recognize a published subset with only older known media outside it.

    A gallery count does not identify the absent items. Keep scopeComplete false
    even when the count is consistent with previously archived older recordings.
    """
    scan = report["scan"] or {}
    if scan.get("scopeComplete") is not False or scan.get("discoveryComplete") is not False:
        return False
    channel = report["channels"].get(f"{report['courseId']}:{report['channelId']}", {})
    if channel.get("state") != "partial" or channel.get("method") != "kaf_native_visible_gallery_total":
        return False
    members = channel.get("memberEntryIds")
    total = channel.get("totalCount")
    started = scan.get("startedAt")
    if (not isinstance(members, list) or not members or type(total) is not int
            or len(set(members)) != len(members) or not len(members) < total
            or channel.get("uniqueEntries") != len(members) or type(started) is not int):
        return False
    visible = set(members)
    older = set()
    for entry in report["entries"].values():
        if entry.get("parentEntryId") or entry.get("channelId") != report["channelId"]:
            continue
        entry_id = entry.get("entryId")
        if entry_id in visible:
            continue
        published = entry.get("publishedAt")
        if (not entry_id or type(published) is not int or published <= 0
                or published >= started - HISTORICAL_VISIBILITY_SECONDS
                or entry.get("state") != "archived"
                or not any(item.get("kind") == "video" and item.get("remote", {}).get("state") == "verified"
                           for item in entry.get("files", []))):
            return False
        older.add(entry_id)
    return len(older) >= total - len(visible)


def run_course(command, lock_fd, course_id):
    child = subprocess.Popen(command, pass_fds=(lock_fd,), stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, errors='replace')
    authorization_required = False
    subset_published = False
    for line in child.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        try:
            event = json.loads(line)
            subset_published |= (event.get('state') == 'partial_discovery_archive_published'
                                 and event.get('courseId') == course_id)
            authorization_required |= event.get('state') in {'needs_reauth', 'needs_browser_verification',
                'server_launch_rejected', 'needs_asset_browser_verification'} or (
                event.get('state') == 'grant_failed' and event.get('code') in
                {'CANVAS_HTTP_401', 'CANVAS_HTTP_403', 'CANVAS_TOKEN_NOT_CONFIGURED'})
        except (ValueError, AttributeError):
            pass
    return child.wait(), authorization_required, subset_published


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--archive-r2", action="store_true", help="Download, decode new originals, verify private R2 and release only verified caches")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--video-policy", choices=("auto", "original", "hd"), default="original")
    parser.add_argument("--unattended", action="store_true")
    parser.add_argument("--website-authorization", action="store_true")
    args = parser.parse_args()
    if args.archive_r2:
        args.download = True
    if args.unattended and args.website_authorization:
        parser.error('Choose unattended sync or website authorization')
    try:
        records = validated_catalog(args.catalog)
    except Exception as error:
        code = str(error) if str(error) in {"INVALID_CATALOG", "INVALID_CATALOG_RECORD", "INVALID_CATALOG_IDENTIFIERS",
                                          "INVALID_OBSERVED_GALLERY_URL", "DUPLICATE_CATALOG_TARGET"} else "CATALOG_READ_FAILED"
        print(json.dumps({"state": "catalog_rejected", "code": code}), file=sys.stderr)
        return 2
    if args.dry_run:
        print(json.dumps({"state": "catalog_validated", "targets": records, "downloadRequested": args.download,
                          "networkRequested": False}))
        return 0
    results = []
    run_id = str(time.time_ns())
    archive_root = Path("/srv/study-course-recordings")
    import fcntl
    for record in records:
        with Path("/srv/study-course-video-state/manual-run.lock").open("a") as run_lock:
            fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            command = ["bash", str(Path(__file__).with_name("server-run.sh")),
                       "--course-id", record["courseId"], "--tool-id", record["toolId"],
                       "--channel-id", record["channelId"], "--observed-gallery-url", record["galleryUrl"], "--video-policy", args.video_policy]
            command += ["--lock-fd", str(run_lock.fileno())]
            if args.unattended:
                command.append('--unattended')
            if args.website_authorization:
                command.append('--website-authorization')
            if args.archive_r2:
                command.append("--archive-r2")
            elif args.download:
                command.append("--download")
            print(json.dumps({"state": "catalog_course_started", "courseId": record["courseId"],
                              "channelId": record["channelId"], "downloadRequested": args.download}), flush=True)
            # argv only; a failed course does not block the remaining explicit list.
            code, authorization_required, subset_published = run_course(command, run_lock.fileno(), record["courseId"])
            summary = {"courseId": record["courseId"], "channelId": record["channelId"], "exitCode": code}
            try:
                manifest = json.loads((archive_root / "manifest.json").read_text())
                current = manifest.get("scan", {}).get("courses") == [record["courseId"]]
                report = {**summary, "scanEvidenceCurrent": current, "completedAt": int(time.time()),
                          "scan": manifest.get("scan") if current else None,
                          "archive": manifest.get("archive") if current and args.download else None,
                          "formatAllocation": manifest.get("formatAllocation") if current and args.download and
                                              manifest.get("formatAllocation", {}).get("courseIds") == [record["courseId"]] else None,
                          "channels": {key: value for key, value in manifest.get("channels", {}).items() if key.startswith(record["courseId"] + ":")},
                          "streams": {key: value for key, value in manifest.get("streams", {}).items() if key.startswith(record["courseId"] + ":")},
                          "entries": {key: value for key, value in manifest.get("entries", {}).items() if value.get("courseId") == record["courseId"]}}
                if code == 0 and args.download and current and not args.archive_r2:
                    decoder = subprocess.run([sys.executable, str(Path(__file__).with_name("verify-archive.py")),
                                              "--course-id", record["courseId"]], check=False).returncode
                    report["decoderExitCode"] = decoder
                    if decoder:
                        summary["exitCode"] = decoder
                if code == 0 and args.archive_r2 and current:
                    report["decoderExitCode"] = 0
                    report["r2ArchiveRequested"] = True
                atomic_json(archive_root / "reports" / ("course-" + record["courseId"] + "-" + run_id + ".json"), report)
                summary["scopeComplete"] = bool(current and manifest["scan"].get("scopeComplete"))
                summary["archive"] = report["archive"]
                if code == 2 and subset_published and not authorization_required and current and historical_archive_accounts_for_gap(report):
                    summary["visibilityState"] = "historical_archive_accounts_for_gap"
            except Exception:
                summary["reportState"] = "report_failed"
                summary["exitCode"] = 2
            results.append(summary)
            print(json.dumps({"state": "catalog_course_complete", **summary}), flush=True)
            atomic_json(archive_root / "reports" / ("catalog-" + run_id + ".json"), {"runId": run_id, "results": results})
            if args.archive_r2:
                snapshot = subprocess.run([sys.executable, str(Path(__file__).with_name("thin-snapshot.py")), "--lock-fd", str(run_lock.fileno())], pass_fds=(run_lock.fileno(),), check=False).returncode
                if snapshot:
                    summary["exitCode"] = 2
                    summary["snapshotState"] = "failed"
                    atomic_json(archive_root / "reports" / ("catalog-" + run_id + ".json"), {"runId": run_id, "results": results})
            # An authorization failure needs one human action, not one new
            # launch for every remaining course in the daily catalog.
            if args.unattended and authorization_required:
                break
    all_succeeded = len(results) == len(records) and all(item["exitCode"] == 0 for item in results)
    visible_archived = len(results) == len(records) and all(
        item["exitCode"] == 0 or (
            item["exitCode"] == 2
            and item.get("visibilityState") == "historical_archive_accounts_for_gap"
            and not item.get("snapshotState")
        ) for item in results)
    print(json.dumps({"state": "catalog_complete", "results": results,
                      "allSucceeded": all_succeeded, "visibleArchiveComplete": visible_archived}), flush=True)
    if all_succeeded:
        return 0
    return VISIBLE_ARCHIVE_COMPLETE if visible_archived else 2


if __name__ == "__main__":
    sys.exit(main())
