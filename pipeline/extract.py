"""Extract Q6 & Q7 from Section B of each paper -> site/data/questions.draft.json

Usage:
    python pipeline/extract.py                      # process Question Paper/
    python pipeline/extract.py "Test"               # process another folder
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from docx_reader import Segment, question_paper_region, read_paper
from classify import classify_q6, classify_q7

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "Question Paper"
OUT = ROOT / "site" / "data" / "questions.draft.json"
TAXONOMY_OUT = ROOT / "site" / "data" / "taxonomy.json"
CONFIG = ROOT / "config"

_MARKS_RE = re.compile(r"\[\s*(\d+)\s*\]")
_TRIGGER_RE = re.compile(
    r"(In your opinion\b|Do you think\b|Do you agree\b|Do you feel\b|Do you believe\b|"
    r"To what extent\b|What can\b|What are\b|What do\b|Why \b|Why do\b|"
    r"How can\b|How far\b|How do\b|Suggest\b|Explain how\b)",
    re.I,
)

# Content signatures to locate the two Section-B questions without a printed number.
_Q7_TRIGGER = re.compile(
    r"\b(Do you think|Do you agree|Do you feel|Do you believe|To what extent|How far do you agree)\b", re.I)
_GIVE_TWO = re.compile(r"\btwo\s+[a-z]+", re.I)          # Q6 asks for "two <noun>"
_HAS_MARKS = re.compile(r"\[\s*\d+\s*\]")
_INSTRUCTION_START = re.compile(
    r"^(In your opinion|Do you think|Do you agree|Do you feel|Do you believe|To what extent|"
    r"How far|Suggest|Why do you|How can|What can|What are|What do|Explain how)", re.I)
_BARE_LABEL = re.compile(r"^(extract|source)\s*\d*\s*:?\s*$", re.I)
_END_PAPER = re.compile(r"(^|~\s*)end of (the )?paper", re.I)
_SCHOOL_RE = re.compile(
    r"([A-Z][A-Za-z.'()&/-]*(?:\s+[A-Z][A-Za-z.'()&/-]*){0,4}?\s+"
    r"(?:SECONDARY SCHOOL|INSTITUTION|JUNIOR COLLEGE|HIGH SCHOOL))", re.I)


# ---- locate a question by its leading number within QP segments ------------

def _is_qstart(seg: Segment, n: int) -> bool:
    if seg.cells and seg.cells[0].strip() == str(n):
        return True
    return bool(re.match(rf"^{n}[\.\)\s]\s*\S", seg.text))


def _find_start(segments: list[Segment], n: int) -> int | None:
    for i, seg in enumerate(segments):
        if _is_qstart(seg, n):
            return i
    return None


def _block_text(segments: list[Segment], start: int, end: int, n: int) -> str:
    parts = [segments[start].text]
    for seg in segments[start + 1 : end]:
        parts.append(seg.text)
    text = " ".join(parts)
    text = re.sub(rf"^{n}[\.\)\s]+", "", text).strip()        # drop leading number
    text = re.sub(r"\s+", " ", text)
    return text


def _split_context_stem(text: str) -> tuple[str, str]:
    m = _TRIGGER_RE.search(text)
    if m and m.start() > 0:
        return text[: m.start()].strip(), text[m.start():].strip()
    return "", text


def _marks(text: str) -> int | None:
    found = _MARKS_RE.findall(text)
    return int(found[-1]) if found else None


# ---- filename metadata ----------------------------------------------------

_STOP_TOKENS = {"SS", "QP", "AS", "PRELIM", "PRELIMS", "SECTION", "HUM", "AND", "V2", "V1"}


def _detect_school(segments: list[Segment]) -> str | None:
    """Find the school name in the paper header (more reliable than filenames)."""
    for seg in segments[:14]:
        m = _SCHOOL_RE.search(seg.text)
        if m:
            name = re.sub(r"\s+", " ", m.group(1)).strip()
            name = re.sub(r"^(?:[A-Z]\s+)+", "", name)  # drop stray leading logo/bullet letters
            name = re.sub(r"\s*\b(secondary school|high school)\b", "", name, flags=re.I).strip()
            return name.title() if name.isupper() else name
    return None


def _metadata(filename: str, segments: list[Segment]) -> dict:
    stem = Path(filename).stem
    year_m = re.search(r"(20\d{2})", stem)
    year = int(year_m.group(1)) if year_m else None

    # School: prefer the document header; fall back to a filename acronym.
    school = _detect_school(segments)
    if not school:
        for tok in re.findall(r"[A-Z]{2,}(?:\([A-Za-z]+\))?", stem):
            if tok.upper() not in _STOP_TOKENS:
                school = tok
                break

    level_m = re.search(r"(S?4E5N|4E5N|S4E5N|4E|5N|4N)", stem)
    level = level_m.group(1) if level_m else None
    paper = f"Prelim {level}" if level else "Prelim"

    return {"school": school, "year": year, "paper": paper,
            "meta_ok": bool(school and year)}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "x").lower()).strip("-")


# ---- per-paper extraction -------------------------------------------------

def _strip_num(t: str) -> str:
    return re.sub(r"^\s*[67][.)\s]+", "", t).strip()


def _needs_context(seg: Segment) -> bool:
    return bool(_INSTRUCTION_START.match(_strip_num(seg.text)))


def _context_like(seg: Segment) -> bool:
    t = seg.text
    return bool(t) and len(t) <= 240 and not _BARE_LABEL.match(t) and not _HAS_MARKS.search(t)


def _find_context(qp: list[Segment], idx: int, other: int) -> str:
    for j in range(idx - 1, max(-1, idx - 4), -1):
        if j == other:
            break
        if _BARE_LABEL.match(qp[j].text):
            continue
        return qp[j].text if _context_like(qp[j]) else ""
    return ""


def _build_text(qp: list[Segment], idx: int, other: int) -> str:
    body = _strip_num(qp[idx].text)
    ctx = _find_context(qp, idx, other) if _needs_context(qp[idx]) else ""
    return f"{ctx} {body}".strip() if ctx else body


def extract_paper(path: Path) -> list[dict]:
    all_segs = read_paper(path)
    qp = question_paper_region(all_segs)
    for i, seg in enumerate(qp):
        if _END_PAPER.search(seg.text):
            qp = qp[:i]
            break
    meta = _metadata(path.name, all_segs)

    # Q6 = the "two <noun> [marks]" line.
    q6i = next((i for i in range(len(qp) - 1, -1, -1)
                if _GIVE_TWO.search(qp[i].text) and _HAS_MARKS.search(qp[i].text)), None)

    # Q7 = a discursive (non "two <noun>") line, preferably after Q6 and with marks.
    def pick_q7(start: int) -> int | None:
        found = None
        for i in range(start, len(qp)):
            if i == q6i:
                continue
            if _Q7_TRIGGER.search(qp[i].text) and not _GIVE_TWO.search(qp[i].text):
                found = i
                if _HAS_MARKS.search(qp[i].text):
                    return i
        return found

    q7i = pick_q7(q6i + 1) if q6i is not None else None
    if q7i is None:
        q7i = pick_q7(0)

    # Fallback to printed-number anchor.
    if q6i is None:
        q6i = _find_start(qp, 6)
    if q7i is None:
        f = _find_start(qp, 7)
        q7i = f if f != q6i else None

    records: list[dict] = []
    if q6i is not None:
        records.append(_make_q6(_build_text(qp, q6i, q7i if q7i is not None else -1), meta, path))
    else:
        print(f"  !! Q6 not found in {path.name}")
    if q7i is not None:
        records.append(_make_q7(_build_text(qp, q7i, q6i if q6i is not None else -1), meta, path))
    else:
        print(f"  !! Q7 not found in {path.name}")
    return records


def _base(meta: dict, path: Path, n: int, context: str, stem: str, marks) -> dict:
    return {
        "id": f"{_slug(meta['school'])}-{meta['year']}-q{n}",
        "school": meta["school"], "year": meta["year"], "paper": meta["paper"],
        "question_number": n,
        "context": context,
        "stem": stem,
        "marks": marks,
        "source_file": str(path.relative_to(ROOT)).replace("\\", "/"),
    }


def _make_q6(text: str, meta: dict, path: Path) -> dict:
    context, stem = _split_context_stem(text)
    category, raw_noun, conf = classify_q6(stem or text)
    rec = _base(meta, path, 6, context, stem or text, _marks(text))
    rec.update({
        "bank": "Q6",
        "category": category or raw_noun,
        "category_raw": raw_noun,
        "issue": None, "chapter": None, "chapter_title": None,
        "confidence": conf,
        "needs_review": (category is None) or not meta["meta_ok"],
    })
    return rec


def _make_q7(text: str, meta: dict, path: Path) -> dict:
    context, stem = _split_context_stem(text)
    issue, chapter, title, conf = classify_q7(text)
    rec = _base(meta, path, 7, context, stem or text, _marks(text))
    rec.update({
        "bank": "Q7",
        "category": None, "category_raw": None,
        "issue": issue, "chapter": chapter, "chapter_title": title,
        "confidence": conf,
        "needs_review": (issue is None) or conf < 0.5 or not meta["meta_ok"],
    })
    return rec


def _write_taxonomy() -> None:
    """Emit category + issue/chapter options under site/data/ for the web tools."""
    cats = json.loads((CONFIG / "categories.json").read_text(encoding="utf-8"))["categories"]
    issues = json.loads((CONFIG / "chapters.json").read_text(encoding="utf-8"))["issues"]
    taxonomy = {
        "categories": list(cats.keys()),
        "issues": [
            {
                "issue": iss["issue"],
                "title": iss["title"],
                "chapters": [{"chapter": ch["chapter"], "title": ch["title"]} for ch in iss["chapters"]],
            }
            for iss in issues
        ],
    }
    TAXONOMY_OUT.write_text(json.dumps(taxonomy, indent=2, ensure_ascii=False), encoding="utf-8")

    # Full rule set for the in-browser extractor (single source of truth = config/).
    classify_cfg = {"categories": cats, "issues": issues}
    (ROOT / "site" / "data" / "classify-config.json").write_text(
        json.dumps(classify_cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_INPUT
    if not folder.is_absolute():
        folder = ROOT / folder
    papers = sorted([*folder.glob("*.docx"), *folder.glob("*.pdf")])
    if not papers:
        print(f"No papers found in {folder}")
        return

    all_records: list[dict] = []
    print(f"Processing {len(papers)} paper(s) from {folder.name}/ ...")
    for p in papers:
        recs = extract_paper(p)
        all_records.extend(recs)
        print(f"  - {p.name}: {len(recs)} question(s)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(all_records, indent=2, ensure_ascii=False), encoding="utf-8")
    _write_taxonomy()

    q6 = sum(r["bank"] == "Q6" for r in all_records)
    q7 = sum(r["bank"] == "Q7" for r in all_records)
    flagged = sum(r["needs_review"] for r in all_records)
    print(f"\nWrote {len(all_records)} questions ({q6} Q6, {q7} Q7) to {OUT.relative_to(ROOT)}")
    print(f"{flagged} flagged for review.")


if __name__ == "__main__":
    main()
