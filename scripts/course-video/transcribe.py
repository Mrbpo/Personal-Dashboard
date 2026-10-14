"""Optional local CPU subtitle generation; no remote AI calls."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02d}:{milliseconds // 60000 % 60:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--model-path", type=Path, required=True, help="Existing local faster-whisper model; no implicit model download")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--language", help="Omit for detection; never translate automatically")
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--source-video-sha256", required=True, help="SHA from the verified original archive manifest")
    parser.add_argument("--clip-start-ms", type=int, default=0)
    parser.add_argument("--clip-end-ms", type=int, required=True)
    args = parser.parse_args()
    if not args.video.is_file() or not args.model_path.is_dir() or args.threads < 1:
        parser.error("Require an existing video, local model directory and positive thread count")
    if not re.fullmatch(r'[a-f0-9]{64}', args.source_video_sha256) or args.clip_start_ms < 0 or args.clip_end_ms <= args.clip_start_ms:
        parser.error('Require original SHA and a valid source clip window')
    model_receipt = json.loads((args.model_path / 'download-manifest.json').read_text())
    model_record = next(item for item in model_receipt['files'] if item['name'] == 'model.bin')
    if not re.fullmatch(r'[a-f0-9]{40}', model_receipt.get('revision', '')) or not re.fullmatch(r'[a-f0-9]{64}', model_record.get('sha256', '')):
        raise ValueError('Model must have a pinned revision and checksum receipt')
    import av
    with av.open(str(args.video)) as audio:
        duration = audio.duration / av.time_base if audio.duration is not None else None
    clip_duration = (args.clip_end_ms - args.clip_start_ms) / 1000
    if duration is None or abs(duration - clip_duration) > 1:
        raise ValueError('Audio duration does not match source clip window')
    from faster_whisper import WhisperModel
    model = WhisperModel(str(args.model_path), device="cpu", compute_type="int8", cpu_threads=args.threads, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(str(args.video), language=args.language, vad_filter=True, beam_size=5)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    part = args.output.with_suffix(args.output.suffix + ".part")
    count = 0
    with part.open("w", encoding="utf-8") as stream:
        stream.write("WEBVTT\n\n")
        for segment in segments:
            start, end = max(0, segment.start), min(clip_duration, segment.end)
            if end > start and segment.text.strip():
                stream.write(f"{timestamp(start)} --> {timestamp(end)}\n{segment.text.strip()}\n\n")
                count += 1
    if not count:
        raise RuntimeError("No speech detected; original video remains preserved")
    part.replace(args.output)
    provenance = {"schemaVersion": 1, "method": "local-asr", "model": model_receipt['repository'],
                  "modelRevision": model_receipt['revision'], "modelSha256": model_record['sha256'],
                  "computeType": "int8", "language": info.language, "cues": count,
                  "subtitleSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                  "sourceVideoSha256": args.source_video_sha256, "sourceAudioSha256": file_sha256(args.video),
                  "clipStartMs": args.clip_start_ms, "clipEndMs": args.clip_end_ms, "timestampBasis": "clip-relative"}
    args.output.with_suffix(args.output.suffix + ".provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"state": "subtitles_generated", "cues": count, "language": info.language}))


if __name__ == "__main__":
    main()
