"""Freeze author-heldout inputs; no retrieval, models, database, or scoring imports.

Python standard library only. Raw forum Parquet remains intact without requiring
a new reader installation. See docs/heldout-study-freeze.md for the boundary.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = ROOT / "docs/heldout-study-freeze-protocol.json"
QASPER_REVISION = "fdc9d8214fbab5dd782958601db4d678e6934a54"
FORUM_REVISION = "e84b7220ce5a4e6c49aeb568983b0ec5a7584c2c"
QRELS_REVISION = "13595a9f221256a9a21e91c8b0fed3563382b6a7"
FORUM_FILES = {
    "physics": [("corpus", 18811650, "e130a791d68e8ad5217b449737d79ac45e7924f36f3b2658438306ae80c3938b"),
                ("queries", 47465, "064a126912aa31acec858fe81bf5ab85e5eb40de339d11b9800d585c7b6b8f7f")],
    "stats": [("corpus", 25668372, "6ab4f4ac6333619ece0b35516789a5a7cb4d94ba621d0d219d13adf5dfaf3d1e"),
              ("queries", 30347, "c7c69b410ee260f9121cc4dac4b717e9cb3681d760e95e233d6de9b1eb52e1d9")],
    "mathematica": [("corpus", 10765498, "6442de2833baf2ec332b0ca9120ca5bf98a9a7bf7b8c4ad357a8b3eac1f69bca"),
                    ("queries", 34583, "78ca3ee7dea6097a5472643292576fc86e4671e2dd3976bacc9ae2c72bd0af40")],
}
FORUM_COUNTS = {"physics": {"corpus": 38316, "queries": 1039},
                "stats": {"corpus": 42269, "queries": 652},
                "mathematica": {"corpus": 16705, "queries": 804}}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalized(text):
    return " ".join(text.casefold().split())


def select_ids(ids, source, seed, count):
    # Only source and original ID affect order, never the gold or algorithm.
    return sorted(ids, key=lambda item: (sha256(f"{seed}\n{source}\n{item}".encode()), item))[:count]


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(value) + "\n", encoding="utf-8", newline="\n")


def save_jsonl(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for value in values:
            stream.write(canonical(value) + "\n")


def file_receipt(path, root):
    data = path.read_bytes()
    return {"path": path.relative_to(root).as_posix(), "bytes": len(data), "sha256": sha256(data)}


class DownloadBudget:
    def __init__(self, directory, cap):
        self.directory = directory
        self.ledger_path = directory / "download-ledger.json"
        self.ledger = json.loads(self.ledger_path.read_text()) if self.ledger_path.exists() else {
            "capBytes": cap, "researchReserveBytes": 1000000, "receivedBytes": 0, "sources": []}
        if self.ledger["capBytes"] != cap:
            raise ValueError("Download budget is already frozen; do not reset it")

    def charge(self, count):
        if self.ledger["receivedBytes"] + self.ledger["researchReserveBytes"] + count > self.ledger["capBytes"]:
            raise ValueError("Initial download budget exceeded; stop before receiving more bytes")
        self.ledger["receivedBytes"] += count
        save_json(self.ledger_path, self.ledger)

    def fetch(self, key, url, revision, license_name, expected_bytes=None, expected_sha=None):
        path = self.directory / "raw" / key
        existing = next((row for row in self.ledger["sources"] if row["path"] == f"raw/{key}"), None)
        if existing:
            receipt = file_receipt(path, self.directory)
            if receipt["sha256"] != existing["sha256"] or receipt["bytes"] != existing["bytes"]:
                raise ValueError(f"Cached original changed: {key}")
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".partial")
        request = urllib.request.Request(url, headers={"User-Agent": "Issue68-heldout-study-freeze/1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            headers = dict(response.headers)
            declared = response.headers.get("Content-Length")
            if declared and int(declared) + self.ledger["receivedBytes"] + self.ledger["researchReserveBytes"] > self.ledger["capBytes"]:
                raise ValueError(f"Package would exceed budget: {key}")
            with temporary.open("wb") as stream:
                while True:
                    remaining = self.ledger["capBytes"] - self.ledger["receivedBytes"] - self.ledger["researchReserveBytes"]
                    if remaining <= 0:
                        raise ValueError("No download budget remaining")
                    block = response.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    self.charge(len(block))
                    stream.write(block)
        receipt = file_receipt(temporary, self.directory)
        if expected_bytes is not None and receipt["bytes"] != expected_bytes:
            raise ValueError(f"Original byte count mismatch: {key}")
        if expected_sha is not None and receipt["sha256"] != expected_sha:
            raise ValueError(f"Original SHA mismatch: {key}")
        temporary.replace(path)
        self.ledger["sources"].append({**file_receipt(path, self.directory), "sourceUrl": url,
                                      "revision": revision, "license": license_name,
                                      "responseHeaders": headers})
        save_json(self.ledger_path, self.ledger)
        return path


def collect_previous(frozen, cache):
    material_ids, question_ids, question_texts, title_abstracts = set(), set(), set(), set()
    receipts = []
    for path in sorted(frozen.glob("*.documents.jsonl")):
        receipts.append({"kind": "frozen-corpus", "name": path.name,
                         "bytes": path.stat().st_size, "sha256": sha256(path.read_bytes())})
        for line in path.read_text(encoding="utf-8").splitlines():
            document = json.loads(line)
            if document.get("origin") == "qasper" or document.get("originalId", "").startswith("qasper:"):
                material_ids.add(document["originalId"].removeprefix("qasper:"))
    for path in [frozen / "cases.json", frozen / "truth-cases.json"]:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            receipts.append({"kind": "frozen-questions", "name": path.name,
                             "bytes": path.stat().st_size, "sha256": sha256(path.read_bytes())})
            for case in data:
                question_ids.add(str(case["id"]))
                question_texts.add(normalized(case.get("query", case.get("question", ""))))
    for path in sorted(cache.glob("qasper-*.json")):
        if not re.fullmatch(r"qasper-\d+\.json", path.name):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        receipts.append({"kind": "seen-raw-papers", "name": path.name,
                         "bytes": path.stat().st_size, "sha256": sha256(path.read_bytes())})
        for wrapper in data["rows"]:
            row = wrapper["row"]
            material_ids.add(row["id"])
            title_abstracts.add(sha256(normalized(row["title"] + "\n" + row["abstract"]).encode()))
            question_ids.update(row["qas"]["question_id"])
            question_texts.update(normalized(text) for text in row["qas"]["question"])
    if not receipts or len(material_ids) < 100:
        raise ValueError("Previous calibration inputs missing/incomplete; refuse unseen claim")
    return {"materials": material_ids, "ids": question_ids, "texts": question_texts,
            "titleAbstracts": title_abstracts, "receipts": receipts}


def material_text(paper):
    segments = [{"locator": "title", "text": paper["title"]}, {"locator": "abstract", "text": paper["abstract"]}]
    for section_index, section in enumerate(paper["full_text"]):
        segments.append({"locator": f"section:{section_index}:heading", "text": section["section_name"]})
        for paragraph_index, paragraph in enumerate(section["paragraphs"]):
            segments.append({"locator": f"section:{section_index}:paragraph:{paragraph_index}", "text": paragraph})
    for index, figure in enumerate(paper.get("figures_and_tables", [])):
        segments.append({"locator": f"figure-or-table:{index}:{figure['file']}", "text": figure["caption"]})
    offset = 0
    for segment in segments:
        segment["start"] = offset
        segment["end"] = offset + len(segment["text"])
        offset = segment["end"] + 2
    return "\n\n".join(segment["text"] for segment in segments), segments


def evidence_locations(text, segments, evidence):
    # Offsets use Unicode code points; preserve unmatched author strings too.
    locations = []
    for segment in segments:
        start = 0
        while evidence:
            found = segment["text"].find(evidence, start)
            if found < 0:
                break
            begin = segment["start"] + found
            locations.append({"locator": segment["locator"], "start": begin,
                              "end": begin + len(evidence), "unit": "unicode-code-points"})
            start = found + 1
    assert all(text[row["start"]:row["end"]] == evidence for row in locations)
    return locations


def build_qasper(papers, source, previous, selected_ids, selected_texts, protocol):
    materials, eligible, excluded = [], {}, {"previousMaterial": 0, "previousQuestion": 0, "previousCandidateQuestion": 0}
    for paper_id, paper in papers.items():
        identity = sha256(normalized(paper["title"] + "\n" + paper["abstract"]).encode())
        if paper_id in previous["materials"] or identity in previous["titleAbstracts"]:
            excluded["previousMaterial"] += 1
            continue
        text, segments = material_text(paper)
        materials.append({"source": source, "originalId": paper_id, "title": paper["title"],
                          "text": text, "segments": segments, "authorMaterial": {
                              key: value for key, value in paper.items() if key != "qas"}})
        for qa in paper["qas"]:
            qid, query = qa["question_id"], normalized(qa["question"])
            if qid in previous["ids"] or query in previous["texts"]:
                excluded["previousQuestion"] += 1
            elif qid in selected_ids or query in selected_texts:
                excluded["previousCandidateQuestion"] += 1
            else:
                eligible[qid] = (paper_id, qa, text, segments)
    ids = select_ids(eligible, source, protocol["seed"], protocol["selection"]["questionsPerCandidate"])
    if len(ids) != protocol["selection"]["questionsPerCandidate"]:
        raise ValueError(f"Fewer than fixed question count eligible in {source}")
    cases = []
    for qid in ids:
        paper_id, qa, text, segments = eligible[qid]
        evidence = [{"annotationId": annotation["annotation_id"], "text": item,
                     "locations": evidence_locations(text, segments, item)}
                    for annotation in qa["answers"] for item in annotation["answer"]["evidence"]]
        cases.append({"source": source, "originalId": qid, "materialId": paper_id,
                      "query": qa["question"], "authorQuestionAndGold": qa,
                      "authorEvidenceSpans": evidence})
        selected_ids.add(qid)
        selected_texts.add(normalized(qa["question"]))
    if previous["materials"].intersection(row["originalId"] for row in materials):
        raise ValueError("Previously seen material entered new candidate")
    stats = {"sourcePapers": len(papers), "eligibleMaterials": len(materials), "eligibleQuestions": len(eligible),
             "selectedQuestions": len(cases), "selectedMaterials": len({row["materialId"] for row in cases}),
             "excluded": excluded, "previousMaterialIdOverlap": 0, "previousQuestionIdOrTextOverlap": 0,
             "anyUnanswerableAnnotations": sum(any(a["answer"]["unanswerable"] for a in row["authorQuestionAndGold"]["answers"]) for row in cases),
             "allUnanswerableAnnotations": sum(all(a["answer"]["unanswerable"] for a in row["authorQuestionAndGold"]["answers"]) for row in cases),
             "conflictingAnswerability": sum(len({a["answer"]["unanswerable"] for a in row["authorQuestionAndGold"]["answers"]}) > 1 for row in cases),
             "unmatchedAuthorEvidenceStrings": sum(not span["locations"] for row in cases for span in row["authorEvidenceSpans"])}
    return materials, cases, stats


def qasper_sources(budget):
    base = "https://qasper-dataset.s3.us-west-2.amazonaws.com/"
    archives = [
        ("qasper-train-dev-v0.3.tgz", "PVl1ofaATXMYFgEb.9Rei3dJqZ4XzhBg", 10835856),
        ("qasper-test-and-evaluator-v0.3.tgz", "MWliK0rgHeKzeNbQ_AmemEkriliL7eHF", 3865061),
    ]
    output = {}
    for key, version, count in archives:
        url = base + key + "?versionId=" + urllib.parse.quote(version)
        path = budget.fetch(key, url, f"v0.3 / S3 version {version}", "CC-BY-4.0", count)
        with tarfile.open(path, "r:gz") as archive:
            for split in ["train", "dev", "test"]:
                name = f"qasper-{split}-v0.3.json"
                member = next((row for row in archive.getmembers() if row.name == name), None)
                if member:
                    raw = archive.extractfile(member).read()
                    original = budget.directory / "originals" / name
                    original.parent.mkdir(parents=True, exist_ok=True)
                    original.write_bytes(raw)
                    output[split] = json.loads(raw)
    return output


def forum_sources(budget, previous, protocol):
    # Complete original background files, not a 50-row pseudo-corpus.
    snapshot_url = f"https://huggingface.co/api/datasets/BeIR/cqadupstack/revision/{FORUM_REVISION}"
    budget.fetch("beir-metadata.json", snapshot_url, FORUM_REVISION, "CC-BY-SA-4.0 (official card)")
    results = {}
    for forum in protocol["selection"]["supplementaryForumOrder"]:
        for kind, count, digest in FORUM_FILES[forum]:
            key = f"{forum}/{kind}-00000-of-00001.parquet"
            url = f"https://huggingface.co/datasets/BeIR/cqadupstack/resolve/{FORUM_REVISION}/{forum}/{kind}/{kind}-00000-of-00001.parquet"
            budget.fetch(key, url, FORUM_REVISION, "CC-BY-SA-4.0 (official card)", count, digest)
        qrels_url = f"https://huggingface.co/datasets/BeIR/cqadupstack-qrels/resolve/{QRELS_REVISION}/{forum}/test.tsv"
        qrels_path = budget.fetch(f"{forum}/test.tsv", qrels_url, QRELS_REVISION, "CC-BY-SA-4.0 (official card)")
        qrels = list(csv.DictReader(io.StringIO(qrels_path.read_text()), delimiter="\t"))
        rows = []
        for offset in range(0, FORUM_COUNTS[forum]["queries"], 100):
            parameters = urllib.parse.urlencode({"dataset": "BeIR/cqadupstack", "config": forum,
                                                "split": "queries", "offset": offset, "length": 100})
            url = "https://datasets-server.huggingface.co/rows?" + parameters
            response_path = budget.fetch(f"{forum}/query-rows-{offset}.json", url,
                                         f"official rows API observed with repository {FORUM_REVISION}", "CC-BY-SA-4.0 (official card)")
            response = json.loads(response_path.read_bytes())
            if response["num_rows_total"] != FORUM_COUNTS[forum]["queries"]:
                raise ValueError("Official query API count changed")
            rows.extend(wrapper["row"] for wrapper in response["rows"])
        queries = {str(row["_id"]): row for row in rows}
        if len(queries) != FORUM_COUNTS[forum]["queries"]:
            raise ValueError("Official query API is incomplete")
        judged = {row["query-id"] for row in qrels}
        if not judged.issubset(queries):
            raise ValueError("Author qrels query IDs missing from official queries")
        eligible = {qid: query for qid, query in queries.items()
                    if normalized(query["text"] or query["title"]) not in previous["texts"]}
        selected = select_ids(eligible, f"cqadupstack-{forum}", protocol["seed"], protocol["selection"]["questionsPerCandidate"])
        cases = [{"source": f"cqadupstack-{forum}", "originalId": qid,
                  "authorQuery": queries[qid], "authorQrels": [row for row in qrels if row["query-id"] == qid],
                  "evidenceSpans": None, "goldType": "author-duplicate-document-retrieval-only",
                  "answerGold": None} for qid in selected]
        save_jsonl(budget.directory / "candidates" / f"cqadupstack-{forum}.queries.jsonl", rows)
        save_json(budget.directory / "candidates" / f"cqadupstack-{forum}.cases.json", cases)
        results[forum] = {**FORUM_COUNTS[forum], "qrelRows": len(qrels), "selectedQueries": len(cases),
                          "previousSelectedQueryTextOverlap": 0, "goldType": "duplicate-document-retrieval-only",
                          "corpusStatus": "complete-raw-parquet-frozen-text-conversion-pending",
                          "corpusTextOverlapCheck": "pending-existing-parquet-reader",
                          "queryApiRevisionBinding": "observed repository SHA before/after; API does not expose content revision"}
    # The rows API is not revision-addressed: fail on a moved upstream snapshot.
    after = budget.fetch("beir-metadata-after.json", "https://huggingface.co/api/datasets/BeIR/cqadupstack",
                         FORUM_REVISION, "CC-BY-SA-4.0 (official card)")
    if json.loads(after.read_bytes())["sha"] != FORUM_REVISION:
        raise ValueError("Official repository moved during rows capture; forum query binding unverified")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "data/heldout-study-v1")
    parser.add_argument("--previous-frozen", type=Path, required=True)
    parser.add_argument("--previous-cache", type=Path, required=True)
    parser.add_argument("--include-forums", action="store_true")
    args = parser.parse_args()
    if (args.out / "manifest.json").exists():
        raise ValueError("Frozen manifest already exists; verify it instead of overwriting it")
    protocol = json.loads(PROTOCOL.read_text())
    previous = collect_previous(args.previous_frozen, args.previous_cache)
    budget = DownloadBudget(args.out, protocol["downloadBudgetBytes"])
    sources = qasper_sources(budget)
    selected_ids, selected_texts, material_sets = set(), set(), []
    candidates = {}
    for source, split in [("qasper-validation", "dev"), ("qasper-test", "test"), ("qasper-unseen-train", "train")]:
        materials, cases, stats = build_qasper(sources[split], source, previous, selected_ids, selected_texts, protocol)
        material_set = {row["originalId"] for row in materials}
        if any(material_set.intersection(earlier) for earlier in material_sets):
            raise ValueError("New candidate materials overlap across rounds")
        material_sets.append(material_set)
        save_jsonl(args.out / "candidates" / f"{source}.materials.jsonl", materials)
        save_json(args.out / "candidates" / f"{source}.cases.json", cases)
        candidates[source] = stats
    forums = forum_sources(budget, previous, protocol) if args.include_forums else {"status": "not-requested"}
    paths = sorted(path for folder in ["candidates", "originals"] for path in (args.out / folder).glob("*") if path.is_file())
    manifest = {"schemaVersion": 1, "status": "candidate-freeze-only-no-retrieval-or-scoring",
                "protocolSha256": sha256(PROTOCOL.read_bytes()), "protocol": protocol,
                "sources": budget.ledger["sources"], "downloadBudget": {
                    key: value for key, value in budget.ledger.items() if key != "sources"},
                "previousCalibration": {"materials": len(previous["materials"]), "questionIds": len(previous["ids"]),
                                        "questionTexts": len(previous["texts"]), "files": previous["receipts"]},
                "qasperCandidates": candidates, "forumCandidates": forums,
                "crossRoundQasperMaterialIdOverlap": 0, "crossRoundSelectedQuestionIdOrTextOverlap": 0,
                "files": [file_receipt(path, args.out) for path in paths],
                "pending": ["Forum Parquet text conversion and complete-text overlap audit with an existing reader",
                            "Independent import/state-transition/answer evaluation protocol and actual three 100% acceptance runs",
                            "Controlled source/time/permission conflict fixtures, if required, separately labeled and frozen"]}
    save_json(args.out / "manifest.json", manifest)
    print(canonical({"out": str(args.out.resolve()), "receivedBytes": budget.ledger["receivedBytes"],
                     "qasperCandidates": candidates, "forumCandidates": forums, "status": manifest["status"]}))


if __name__ == "__main__":
    main()
