"""Freeze existing public text caches offline. Never seed a business database."""
import argparse
import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path

SOURCES = {
    'content': ('content.sqlite', 'https://huggingface.co/datasets/hotpotqa/hotpot_qa'),
    'syllabusqa': ('syllabusqa.sqlite', 'https://github.com/umass-ml4ed/SyllabusQA'),
    'qasper': ('qasper.sqlite', 'https://huggingface.co/datasets/allenai/qasper'),
    'courseassist': ('courseassist.sqlite', 'https://github.com/ytyfeng/CourseAssist-Data'),
    'mixed': ('mixed.sqlite', 'controlled-synthetic-fixture'),
}
REPORTS = ['truth-results.json', 'content-retrieval.json', 'content-answers.json',
           'syllabusqa-retrieval.json', 'syllabusqa-grounding-v3.json', 'qasper-retrieval.json',
           'qasper-grounding-v2.json', 'courseassist-results.json', 'courseassist-judgments.json',
           'mixed-course-results.json']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Freeze output must be a new directory; preserve previous states')
    args.output.mkdir(parents=True)
    receipts, maps, title_maps, courses = [], {}, {}, {}

    def save(name, data):
        target = args.output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        receipts.append({'path': name, 'sha256': digest(data), 'bytes': len(data)})

    summaries = {}
    for dataset, (filename, source_url) in SOURCES.items():
        path = args.cache / filename
        original_hash = digest(path.read_bytes())
        con = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
        maps[dataset], title_maps[dataset], courses[dataset] = {}, {}, set()
        documents = []

        def document(original_id, course, name, origin, pages):
            if not pages or not any(page['text'].strip() for page in pages):
                raise ValueError('Do not silently omit an empty original source')
            body_hash = digest(encode(pages))
            item_id = 'text68:' + dataset + ':' + digest(original_id.encode())
            maps[dataset][original_id] = item_id
            title_maps[dataset][name] = item_id
            courses[dataset].add(course)
            documents.append({'id': item_id, 'originalId': original_id, 'courseId': course, 'name': name,
                'hash': body_hash, 'origin': origin, 'pages': pages,
                'source': {'dataset': dataset, 'sourceUrl': source_url, 'cacheFile': filename,
                           'cacheSha256': original_hash, 'originalId': original_id,
                           'synthetic': dataset == 'mixed' and origin not in ('public-background', 'public-syllabus')}})

        for row in con.execute('SELECT id,course_id,name,origin FROM library_documents WHERE deleted=0 ORDER BY id'):
            chunks = list(con.execute('SELECT id,locator,body FROM library_chunks WHERE document_id=? ORDER BY position', (row['id'],)))
            pages = [{'originalChunkId': chunk['id'], 'locator': chunk['locator'], 'text': chunk['body']} for chunk in chunks]
            document(row['id'], row['course_id'], row['name'], row['origin'], pages)
        if dataset in ('courseassist', 'mixed'):
            for row in con.execute('SELECT id,course_id,title,body,answer FROM piazza_posts ORDER BY id'):
                document(row['id'], row['course_id'], row['title'], 'piazza', [{'originalChunkId': row['id'],
                    'locator': 'cached forum question and published answer',
                    'text': 'Question: ' + row['body'] + '\nPublished answer: ' + (row['answer'] or '')}])
        if dataset == 'mixed':
            for row in con.execute('SELECT id,course_id,title,body,source_type FROM source_items ORDER BY id'):
                document(row['id'], row['course_id'], row['title'], 'synthetic:' + row['source_type'],
                         [{'originalChunkId': row['id'], 'locator': 'controlled source text', 'text': row['body']}])
        con.close()
        data = b''.join(encode(doc) + b'\n' for doc in documents)
        save(dataset + '.documents.jsonl', data)
        summaries[dataset] = {'documents': len(documents), 'logicalTextSegments': sum(len(doc['pages']) for doc in documents),
                              'bytes': len(data), 'courses': sorted(courses[dataset]), 'cacheSha256': original_hash}

    # Original reports are retained byte-for-byte, including old failures/answers.
    for name in REPORTS:
        save('original/' + name, (args.cache / name).read_bytes())
    read = lambda name: json.loads((args.cache / name).read_text(encoding='utf-8'))
    cases = []
    for row in read('content-retrieval.json')['results']:
        cases.append({'dataset': 'content', 'id': row['id'], 'query': row['question'],
            'scope': {'courseId': 'benchmark-course'}, 'referenceAnswer': row['answer'],
            'expectedOriginalSources': row['gold'],
            'expectedDocumentIds': [title_maps['content'][name] for name in row['gold']],
            'originalRecall': row['recall'], 'retrievalLimit': 14, 'criterion': 'all-source-documents'})
    # Preserve the actual stored original course ID rather than invent a filter.
    for row in cases:
        if row['dataset'] == 'content':
            assert len(courses['content']) == 1
            row['scope']['courseId'] = next(iter(courses['content']))
    for row in read('syllabusqa-retrieval.json')['results']:
        cases.append({'dataset': 'syllabusqa', 'id': row['id'], 'query': row['syllabus'] + ': ' + row['question'],
            'scope': {'courseId': next(iter(courses['syllabusqa']))}, 'referenceAnswer': row['answer'],
            'expectedOriginalSources': [row['syllabus']], 'expectedDocumentIds': [title_maps['syllabusqa'][row['syllabus']]],
            'criterion': 'target-document-only', 'scopeWarning': 'original query names the target syllabus'})
    for row in read('qasper-retrieval.json')['results']:
        cases.append({'dataset': 'qasper', 'id': row['id'], 'query': row['question'],
            'scope': {'courseId': next(iter(courses['qasper'])), 'documentId': maps['qasper'][row['paperId']]},
            'referenceAnswer': row['answer'], 'expectedOriginalSources': row['goldChunkIds'],
            'expectedDocumentIds': [maps['qasper'][row['paperId']]], 'expectedOriginalChunkIds': row['goldChunkIds'],
            'criterion': 'any-gold-text-segment', 'scopeWarning': 'original test selects the paper and permits up to 80 candidates'})
    for row in read('courseassist-results.json')['results']:
        original_id = 'courseassist:piazza:' + str(row['id'])
        cases.append({'dataset': 'courseassist', 'id': str(row['id']), 'query': row['question'],
            'scope': {'courseId': 'courseassist-pl'}, 'referenceAnswer': row['reference'],
            'expectedOriginalSources': [original_id], 'expectedDocumentIds': [maps['courseassist'][original_id]],
            'criterion': 'all-source-documents', 'scopeWarning': 'original forum question is also the source title'})
    for index, row in enumerate(read('mixed-course-results.json')['cases']):
        cases.append({'dataset': 'mixed', 'id': str(index), 'query': row['question'], 'scope': {'courseId': row['courseId']},
            'referenceAnswer': row['expected'], 'expectedOriginalSources': row['proof'],
            'expectedDocumentIds': [maps['mixed'][key] for key in row['proof']], 'criterion': 'all-source-documents'})
    assert len(cases) == 250
    save('cases.json', encode(cases))
    truth = read('truth-results.json')['cases']
    assert len(truth) == 50 and len({row['question'] for row in truth}) == 50
    save('truth-cases.json', encode(truth))
    base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    code_paths = ['lib/kernel/service.ts', 'lib/kernel/document-search.ts', 'lib/kernel/db.ts',
                  'lib/kernel/document-semantic.ts', 'lib/kernel/document-rerank.ts', 'lib/kernel/document-vector.ts',
                  'scripts/freeze-text-calibration.py', 'scripts/benchmark-text-kernel.mjs', 'scripts/text-calibration-input.mjs']
    # Git checkout line endings vary across Windows and the Linux runner.
    code = {name: digest(Path(name).read_bytes().replace(b'\r\n', b'\n')) for name in code_paths}
    manifest = {'schemaVersion': 1, 'purpose': 'offline calibration, not a formal three-state acceptance',
        'baseCommit': base, 'codeHashNormalization': 'LF', 'codeSha256': code, 'files': receipts, 'corpora': summaries,
        'caseCounts': {'truth': 50, **{dataset: 50 for dataset in SOURCES}},
        'answersPending': True, 'networkRequests': 0, 'paidAiCalls': 0,
        'warnings': ['Cached extracted text does not validate binary PDF parsing.',
                     'Original scope, gold and failures are preserved; these are calibration questions, not unseen test sets.',
                     'Truth cases are controlled fixtures; no source publication time is invented.']}
    (args.output / 'manifest.json').write_bytes(encode(manifest))
    print(json.dumps({'state': 'frozen', 'baseCommit': base, 'manifestSha256': digest(encode(manifest)),
                      'corpora': summaries, 'caseCounts': manifest['caseCounts'], 'networkRequests': 0, 'paidAiCalls': 0}))


if __name__ == '__main__':
    main()
