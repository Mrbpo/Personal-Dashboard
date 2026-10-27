import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('player_export', Path(__file__).with_name('export-player-catalog.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlayerCatalogTest(unittest.TestCase):
    def test_export_keeps_needed_metadata_and_drops_auth_and_history(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / 'source.json', Path(folder) / 'player' / 'manifest.json'
            source.write_text(json.dumps({'ks': 'private', 'entries': {'a': {'courseId': '123', 'entryId': '0_a',
                'title': 'Lecture', 'ks': 'private', 'history': [{'cookie': 'private'}], 'files': [
                    {'kind': 'video', 'path': 'original.mp4', 'authorization': 'private',
                     'remote': {'key': 'course-recordings/sample', 'password': 'private'}}]}}}))
            original = source.read_bytes()
            module.publish(source, target)
            value = target.read_text()
            self.assertNotIn('private', value)
            self.assertNotIn('history', value)
            self.assertEqual(json.loads(value)['entries']['a']['files'][0]['remote']['key'], 'course-recordings/sample')
            self.assertEqual(source.read_bytes(), original)
            module.publish(source, target)
            self.assertEqual(target.read_text(), value)
            with self.assertRaises(ValueError):
                module.publish(source, source)
