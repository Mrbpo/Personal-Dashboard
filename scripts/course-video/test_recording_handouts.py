import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('handouts', Path(__file__).with_name('recording-handouts.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RestoreTest(unittest.TestCase):
    def test_archived_copy_is_verified_before_publishing_pointer(self):
        sha = 'a' * 64
        blobs = {'html': b'<html>slides</html>', 'pdf': b'%PDF-'}
        files = {key: {'sha256': worker.hash_bytes(data), 'bytes': len(data)} for key, data in blobs.items()}
        manifest = worker.encode({'videoSha256': sha, 'files': files})
        version = worker.hash_bytes(manifest)
        objects = {'manifest.json': manifest, 'guide.html': blobs['html'], 'guide.pdf': blobs['pdf']}

        class Store:
            def read(self, key, limit):
                data = objects[key.split('/')[-1]]
                assert len(data) <= limit
                return data

        with tempfile.TemporaryDirectory() as folder, patch.object(worker.os, 'chown', create=True):
            root = Path(folder) / sha
            objects['guide.pdf'] = b'wrong'
            with self.assertRaisesRegex(ValueError, 'MISMATCH'):
                worker.materialize(Store(), 'prefix', version, root)
            self.assertFalse((root / 'current.json').exists())
            objects['guide.pdf'] = blobs['pdf']
            worker.materialize(Store(), 'prefix', version, root)
            self.assertEqual(worker.local_version(root), version)
            self.assertEqual(json.loads((root / 'current.json').read_bytes()), {'version': version})


if __name__ == '__main__':
    unittest.main()
