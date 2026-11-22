import hashlib
import shutil
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

try:
    import slide_handout as slides
except ModuleNotFoundError as exc:
    if exc.name != 'PIL':
        raise
    slides = None


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@unittest.skipUnless(slides and shutil.which('ffmpeg'), 'requires FFmpeg and Pillow')
class HandoutTest(unittest.TestCase):
    def test_screen_transitions_caption_binding_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / 'clip.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=1:d=6',
                            '-f', 'lavfi', '-i', 'color=white:s=320x180:r=1:d=6',
                            '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-threads', '1',
                            '-c:v', 'mpeg4', str(video)], check=True)
            sha = hashlib.sha256(video.read_bytes()).hexdigest()
            bundle = dict(videoSha256=sha, source=dict(clipStartMs=0, clipEndMs=12000), cues=[
                dict(startMs=500, endMs=3500, en='First & original', zh='第一张课件'),
                dict(startMs=9000, endMs=11000, en='Spans the boundary', zh='跨越边界'),
                dict(startMs=11000, endMs=12000, en='Second <slide>', zh='第二张课件')])
            meta = dict(videoSha256=sha, durationSeconds=12, title='Lecture 1', courseName='Biology',
                        publishedAt=1791914402, frameCacheDir=root / 'cache')
            with ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=tmp)) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f'http://127.0.0.1:{server.server_port}/clip.mp4?signature=test'
                    frames = slides._frames(url, 12, sha, root, meta['frameCacheDir'])
                finally:
                    server.shutdown()
                    thread.join()
            self.assertEqual([pts for pts, _ in frames], [0, 10000])
            text, printable = slides._documents(frames, bundle, meta)
            self.assertEqual(text.count('class="cue"'), 3)
            self.assertIn('2026-10-13', text)
            self.assertIn('EDT', text)
            self.assertIn('Second &lt;slide&gt;', text)
            self.assertIn('第一张课件', printable)
            first, second = text.split('<h2>0:10</h2>')
            self.assertIn('Spans the boundary', first)
            self.assertIn('Second &lt;slide&gt;', second)
            self.assertNotIn('<details>', printable)
            cacheless_meta = {**meta, 'publishedAt': None}
            self.assertIn('未知', slides._documents(frames, bundle, cacheless_meta)[0])
            with patch.object(slides, '_sample', side_effect=AssertionError('cache missed')):
                self.assertEqual(slides._frames(video, 12, sha, root, meta['frameCacheDir']), frames)
            if shutil.which('weasyprint'):
                out = root / 'out'
                self.assertEqual(slides.build_handout(video, bundle, {**meta, 'frameCacheDir': None}, out), 2)
                self.assertEqual((out / 'guide.html').read_text(encoding='utf8'), text)
                pdf = out / 'guide.pdf'
                self.assertTrue(pdf.read_bytes().startswith(b'%PDF-'))
                if shutil.which('pdftotext'):
                    extracted = subprocess.check_output(['pdftotext', str(pdf), '-']).decode('utf8')
                    for value in ('Biology', 'First & original', '第一张课件', '第二张课件', '2026-10-13'):
                        self.assertIn(value, extracted)


if __name__ == '__main__':
    unittest.main()
