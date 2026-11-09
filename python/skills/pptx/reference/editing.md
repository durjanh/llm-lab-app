# Changing a deck someone gave you, and using a template

Part of the pptx skill. Read it before you change an attached deck or build from a template.

## A deck to tidy, correct or extend

Change that deck. Do not rebuild it: its masters, pictures, charts and formatting must survive. **Never delete a picture, chart or slide unless the user asks**, and never to clear a flag from `slide_text.py`: a company deck often puts text on photos on purpose. The number of pictures `slide_text.py` reports should be the same before and after your changes.

1. Copy it to `work/` under a short name, and read every slide: `python skills/pptx/scripts/slide_text.py work/deck.pptx`. It lists each shape by name with its position, text, tables, chart data and notes, and flags what tends to look wrong.
2. Render it once (`bash skills/pptx/scripts/render.sh work/deck.pptx`) so the first visual check shows the deck as it was given.
3. Change only what needs changing, with the scripts below where they fit, and save each round as a new version (`deck-v2.pptx`).
4. Text inside a picture cannot be edited. Say which slides have it and what is wrong there.
5. Check that numbers in the text match the chart data on the same slide. Ask about anything you cannot decide (names, dates, terms) instead of guessing, and list those questions in your reply.

### Text, without losing its formatting

Setting `text_frame.text` throws fonts, sizes and colours away, and a phrase is often split across several runs. Use `edit_text.py` with a list of changes:

```bash
cat > work/edits.json <<'EOF'
[{"slide": 1, "find": "August 26", "replace": "August 2026"},
 {"slide": 4, "shape": "Title 1", "paragraphs": ["Operational summary"]},
 {"slide": 7, "notes": "Reviewer asked: can we add month-on-month trends?"}]
EOF
python skills/pptx/scripts/edit_text.py work/deck.pptx work/edits.json work/deck-v2.pptx
```

It reports each change, and exits with 1 listing any that matched nothing.

### Slides: delete, move, duplicate, reorder

```bash
python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx delete 5 7
python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx move 6 2
python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx duplicate 3
python skills/pptx/scripts/slides.py work/deck.pptx work/deck-v2.pptx keep 1 4 2 3
```

### Shapes, in a script of your own

```python
from pptx import Presentation
from pptx.util import Inches
prs = Presentation("work/deck-v2.pptx")
slide = prs.slides[3]
shape = next(s for s in slide.shapes if s.name == "TextBox 34")
shape.left, shape.top = Inches(0.6), Inches(1.2)         # move
shape.width = Inches(5.5)                                 # resize
shape._element.getparent().remove(shape._element)        # delete a stray shape
prs.save("work/deck-v3.pptx")
```

### Colours and settings python-pptx cannot reach

Some things live only in the XML, such as the theme's hyperlink colour. Unpack the deck, change the part, pack it again and validate it:

```bash
python skills/pptx/scripts/ooxml.py unpack work/deck-v3.pptx work/x
python skills/pptx/scripts/ooxml.py show work/deck-v3.pptx ppt/theme/theme1.xml | grep -A2 hlink
sed -i 's#<a:hlink><a:srgbClr val="0000FF"/>#<a:hlink><a:srgbClr val="9CC3FF"/>#' work/x/ppt/theme/theme1.xml
python skills/pptx/scripts/ooxml.py pack work/x work/deck-v4.pptx
python skills/pptx/scripts/ooxml.py validate work/deck-v4.pptx
```

Edit the unpacked files, never the laid-out text `show` prints: whitespace inside a text element is part of the text.

## A template

A template is the company's own design. When one is attached, always start from it, never from `Presentation()`, so every slide keeps the company's masters, logo, theme colours and fonts.

1. Read its layouts and placeholders: `python skills/pptx/scripts/slide_text.py inputs/template.pptx --layouts`.
2. Read its colours and fonts: `python skills/pptx/scripts/theme.py inputs/template.pptx`. Use the accents for charts and shapes, and its fonts, rather than your own.
3. Open it, add each slide with the layout that fits (found by `layout.name`), and fill its placeholders (`slide.placeholders[idx]`) rather than adding loose text boxes.
4. Remove its example slides unless the user wants them: `slides.py ... keep` with the numbers of your new slides, after you have added them.
5. With a template and a screenshot together, the screenshot gives the arrangement and the chart type; the template gives the colours, fonts and logo.

Before you deliver any deck, run `python skills/pptx/scripts/ooxml.py validate` on it.
