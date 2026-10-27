"""Bounded controls for a source-qualification gate; no PDF libraries required."""
import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("qualify_pdf_evidence.py"))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def observation(text, citations=()):
    chars = [{"text": c, "bbox": [i, 10, i + 1, 12]} for i, c in enumerate(text)]
    links = []
    for literal, destination, target in citations:
        start = text.index(literal)
        links.append({"page": 1, "destination": destination, "targetPage": target,
                      "bbox": [start, 10, start + len(literal), 12]})
    return {"sourceHash": "a" * 64, "pages": [{"number": 1, "chars": chars}], "links": links}


class SourceQualificationControls(unittest.TestCase):
    text = "The experiment used 1.2 hours (Author, 2020). The sample size was20 and x>y."
    evidence = "The experiment used 1.2 hours BIBREF1. The sample size was20 and x>y."

    def document(self):
        return observation(self.text, [("(Author, 2020)", "cite.author2020", 4)])

    def test_exact_source_and_explicit_placeholder(self):
        self.assertEqual(q.align(self.text, self.document())["mode"], "exact-literal")
        result = q.align(self.evidence, self.document())
        self.assertEqual(result["status"], "source-bound-observation")
        self.assertEqual(result["bindings"][0]["targetPage"], 4)
        self.assertEqual(result["regions"][0]["physicalPage"], 1)

    def test_wrong_prose_number_decimal_and_operator_are_unknown(self):
        for old, new in [("experiment", "hypothesis"), ("1.2", "12"), ("20", "21"), (">", "<")]:
            with self.subTest(old=old):
                self.assertEqual(q.align(self.evidence.replace(old, new), self.document())["status"], "unknown")

    def test_missing_nonbibliographic_unresolved_and_partial_links_are_unknown(self):
        for change in ["missing", "figure", "unresolved", "partial"]:
            document = self.document()
            if change == "missing":
                document["links"] = []
            elif change == "figure":
                document["links"][0]["destination"] = "figure.caption.1"
            elif change == "unresolved":
                document["links"][0]["targetPage"] = 0
            else:
                document["links"][0]["bbox"][2] -= 6
            with self.subTest(change=change):
                self.assertEqual(q.align(self.evidence, document)["status"], "unknown")

    def test_duplicate_context_is_unknown(self):
        document = self.document()
        page2 = copy.deepcopy(document["pages"][0]); page2["number"] = 2
        document["pages"].append(page2)
        document["links"].append({**document["links"][0], "page": 2})
        self.assertEqual(q.align(self.evidence, document)["status"], "unknown")

    def test_whitespace_cannot_merge_numbers(self):
        source = "The observed samples were 1 2 units in this experiment."
        evidence = "The observed samples were12 units in this experiment."
        self.assertEqual(q.align(evidence, observation(source))["status"], "unknown")
        # PDF word extraction omits spaces but retains word identity.
        document = observation(source)
        for i, char in enumerate(document["pages"][0]["chars"]):
            char["wordIndex"] = len(source[:i].split())
        document["pages"][0]["chars"] = [c for c in document["pages"][0]["chars"] if c["text"] != " "]
        self.assertEqual(q.align(evidence, document)["status"], "unknown")

    def test_multiple_placeholders_keep_distinct_destinations(self):
        text = "The first source is (Author, 2020) and the second source is (Other, 2021). Both are cited here."
        evidence = "The first source is BIBREF1 and the second source is BIBREF2. Both are cited here."
        document = observation(text, [("(Author, 2020)", "cite.author2020", 4), ("(Other, 2021)", "cite.other2021", 5)])
        result = q.align(evidence, document)
        self.assertEqual(result["status"], "source-bound-observation")
        self.assertEqual([b["targetPage"] for b in result["bindings"]], [4, 5])


if __name__ == "__main__":
    unittest.main()
