#!/usr/bin/env python3
"""Publish a minimal, atomic player catalog; never publish archive auth/history."""
import argparse
import json
import os
import tempfile
from pathlib import Path

ENTRY = ('courseId', 'entryId', 'parentEntryId', 'track', 'title', 'state', 'durationSeconds', 'publishedAt')
FILE = ('kind', 'path', 'sha256', 'bytes')
REMOTE = ('state', 'method', 'bucket', 'endpointHost', 'key', 'etag', 'sha256', 'bytes')


def publish(source, destination, group=None):
    if source.resolve() == destination.resolve():
        raise ValueError('Player catalog must not replace its source')
    manifest = json.loads(source.read_text(encoding='utf-8-sig'))
    entries = {}
    for identity, entry in manifest['entries'].items():
        result = {key: entry.get(key) for key in ENTRY}
        result['files'] = []
        for file in entry.get('files', []):
            if file.get('kind') != 'video':
                continue
            value = {key: file.get(key) for key in FILE}
            value['remote'] = {key: file.get('remote', {}).get(key) for key in REMOTE}
            result['files'].append(value)
        entries[identity] = result
    destination.parent.mkdir(parents=True, mode=0o750, exist_ok=True)
    if group is not None:
        os.chown(destination.parent, -1, group)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False, mode='w', encoding='utf-8') as output:
            temporary = Path(output.name)
            json.dump({'entries': entries}, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o640)
        if group is not None:
            os.chown(temporary, -1, group)
        temporary.replace(destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return {'entries': len(entries), 'authIncluded': False, 'historyIncluded': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/srv/study-course-recordings/manifest.json'))
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--group', type=int)
    arguments = parser.parse_args()
    print(json.dumps(publish(arguments.source, arguments.destination, arguments.group)))
