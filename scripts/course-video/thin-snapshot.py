#!/usr/bin/env python3
"""Atomically publish small public metadata/captions into existing backup scope."""
import argparse
import hashlib
import io
import json
import os
import re
import tarfile
import time
from pathlib import Path
from urllib.parse import urlparse
from archive import public_url, sha256

SECRET_FIELDS = {'ks', 'cookie', 'cookies', 'authorization', 'password', 'launchurl', 'accesstoken',
                 'refreshtoken', 'secretaccesskey', 'awsaccesskeyid', 'awssecretaccesskey', 'storagestate', 'headers'}


def redact_metadata(value):
    if isinstance(value, dict):
        if any(re.sub(r'[^a-z]', '', key.lower()) in SECRET_FIELDS for key in value):
            raise ValueError('AUTH_DATA_NOT_ALLOWED')
        return {key: redact_metadata(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_metadata(item) for item in value]
    if isinstance(value, str):
        def redact(match):
            url = match.group(0)
            if urlparse(url).username or urlparse(url).password:
                raise ValueError('AUTH_DATA_NOT_ALLOWED')
            return public_url(url)
        return re.sub(r'https?://[^\s<>\"]+', redact, value)
    return value


def build_snapshot(root, destination):
    root = root.resolve()
    manifest = json.loads((root / 'manifest.json').read_text())
    sources = {'manifest.json': root / 'manifest.json'}
    catalog = Path(__file__).with_name('core-courses.catalog.json')
    if catalog.is_file():
        sources['configuration/core-courses.catalog.json'] = catalog
    for path in list((root / 'reports').glob('*.json')) + list(root.glob('channel-discovery-*.json')):
        if path.resolve().is_relative_to(root) and path.is_file():
            sources[str(path.relative_to(root))] = path
    captions = {}
    for entry in manifest['entries'].values():
        for version in [entry] + entry.get('history', []):
            for item in version.get('files', []):
                if item.get('kind') != 'caption':
                    continue
                path = (root / item['path']).resolve()
                if not path.is_relative_to(root) or path.suffix.lower() not in ('.srt', '.vtt', '.ttml') or not path.is_file():
                    raise ValueError('INVALID_CAPTION_PATH')
                if sha256(path) != item['sha256']:
                    raise ValueError('CAPTION_SHA_MISMATCH')
                captions[str(path.relative_to(root))] = path
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + '.tmp-' + str(os.getpid()))
    index = {'createdAt': int(time.time()), 'files': {}, 'videoFilesIncluded': 0,
             'authStateIncluded': False, 'method': 'atomic_tar_metadata_and_captions'}
    try:
        with tarfile.open(temporary, 'w') as bundle:
            for name, path in sorted(sources.items()):
                content = json.dumps(redact_metadata(json.loads(path.read_text())), ensure_ascii=False, indent=2).encode()
                index['files'][name] = {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}
                header = tarfile.TarInfo(name)
                header.size, header.mode = len(content), 0o600
                bundle.addfile(header, io.BytesIO(content))
            for name, path in sorted(captions.items()):
                index['files'][name] = {'sha256': sha256(path), 'bytes': path.stat().st_size}
                bundle.add(path, arcname=name, recursive=False)
            content = json.dumps(index, indent=2).encode()
            header = tarfile.TarInfo('snapshot-index.json')
            header.size, header.mode = len(content), 0o600
            bundle.addfile(header, io.BytesIO(content))
        temporary.chmod(0o600)
        with temporary.open('r+b') as stream:
            os.fsync(stream.fileno())
        temporary.replace(destination)  # Existing backup reads one whole inode.
        if os.name == 'posix':
            descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()
    return {'state': 'thin_snapshot_saved', 'files': len(index['files']), 'captions': len(captions),
            'bytes': destination.stat().st_size, 'videoFilesIncluded': 0, 'authStateIncluded': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=Path('/srv/study-course-recordings'))
    parser.add_argument('--destination', type=Path, default=Path('/srv/study/data/course-recording-archive/snapshot.tar'))
    parser.add_argument('--lock-fd', type=int)
    args = parser.parse_args()
    import fcntl
    lock_path = Path('/srv/study-course-video-state/manual-run.lock')
    if args.lock_fd is not None:
        if Path('/proc/self/fd/' + str(args.lock_fd)).resolve() != lock_path.resolve():
            raise ValueError('INVALID_INHERITED_LOCK')
        lock = os.fdopen(os.dup(args.lock_fd), 'a')
    else:
        lock = lock_path.open('a')
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(build_snapshot(args.archive, args.destination)), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z_]{3,80}', str(error)) else 'THIN_SNAPSHOT_FAILED'
        print(json.dumps({'state': 'thin_snapshot_failed', 'code': code}), flush=True)
        raise SystemExit(2)
