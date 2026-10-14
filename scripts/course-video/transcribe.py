"""Optional local CPU subtitle generation; no remote AI calls."""
import argparse
import hashlib
import json
import os
from pathlib import Path


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02d}:{milliseconds // 60000 % 60:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--model-path", type=Path, required=True, help="Existing local faster-whisper model; no implicit model download")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--language", help="Omit for detection; never translate automatically")
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    if not args.video.is_file() or not args.model_path.is_dir() or args.threads < 1:
        parser.error("Require an existing video, local model directory and positive thread count")
    from faster_whisper import WhisperModel
    model = WhisperModel(str(args.model_path), device="cpu", compute_type="int8", cpu_threads=args.threads, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(str(args.video), language=args.language, vad_filter=True, beam_size=5)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    part = args.output.with_suffix(args.output.suffix + ".part")
    count = 0
    with part.open("w", encoding="utf-8") as stream:
        stream.write("WEBVTT\n\n")
        for segment in segments:
            if segment.end > segment.start and segment.text.strip():
                stream.write(f"{timestamp(segment.start)} --> {timestamp(segment.end)}\n{segment.text.strip()}\n\n")
                count += 1
    if not count:
        raise RuntimeError("No speech detected; original video remains preserved")
    part.replace(args.output)
    provenance = {"method": "local-asr", "model": args.model_path.name, "computeType": "int8", "language": info.language,
                  "cues": count, "subtitleSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "sourceVideo": args.video.name}
    args.output.with_suffix(args.output.suffix + ".provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"state": "subtitles_generated", "cues": count, "language": info.language}))


if __name__ == "__main__":
    main()
