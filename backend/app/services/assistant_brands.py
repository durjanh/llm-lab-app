"""Brand kits: a person's own deck templates, logos and style notes, so the assistant can make decks and documents in
a company's design instead of the house style.

A kit is a folder under `generated/brands/<id>/` (gitignored, so company templates never reach the repo). It may hold
a PowerPoint template (`.potx` or `.pptx`), a logo (`.png`, `.jpg`, `.svg`), notes (`guidelines.md` or `.txt`) and a
`brand.json` with a display name, colours and fonts. When a chat chooses a kit, its files are copied into the chat's
`inputs/brand/` before each turn and the agent is told to use them; the pptx skill already builds from a template there.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
TEMPLATE_EXTS = (".potx", ".pptx")
LOGO_EXTS = (".png", ".jpg", ".jpeg", ".svg")
NOTE_NAMES = ("guidelines.md", "guidelines.txt", "brand.md")
MAX_KIT_FILE_BYTES = 60 * 2**20  # a template with embedded fonts and images can be large, but not unbounded
MAX_KITS = 30


def _regular(path: Path, folder: Path) -> bool:
    """A real file inside the kit's folder: no links that point elsewhere, nothing too big."""
    try:
        return (path.is_file() and not path.is_symlink() and path.resolve().parent == folder.resolve()
                and path.stat().st_size <= MAX_KIT_FILE_BYTES)
    except OSError:
        return False


class BrandKits:
    """The kits on this machine, read fresh on each call so a template dropped into the folder appears at once."""

    def __init__(self, folder: Path):
        self.folder = folder

    def _kit(self, folder: Path) -> dict[str, Any] | None:
        if not SLUG.match(folder.name) or not folder.is_dir() or folder.is_symlink():
            return None
        files = sorted(p for p in folder.iterdir() if _regular(p, folder))
        template = next((p for p in files if p.suffix.lower() in TEMPLATE_EXTS), None)
        logo = next((p for p in files if p.suffix.lower() in LOGO_EXTS), None)
        notes = next((p for p in files if p.name.lower() in NOTE_NAMES), None)
        info: dict[str, Any] = {}
        brand = folder / "brand.json"
        if _regular(brand, folder):
            try:
                loaded = json.loads(brand.read_text(encoding="utf-8"))
                info = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                info = {}
        if not (template or logo or notes or info):
            return None  # an empty folder is not a kit yet
        name = str(info.get("name") or folder.name.replace("-", " ").replace("_", " ").title())[:60]
        colours = info.get("colours") if isinstance(info.get("colours"), dict) else {}
        fonts = info.get("fonts") if isinstance(info.get("fonts"), dict) else {}
        return {
            "id": folder.name, "name": name,
            "template": template.name if template else None, "logo": logo.name if logo else None,
            "guidelines": notes.name if notes else None, "has_brand_json": bool(info),
            "colours": {str(k)[:30]: str(v)[:20] for k, v in list(colours.items())[:12]},
            "fonts": {str(k)[:30]: str(v)[:60] for k, v in list(fonts.items())[:6]},
            "_files": [p for p in (template, logo, notes, brand if info else None) if p is not None],
        }

    def list(self) -> list[dict[str, Any]]:
        """Every kit, for the page: names and what each holds, never file paths on this machine."""
        if not self.folder.is_dir():
            return []
        kits = [self._kit(p) for p in sorted(self.folder.iterdir())[:MAX_KITS * 3]]
        return [{k: v for k, v in kit.items() if k != "_files"} for kit in kits if kit][:MAX_KITS]

    def get(self, kit_id: str) -> dict[str, Any] | None:
        if not SLUG.match(kit_id or ""):
            return None
        return self._kit(self.folder / kit_id)

    def install(self, kit_id: str, workspace: Path) -> dict[str, Any] | None:
        """Copies the kit into `inputs/brand/` of a chat's workspace, replacing any kit there before. Returns the
        kit (with the copied names) or None when it no longer exists, in which case `inputs/brand/` is cleared."""
        target = workspace / "inputs" / "brand"
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        kit = self.get(kit_id)
        if kit is None:
            return None
        target.mkdir(parents=True, exist_ok=True)
        for path in kit["_files"]:
            shutil.copyfile(path, target / path.name)
        return kit

    @staticmethod
    def note(kit: dict[str, Any]) -> str:
        """What the agent is told, with the person's message, about the chosen kit."""
        parts = [f"Brand for decks and documents in this chat: {kit['name']}. Its files are in inputs/brand/."]
        if kit["template"]:
            parts.append(f"Build every deck from the template inputs/brand/{kit['template']} (its masters, layouts, "
                         "theme colours and fonts), following the pptx skill's editing.md, not the house style.")
        if kit["logo"]:
            parts.append(f"The logo is inputs/brand/{kit['logo']}; use it where the template does not already.")
        if kit["guidelines"]:
            parts.append(f"Read inputs/brand/{kit['guidelines']} first and follow it.")
        if kit["colours"] or kit["fonts"]:
            parts.append("Brand colours and fonts are in inputs/brand/brand.json.")
        return " ".join(parts)
