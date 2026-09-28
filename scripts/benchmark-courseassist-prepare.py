"""Cache the public, anonymized CourseAssist Piazza evaluation rows."""

import csv
import json
from pathlib import Path
from urllib.request import urlopen

root = Path("data/benchmark")
root.mkdir(parents=True, exist_ok=True)
source = "https://raw.githubusercontent.com/ytyfeng/CourseAssist-Data/main/qa_data.csv"
csv_path = root / "courseassist-qa.csv"
if not csv_path.exists():
    csv_path.write_bytes(urlopen(source, timeout=30).read())
with csv_path.open(encoding="utf-8-sig", newline="") as handle:
    rows = [
        {key: row[key] for key in ("Category", "Question", "Answer", "Context")}
        for row in csv.DictReader(handle)
        if row.get("Question", "").strip() and row.get("Answer", "").strip()
    ]
if len(rows) != 50:
    raise ValueError(f"Expected 50 complete questions, found {len(rows)}")
(root / "courseassist-qa.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
print(f"Prepared {len(rows)} real Piazza questions")
