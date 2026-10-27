"""Offline source qualification, never a QA score or a website write path.

Input evidence JSON: [{"id": "opaque-id", "text": "unaltered author evidence"}].
Requires the existing development PDF libraries pypdf and pdfplumber.
Unknown mappings are preserved; this tool does not repair text or answers.
"""
import argparse
import hashlib
import importlib.metadata
import json
import re
import unicodedata
from pathlib import Path

VERSION = "pdf-evidence-native-links-v1"
PLACEHOLDER = re.compile(r"\bBIBREF\d+\b", re.I)
MAX_GAP = 256
MAX_BRANCHES = 32


def normalize(text):
    # Preserve numbers, punctuation, signs and mathematical operators.
    return "".join(c for c in unicodedata.normalize("NFKC", text).casefold()
                   if not c.isspace())


def index_document(document):
    text, observations = [], []
    for page in document["pages"]:
        for position, char in enumerate(page["chars"]):
            for value in normalize(char["text"]):
                text.append(value)
                observations.append({**char, "page": page["number"], "position": position})
    return "".join(text), observations


def positions(text, literal, start=0, end=None):
    while literal:
        found = text.find(literal, start, len(text) if end is None else end)
        if found < 0:
            return
        yield found
        start = found + 1


def numeric_tokens(text):
    return re.findall(r"\d+(?:[.,]\d+)*", unicodedata.normalize("NFKC", text))


def numbers_match(literal, chars):
    # Whitespace normalization must not turn two numbers into one number.
    raw, previous = [], None
    for char in chars:
        if previous and (char["page"], char["position"]) == (previous["page"], previous["position"]):
            continue  # A single ligature can contribute several normalized characters.
        if previous and (char["page"] != previous["page"]
                         or char["position"] > previous["position"] + 1
                         or char.get("wordIndex") != previous.get("wordIndex")):
            raw.append(" ")
        raw.append(char["text"])
        previous = char
    return numeric_tokens(literal) == numeric_tokens("".join(raw))


def native_citation(chars, links):
    letters = [c for c in chars if any(v.isalnum() for v in c["text"])]
    if not letters:
        return None
    destinations, used = set(), {}
    for char in letters:
        x0, top, x1, bottom = char["bbox"]
        x, y = (x0 + x1) / 2, (top + bottom) / 2
        hits = [link for link in links if link["page"] == char["page"]
                and link.get("targetPage", 0) > 0
                and link["destination"].startswith("cite.")
                and link["bbox"][0] - .75 <= x <= link["bbox"][2] + .75
                and link["bbox"][1] - .75 <= y <= link["bbox"][3] + .75]
        if not hits:
            return None
        for hit in hits:
            destinations.add((hit["destination"], hit["targetPage"]))
            used[json.dumps(hit, sort_keys=True)] = hit
    if len(destinations) != 1:
        return None
    destination, target = next(iter(destinations))
    return {"destination": destination, "targetPage": target,
            "nativeText": "".join(c["text"] for c in chars),
            "links": list(used.values()),
            "authority": "explicit-native-GoTo",
            "roleBasis": "cite.-named destination; not semantic section verification"}


def align(evidence, document, indexed=None):
    base = {"toolVersion": VERSION, "sourceHash": document["sourceHash"],
            "evidenceSha256": hashlib.sha256(evidence.encode()).hexdigest(),
            "status": "unknown", "wholeSourceVersionIdentity": "unknown"}
    if not 16 <= len(evidence) <= 40000:
        return {**base, "reason": "evidence-size-limit"}
    parts = PLACEHOLDER.split(evidence)
    placeholders = PLACEHOLDER.findall(evidence)
    literals = [normalize(part) for part in parts]
    if len(placeholders) > 16 or len(literals[0]) < 16 or len(literals[-1]) < 16:
        return {**base, "reason": "insufficient-literal-context"}
    if any(not part for part in literals):
        return {**base, "reason": "adjacent-or-edge-placeholder"}
    text, chars = indexed or index_document(document)
    candidates = []
    for start in positions(text, literals[0]):
        end = start + len(literals[0])
        if numbers_match(parts[0], chars[start:end]):
            candidates.append((start, end, []))
        if len(candidates) > MAX_BRANCHES:
            return {**base, "reason": "candidate-limit"}
    for placeholder, original_part, literal in zip(placeholders, parts[1:], literals[1:]):
        expanded = []
        for start, cursor, bindings in candidates:
            for end in positions(text, literal, cursor,
                                 min(len(text), cursor + MAX_GAP + len(literal))):
                if end - cursor > MAX_GAP:
                    continue
                if not numbers_match(original_part, chars[end:end + len(literal)]):
                    continue
                citation = native_citation(chars[cursor:end], document["links"])
                if citation:
                    expanded.append((start, end + len(literal), bindings +
                                     [{"placeholder": placeholder, **citation}]))
                if len(expanded) > MAX_BRANCHES:
                    return {**base, "reason": "candidate-limit"}
        candidates = expanded
    # Do not turn a duplicate source passage into an arbitrary chosen location.
    if len(candidates) != 1:
        return {**base, "reason": "ambiguous-match" if candidates else "no-qualified-match"}
    start, end, bindings = candidates[0]
    selected = chars[start:end]
    pages = sorted({c["page"] for c in selected})
    if len(pages) > 2 or pages[-1] - pages[0] > 1:
        return {**base, "reason": "page-span-limit"}
    regions = []
    for page in pages:
        boxes = [c["bbox"] for c in selected if c["page"] == page]
        regions.append({"physicalPage": page, "bboxTopLeftPoints": [
            min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]})
    return {**base, "status": "source-bound-observation",
            "mode": "native-bibliographic-placeholder" if bindings else "exact-literal",
            "regions": regions, "bindings": bindings,
            "normalization": "NFKC/casefold/whitespace only; numeric punctuation preserved",
            "qaCorrectnessAssessed": False}


def extract_pdf(path, expected_hash):
    import pdfplumber
    from pypdf import PdfReader
    if path.stat().st_size > 50_000_000:
        raise ValueError("Original PDF size limit")
    raw = path.read_bytes()
    if len(raw) > 50_000_000 or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("Original PDF hash/size mismatch")
    reader = PdfReader(path)
    destinations = reader.named_destinations
    pages, links, hyphens = [], [], []
    if len(reader.pages) > 200:
        raise ValueError("PDF page limit")
    total = 0
    with pdfplumber.open(path) as pdf:
        for number, page in enumerate(pdf.pages, 1):
            words = page.extract_words(use_text_flow=True, return_chars=True)
            chars = []
            for i, word in enumerate(words):
                following = words[i + 1] if i + 1 < len(words) else None
                wrap = (following and re.search(r"[A-Za-z]{2}-$", word["text"])
                        and re.match(r"[a-z]", following["text"])
                        and following["top"] > word["top"] + 2
                        and following["top"] - word["top"] < 2 * word["height"]
                        and following["x0"] < word["x0"])
                for j, char in enumerate(word["chars"]):
                    box = [char["x0"], char["top"], char["x1"], char["bottom"]]
                    if wrap and j == len(word["chars"]) - 1 and char["text"] == "-":
                        hyphens.append({"page": number, "bbox": box,
                                        "observation": "alphabetic line-wrap hyphen"})
                    else:
                        chars.append({"text": char["text"], "bbox": box, "wordIndex": i})
            total += len(chars)
            if total > 2_000_000:
                raise ValueError("Native character limit")
            pages.append({"number": number, "chars": chars})
            for ref in reader.pages[number - 1].get("/Annots", []):
                annotation = ref.get_object()
                action = annotation.get("/A")
                action = action.get_object() if action else None
                if not action or action.get("/S") != "/GoTo":
                    continue
                destination = str(action.get("/D", ""))
                target = destinations.get(destination)
                if not destination.startswith("cite.") or target is None:
                    continue
                x0, y0, x1, y1 = map(float, annotation["/Rect"])
                links.append({"page": number, "destination": destination,
                              "targetPage": reader.get_destination_page_number(target) + 1,
                              "bbox": [x0, page.height - y1, x1, page.height - y0]})
    return {"sourceHash": expected_hash, "pages": pages, "links": links,
            "extractor": {name: importlib.metadata.version(name)
                          for name in ["pypdf", "pdfplumber"]},
            "configuration": {"wordOrder": "native-text-flow", "bboxTolerancePoints": .75,
                              "maxCitationGapCharacters": MAX_GAP},
            "lineWrapObservations": hyphens}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--evidence-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.evidence_file.stat().st_size > 2_000_000:
        raise ValueError("Preserve previous output; evidence input limit")
    evidence = json.loads(args.evidence_file.read_text(encoding="utf-8"))
    if not isinstance(evidence, list) or len(evidence) > 200:
        raise ValueError("Expected at most200 evidence records")
    document = extract_pdf(args.pdf, args.source_sha256)
    indexed = index_document(document)
    results = [{"id": row["id"], **align(row["text"], document, indexed)} for row in evidence]
    output = {"toolVersion": VERSION, "sourceHash": document["sourceHash"],
              "extractor": document["extractor"], "configuration": document["configuration"],
              "lineWrapObservations": document["lineWrapObservations"], "results": results,
              "providerCalls": 0, "databaseWrites": 0, "isQuestionAnswerScore": False}
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(output, file, ensure_ascii=False, indent=2)
    print(json.dumps({"records": len(results),
                      "sourceBound": sum(r["status"] == "source-bound-observation" for r in results),
                      "unknown": sum(r["status"] == "unknown" for r in results), "providerCalls": 0}))


if __name__ == "__main__":
    main()
