"""Fetch only the pinned public CPU ASR model; never transcribe or fetch videos."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.request import urlopen

REPO = 'Systran/faster-whisper-small.en'
REVISION = 'd1d751a5f8271d482d14ca55d9e2deeebbae577f'
FILES = {'config.json': 2657, 'model.bin': 483545366, 'tokenizer.json': 2128466, 'vocabulary.txt': 422309}
MODEL_SHA256 = '62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    records = []
    for name, size in FILES.items():
        destination = root / name
        digest = hashlib.sha256()
        if destination.is_file() and destination.stat().st_size == size:
            with destination.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
        else:
            temporary = destination.with_suffix(destination.suffix + '.part')
            actual = 0
            with urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}', timeout=90) as response, temporary.open('wb') as stream:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    actual += len(chunk)
                    if actual > size:
                        raise ValueError('MODEL_SIZE_MISMATCH')
                    digest.update(chunk)
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            if actual != size:
                raise ValueError('MODEL_SIZE_MISMATCH')
            if name == 'model.bin' and digest.hexdigest() != MODEL_SHA256:
                raise ValueError('MODEL_SHA_MISMATCH')
            temporary.replace(destination)
        if name == 'model.bin' and digest.hexdigest() != MODEL_SHA256:
            raise ValueError('MODEL_SHA_MISMATCH')
        records.append({'name': name, 'bytes': size, 'sha256': digest.hexdigest()})
    manifest = {'schemaVersion': 1, 'repository': REPO, 'revision': REVISION, 'files': records}
    temporary = root / 'download-manifest.json.part'
    temporary.write_text(json.dumps(manifest, indent=2))
    temporary.replace(root / 'download-manifest.json')
    print(json.dumps({'state': 'asr_model_prepared', **manifest, 'transcriptionStarted': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'state': 'model_preparation_failed', 'exceptionType': type(error).__name__}))
        raise SystemExit(2)
