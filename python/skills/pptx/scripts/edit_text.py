"""Changes text in a deck without losing its formatting. Part of the pptx skill.

Setting a shape's text with python-pptx throws away its fonts, sizes and colours, and a phrase is often split across
several runs, so a plain replace misses it. This finds each phrase across runs and changes only those characters,
keeping the formatting of the run where the phrase starts. It looks in text boxes, placeholders, tables and grouped
shapes, and can also replace a shape's whole text paragraph by paragraph.

    python skills/pptx/scripts/edit_text.py work/deck.pptx edits.json work/deck-v2.pptx

edits.json is a list of changes; slide numbers start at 1, and shape (a name from slide_text.py) is optional:

    [{"slide": 1, "find": "August 26", "replace": "August 2026"},
     {"slide": 3, "shape": "TextBox 34", "find": "Complete", "replace": "– Complete"},
     {"slide": 4, "shape": "Title 1", "paragraphs": ["Operational summary"]},
     {"slide": 7, "notes": "Reviewer asked: can we add month-on-month trends?"}]

A change that matches nothing is reported and the script exits with 1, so nothing is changed silently by mistake.
"""
from __future__ import annotations

import copy
import json
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def text_frames(shapes):
    """Every (shape name, text frame) in these shapes, looking inside groups and table cells."""
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from text_frames(shape.shapes)
            continue
        if shape.has_text_frame:
            yield shape.name, shape.text_frame
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    yield shape.name, cell.text_frame


def replace_in_paragraph(paragraph, find: str, replace: str) -> int:
    """Replaces every `find` in the paragraph across its runs. The new text takes the first matched run's format."""
    count = 0
    while True:
        runs = list(paragraph.runs)
        full = "".join(r.text for r in runs)
        at = full.find(find)
        if at < 0 or not runs:
            return count
        end, pos, first = at + len(find), 0, None
        for r in runs:
            start, stop = pos, pos + len(r.text)
            pos = stop
            if stop <= at or start >= end:
                continue  # outside the match
            keep_before = r.text[:max(0, at - start)]
            keep_after = r.text[max(0, end - start):] if stop > end else ""
            if first is None:
                r.text = keep_before + replace + keep_after
                first = r
            else:
                r.text = keep_after
        count += 1
        if not find:
            return count


def set_paragraphs(frame, lines: list[str]) -> None:
    """Replaces a text frame's paragraphs with these lines, each keeping the format of the paragraph it replaces (or
    of the last one, for extra lines)."""
    paragraphs = list(frame.paragraphs)
    for i, line in enumerate(lines):
        if i >= len(paragraphs):  # an extra line: a copy of the last paragraph, so it keeps that format
            paragraphs[-1]._p.addnext(copy.deepcopy(paragraphs[-1]._p))
            paragraphs = list(frame.paragraphs)
        p = paragraphs[i]
        runs = list(p.runs)
        if runs:
            runs[0].text = line
            for r in runs[1:]:
                r._r.getparent().remove(r._r)
        else:
            p.text = line
    for p in list(frame.paragraphs)[len(lines):]:
        p._p.getparent().remove(p._p)


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    deck, edits_path, out = sys.argv[1:]
    prs = Presentation(deck)
    edits = json.load(open(edits_path))
    missed = []
    for e in edits:
        n = int(e["slide"])
        if not 1 <= n <= len(prs.slides):
            missed.append(f"slide {n} does not exist")
            continue
        slide = prs.slides[n - 1]
        if "notes" in e:
            slide.notes_slide.notes_text_frame.text = e["notes"]
            print(f"slide {n}: notes set")
            continue
        frames = [(name, f) for name, f in text_frames(slide.shapes) if not e.get("shape") or name == e["shape"]]
        if "paragraphs" in e:
            if not frames:
                missed.append(f"slide {n}: no shape called {e.get('shape')!r}")
                continue
            set_paragraphs(frames[0][1], e["paragraphs"])
            print(f"slide {n} {frames[0][0]}: text set")
            continue
        count = sum(replace_in_paragraph(p, e["find"], e["replace"]) for _, f in frames for p in f.paragraphs)
        if count:
            print(f"slide {n}: {e['find']!r} -> {e['replace']!r} ({count}x)")
        else:
            missed.append(f"slide {n}: {e['find']!r} not found" + (f" in {e['shape']!r}" if e.get("shape") else ""))
    prs.save(out)
    print(f"saved {out}")
    if missed:
        print("Not changed:\n  " + "\n  ".join(missed))
        sys.exit(1)


if __name__ == "__main__":
    main()
