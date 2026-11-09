"""Deletes, moves and duplicates slides, which python-pptx has no methods for. Part of the pptx skill.

    python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx delete 5 7
    python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx move 6 2       # slide 6 becomes slide 2
    python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx duplicate 3    # the copy goes after slide 3
    python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx keep 1 4 2     # only these, in this order

Slide numbers start at 1 and refer to the deck as it is before the command. A duplicate shares its pictures with the
original. A slide with a chart cannot be duplicated here, because the copy would share the chart's data: add a new
slide with the same layout and make the chart again with add_chart.
"""
from __future__ import annotations

import copy
import sys

from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT


def slide_ids(prs):
    return prs.slides._sldIdLst


def delete(prs, numbers: list[int]) -> None:
    ids = list(slide_ids(prs))
    for n in sorted(set(numbers), reverse=True):
        sld = ids[n - 1]
        prs.part.drop_rel(sld.rId)
        slide_ids(prs).remove(sld)


def move(prs, src: int, dst: int) -> None:
    ids = slide_ids(prs)
    sld = list(ids)[src - 1]
    ids.remove(sld)
    ids.insert(dst - 1, sld)


def duplicate(prs, n: int) -> None:
    source = prs.slides[n - 1]
    if any(getattr(s, "has_chart", False) and s.has_chart for s in source.shapes):
        sys.exit(f"Slide {n} has a chart, which a copy would share. Add a slide with layout "
                 f"{source.slide_layout.name!r} and make the chart again with add_chart.")
    copy_ = prs.slides.add_slide(source.slide_layout)
    for shape in list(copy_.shapes):  # the layout's empty placeholders: the source's own shapes replace them
        shape._element.getparent().remove(shape._element)
    renamed = {}
    for rel in source.part.rels.values():  # pictures, media and links the shapes point at
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE):
            continue
        renamed[rel.rId] = (copy_.part.relate_to(rel.target_ref, rel.reltype, is_external=True) if rel.is_external
                            else copy_.part.relate_to(rel.target_part, rel.reltype))
    tree = copy_.shapes._spTree
    for el in source.shapes._spTree.iterchildren():
        if el.tag.endswith(("}nvGrpSpPr", "}grpSpPr")):
            continue
        clone = copy.deepcopy(el)
        for node in clone.iter():
            for attr, value in list(node.attrib.items()):
                if attr.endswith(("}embed", "}link", "}id")) and value in renamed:
                    node.set(attr, renamed[value])
        tree.append(clone)
    if source.has_notes_slide:
        copy_.notes_slide.notes_text_frame.text = source.notes_slide.notes_text_frame.text
    move(prs, len(prs.slides), n + 1)


def main() -> None:
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    deck, out, command, *numbers = sys.argv[1:]
    prs = Presentation(deck)
    nums = [int(x) for x in numbers]
    total = len(prs.slides)
    if any(not 1 <= x <= total for x in nums):
        sys.exit(f"The deck has {total} slides: use numbers from 1 to {total}.")
    if command == "delete":
        delete(prs, nums)
    elif command == "move" and len(nums) == 2:
        move(prs, *nums)
    elif command == "duplicate" and len(nums) == 1:
        duplicate(prs, nums[0])
    elif command == "keep":
        order = list(slide_ids(prs))
        for position, n in enumerate(nums, start=1):  # put the kept slides in the order given, then drop the rest
            slide_ids(prs).remove(order[n - 1])
            slide_ids(prs).insert(position - 1, order[n - 1])
        ids = list(slide_ids(prs))
        for sld in ids[len(nums):]:
            prs.part.drop_rel(sld.rId)
            slide_ids(prs).remove(sld)
    else:
        sys.exit(__doc__)
    prs.save(out)
    print(f"saved {out}: {len(prs.slides)} slides")


if __name__ == "__main__":
    main()
