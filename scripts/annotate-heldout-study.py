"""Freeze separate title-context fixtures and evidence-location diagnostics.

Original questions/gold and the base manifest are never rewritten. Normalized
matches are diagnostics and do not turn a nonliteral match into a raw span.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import unicodedata

SCRIPT = Path(__file__).with_name("freeze-heldout-study.py")
SPEC = importlib.util.spec_from_file_location("heldout_freeze", SCRIPT)
freeze = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(freeze)


def normalize(text, mode):
    if "nfkc" in mode:
        text = unicodedata.normalize("NFKC", text)
    if "whitespace" in mode:
        text = " ".join(text.split())
    return text


def audit_span(span, material):
    evidence = span["text"]
    result = {"annotationId": span["annotationId"], "originalEvidenceText": evidence,
              "rawAuthorEvidenceSpans": span["locations"], "literalAligned": bool(span["locations"])}
    if span["locations"]:
        result["category"] = "literal"
        return result
    if evidence.startswith("FLOAT SELECTED: "):
        caption = evidence.removeprefix("FLOAT SELECTED: ")
        possible = [{"locator": row["locator"], "captionReferenceMatches": row["text"] == caption}
                    for row in material["segments"] if row["locator"].startswith("figure-or-table:")
                    and row["text"] == caption]
        result.update({"category": "author-float-selection-marker", "possibleCaptionReferences": possible,
                       "rawSpan": None, "figureTablePixelsIncluded": False})
        return result
    matches = []
    for mode in ["nfkc", "whitespace", "nfkc-whitespace"]:
        needle = normalize(evidence, mode)
        for segment in material["segments"]:
            haystack = normalize(segment["text"], mode)
            start = haystack.find(needle) if needle else -1
            if start >= 0:
                matches.append({"normalization": mode, "locator": segment["locator"],
                                "normalizedStart": start, "normalizedEnd": start + len(needle),
                                "unit": "normalized-segment-unicode-code-points", "rawSpan": None})
    result.update({"category": "normalized-only" if matches else "unlocated",
                   "normalizedMatches": matches, "rawSpan": None})
    return result


def annotate(out):
    target = out / "annotations"
    if (target / "manifest.json").exists():
        raise ValueError("Annotation freeze exists; do not overwrite it")
    manifest = json.loads((out / "manifest.json").read_bytes())
    summaries = {}
    for source in manifest["protocol"]["selection"]["candidateOrder"]:
        cases = json.loads((out / "candidates" / f"{source}.cases.json").read_bytes())
        materials = {row["originalId"]: row for row in (
            json.loads(line) for line in (out / "candidates" / f"{source}.materials.jsonl").read_text(encoding="utf-8").split("\n") if line.strip())}
        contexts, audits = [], []
        for case in cases:
            material = materials[case["materialId"]]
            contexts.append({"auditOnly": {"questionId": case["originalId"], "sourceMaterialId": case["materialId"]},
                             "userInput": {"query": case["query"], "selectedMaterialTitle": material["title"]},
                             "fixtureType": "controlled-user-selected-title-from-author-paper-association",
                             "measurementScope": "selected-title-scoped-QA",
                             "requiredDocumentIdFilter": False, "crossMaterialSearchClaim": False})
            audits.append({"questionId": case["originalId"], "materialId": case["materialId"],
                           "evidence": [audit_span(span, material) for span in case["authorEvidenceSpans"]]})
        freeze.save_json(target / f"{source}.title-context.json", contexts)
        freeze.save_json(target / f"{source}.evidence-audit.json", audits)
        categories = Counter(span["category"] for row in audits for span in row["evidence"])
        summaries[source] = {"questionsRetained": len(cases), "evidenceAnnotationStrings": sum(categories.values()),
                             "evidenceCategories": dict(categories),
                             "floatMarkersWithExactCaptionReference": sum(bool(span.get("possibleCaptionReferences")) for row in audits for span in row["evidence"]),
                             "originalQuestionAndGoldChanged": False}
    paths = sorted(target.glob("*.json"))
    supplement = {"status": "preparation-only-context-fixtures-and-nonliteral-evidence-diagnostics",
                  "baseManifestSha256": freeze.sha256((out / "manifest.json").read_bytes()),
                  "annotationScriptSha256": freeze.sha256(Path(__file__).read_bytes().replace(b"\r\n", b"\n")),
                  "summaries": summaries, "files": [freeze.file_receipt(path, out) for path in paths],
                  "scope": "Questions stay unchanged; separate author-title fixtures model a user selection. No single-document ID filter certifies cross-material retrieval.",
                  "pending": ["Float evidence has original captions but no original figure/table pixels in the JSON release",
                              "Nonliteral evidence is not aligned to a raw author span; keep every selected question in its 50-question denominator"]}
    freeze.save_json(target / "manifest.json", supplement)
    print(freeze.canonical({"status": supplement["status"], "summaries": summaries}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=freeze.ROOT / "data/heldout-study-v1")
    args = parser.parse_args()
    annotate(args.out)
