"""Build a source-only slide handout from an archived video and its timed captions."""
import base64
import bisect
import html
import math
import os
import re
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageChops, ImageStat


FRAME_VERSION = 'sampled-slides-v1'
MAX_SAMPLES = 650
MAX_FRAMES = 128
MAX_FRAME_BYTES = 150 * 1024
HTML_LIMIT = 32 * 1024**2
PDF_LIMIT = 64 * 1024**2


def _run(args, timeout, failure):
    # Media URLs are short-lived credentials; never include argv/stderr in logs or exceptions.
    env = {k: v for k, v in os.environ.items() if k in (
        'PATH', 'HOME', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR',
        'USERPROFILE', 'LOCALAPPDATA', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH')}
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=env, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        raise RuntimeError(failure) from None
    if result.returncode:
        raise RuntimeError(failure)


def _difference(previous, current):
    # Global changes catch slide transitions; small tiled changes retain incremental
    # equations and bullet points without letting a moving pointer select every frame.
    diff = ImageChops.difference(previous, current)
    changed = diff.point(lambda n: 255 if n > 22 else 0)
    tiles = sorted(changed.resize((16, 9), Image.Resampling.BOX).getdata(), reverse=True)
    return max(ImageStat.Stat(changed).mean[0] / 3.0, min(tiles[0] / 40, tiles[1] / 14))


def _frame_bytes(path):
    from io import BytesIO
    data = path.read_bytes()
    if len(data) <= MAX_FRAME_BYTES:
        return data
    with Image.open(path) as source:
        image = source.convert('RGB')
        for edge in (1280, 1024, 800, 640):
            image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
            output = BytesIO()
            image.save(output, 'JPEG', quality=76, optimize=True)
            if output.tell() <= MAX_FRAME_BYTES:
                return output.getvalue()
    raise ValueError('SLIDE_IMAGE_TOO_LARGE')


def _sample(url, duration, directory):
    step = max(5, math.ceil(duration / (MAX_SAMPLES - 1)))
    # Keep original frame PTS relative to the media timeline. The filename is the
    # encoder PTS in milliseconds, not an assumed frame-number times sample interval.
    select = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t,{step})'"
    scale = "scale=w='max(2,trunc(min(1440,min(iw*sar,1000*dar))/2)*2)':h='max(2,trunc(ow/dar/2)*2)',setsar=1"
    _run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts', '-start_at_zero',
          '-threads', '1', '-i', str(url), '-map', '0:v:0', '-an', '-sn', '-dn',
          '-filter_threads', '1', '-vf', select + ',' + scale, '-frames:v', str(MAX_SAMPLES),
          '-fps_mode', 'passthrough', '-enc_time_base', '1:1000', '-frame_pts', '1',
          '-threads', '1', '-q:v', '4', str(directory / '%012d.jpg')],
         max(600, math.ceil(duration)), 'SLIDE_VIDEO_DECODE_FAILED')
    chosen = []
    previous = None
    for path in sorted(directory.glob('*.jpg')):
        pts = int(path.stem)
        if pts < 0 or pts >= duration * 1000:
            continue
        with Image.open(path) as frame:
            current = frame.convert('L').resize((256, 144), Image.Resampling.BILINEAR)
        score = 0 if previous is None else _difference(previous, current)
        if previous is None or score >= 1:
            chosen.append((pts, score, path))
            previous = current
    if not chosen:
        raise ValueError('NO_SLIDE_FRAMES')
    if len(chosen) > MAX_FRAMES:
        # On moving video select one strong transition per time band. Keep the
        # opening frame and distribute the rest over the entire recording.
        bands = {}
        for item in chosen[1:]:
            band = int(item[0] * (MAX_FRAMES - 1) / (duration * 1000))
            if band not in bands or item[1] > bands[band][1]:
                bands[band] = item
        chosen = [chosen[0], *[bands[i] for i in sorted(bands)]]
    return [(pts, _frame_bytes(path)) for pts, _, path in chosen]


def _frames(url, duration, sha, directory, cache_root):
    if not cache_root:
        return _sample(url, duration, directory)
    root = Path(cache_root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / f'{sha}-{FRAME_VERSION}-{round(duration * 1000)}.zip'
    if path.exists():
        try:
            with zipfile.ZipFile(path) as cache:
                items = cache.infolist()
                if not 0 < len(items) <= MAX_FRAMES or any(
                    not re.fullmatch(r'\d{12}\.jpg', i.filename) or not 0 < i.file_size <= MAX_FRAME_BYTES for i in items
                ):
                    raise ValueError('INVALID_FRAME_CACHE')
                frames = [(int(i.filename[:-4]), cache.read(i)) for i in items]
                ts = [t for t, _ in frames]
                if ts != sorted(set(ts)) or ts[-1] >= duration * 1000:
                    raise ValueError('INVALID_FRAME_CACHE')
                return frames
        except (zipfile.BadZipFile, ValueError, EOFError):
            pass  # Rebuild from the verified source; publish the complete cache atomically.
    frames = _sample(url, duration, directory)
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as tmp:
        temp = Path(tmp.name)
    try:
        with zipfile.ZipFile(temp, 'w') as cache:
            for pts, image in frames:
                cache.writestr(f'{pts:012d}.jpg', image)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)
    return frames


def _time(ms):
    seconds = ms // 1000
    return f'{seconds // 60}:{seconds % 60:02d}'


def _escape(value):
    return html.escape(str(value), quote=True)


def _documents(frames, bundle, meta):
    published = meta.get('publishedAt')
    date = '未知' if published is None else datetime.fromtimestamp(published, timezone.utc).astimezone(
        ZoneInfo('America/Toronto')).strftime('%Y-%m-%d %H:%M:%S %Z')
    source, cues = bundle['source'], bundle['cues']
    positions = [t for t, _ in frames]
    groups = [[] for _ in frames]
    before = []
    for cue in cues:
        index = bisect.bisect_right(positions, cue['startMs']) - 1
        (groups[index] if index >= 0 else before).append(cue)
    translated = sum(bool(c.get('zh')) for c in cues)
    css = '''
    @page {size:A4; margin:14mm}
    *{box-sizing:border-box} body{margin:24px auto;padding:0 18px;max-width:940px;color:#181818;
    font-family:"Noto Sans CJK SC","Noto Serif CJK SC","Microsoft YaHei",sans-serif;line-height:1.55}
    h1{font-size:1.65em;overflow-wrap:anywhere}h2{font-size:1.05em}figure{margin:1.4em 0 .4em}
    img{display:block;max-width:100%;max-height:75vh;margin:auto}summary{cursor:pointer}
    .cue{border-top:1px solid #ddd;padding:.35em 0;overflow-wrap:anywhere}.cue time{font-size:.8em;color:#444}
    @media print{body{margin:0;padding:0;max-width:none;font-size:10pt}figure,.cue{break-inside:avoid}
    img{max-height:150mm}h2,h3{break-after:avoid}}
    '''
    title = _escape(meta['title'])
    head = f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{title}</title><style>{css}</style><body>'
    head += (f'<header><h1>{title}</h1><div>课程：{_escape(meta["courseName"])}</div>'
             f'<div>录像发布时间（多伦多）：{_escape(date)}</div>'
             f'<div>转写覆盖 {_time(source["clipStartMs"])}–{_time(source["clipEndMs"])} · '
             f'中文 {translated}/{len(cues)} 段</div></header>')
    body = []
    def transcript(rows):
        if not rows:
            return '<p>本段暂无转写。</p>'
        content = ''.join(f'<div class="cue"><time>{_time(c["startMs"])}–{_time(c["endMs"])}</time>'
                          f'<div lang="en">{_escape(c["en"])}</div>'
                          + (f'<div>{_escape(c["zh"])}</div>' if c.get('zh') else '') + '</div>' for c in rows)
        return f'<details><summary>转写（{len(rows)} 段）</summary>{content}</details>'
    if before:
        body.extend(['<h2>首帧之前</h2>', transcript(before)])
    for (pts, data), rows in zip(frames, groups):
        image = base64.b64encode(data).decode('ascii')
        body.append(f'<section><figure><h2>{_time(pts)}</h2><img alt="录像画面 {_time(pts)}" '
                    f'src="data:image/jpeg;base64,{image}"></figure>{transcript(rows)}</section>')
    document = head + ''.join(body) + '</body></html>'
    printable = document.replace('<details>', '<div>').replace('</details>', '</div>').replace(
        '<summary>', '<h3>').replace('</summary>', '</h3>')
    return document, printable


def build_handout(video_url, bundle, metadata, out_dir):
    """Write guide.html and guide.pdf to a caller-owned staging directory; return frame count."""
    sha = metadata['videoSha256']
    if not re.fullmatch(r'[a-f0-9]{64}', sha) or bundle.get('videoSha256') != sha:
        raise ValueError('SLIDE_SUBTITLE_SOURCE_MISMATCH')
    duration = metadata['durationSeconds']
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 21600:
        raise ValueError('INVALID_SLIDE_DURATION')
    if not bundle.get('cues') or not metadata['courseName'] or not metadata['title']:
        raise ValueError('MISSING_SLIDE_METADATA')
    out = Path(out_dir)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.slides-', dir=out) as tmp:
        directory = Path(tmp)
        frames = _frames(video_url, duration, sha, directory, metadata.get('frameCacheDir'))
        document, printable = _documents(frames, bundle, metadata)
        html_file = directory / 'guide.html'
        html_file.write_text(document, encoding='utf-8')
        if html_file.stat().st_size > HTML_LIMIT:
            raise ValueError('SLIDE_HTML_TOO_LARGE')
        print_source = directory / 'print.html'
        print_source.write_text(printable, encoding='utf-8')
        pdf = directory / 'guide.pdf'
        _run(['weasyprint', str(print_source), str(pdf)], 600, 'SLIDE_PDF_RENDER_FAILED')
        if not pdf.is_file() or not 0 < pdf.stat().st_size <= PDF_LIMIT:
            raise ValueError('INVALID_SLIDE_PDF_SIZE')
        with pdf.open('rb') as f:
            if f.read(5) != b'%PDF-':
                raise ValueError('INVALID_SLIDE_PDF')
        pdf.replace(out / pdf.name)
        html_file.replace(out / html_file.name)
        return len(frames)
