---
name: pptx
description: Makes and edits PowerPoint decks (.pptx) with python-pptx - new decks in a professional house style by default, decks built from a company template or brand, changes to a deck someone gave you, slides matched to a screenshot, and native charts - and renders the slides to PNG to check them. Use whenever a task asks for a presentation, slides or a deck.
---

# PowerPoint decks

Write Python with python-pptx in a script in `work/`, run it, and keep it: on a follow-up, change the script and run it again rather than starting over. Save each version under a new name (`deck-v2.pptx`).

## Whose style: decide this first

Every deck must look professionally designed. Choose the style in this order:

1. **The person's template.** A `.pptx` or `.potx` in `inputs/`, or one they point to: build from it (`reference/editing.md`) and use its theme (`theme.py`).
2. **The person's brand.** Colours, fonts or a style guide they give in the message, in an uploaded file, or through a connected MCP server that offers brand guidelines or templates: follow it. With only a brand colour, use the house style with `Deck(accent="#hex")`.
3. **Otherwise, the house style** in `scripts/house.py`. Do not hand-place plain text boxes on white slides.

If the deck is clearly for a named organisation and you have none of its brand, say you have used the house style and that a template or brand colours would let you match theirs. Do not stop to ask unless the person asked you to check first.

## The house style (`scripts/house.py`)

```python
import sys; sys.path.insert(0, "skills/pptx/scripts")
from house import Deck
deck = Deck(theme="slate", footer="Sales review · April 2026")   # "slate" (light, default) or "midnight" (dark)
deck.title("Sales review", "January to April 2026", "Prepared 25 November 2026")
deck.kpis("Revenue grew by a third, led by North",
          [("£71.3k", "Revenue, Jan–Apr", "+33.5%", True), ("981", "Orders", "+32%", True)],
          kicker="Where we are", source="inputs/orders.csv")
deck.chart_with_points("North pulled ahead from February", ["Jan", "Feb", "Mar", "Apr"],
                       {"North": [8400, 9300, 10800, 11900], "South": [7100, 7600, 7400, 8800]},
                       ["North grew every month", "South dipped in March"], number_format="£#,##0",
                       source="inputs/orders.csv")
deck.closing("Three decisions for this month", ["...", "...", "..."])
deck.save("work/sales-review.pptx")
```

Slide types: `title`, `agenda`, `section`, `bullets` (up to six), `kpis` (two to four cards), `chart` (native: column, bar, stacked, stacked100, line, area, pie, doughnut), `chart_with_points`, `table` (up to twelve rows), `two_column`, `big_number`, `closing`. Every content slide takes `kicker`, `source` and `notes` (speaker notes). Each returns the slide, and `deck.text(...)` and `deck.rect(...)` add anything extra in the same style. `python skills/pptx/scripts/house.py` builds a demonstration of every type in `work/house-demo.pptx`.

## A professional deck

- **A storyline, not a list of facts.** Title slide; the answer or summary first (KPI cards or a big number); then the evidence, one point per slide; then what to do next (`closing`). Add `agenda` and `section` slides for decks over about eight slides.
- **Action titles.** Each headline states the point ("North pulled ahead from February"), not the topic ("Revenue by region"). The kicker above it names the topic.
- **No thin slides.** Never a slide with one sentence on white. A single finding becomes a `big_number`, a `kpis` card row, a chart with its takeaway, or joins related points on a `bullets` slide.
- **Charts are native and editable**, styled by the house style; label values when there are few, give number formats (`£#,##0`, `0%`, `#,##0.0`), cite the source in the footer.
- **Respect the person's request.** Asked for three slides, make three: title plus two, or three content slides if they asked for content only, and say which.
- Speaker notes for anything that needs more words than the slide should hold.

## Read first, for the task in hand

| Task | Read |
|---|---|
| Changing an attached deck, or building from a template | `skills/pptx/reference/editing.md` |
| Any chart beyond what `house.py` makes | `skills/pptx/reference/charts.md` |
| A custom layout, a brand style, or matching a screenshot | `skills/pptx/reference/design.md` |

Read them with `cat`. Each is short; read every one that applies before you write code.

## Scripts

All in `skills/pptx/scripts/`; run each with no arguments for its usage.

| Script | What it does |
|---|---|
| `house.py` | the house style: `Deck` and its slide types (above) |
| `slide_text.py deck.pptx` | every slide as text: shapes with positions, tables, chart data, notes, and flags for shapes off the slide or overlapping, empty placeholders, default chart titles and axes not starting at zero. `--layouts` lists a template's layouts |
| `theme.py deck.pptx` | the theme's colours and fonts, for charts and shapes in a template's style |
| `edit_text.py deck.pptx edits.json out.pptx` | changes text without losing its formatting, across runs, in shapes, tables and groups; sets speaker notes |
| `slides.py deck.pptx out.pptx delete/move/duplicate/keep ...` | deletes, moves, duplicates and reorders slides |
| `ooxml.py unpack/show/pack/validate` | the deck's raw XML, for what python-pptx cannot reach; `validate` checks the package |
| `render.sh deck.pptx [first last]` | copies the deck into `outputs/`, and renders its slides as PNGs into `work/render/` for the visual check |

## A new deck without the house style (a template or a brand)

```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation("inputs/template.pptx")                        # see editing.md; Presentation() only with a brand
slide = prs.slides.add_slide(prs.slide_layouts[1])                # the template's own layouts first
prs.save("work/deck.pptx")
```

Tables: `slide.shapes.add_table(rows, cols, left, top, width, height).table`, then `table.cell(r, c).text`. Pictures: `slide.shapes.add_picture(path, left, top, width=...)`.

## Before you deliver

1. `python skills/pptx/scripts/slide_text.py work/deck-v2.pptx`, and fix everything it flags, or say why a flag is intended.
2. `python skills/pptx/scripts/ooxml.py validate work/deck-v2.pptx`.
3. `bash skills/pptx/scripts/render.sh work/deck-v2.pptx` (or `... 4 4` for only slide 4 after changing only it). It copies the deck into `outputs/`, so the person gets it, and writes `work/render/deck-v2-slide-01.png` and so on for the visual check. Look at every slide: text inside its box, nothing overlapping, nothing cut off, and no slide that looks empty. Fix and render again until it is right. The PNGs are checks, never deliverables: leave them in `work/`.
