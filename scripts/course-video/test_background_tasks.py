import importlib.util
import json
import tempfile
import unittest
from contextlib import nullcontext
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('background_tasks', Path(__file__).with_name('background-tasks.py'))
tasks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tasks)


class BackgroundTasksTest(unittest.TestCase):
    def test_request_accepts_only_fresh_fixed_unit_actions(self):
        clock = datetime.now(timezone.utc)
        request = {'id': 'c552462f-78e5-4dcf-986e-46bef448bd52', 'task': 'subtitles', 'requestedAt': clock.isoformat()}
        self.assertEqual(tasks.validate_request(request, clock), request)
        for extra in ({'task': 'reboot'}, {'task': 'recordings'}, {'task': 'backup;exit'}, {'id': '../file'},
                      {'requestedAt': (clock - timedelta(hours=1)).isoformat()}, {'unit': 'arbitrary.service'}):
            with self.assertRaises((ValueError, TypeError)):
                tasks.validate_request({**request, **extra}, clock)

    def test_coverage_does_not_fill_gaps_or_double_count_overlaps(self):
        self.assertEqual(tasks.coverage([(0, 100), (50, 200), (300, 400)], 350), 250)

    def test_progress_keeps_model_versions_and_partial_bilingual_publication_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sha, model = 'a' * 64, 'b' * 40
            for revision, start, end in [(model, 0, 300000), ('c' * 40, 300000, 600000)]:
                workspace = root / sha / revision
                workspace.mkdir(parents=True)
                vtt = workspace / f'chunk-{start}-{end}.vtt'
                vtt.write_text('WEBVTT\n\n')
                vtt.with_suffix('.vtt.provenance.json').write_text(json.dumps({'sourceVideoSha256': sha, 'modelRevision': revision, 'clipStartMs': start, 'clipEndMs': end}))
            published = root / 'published'
            published.mkdir()
            (published / (sha + '.json')).write_text(json.dumps({'videoSha256': sha, 'source': {'clipStartMs': 0, 'clipEndMs': 300000}, 'translation': {'model': 'test'}, 'cues': [{'en': 'sample', 'zh': 'sample'}]}))
            value = tasks.subtitle_progress({'videoSha256': sha, 'state': 'failed', 'progress': {'modelRevision': model}}, 600000, root, published)
            self.assertEqual(value['englishCoveredMs'], 300000)
            self.assertTrue(value['partial'])
            self.assertFalse(value['complete'])
            self.assertEqual(value['translatedCues'], 1)

    def test_recovery_preserves_failure_history_and_rejects_any_paid_ledger_or_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sha, revision = 'a' * 64, 'b' * 40
            source = root / 'state' / sha / revision / 'translation-input/source.vtt'
            source.parent.mkdir(parents=True)
            source.write_text('WEBVTT\n\n')
            source.with_suffix('.vtt.provenance.json').write_text(json.dumps({'sourceVideoSha256': sha, 'modelRevision': revision,
                'clipStartMs': 0, 'clipEndMs': 1000, 'subtitleSha256': tasks.worker.digest(source)}))
            job = {'videoSha256': sha, 'state': 'failed', 'reasonCode': 'TRANSLATION_STOPPED_REVIEW_LEDGER', 'attempts': 5}
            self.assertTrue(tasks.safe_input_recovery(job, root / 'state'))
            output = source.parent.parent / 'translation-output'
            output.mkdir()
            for name in (sha + '.translation-ledger.json', sha + '.response-1.json'):
                path = output / name
                path.write_text('{}')
                self.assertFalse(tasks.safe_input_recovery(job, root / 'state'))
                path.unlink()
            (root / 'subtitle-queue.json').write_text(json.dumps({'jobs': [job]}))
            with patch.object(tasks.worker, 'queue_lock', return_value=nullcontext()):
                self.assertEqual(tasks.recover_inputs(root, root / 'state'), 1)
            updated = json.loads((root / 'subtitle-queue.json').read_text())['jobs'][0]
            self.assertEqual(updated['state'], 'pending')
            self.assertEqual(updated['attempts'], 5)
            history = json.loads(next((root / 'private').glob('subtitle-recovery-*')).read_text())
            self.assertEqual(history['jobs'][0], job)
            source.write_text('changed source')
            self.assertFalse(tasks.safe_input_recovery(job, root / 'state'))


if __name__ == '__main__':
    unittest.main()
