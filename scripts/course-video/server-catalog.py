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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--video-policy", choices=("auto", "original", "hd"), default="original")
    args = parser.parse_args()
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
    for record in records:
        command = ["bash", str(Path(__file__).with_name("server-run.sh")),
                   "--course-id", record["courseId"], "--tool-id", record["toolId"],
                   "--channel-id", record["channelId"], "--observed-gallery-url", record["galleryUrl"], "--video-policy", args.video_policy]
        if args.download:
            command.append("--download")
        print(json.dumps({"state": "catalog_course_started", "courseId": record["courseId"],
                          "channelId": record["channelId"], "downloadRequested": args.download}), flush=True)
        # argv only; a failed course does not block the remaining explicit list.
        code = subprocess.run(command, check=False).returncode
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
            if code == 0 and args.download and current:
                decoder = subprocess.run([sys.executable, str(Path(__file__).with_name("verify-archive.py")),
                                          "--course-id", record["courseId"]], check=False).returncode
                report["decoderExitCode"] = decoder
                if decoder:
                    summary["exitCode"] = decoder
            atomic_json(archive_root / "reports" / ("course-" + record["courseId"] + "-" + run_id + ".json"), report)
            summary["scopeComplete"] = bool(current and manifest["scan"].get("scopeComplete"))
            summary["archive"] = report["archive"]
        except Exception:
            summary["reportState"] = "report_failed"
            summary["exitCode"] = 2
        results.append(summary)
        print(json.dumps({"state": "catalog_course_complete", **summary}), flush=True)
        atomic_json(archive_root / "reports" / ("catalog-" + run_id + ".json"), {"runId": run_id, "results": results})
    print(json.dumps({"state": "catalog_complete", "results": results,
                      "allSucceeded": all(item["exitCode"] == 0 for item in results)}), flush=True)
    return 0 if all(item["exitCode"] == 0 for item in results) else 2


if __name__ == "__main__":
    sys.exit(main())
