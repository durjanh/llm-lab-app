---
name: pptx
description: Makes and edits PowerPoint decks (.pptx) with python-pptx - new decks, decks built from a company template, changes to a deck someone gave you, slides matched to a screenshot, and native charts - and renders the slides to PNG to check them. Use whenever a task asks for a presentation, slides or a deck.
---

# PowerPoint decks

Write Python with python-pptx in a script in `work/`, run it, and keep it: on a follow-up, change the script and run it again rather than starting over. Save each version under a new name (`deck-v2.pptx`).

## Read first, for the task in hand

| Task | Read |
|---|---|
| Changing an attached deck, or building from a template | `skills/pptx/reference/editing.md` |
| Any chart | `skills/pptx/reference/charts.md` |
| Designing slides, or matching a screenshot | `skills/pptx/reference/design.md` |

Read them with `cat`. Each is short; read every one that applies before you write code.

## Scripts

All in `skills/pptx/scripts/`; run each with no arguments for its usage.

| Script | What it does |
|---|---|
| `slide_text.py deck.pptx` | every slide as text: shapes with positions, tables, chart data, notes, and flags for shapes off the slide or overlapping, empty placeholders, default chart titles and axes not starting at zero. `--layouts` lists a template's layouts |
| `theme.py deck.pptx` | the theme's colours and fonts, for charts and shapes in a template's style |
| `edit_text.py deck.pptx edits.json out.pptx` | changes text without losing its formatting, across runs, in shapes, tables and groups; sets speaker notes |
| `slides.py deck.pptx out.pptx delete/move/duplicate/keep ...` | deletes, moves, duplicates and reorders slides |
| `ooxml.py unpack/show/pack/validate` | the deck's raw XML, for what python-pptx cannot reach; `validate` checks the package |
| `render.sh deck.pptx [first last]` | the deck into `outputs/`, and its slides as PNGs for the visual check |

## A new deck

```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()                                              # or Presentation("inputs/template.pptx"): see editing.md
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9
slide = prs.slides.add_slide(prs.slide_layouts[6])                # 6 is blank; 0 title, 1 title and content
box = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12.1), Inches(1.0))
box.text_frame.word_wrap = True
p = box.text_frame.paragraphs[0]; p.text = "Title"; p.font.size = Pt(36); p.font.bold = True
prs.save("work/deck.pptx")
```

Tables: `slide.shapes.add_table(rows, cols, left, top, width, height).table`, then `table.cell(r, c).text`. Pictures: `slide.shapes.add_picture(path, left, top, width=...)`.

## Before you deliver

1. `python skills/pptx/scripts/slide_text.py work/deck-v2.pptx`, and fix everything it flags, or say why a flag is intended.
2. `python skills/pptx/scripts/ooxml.py validate work/deck-v2.pptx`.
3. `bash skills/pptx/scripts/render.sh work/deck-v2.pptx` (or `... 4 4` for only slide 4 after changing only it). It copies the deck into `outputs/`, so the user gets it, and writes `outputs/deck-v2-slide-01.png` and so on for the visual check.
