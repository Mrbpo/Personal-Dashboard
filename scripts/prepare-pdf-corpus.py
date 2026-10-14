"""Download public MIT OCW course PDFs; no user course data or credentials."""
import argparse
import hashlib
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE = 'https://ocw.mit.edu'
SETS = [
    ('numerical', '/courses/2-086-numerical-computation-for-mechanical-engineers-spring-2013/pages/lecture-notes/',
     r'Lecture (?:1|2|4|9|15|22) Notes'),
    ('probability', '/courses/18-05-introduction-to-probability-and-statistics-spring-2022/pages/classes-reading-and-in-class-materials/',
     r'Class (?:3|4a|5a|7|10b|14|18|20) Reading'),
    ('mechanics', '/courses/8-01sc-classical-mechanics-fall-2016/pages/online-textbook/',
     r'Chapter (?:4|5|7|12|13|14):'),
]


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items, self.href, self.label = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.label = []

    def handle_data(self, data):
        if self.href:
            self.label.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.href:
            self.items.append((self.href, ' '.join(''.join(self.label).split())))
            self.href = None


def read(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Study-PDF-Acceptance/1.0'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def links(url):
    parser = Links()
    parser.feed(read(url).decode('utf-8'))
    return parser.items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--list-only', action='store_true')
    args = parser.parse_args()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    records = []
    for group, path, selected in SETS:
        page = BASE + path
        candidates = [(urllib.parse.urljoin(page, href), label) for href, label in links(page)
                      if re.search(selected, label, re.I)]
        print(group, len(candidates), [label for _, label in candidates], flush=True)
        if args.list_only:
            continue
        for index, (resource, title) in enumerate(candidates):
            pdf = resource if resource.lower().endswith('.pdf') else next(
                urllib.parse.urljoin(resource, href) for href, _ in links(resource)
                if urllib.parse.urlparse(href).path.lower().endswith('.pdf'))
            name = f'{group}-{index+1:02d}.pdf'
            destination = root / name
            if not destination.exists():
                data = read(pdf)
                if not data.startswith(b'%PDF-'):
                    raise ValueError('Download is not a PDF: ' + pdf)
                destination.write_bytes(data)
            data = destination.read_bytes()
            records.append(dict(group=group, title=title, source_url=pdf, resource_url=resource,
                                path=name, sha256=hashlib.sha256(data).hexdigest(), size=len(data)))
            print('downloaded', group, title, len(data), flush=True)
    if records:
        (root / 'manifest.json').write_text(json.dumps(records, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
