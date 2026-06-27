"""Classification for Q6 (recommendation noun) and Q7 (topic/chapter)."""

from __future__ import annotations

import json
import re
from pathlib import Path

_CONFIG = Path(__file__).resolve().parent.parent / "config"

_STOP_AFTER_NUM = {"main", "key", "possible", "important", "specific", "good", "of", "such", "other"}


def _load(name: str) -> dict:
    return json.loads((_CONFIG / name).read_text(encoding="utf-8"))


# ----- Q6: extract the "two X" / "some X" noun and canonicalise it ----------

def _build_variant_map() -> dict[str, str]:
    cats = _load("categories.json")["categories"]
    variant_to_canon: dict[str, str] = {}
    for canon, variants in cats.items():
        variant_to_canon[canon.lower()] = canon
        for v in variants:
            variant_to_canon[v.lower()] = canon
    return variant_to_canon


_VARIANTS = _build_variant_map()
_NOUN_RE = re.compile(r"\b(?:two|some)\s+([a-z]+)(?:\s+([a-z]+))?", re.I)


def classify_q6(text: str) -> tuple[str | None, str, float]:
    """Return (canonical_category, raw_noun, confidence)."""
    for m in _NOUN_RE.finditer(text.lower()):
        w1, w2 = m.group(1), m.group(2)
        # skip a leading adjective (e.g. "two main reasons")
        candidates = []
        if w1 in _STOP_AFTER_NUM and w2:
            candidates = [w2, w1]
        else:
            candidates = [w1] + ([w2] if w2 else [])
        for w in candidates:
            if w in _VARIANTS:
                return _VARIANTS[w], w, 1.0
        # no canonical match — keep the first real noun verbatim, flag it
        raw = w2 if (w1 in _STOP_AFTER_NUM and w2) else w1
        return None, raw, 0.4
    return None, "", 0.2


# ----- Q7: score context+stem against chapter keywords ---------------------

_ISSUES = _load("chapters.json")["issues"]


def classify_q7(text: str) -> tuple[int | None, int | None, str | None, float]:
    """Return (issue, chapter, chapter_title, confidence)."""
    low = text.lower()
    best = None
    best_score = 0.0
    for issue in _ISSUES:
        for ch in issue["chapters"]:
            score = 0.0
            for kw in ch["keywords"]:
                if kw in low:
                    # weight by keyword specificity (length / word count)
                    score += 1.0 + 0.25 * len(kw.split())
            if score > best_score:
                best_score = score
                best = (issue["issue"], ch["chapter"], ch["title"])
    if not best:
        return None, None, None, 0.0
    # confidence: saturating function of raw score
    conf = min(1.0, best_score / 3.0)
    return best[0], best[1], best[2], round(conf, 2)
