"""Every slide of a deck as text, with the problems a render would show flagged; or a template's layouts.

Part of the pptx skill. Read a deck with this before changing it, and read each version you save: it lists each
shape with its position, size and text, tables, chart data and speaker notes, and flags what tends to look wrong:
shapes off the slide, shapes that partly overlap, empty placeholders, charts that may show a default "Chart Title",
and bar, column or line charts whose value axis may not start at zero.

    python skills/pptx/scripts/slide_text.py inputs/deck.pptx             # every slide
    python skills/pptx/scripts/slide_text.py work/deck.pptx --slides 2,5   # some slides
    python skills/pptx/scripts/slide_text.py inputs/template.pptx --layouts   # a template's layouts and placeholders
"""
from __future__ import annotations

import argparse

from pptx import Presentation
from pptx.util import Emu

ZERO_BASED = ("COLUMN", "BAR", "LINE", "AREA")  # chart types whose value axis should start at zero


def inches(value: int | None) -> str:
    return f"{Emu(value or 0).inches:.2f}"


def box(shape) -> tuple[int, int, int, int] | None:
    if shape.left is None or shape.width is None:
        return None
    return shape.left, shape.top, shape.left + shape.width, shape.top + shape.height


def is_backdrop(shape, width: int, height: int) -> bool:
    """A picture, or a shape covering most of the slide: text on top of it is the design, not a fault."""
    if shape.shape_type is not None and shape.shape_type.name in ("PICTURE", "GROUP"):
        return True
    return bool(shape.width and shape.height and shape.width * shape.height > 0.6 * width * height)


def partly_overlap(a, b) -> bool:
    """True when two boxes overlap but neither holds the other (a card holding its text is fine)."""
    if a is None or b is None:
        return False
    inside = lambda x, y: x[0] >= y[0] and x[1] >= y[1] and x[2] <= y[2] and x[3] <= y[3]  # noqa: E731
    crosses = a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
    return crosses and not inside(a, b) and not inside(b, a)


def chart_flags(chart) -> list[str]:
    flags = []
    deleted = chart._chartSpace.chart.find(
        "{http://schemas.openxmlformats.org/drawingml/2006/chart}autoTitleDeleted")
    if not chart.has_title and (deleted is None or deleted.get("val") not in ("1", "true")):
        flags.append('MAY SHOW A DEFAULT "Chart Title": set chart.has_title = False, or give it a title')
    kind = chart.chart_type.name if chart.chart_type is not None else ""
    if kind.startswith(ZERO_BASED):
        try:
            if chart.value_axis.minimum_scale is None:
                flags.append("VALUE AXIS MAY NOT START AT 0: set chart.value_axis.minimum_scale = 0")
        except ValueError:
            pass
    return flags


def layouts(prs) -> None:
    for i, layout in enumerate(prs.slide_layouts):
        print(f"\nlayout {i}: {layout.name!r}")
        for ph in layout.placeholders:
            print(f"  placeholder idx {ph.placeholder_format.idx} {ph.placeholder_format.type} {ph.name!r} "
                  f"at ({inches(ph.left)}, {inches(ph.top)}) size {inches(ph.width)} x {inches(ph.height)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("deck")
    parser.add_argument("--slides", help="comma-separated slide numbers, from 1")
    parser.add_argument("--layouts", action="store_true", help="list the slide layouts and their placeholders")
    args = parser.parse_args()
    prs = Presentation(args.deck)
    width, height = prs.slide_width, prs.slide_height
    pictures = sum(1 for s in prs.slides for sh in s.shapes if sh.shape_type is not None and sh.shape_type.name == "PICTURE")
    print(f"{len(prs.slides)} slides, {inches(width)} x {inches(height)} in, {pictures} pictures")
    if args.layouts:
        layouts(prs)
        return
    wanted = {int(n) for n in args.slides.split(",")} if args.slides else None
    problems = 0
    for number, slide in enumerate(prs.slides, start=1):
        if wanted and number not in wanted:
            continue
        print(f"\n=== slide {number} · layout {slide.slide_layout.name!r}")
        shapes = list(slide.shapes)
        for i, shape in enumerate(shapes):
            b = box(shape)
            flags = []
            if b and (b[0] < 0 or b[1] < 0 or b[2] > width or b[3] > height):
                flags.append("OFF THE SLIDE")
            overlaps = [] if is_backdrop(shape, width, height) else [
                o.name for o in shapes[:i] + shapes[i + 1:] if not is_backdrop(o, width, height) and partly_overlap(b, box(o))]
            if overlaps:
                flags.append("PARTLY OVERLAPS " + ", ".join(overlaps))
            text = shape.text_frame.text.strip() if shape.has_text_frame else ""
            if shape.is_placeholder and shape.has_text_frame and not text:
                flags.append("EMPTY PLACEHOLDER")
            if getattr(shape, "has_chart", False) and shape.has_chart:
                flags += chart_flags(shape.chart)
            problems += len(flags)
            kind = "placeholder" if shape.is_placeholder else (shape.shape_type.name.lower() if shape.shape_type else "shape")
            where = f"at ({inches(shape.left)}, {inches(shape.top)}) size {inches(shape.width)} x {inches(shape.height)}"
            print(f"- {shape.name} [{kind}] {where}")
            for flag in flags:
                print(f"    ! {flag}")
            for line in text.splitlines():
                print(f"    {line}")
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    print("    | " + " | ".join(c.text.strip() for c in row.cells) + " |")
            if getattr(shape, "has_chart", False) and shape.has_chart:
                chart = shape.chart
                print(f"    chart {chart.chart_type.name if chart.chart_type is not None else ''}")
                for plot in chart.plots:
                    categories = list(plot.categories)
                    for series in plot.series:
                        print(f"    series {series.name!r}: {dict(zip(categories, series.values))}")
            if shape.shape_type is not None and shape.shape_type.name == "PICTURE":
                print("    (a picture: its text cannot be edited here)")
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            print(f"  notes: {slide.notes_slide.notes_text_frame.text.strip()}")
    print(f"\n{problems} flagged" + (": fix what is really wrong, and say why the rest are intended. Never delete "
                                     "pictures, charts or slides to clear a flag." if problems else "."))


if __name__ == "__main__":
    main()
