#!/usr/bin/env python3
"""Derive host-side R2 read-only session credentials; never publish the parent secret."""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shlex
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


def parent_config(path):
    allowed = {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'S3_ENDPOINT', 'S3_BUCKET'}
    result = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if not match or match[1] not in allowed:
            continue
        values = shlex.split(match[2], comments=True)
        if len(values) > 1:
            raise ValueError('INVALID_PARENT_CONFIGURATION')
        result[match[1]] = values[0] if values else ''
    return result


def derive_credentials(config, now=None):
    endpoint = urlparse(config.get('S3_ENDPOINT', ''))
    host = endpoint.hostname or ''
    if (endpoint.scheme != 'https' or not re.fullmatch(r'[a-f0-9]{32}\.r2\.cloudflarestorage\.com', host)
            or endpoint.port or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in {'', '/'}):
        raise ValueError('INVALID_PARENT_ENDPOINT')
    bucket = config.get('S3_BUCKET', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket):
        raise ValueError('INVALID_PARENT_BUCKET')
    key, secret = config.get('AWS_ACCESS_KEY_ID', ''), config.get('AWS_SECRET_ACCESS_KEY', '')
    if not key or not secret or config.get('AWS_SESSION_TOKEN'):
        raise ValueError('STATIC_PARENT_CREDENTIALS_REQUIRED')
    issued = int(time.time() if now is None else now)
    expires = issued + 86400
    claims = {'bucket': bucket, 'actions': ['GetObject', 'HeadObject'],
              'paths': {'prefixPaths': ['course-recordings/'], 'objectPaths': []},
              'sub': host.split('.')[0], 'iss': key, 'aud': host, 'iat': issued, 'exp': expires}
    def encoded(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=').decode()
    unsigned = encoded({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encoded(claims)
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    token = unsigned + '.' + signature
    return {'accessKeyId': key, 'secretAccessKey': hashlib.sha256(token.encode()).hexdigest(),
            'sessionToken': base64.b64encode(('jwt/' + token).encode()).decode(),
            'expiresAt': datetime.fromtimestamp(expires, timezone.utc).isoformat()}


def publish(path, credentials, group):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
    path.parent.chmod(0o750)
    os.chown(path.parent, 0, group)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(credentials, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temporary, 0, group)
        temporary.chmod(0o640)
        temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Optional administrator-only env file; otherwise use the host service environment')
    parser.add_argument('--output', type=Path, default=Path('/srv/study/recording-player/credentials.json'))
    parser.add_argument('--group', type=int, default=1000)
    args = parser.parse_args()
    if os.geteuid() != 0 or args.group < 0:
        raise SystemExit('HOST_ADMINISTRATOR_REQUIRED')
    try:
        credentials = derive_credentials(parent_config(args.env_file) if args.env_file else os.environ)
        publish(args.output, credentials, args.group)
    except Exception:
        raise SystemExit('PLAYER_CREDENTIAL_REFRESH_FAILED') from None
    print(json.dumps({'state': 'player-read-credentials-refreshed', 'expiresAt': credentials['expiresAt']}))


if __name__ == '__main__':
    main()
