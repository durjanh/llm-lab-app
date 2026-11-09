"""A deck's or template's theme: its colours and fonts, to use for charts, shapes and text. Part of the pptx skill.

A company template carries its brand in the theme. Use these colours (accent1 first, then accent2 and so on) for chart
series and shapes, and these fonts, rather than colours and fonts of your own.

    python skills/pptx/scripts/theme.py inputs/template.pptx
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET

from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
ROLE = {"dk1": "dark text", "lt1": "light background", "dk2": "dark second", "lt2": "light second",
        "hlink": "hyperlink", "folHlink": "visited hyperlink"}


def colour(slot) -> str:
    for child in slot:
        if child.tag == A + "srgbClr":
            return child.get("val", "")
        if child.tag == A + "sysClr":
            return child.get("lastClr", child.get("val", ""))
    return "?"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    prs = Presentation(sys.argv[1])
    for number, master in enumerate(prs.slide_masters, start=1):
        theme = ET.fromstring(master.part.part_related_by(RT.THEME).blob)
        scheme = theme.find(f"{A}themeElements/{A}clrScheme")
        fonts = theme.find(f"{A}themeElements/{A}fontScheme")
        print(f"master {number}: colour scheme {scheme.get('name')!r}")
        for name in SLOTS:
            slot = scheme.find(A + name)
            if slot is not None:
                print(f"  {name:<9} #{colour(slot)}  {ROLE.get(name, 'chart and shape colour')}")
        for kind in ("majorFont", "minorFont"):
            latin = fonts.find(f"{A}{kind}/{A}latin")
            print(f"  {'headings' if kind == 'majorFont' else 'body':<9} font {latin.get('typeface') if latin is not None else '?'}")
    print("\nIn python-pptx: RGBColor.from_string('<hex without #>'), and font.name = '<font>'.")


if __name__ == "__main__":
    main()
