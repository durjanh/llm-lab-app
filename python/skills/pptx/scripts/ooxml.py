"""A deck's raw XML: unpack it, read one part laid out, pack it again, and check the package. Part of the pptx skill.

A .pptx is a zip of XML parts. Some changes have no python-pptx method, such as a theme colour (the hyperlink colour
in ppt/theme/theme1.xml) or an attribute deep in a chart; edit the XML for those. Unpacking keeps every byte as it is:
read parts with `show`, which lays them out, but edit the unpacked files, never that layout, because whitespace
inside a text element is part of the text.

    python skills/pptx/scripts/ooxml.py unpack work/deck.pptx work/deck-xml
    python skills/pptx/scripts/ooxml.py show work/deck.pptx ppt/slides/slide3.xml
    python skills/pptx/scripts/ooxml.py pack work/deck-xml work/deck-v2.pptx
    python skills/pptx/scripts/ooxml.py validate work/deck-v2.pptx

validate checks what makes PowerPoint refuse or "repair" a file: every XML part parses, every internal relationship
points at a part that exists, every part has a content type, and python-pptx can open it. It exits with 1 on a fault.
"""
from __future__ import annotations

import posixpath
import sys
import xml.dom.minidom
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def unpack(deck: str, folder: str) -> None:
    with zipfile.ZipFile(deck) as z:
        z.extractall(folder)
    print(f"unpacked {deck} into {folder}/ (slides in ppt/slides/, theme in ppt/theme/, charts in ppt/charts/)")


def show(deck: str, part: str) -> None:
    with zipfile.ZipFile(deck) as z:
        print(xml.dom.minidom.parseString(z.read(part)).toprettyxml(indent="  ")[:200_000])


def pack(folder: str, deck: str) -> None:
    root = Path(folder)
    files = sorted(p for p in root.rglob("*") if p.is_file())
    first = root / "[Content_Types].xml"  # must come first in the zip
    with zipfile.ZipFile(deck, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(first, "[Content_Types].xml")
        for p in files:
            if p != first:
                z.write(p, p.relative_to(root).as_posix())
    print(f"packed {folder}/ into {deck}")


def validate(deck: str) -> int:
    faults = []
    with zipfile.ZipFile(deck) as z:
        names = set(z.namelist())
        if "[Content_Types].xml" not in names:
            print("FAULT: no [Content_Types].xml")
            return 1
        types = ET.fromstring(z.read("[Content_Types].xml"))
        defaults = {d.get("Extension", "").lower() for d in types.iter(CT + "Default")}
        overrides = {o.get("PartName", "").lstrip("/") for o in types.iter(CT + "Override")}
        for name in sorted(names):
            if name.endswith("/"):
                continue
            if name.endswith((".xml", ".rels")):
                try:
                    tree = ET.fromstring(z.read(name))
                except ET.ParseError as exc:
                    faults.append(f"{name}: XML does not parse ({exc})")
                    continue
                if name.endswith(".rels"):
                    base = posixpath.dirname(posixpath.dirname(name))  # ppt/slides/_rels/x.rels -> ppt/slides
                    for rel in tree.iter(REL + "Relationship"):
                        if rel.get("TargetMode") == "External":
                            continue
                        target = rel.get("Target", "")
                        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
                        if path not in names:
                            faults.append(f"{name}: {rel.get('Id')} points at {path}, which is missing")
            if name != "[Content_Types].xml" and name not in overrides and name.rsplit(".", 1)[-1].lower() not in defaults:
                faults.append(f"{name}: no content type")
    try:
        from pptx import Presentation
        slides = len(Presentation(deck).slides)
    except Exception as exc:  # noqa: BLE001
        faults.append(f"python-pptx cannot open it: {exc}")
        slides = None
    for f in faults:
        print("FAULT:", f)
    print(f"{deck}: {'valid' if not faults else f'{len(faults)} faults'}" + (f", {slides} slides" if slides is not None else ""))
    return 1 if faults else 0


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "unpack":
        unpack(args[1], args[2])
    elif len(args) == 3 and args[0] == "show":
        show(args[1], args[2])
    elif len(args) == 3 and args[0] == "pack":
        pack(args[1], args[2])
    elif len(args) == 2 and args[0] == "validate":
        sys.exit(validate(args[1]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
