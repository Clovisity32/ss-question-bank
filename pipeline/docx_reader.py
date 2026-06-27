"""Ordered reader for .docx (and basic .pdf) papers.

Yields the document body as a flat list of Segment objects in reading order,
mixing paragraphs and table rows. Also isolates the Question Paper (QP) region
by truncating at the first Answer-Scheme / marking marker, so marking content
never leaks into extracted questions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import docx
from docx.document import Document as _Doc
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph


@dataclass
class Segment:
    kind: str            # "para" | "row"
    text: str            # display text (cells de-duplicated and joined)
    cells: list = field(default_factory=list)  # for rows: per-cell text


# --- Answer-Scheme / marking markers: everything from the first hit is dropped.
_AS_MARKERS = re.compile(
    r"""(
        ^\s*L\s*[1-4]\b                 # marking levels L1..L4
        | \bAward\s+\d+\s*(?:[-–]\s*\d+)?\s*m(?:ark)?s?\b
        | \bmark(?:ing)?\s+scheme\b
        | \banswer\s+scheme\b
        | \bsuggested\s+answer
        | \btarget\s+skill\b
    )""",
    re.I | re.X,
)


def _dedup_cells(cells: list[str]) -> str:
    """Join row cells, collapsing the repeated-column duplication seen in some papers."""
    out: list[str] = []
    for c in cells:
        c = c.strip()
        if c and (not out or out[-1] != c):
            out.append(c)
    return "  ".join(out)


def _iter_body(doc: _Doc):
    """Yield Paragraph and Table objects in true document order."""
    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, doc)
        elif isinstance(child, CT_Tbl):
            yield Table(child, doc)


def read_docx(path: str | Path) -> list[Segment]:
    doc = docx.Document(str(path))
    segments: list[Segment] = []
    for block in _iter_body(doc):
        if isinstance(block, Paragraph):
            t = block.text.strip()
            if t:
                segments.append(Segment("para", _norm(t)))
        else:  # Table
            for row in block.rows:
                cells = [c.text.strip() for c in row.cells]
                text = _norm(_dedup_cells(cells))
                if text:
                    segments.append(Segment("row", text, [_norm(c) for c in cells]))
    return segments


def read_pdf(path: str | Path) -> list[Segment]:
    """Basic PDF text reader (untuned — current inputs are .docx)."""
    import pdfplumber

    segments: list[Segment] = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or "").splitlines():
                t = _norm(line.strip())
                if t:
                    segments.append(Segment("para", t))
    return segments


def read_paper(path: str | Path) -> list[Segment]:
    path = Path(path)
    if path.suffix.lower() == ".pdf":
        return read_pdf(path)
    return read_docx(path)


def question_paper_region(segments: list[Segment]) -> list[Segment]:
    """Return only the Question Paper portion (drop Answer-Scheme tail)."""
    for i, seg in enumerate(segments):
        if _AS_MARKERS.search(seg.text):
            return segments[:i]
    return segments


def _norm(s: str) -> str:
    # collapse whitespace/newlines and normalise common smart punctuation
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip()


if __name__ == "__main__":
    import sys

    for p in sys.argv[1:]:
        segs = question_paper_region(read_paper(p))
        print(f"\n### {p}  ({len(segs)} QP segments)")
        for s in segs:
            print(f"  [{s.kind}] {s.text[:140]}")
