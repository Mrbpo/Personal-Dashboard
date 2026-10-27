#!/usr/bin/env python3
"""Administrator-only preparation for an approved release; does not restart services."""
import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


def write(path, text, mode=0o600, group=0):
    temporary = path.with_name(path.name + '.release-new')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, mode)
    os.chown(temporary, 0, group)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{40}', args.sha):
        parser.error('root and an exact release SHA are required')
    import yaml
    code = Path(__file__).resolve().parent.parent
    host = Path('/srv/study')
    tool = Path('/srv/study-course-video-tool')
    control = Path('/srv/study-course-video-control')
    snapshot = host / 'data/private/recordings-release' / args.sha
    snapshot.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('compose.yml', 'Caddyfile', 'course-video-control.env', 'recordings-readonly.env'):
        source = host / name
        if source.exists() and not (snapshot / name).exists():
            shutil.copyfile(source, snapshot / name)
            os.chmod(snapshot / name, 0o600)
    for path, mode, group in ((host / 'recording-player', 0o750, 1000),
                              (host / 'data/recording-subtitles', 0o750, 1000),
                              (control, 0o750, 1000), (control / 'private', 0o700, 0),
                              (control / 'requests', 0o2770, 1000)):
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, 0, group)
        os.chmod(path, mode)
    for name in ('archive.py', 'interactive-entrypoint.sh', 'server-run.sh', 'server-catalog.py',
                 'control-runner.py', 'subtitle-worker.py', 'export-player-catalog.py',
                 'refresh-playback-credentials.py'):
        shutil.copyfile(code / 'scripts/course-video' / name, tool / name)
        os.chmod(tool / name, 0o755)
    subprocess.run(['python3', str(tool / 'export-player-catalog.py'), '--destination',
                    str(host / 'recording-player/manifest.json'), '--group', '1000'], check=True)
    # Endpoint/bucket are public routing metadata; the parent key stays in its existing root-only file.
    import shlex
    config = {}
    for line in (host / 'backup-s3.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            if key.strip() in ('S3_ENDPOINT', 'S3_BUCKET'):
                config[key.strip()] = shlex.split(value)[0]
    write(host / 'recordings-readonly.env',
          'RECORDINGS_S3_ENDPOINT=' + config['S3_ENDPOINT'] + '\nRECORDINGS_S3_BUCKET=' + config['S3_BUCKET'] +
          '\nRECORDINGS_S3_CREDENTIALS_FILE=/app/course-recordings/credentials.json\n')
    write(host / 'course-video-control.env', '\n'.join((
        'COURSE_VIDEO_CONTROL_DIR=/srv/study-course-video-control', 'COURSE_VIDEO_WEB_GID=1000',
        'COURSE_VIDEO_NETWORK=study_default', 'COURSE_VIDEO_PLAYER_CATALOG=/srv/study/recording-player/manifest.json',
        'COURSE_VIDEO_PLAYER_GID=1000', 'COURSE_VIDEO_SUBTITLE_DIR=/srv/study/data/recording-subtitles',
        'COURSE_VIDEO_APP_IMAGE=study-cabinet:' + args.sha, '')))
    base = yaml.safe_load((host / 'compose.yml').read_text())
    for name in ('compose.recordings.yml', 'compose.recording-sync.yml'):
        overlay = yaml.safe_load((code / 'deploy' / name).read_text())
        for service, addition in overlay['services'].items():
            target = base['services'][service]
            target.setdefault('environment', {}).update(addition.get('environment', {}))
            for field in ('env_file', 'volumes'):
                if field not in addition:
                    continue
                existing = target.get(field, [])
                if isinstance(existing, str):
                    existing = [existing]
                for item in addition[field]:
                    if item not in existing:
                        existing.append(item)
                target[field] = existing
    for service in ('web', 'worker'):
        base['services'][service].setdefault('environment', {})['STUDY_ANSWER_BACKEND'] = 'legacy'
    write(host / 'compose.yml', yaml.safe_dump(base, sort_keys=False))
    shutil.copyfile(code / 'deploy/Caddyfile', host / 'Caddyfile')
    os.chmod(host / 'Caddyfile', 0o644)
    units = ('course-video-control.service', 'course-video-control.path', 'course-video-daily.service',
             'course-video-daily.timer', 'course-subtitle-worker.service', 'course-subtitle-worker.path',
             'course-recording-credentials.service', 'course-recording-credentials.timer')
    for name in units:
        shutil.copyfile(code / 'deploy' / name, Path('/etc/systemd/system') / name)
        os.chmod(Path('/etc/systemd/system') / name, 0o644)
    # A separate activation step follows actual release and HTTP checks.
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    write(snapshot / 'preparation.json', json.dumps({'sha': args.sha, 'unitsInstalled': list(units),
          'servicesStarted': False, 'answerBackend': 'legacy'}, indent=2) + '\n')
    print(json.dumps({'prepared': True, 'sha': args.sha, 'servicesStarted': False}))


if __name__ == '__main__':
    main()
