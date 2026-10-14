"""Input-integrity checks only; never execute retrieval or grade an answer."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/freeze-heldout-study.py"
SPEC = importlib.util.spec_from_file_location("heldout_freeze", SCRIPT)
freeze = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(freeze)
ANNOTATION_SPEC = importlib.util.spec_from_file_location("heldout_annotations", SCRIPT.with_name("annotate-heldout-study.py"))
annotations = importlib.util.module_from_spec(ANNOTATION_SPEC)
ANNOTATION_SPEC.loader.exec_module(annotations)


def paper(question_id, text, unanswerable=False):
    return {"title": "A paper", "abstract": "An abstract", "full_text": [
        {"section_name": "Evidence", "paragraphs": ["α😀 exact evidence", "exact evidence"]}],
        "figures_and_tables": [{"file": "table.png", "caption": "An original table caption"}],
        "qas": [{"question_id": question_id, "question": text, "answers": [{
            "annotation_id": "original-a", "answer": {"unanswerable": unanswerable,
            "yes_no": None, "extractive_spans": [], "free_form_answer": "Author answer",
            "evidence": ["exact evidence", "author evidence not matching text"]}}]}]}


class FreezeIntegrityTests(unittest.TestCase):
    def test_order_ignores_original_input_order(self):
        ids = ["qa-a", "qa-b", "qa-c", "qa-d"]
        self.assertEqual(freeze.select_ids(ids, "source", "fixed-seed", 3),
                         freeze.select_ids(reversed(ids), "source", "fixed-seed", 3))

    def test_unicode_offsets_and_all_original_evidence_survive(self):
        original = paper("qa-a", "What did they measure?", True)
        untouched = copy.deepcopy(original)
        prior = {key: set() for key in ["materials", "ids", "texts", "titleAbstracts"]}
        protocol = {"seed": "seed", "selection": {"questionsPerCandidate": 1}}
        materials, cases, stats = freeze.build_qasper({"paper-1": original}, "source", prior, set(), set(), protocol)
        self.assertEqual(original, untouched)
        self.assertEqual(cases[0]["authorQuestionAndGold"], original["qas"][0])
        self.assertEqual(stats["anyUnanswerableAnnotations"], 1)
        self.assertEqual(stats["unmatchedAuthorEvidenceStrings"], 1)
        exact = cases[0]["authorEvidenceSpans"][0]
        self.assertEqual(len(exact["locations"]), 2)
        for span in exact["locations"]:
            self.assertEqual(materials[0]["text"][span["start"]:span["end"]], exact["text"])

    def test_previous_material_and_question_exclusion_is_not_gold_filter(self):
        papers = {"seen": paper("old", "Old query"), "new": paper("new", "New query", True)}
        prior = {"materials": {"seen"}, "ids": set(), "texts": {"old query"}, "titleAbstracts": set()}
        protocol = {"seed": "seed", "selection": {"questionsPerCandidate": 1}}
        materials, cases, stats = freeze.build_qasper(papers, "source", prior, set(), set(), protocol)
        self.assertEqual([row["originalId"] for row in materials], ["new"])
        self.assertEqual(cases[0]["originalId"], "new")
        self.assertEqual(stats["excluded"]["previousMaterial"], 1)

    def test_download_charges_are_persistent_and_cannot_reset(self):
        data_root = SCRIPT.parents[1] / "data"
        data_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=data_root) as directory:
            # Verify the recursive cleanup target stays inside our workspace.
            self.assertTrue(Path(directory).resolve().is_relative_to(data_root.resolve()))
            budget = freeze.DownloadBudget(Path(directory), 1000010)
            budget.charge(10)
            with self.assertRaises(ValueError):
                budget.charge(1)
            reused = freeze.DownloadBudget(Path(directory), 1000010)
            self.assertEqual(reused.ledger["receivedBytes"], 10)
            with self.assertRaises(ValueError):
                freeze.DownloadBudget(Path(directory), 2000000)

    def test_same_question_text_does_not_repeat_in_one_candidate(self):
        first = paper("q1", "What was measured?")
        second = paper("q2", " what WAS measured? ")
        third = paper("q3", "Another question?")
        prior = {key: set() for key in ["materials", "ids", "texts", "titleAbstracts"]}
        protocol = {"seed": "seed", "selection": {"questionsPerCandidate": 2}}
        _, cases, _ = freeze.build_qasper({"a": first, "b": second, "c": third}, "source", prior, set(), set(), protocol)
        self.assertEqual(len({freeze.normalized(row["query"]) for row in cases}), 2)

    def test_null_author_heading_is_preserved_in_original_material(self):
        original = paper("q1", "A question?")
        original["full_text"][0]["section_name"] = None
        prior = {key: set() for key in ["materials", "ids", "texts", "titleAbstracts"]}
        protocol = {"seed": "seed", "selection": {"questionsPerCandidate": 1}}
        materials, _, _ = freeze.build_qasper({"a": original}, "source", prior, set(), set(), protocol)
        self.assertIsNone(materials[0]["authorMaterial"]["full_text"][0]["section_name"])
        self.assertEqual(materials[0]["segments"][2]["text"], "")

    def test_whitespace_diagnostic_does_not_forge_a_raw_span(self):
        span = {"annotationId": "a", "text": "α😀  exact evidence", "locations": []}
        text, segments = freeze.material_text(paper("q", "Question?"))
        audit = annotations.audit_span(span, {"text": text, "segments": segments})
        self.assertEqual(audit["category"], "normalized-only")
        self.assertFalse(audit["literalAligned"])
        self.assertIsNone(audit["rawSpan"])
        self.assertTrue(all(row["rawSpan"] is None for row in audit["normalizedMatches"]))

    def test_float_caption_reference_is_not_promoted_to_literal_alignment(self):
        span = {"annotationId": "a", "text": "FLOAT SELECTED: An original table caption", "locations": []}
        text, segments = freeze.material_text(paper("q", "Question?"))
        audit = annotations.audit_span(span, {"text": text, "segments": segments})
        self.assertEqual(audit["category"], "author-float-selection-marker")
        self.assertTrue(audit["possibleCaptionReferences"])
        self.assertFalse(audit["literalAligned"])
        self.assertFalse(audit["figureTablePixelsIncluded"])

    def test_nfkc_diagnostic_keeps_original_evidence_text(self):
        span = {"annotationId": "a", "text": "Ａ model", "locations": []}
        audit = annotations.audit_span(span, {"segments": [{"locator": "paragraph", "text": "A model"}]})
        self.assertEqual(audit["originalEvidenceText"], "Ａ model")
        self.assertEqual(audit["category"], "normalized-only")
        self.assertIsNone(audit["rawSpan"])


if __name__ == "__main__":
    unittest.main()
