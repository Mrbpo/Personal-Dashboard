#!/usr/bin/env python3
"""Check only new archive bytes; retain previously passed decoder evidence."""
import argparse
import json
import subprocess
import time
from pathlib import Path
from archive import atomic_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--archive", type=Path, default=Path("/srv/study-course-recordings"))
    args = parser.parse_args()
    root = args.archive.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    ledger_path = root / "reports" / "decoder-ledger.json"
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    results = []
    for key, entry in manifest["entries"].items():
        if entry.get("courseId") != args.course_id:
            continue
        if entry.get("state") != "archived":
            raise ValueError("COURSE_ARCHIVE_INCOMPLETE")
        for item in entry.get("files", []):
            if item.get("kind") != "video":
                continue
            path = (root / item["path"]).resolve()
            if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size != item["bytes"]:
                raise ValueError("ARCHIVE_FILE_MISMATCH")
            identity = key + ":" + item["sha256"]
            if ledger.get(identity, {}).get("passed"):
                results.append({"entryId": entry["entryId"], "bytes": item["bytes"], "previousDecoderPassed": True})
                continue
            with path.open("rb") as stream:
                header = stream.read(32)
            if path.suffix.lower() in (".mp4", ".m4v") and b"ftyp" not in header:
                raise ValueError("MP4_HEADER_MISMATCH")
            probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(path)], timeout=60))
            duration = float(probe["format"]["duration"])
            if abs(duration - float(entry["durationSeconds"])) > 2:
                raise ValueError("MEDIA_DURATION_MISMATCH")
            subprocess.run(["ffmpeg", "-v", "error", "-ss", "10", "-i", str(path),
                            "-frames:v", "1", "-an", "-f", "null", "-"], check=True, timeout=60,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            evidence = {"passed": True, "verifiedAt": int(time.time()), "durationSeconds": duration,
                        "streams": probe["streams"], "bytes": item["bytes"], "sha256": item["sha256"],
                        "method": "ffprobe_and_one_frame"}
            ledger[identity] = evidence
            atomic_json(ledger_path, ledger)
            results.append({"entryId": entry["entryId"], **evidence})
    output = {"courseId": args.course_id, "passed": True, "verifiedFiles": results,
              "newlyDecoded": sum(not item.get("previousDecoderPassed") for item in results)}
    atomic_json(root / "reports" / ("decode-" + args.course_id + ".json"), output)
    print(json.dumps({"state": "course_decoder_complete", "courseId": args.course_id,
                      "files": len(results), "newlyDecoded": output["newlyDecoded"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        safe = str(error) if str(error) in {"COURSE_ARCHIVE_INCOMPLETE", "ARCHIVE_FILE_MISMATCH", "MP4_HEADER_MISMATCH", "MEDIA_DURATION_MISMATCH"} else "DECODER_FAILED"
        print(json.dumps({"state": "course_decoder_failed", "code": safe}), flush=True)
        raise SystemExit(2)
