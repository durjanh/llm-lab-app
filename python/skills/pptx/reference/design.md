# Design: layout, type, colour, and matching a screenshot

Part of the pptx skill. Read it before you design slides from scratch or match a picture.

## Layout

- A 16:9 slide is 13.333 x 7.5 inches. Margins of at least 0.5 inch; 0.6 to 0.8 looks calmer.
- Line elements up on a few shared left edges and tops, and keep the gaps between them equal.
- One idea per slide. At most six bullets, each one line. Shorten the words, or split the slide, rather than shrink text or let it overflow.
- Use the space: a slide whose content fills only the top half looks unfinished. Spread rows evenly down a panel.
- Common arrangements: a title band, then two columns (text left, chart or picture right); a row of three or four KPI cards over one chart; a full-width table with a one-line takeaway above it.

## Type

- Titles 28 to 40 pt, bold. Subtitles 16 to 20 pt. Body 16 to 24 pt. Nothing under 12 pt, chart labels included.
- At most two fonts: the template's, or one sans serif such as Calibri, Arial or Helvetica.
- Left-align body text. Centre only titles on title slides and the numbers on KPI cards if the design centres them.

## Colour

- With a template, its theme colours (`theme.py`). Without one, a dark or light base, one accent for what matters, and greys for the rest. For example: navy `0B1F3A` with teal `2EC4B6`; white with blue `1F6FEB` and grey `6B7280`; charcoal `1F2937` with amber `F59E0B`.
- Contrast high enough to read: dark text on light, light text on dark. Muted text (`9FB3C8` on navy, `6B7280` on white) only for labels.
- Colour has a meaning: the same colour for the same thing on every slide.

## python-pptx defaults to override

- Shapes get the theme's shadow: `shape.shadow.inherit = False` for a flat look.
- A rounded rectangle's corners scale with its size: `shape.adjustments[0] = 0.06` (0 square, 0.5 a pill), so big and small boxes match.
- Shapes have an outline: `shape.line.fill.background()` removes it.
- Text boxes have insets and can autofit: set `text_frame.margin_left` and the others, `text_frame.word_wrap = True`, and size the box to its text.
- Alignment is per paragraph: `paragraph.alignment = PP_ALIGN.LEFT`; vertical alignment is `text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE`.
- A background colour: `slide.background.fill.solid(); slide.background.fill.fore_color.rgb = RGBColor.from_string("0B1F3A")`.

## Matching a screenshot

When the user attaches a picture of a slide and asks for one like it, you are shown the picture. Rebuild the look with real shapes, text and a native chart, using the user's data, not the picture's.

1. Before writing code, describe the picture to yourself: the background; the title's position, size and weight; every card, box and line with its position and size as fractions of the slide's width and height; the colours as hex values; the alignment of text inside each card; and the chart's type, colours, gridlines, legend, value labels and axis.
2. Turn the fractions into inches on a 13.333 x 7.5 inch slide (or the template's size), and write them down in your script as named values, so a fix is a change to one number.
3. Build cards as `MSO_SHAPE.ROUNDED_RECTANGLE` with a fill, no line, no shadow and small corners, and text boxes on top. A KPI card is a large number over a small label, aligned as in the picture.
4. Build the chart as charts.md describes, matching its type, bar width (`gap_width`), colours, gridlines and labels.
5. When the rendered slide comes back next to the picture, compare them part by part, in the order above, and fix what differs: positions, sizes, alignment, colours, then the chart.
