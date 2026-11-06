import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verify_archive', HERE / 'verify-archive.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def manifest():
    return {'scan': {'startedAt': 200, 'courses': ['123'], 'state': 'incomplete',
                     'complete': False, 'scopeComplete': False, 'discoveryComplete': False},
            'archive': {'completedAt': 210, 'state': 'complete', 'scopeEntries': 1,
                        'counts': {'archived': 1}}, 'entries': {}}


class PartialArchiveTests(unittest.TestCase):
    def test_current_download_subset_is_eligible_without_claiming_coverage(self):
        data = manifest()
        verify.require_fresh_partial_download(data, '123', 199)
        self.assertFalse(data['scan']['scopeComplete'])

    def test_stale_wrong_course_auth_and_incomplete_downloads_are_rejected(self):
        changes = [('scan', 'startedAt', 190), ('scan', 'courses', ['456']),
                   ('scan', 'state', 'needs_auth'), ('scan', 'state', 'failed'),
                   ('scan', 'discoveryComplete', True), ('scan', 'scopeComplete', True),
                   ('archive', 'state', 'incomplete'), ('archive', 'completedAt', 100),
                   ('archive', 'scopeEntries', 0), ('archive', 'counts', {'archived': 0})]
        for section, field, value in changes:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(manifest())
                data[section][field] = value
                with self.assertRaisesRegex(ValueError, 'PARTIAL_ARCHIVE_NOT_ELIGIBLE'):
                    verify.require_fresh_partial_download(data, '123', 199)

    @unittest.skipUnless(shutil.which('bash'), 'Bash orchestration runs on Linux')
    def test_real_shell_pipeline_finalizes_partial_and_preserves_failure(self):
        # Exercise the actual pipeline/finalization block without Docker, network or media.
        tail = (HERE / 'server-run.sh').read_text().split('# The vault/token remains', 1)[1]
        tail = '# The vault/token remains' + tail
        for exit_code, stale, expected_upload in [(2, False, True), (2, True, False), (7, False, False), (0, False, True)]:
            with self.subTest(exit_code=exit_code, stale=stale), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                tools = root / 'tools'; tools.mkdir()
                for name in ('verify-archive.py', 'archive.py'):
                    source = (HERE / name).read_text()
                    if name == 'verify-archive.py':
                        source = source.replace('default=Path("/srv/study-course-recordings")',
                                                f'default=Path({str(root / "archive")!r})')
                    (tools / name).write_text(source)
                (tools / 'course-video-grant.mjs').write_text('')
                (tools / 'r2-archive.sh').write_text('echo uploaded >> "$TEST_LOG"\n')
                archive = root / 'archive'; archive.mkdir()
                (archive / 'reports').mkdir()
                data = manifest()
                import time
                data['scan']['startedAt'] = int(time.time()) + (1 if not stale else -60)
                data['archive']['completedAt'] = data['scan']['startedAt'] + 2
                if exit_code == 0:
                    data['scan'].update(state='complete', complete=True, scopeComplete=True, discoveryComplete=True)
                data['entries'] = {'123:0_test': {'courseId': '123', 'entryId': '0_test', 'state': 'archived',
                    'durationSeconds': 60, 'files': [{'kind': 'video', 'path': 'original.mp4', 'bytes': 8, 'sha256': 'a' * 64}]}}
                (archive / 'original.mp4').write_bytes(b'0000ftyp')
                (archive / 'manifest.json').write_text(json.dumps(data))
                (archive / 'reports/decoder-ledger.json').write_text(json.dumps({'123:0_test:' + 'a' * 64: {'passed': True}}))
                header = '''set -euo pipefail
tool_root="$TEST_ROOT/tools"
archive_root="$TEST_ROOT/archive"
state_root="$TEST_ROOT"
course_id=123; tool_id=8084; image=test; container_name=test
archive_r2=1; subtitles_only=0; discover=0; unattended=1
docker_access=(); args=()
docker() { if [[ $1 == exec ]]; then cat >/dev/null; return 0; else cat >/dev/null; return "$TEST_EXIT"; fi; }
verify_remote_cache() { echo verified >> "$TEST_LOG"; }
'''
                script = root / 'run.sh'; script.write_text(header + tail)
                log = root / 'calls.log'
                env = {**os.environ, 'TEST_ROOT': tmp, 'TEST_EXIT': str(exit_code), 'TEST_LOG': str(log)}
                env.pop('COURSE_VIDEO_PLAYER_CATALOG', None)
                result = subprocess.run(['bash', str(script)], env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, exit_code, result.stdout + result.stderr)
                self.assertEqual('uploaded' in (log.read_text() if log.exists() else ''), expected_upload)
                report = archive / 'reports/decode-123.json'
                if expected_upload:
                    self.assertEqual(json.loads(report.read_text())['coverageComplete'], exit_code == 0)


if __name__ == '__main__':
    unittest.main()
