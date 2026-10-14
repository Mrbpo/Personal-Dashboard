"""Verify frozen bytes and author gold without executing or scoring retrieval."""
import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import tarfile

SCRIPT = Path(__file__).with_name("freeze-heldout-study.py")
SPEC = importlib.util.spec_from_file_location("heldout_freeze", SCRIPT)
freeze = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(freeze)


def read_json(path):
    return json.loads(path.read_bytes())


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").split("\n") if line.strip()]


def verify(out, previous_frozen, previous_cache):
    manifest = read_json(out / "manifest.json")
    for receipt in manifest["sources"] + manifest["files"]:
        path = (out / receipt["path"]).resolve()
        if not path.is_relative_to(out.resolve()):
            raise ValueError("Receipt path escaped the freeze root")
        if freeze.file_receipt(path, out.resolve()) != {key: receipt[key] for key in ["path", "bytes", "sha256"]}:
            raise ValueError(f"Frozen original changed: {receipt['path']}")
    if freeze.sha256(freeze.canonical(manifest["protocol"]).encode()) != manifest["protocolSha256"]:
        raise ValueError("Frozen selection protocol hash mismatch")
    if freeze.sha256(SCRIPT.read_bytes().replace(b"\r\n", b"\n")) != manifest["preparationScriptSha256"]:
        raise ValueError("Preparation script changed after freeze")
    protocol = read_json(freeze.PROTOCOL)
    if protocol != manifest["protocol"]:
        raise ValueError("Tracked protocol differs from frozen selection protocol")
    budget = manifest["downloadBudget"]
    if budget["receivedBytes"] + budget["researchReserveBytes"] > budget["capBytes"]:
        raise ValueError("Download budget exceeded")
    previous = freeze.collect_previous(previous_frozen, previous_cache)
    if previous["receipts"] != manifest["previousCalibration"]["files"]:
        raise ValueError("Previous calibration inputs changed after exclusion audit")
    # Compare derived originals byte-for-byte with the retained author archives.
    for archive_path in (out / "raw").glob("qasper-*.tgz"):
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive.getmembers():
                original = out / "originals" / member.name
                if member.name.startswith("qasper-") and member.name.endswith(".json") and original.exists():
                    if archive.extractfile(member).read() != original.read_bytes():
                        raise ValueError("Original author JSON differs from archived bytes")
    selected_ids, selected_texts, materials_seen, evidence_locations = set(), set(), set(), 0
    for source, split in [("qasper-validation", "dev"), ("qasper-test", "test"), ("qasper-unseen-train", "train")]:
        papers = read_json(out / "originals" / f"qasper-{split}-v0.3.json")
        materials, cases, stats = freeze.build_qasper(papers, source, previous, selected_ids, selected_texts, protocol)
        if cases != read_json(out / "candidates" / f"{source}.cases.json"):
            raise ValueError(f"Author gold or deterministic selection changed: {source}")
        if materials != read_jsonl(out / "candidates" / f"{source}.materials.jsonl"):
            raise ValueError(f"Complete eligible source material changed: {source}")
        if stats != manifest["qasperCandidates"][source]:
            raise ValueError(f"Overlap/answerability inventory changed: {source}")
        ids = {row["originalId"] for row in materials}
        if ids.intersection(materials_seen):
            raise ValueError("Candidate material overlap")
        materials_seen.update(ids)
        evidence_locations += sum(len(span["locations"]) for row in cases for span in row["authorEvidenceSpans"])
    forum_count = 0
    if "status" not in manifest["forumCandidates"]:
        for forum in protocol["selection"]["supplementaryForumOrder"]:
            rows = [wrapper["row"] for offset in range(0, freeze.FORUM_COUNTS[forum]["queries"], 100)
                    for wrapper in read_json(out / "raw" / forum / f"query-rows-{offset}.json")["rows"]]
            if rows != read_jsonl(out / "candidates" / f"cqadupstack-{forum}.queries.jsonl"):
                raise ValueError("Forum official query capture changed")
            queries = {str(row["_id"]): row for row in rows}
            eligible = {qid: row for qid, row in queries.items()
                        if freeze.normalized(row["text"] or row["title"]) not in previous["texts"]}
            expected_ids = freeze.select_ids(eligible, f"cqadupstack-{forum}", protocol["seed"], 50)
            cases = read_json(out / "candidates" / f"cqadupstack-{forum}.cases.json")
            if [row["originalId"] for row in cases] != expected_ids:
                raise ValueError("Forum selection changed")
            qrels = list(csv.DictReader(io.StringIO((out / "raw" / forum / "test.tsv").read_text(encoding="utf-8")), delimiter="\t"))
            for case in cases:
                qid = case["originalId"]
                if case["authorQuery"] != queries[qid] or case["authorQrels"] != [row for row in qrels if row["query-id"] == qid]:
                    raise ValueError("Forum original query/qrels gold changed")
                if case["answerGold"] is not None or case["evidenceSpans"] is not None:
                    raise ValueError("Forum qrels incorrectly promoted to invented answer/span gold")
            forum_count += len(cases)
    annotation_count = 0
    annotation_path = out / "annotations" / "manifest.json"
    if annotation_path.exists():
        supplement = read_json(annotation_path)
        if supplement["baseManifestSha256"] != freeze.sha256((out / "manifest.json").read_bytes()):
            raise ValueError("Context/evidence diagnostics do not bind to this base freeze")
        annotation_script = SCRIPT.with_name("annotate-heldout-study.py")
        if supplement["annotationScriptSha256"] != freeze.sha256(annotation_script.read_bytes().replace(b"\r\n", b"\n")):
            raise ValueError("Annotation script changed after sidecar freeze")
        spec = importlib.util.spec_from_file_location("heldout_annotations", annotation_script)
        annotations = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(annotations)
        for receipt in supplement["files"]:
            path = (out / receipt["path"]).resolve()
            if not path.is_relative_to(out.resolve()) or freeze.file_receipt(path, out.resolve()) != receipt:
                raise ValueError("Context/evidence sidecar bytes changed")
        for source in protocol["selection"]["candidateOrder"]:
            cases = read_json(out / "candidates" / f"{source}.cases.json")
            materials = {row["originalId"]: row for row in read_jsonl(out / "candidates" / f"{source}.materials.jsonl")}
            contexts = read_json(out / "annotations" / f"{source}.title-context.json")
            audits = read_json(out / "annotations" / f"{source}.evidence-audit.json")
            if len(contexts) != 50 or len(audits) != 50:
                raise ValueError("Context/evidence diagnostics dropped a selected question")
            for case, context, audit in zip(cases, contexts, audits):
                material = materials[case["materialId"]]
                if context["userInput"] != {"query": case["query"], "selectedMaterialTitle": material["title"]}:
                    raise ValueError("Provided title context modified the original query")
                if context["requiredDocumentIdFilter"] or context["crossMaterialSearchClaim"]:
                    raise ValueError("Title-context fixture overstated its retrieval scope")
                expected = [annotations.audit_span(span, material) for span in case["authorEvidenceSpans"]]
                if audit["evidence"] != expected or audit["questionId"] != case["originalId"]:
                    raise ValueError("Evidence diagnostic changed original spans or strings")
                annotation_count += 1
    return {"status": "frozen-input-integrity-verified-no-retrieval-or-scoring",
            "sourceFiles": len(manifest["sources"]), "derivedFiles": len(manifest["files"]),
            "newQasperMaterials": len(materials_seen), "selectedQasperQuestions": len(selected_ids),
            "selectedForumRetrievalQuestions": forum_count, "locatedAuthorEvidenceOccurrences": evidence_locations,
            "receivedBytes": budget["receivedBytes"], "verifiedTitleContextAndEvidenceCases": annotation_count,
            "forumTextConversion": "pending"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=freeze.ROOT / "data/heldout-study-v1")
    parser.add_argument("--previous-frozen", type=Path, required=True)
    parser.add_argument("--previous-cache", type=Path, required=True)
    args = parser.parse_args()
    print(freeze.canonical(verify(args.out.resolve(), args.previous_frozen, args.previous_cache)))


if __name__ == "__main__":
    main()
