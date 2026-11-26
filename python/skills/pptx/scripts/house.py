"""The house style: a professional default for new decks when the person gives no template or brand. Part of the
pptx skill.

Every slide shares one grid, one type scale and one palette, so a deck looks designed without design work: a title
slide, an agenda, section dividers, bullet slides, KPI cards, native charts styled to match, a chart beside its
takeaways, tables, two columns, a big number and a closing slide. Content slides carry an action title (the
headline states the point, not the topic), a small kicker above it, the source and a page number in the footer, and
speaker notes when given.

    import sys; sys.path.insert(0, "skills/pptx/scripts")
    from house import Deck
    deck = Deck(theme="slate", footer="Sales review · April 2026")
    deck.title("Sales review", "January to April 2026", "Prepared 25 November 2026")
    deck.kpis("North drove two thirds of the growth", [("£71.3k", "Revenue, Jan–Apr", "+33.5%", True), ...])
    deck.chart("North pulled ahead from February", ["Jan", "Feb"], {"North": [8400, 9300], "South": [7100, 7600]},
               number_format="£#,##0", source="inputs/orders.csv")
    deck.save("work/sales-review.pptx")

Run it with no arguments to build a demonstration deck in work/house-demo.pptx.
"""
from __future__ import annotations

import sys
from collections.abc import Sequence

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION, XL_MARKER_STYLE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

# Two palettes. "slate" (light) suits most decks and prints well; "midnight" (dark) suits a screen in a dim room.
THEMES = {
    "slate": {
        "bg": "FFFFFF", "ink": "111827", "body": "374151", "muted": "6B7280", "line": "E5E7EB", "panel": "F3F4F6",
        "accent": "1D4ED8", "accent_soft": "DBEAFE", "good": "047857", "bad": "B91C1C", "cover": "0F172A",
        "cover_ink": "FFFFFF", "cover_muted": "94A3B8",
        "series": ["1D4ED8", "0D9488", "F59E0B", "7C3AED", "DB2777", "64748B"],
    },
    "midnight": {
        "bg": "0F172A", "ink": "F8FAFC", "body": "CBD5E1", "muted": "94A3B8", "line": "1E293B", "panel": "1E293B",
        "accent": "38BDF8", "accent_soft": "0C4A6E", "good": "34D399", "bad": "F87171", "cover": "020617",
        "cover_ink": "FFFFFF", "cover_muted": "94A3B8",
        "series": ["38BDF8", "2DD4BF", "FBBF24", "A78BFA", "F472B6", "94A3B8"],
    },
}
FONT = "Calibri"  # LibreOffice renders it with Carlito, which has the same widths, so layouts match PowerPoint

W, H = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.75)
CONTENT_W = W - 2 * MARGIN
TOP = Inches(1.95)  # where content starts under the kicker and headline
BOTTOM = Inches(6.75)  # where content ends above the footer
CHART_KINDS = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED, "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "stacked": XL_CHART_TYPE.COLUMN_STACKED, "stacked100": XL_CHART_TYPE.COLUMN_STACKED_100,
    "line": XL_CHART_TYPE.LINE_MARKERS, "area": XL_CHART_TYPE.AREA, "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}


def rgb(hex_: str) -> RGBColor:
    return RGBColor.from_string(hex_)


class Deck:
    """A new 16:9 deck in the house style. Each method adds one slide and returns it for any extra touches."""

    def __init__(self, theme: str = "slate", footer: str = "", accent: str | None = None):
        if theme not in THEMES:
            raise ValueError(f"theme must be one of {sorted(THEMES)}")
        self.t = dict(THEMES[theme])
        if accent:  # one brand colour, if the person named one: it becomes the accent and the first series
            self.t["accent"] = accent.lstrip("#").upper()
            self.t["series"] = [self.t["accent"], *self.t["series"][1:]]
        self.footer = footer
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = W, H
        self.page = 0

    # ---------- building blocks ----------
    def _blank(self, bg: str | None = None):
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = rgb(bg or self.t["bg"])
        return slide

    def text(self, slide, x, y, w, h, text: str | Sequence[str], size=18, bold=False, color=None, align="left",
             anchor="top", spacing=1.1, after=6, bullet=False):
        """A text box with no insets, wrapping on; a list of strings becomes one paragraph each."""
        box = slide.shapes.add_textbox(x, y, w, h)
        tf = box.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}[anchor]
        lines = [text] if isinstance(text, str) else list(text)
        for i, line in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            run = p.add_run()
            run.text = ("•  " if bullet else "") + line
            f = run.font
            f.name, f.size, f.bold = FONT, Pt(size), bold
            f.color.rgb = rgb(color or self.t["body"])
            p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}[align]
            p.line_spacing = spacing
            p.space_after = Pt(after)
        return box

    def rect(self, slide, x, y, w, h, fill: str, rounded=False, radius=0.06):
        shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE, x, y, w, h)
        shape.fill.solid()
        shape.fill.fore_color.rgb = rgb(fill)
        shape.line.fill.background()
        shape.shadow.inherit = False
        if rounded:
            shape.adjustments[0] = radius
        return shape

    def _frame(self, headline: str, kicker: str = "", source: str = "", notes: str = ""):
        """A content slide's frame: accent rule, kicker, action-title headline, footer with source and page."""
        self.page += 1
        s = self._blank()
        self.rect(s, MARGIN, Inches(0.55), Inches(0.6), Emu(Pt(4)), self.t["accent"])
        if kicker:
            self.text(s, MARGIN, Inches(0.7), CONTENT_W, Inches(0.35), kicker.upper(), size=12, bold=True,
                      color=self.t["accent"])
        self.text(s, MARGIN, Inches(1.0), CONTENT_W, Inches(0.85), headline, size=28, bold=True,
                  color=self.t["ink"], spacing=1.0, anchor="top")
        self.rect(s, MARGIN, Inches(6.95), CONTENT_W, Emu(Pt(0.75)), self.t["line"])
        left = "  ·  ".join(x for x in (self.footer, f"Source: {source}" if source else "") if x)
        if left:
            self.text(s, MARGIN, Inches(7.05), CONTENT_W - Inches(1), Inches(0.3), left, size=10,
                      color=self.t["muted"])
        self.text(s, W - MARGIN - Inches(1), Inches(7.05), Inches(1), Inches(0.3), str(self.page + 1), size=10,
                  color=self.t["muted"], align="right")
        if notes:
            s.notes_slide.notes_text_frame.text = notes
        return s

    # ---------- slide types ----------
    def title(self, title: str, subtitle: str = "", meta: str = "", notes: str = ""):
        """The cover: dark panel, large title, subtitle and a line such as the date or the author."""
        s = self._blank(self.t["cover"])
        self.rect(s, MARGIN, Inches(2.35), Inches(0.9), Emu(Pt(5)), self.t["accent"])
        self.text(s, MARGIN, Inches(2.6), Inches(10.5), Inches(1.9), title, size=44, bold=True,
                  color=self.t["cover_ink"], spacing=1.0, anchor="bottom")
        if subtitle:
            self.text(s, MARGIN, Inches(4.65), Inches(10.5), Inches(0.9), subtitle, size=22,
                      color=self.t["cover_muted"])
        if meta:
            self.text(s, MARGIN, Inches(6.6), Inches(10), Inches(0.4), meta, size=13, color=self.t["cover_muted"])
        if notes:
            s.notes_slide.notes_text_frame.text = notes
        return s

    def section(self, title: str, number: str = "", notes: str = ""):
        """A divider between parts of a longer deck."""
        s = self._blank(self.t["accent"])
        if number:
            self.text(s, MARGIN, Inches(2.3), Inches(3), Inches(0.9), number, size=40, bold=True,
                      color=self.t["accent_soft"])
        self.text(s, MARGIN, Inches(3.2), Inches(11), Inches(1.5), title, size=40, bold=True, color="FFFFFF",
                  spacing=1.0)
        if notes:
            s.notes_slide.notes_text_frame.text = notes
        return s

    def agenda(self, items: Sequence[str], headline: str = "Agenda", notes: str = ""):
        s = self._frame(headline, notes=notes)
        row = min(Inches(0.85), int((BOTTOM - TOP) / max(1, len(items))))
        for i, item in enumerate(items):
            y = TOP + i * row
            self.text(s, MARGIN, y, Inches(0.8), row, f"{i + 1:02d}", size=22, bold=True, color=self.t["accent"])
            self.text(s, MARGIN + Inches(0.9), y + Inches(0.04), CONTENT_W - Inches(0.9), row, item, size=22,
                      color=self.t["ink"])
            self.rect(s, MARGIN + Inches(0.9), y + row - Inches(0.12), CONTENT_W - Inches(0.9), Emu(Pt(0.75)),
                      self.t["line"])
        return s

    def bullets(self, headline: str, points: Sequence[str], kicker: str = "", source: str = "", notes: str = ""):
        """Up to six short points under an action title, on a light panel so the slide never looks empty."""
        s = self._frame(headline, kicker, source, notes)
        points = list(points)[:6]
        self.rect(s, MARGIN, TOP, CONTENT_W, BOTTOM - TOP, self.t["panel"], rounded=True, radius=0.03)
        row = int((BOTTOM - TOP - Inches(0.6)) / max(1, len(points)))
        for i, point in enumerate(points):
            y = TOP + Inches(0.3) + i * row
            self.rect(s, MARGIN + Inches(0.4), y + Inches(0.12), Inches(0.12), Inches(0.12), self.t["accent"],
                      rounded=True, radius=0.5)
            self.text(s, MARGIN + Inches(0.75), y, CONTENT_W - Inches(1.2), row, point, size=20,
                      color=self.t["ink"])
        return s

    def kpis(self, headline: str, cards: Sequence[tuple], kicker: str = "", source: str = "", notes: str = "",
             caption: str = ""):
        """Two to four KPI cards: (value, label) or (value, label, change, good) where good colours the change."""
        s = self._frame(headline, kicker, source, notes)
        cards = list(cards)[:4]
        gap = Inches(0.3)
        cw = int((CONTENT_W - gap * (len(cards) - 1)) / max(1, len(cards)))
        ch = Inches(2.6)
        for i, card in enumerate(cards):
            value, label = card[0], card[1]
            change, good = (card[2], card[3] if len(card) > 3 else True) if len(card) > 2 else ("", True)
            x = MARGIN + i * (cw + gap)
            self.rect(s, x, TOP + Inches(0.2), cw, ch, self.t["panel"], rounded=True, radius=0.05)
            self.rect(s, x, TOP + Inches(0.2), Inches(0.08), ch, self.t["series"][i % len(self.t["series"])])
            self.text(s, x + Inches(0.35), TOP + Inches(0.5), cw - Inches(0.6), Inches(1.0), value, size=40,
                      bold=True, color=self.t["ink"])
            self.text(s, x + Inches(0.35), TOP + Inches(1.5), cw - Inches(0.6), Inches(0.7), label, size=15,
                      color=self.t["muted"])
            if change:
                self.text(s, x + Inches(0.35), TOP + Inches(2.15), cw - Inches(0.6), Inches(0.4), change, size=15,
                          bold=True, color=self.t["good" if good else "bad"])
        if caption:
            self.text(s, MARGIN, TOP + ch + Inches(0.6), CONTENT_W, Inches(1.2), caption, size=18,
                      color=self.t["body"])
        return s

    def _chart(self, slide, x, y, w, h, categories, series: dict, kind="column", number_format="General",
               labels=True):
        data = CategoryChartData()
        data.categories = list(categories)
        for name, values in series.items():
            data.add_series(name, list(values))
        chart = slide.shapes.add_chart(CHART_KINDS[kind], x, y, w, h, data).chart
        chart.has_title = False
        chart.font.name, chart.font.size = FONT, Pt(12)
        chart.font.color.rgb = rgb(self.t["body"])
        pie = kind in ("pie", "doughnut")
        chart.has_legend = pie or len(series) > 1
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.RIGHT if pie else XL_LEGEND_POSITION.TOP
            chart.legend.include_in_layout = False
            chart.legend.font.size = Pt(12)
        plot = chart.plots[0]
        colours = self.t["series"]
        if pie:
            for j, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = rgb(colours[j % len(colours)])
        else:
            for i, s in enumerate(plot.series):
                c = rgb(colours[i % len(colours)])
                if kind == "line":
                    s.format.line.color.rgb = c
                    s.format.line.width = Pt(2.75)
                    s.smooth = False
                    s.marker.style = XL_MARKER_STYLE.CIRCLE
                    s.marker.size = 7
                    s.marker.format.fill.solid()
                    s.marker.format.fill.fore_color.rgb = c
                    s.marker.format.line.fill.background()
                else:
                    s.format.fill.solid()
                    s.format.fill.fore_color.rgb = c
                    s.format.line.fill.background()
            if kind in ("column", "bar", "stacked", "stacked100"):
                plot.gap_width = 70
                if kind in ("column", "bar"):
                    plot.overlap = -5
            va, ca = chart.value_axis, chart.category_axis
            va.has_major_gridlines = True
            va.major_gridlines.format.line.color.rgb = rgb(self.t["line"])
            va.major_gridlines.format.line.width = Pt(0.75)
            va.format.line.fill.background()
            va.tick_labels.font.size = Pt(11)
            va.tick_labels.font.color.rgb = rgb(self.t["muted"])
            va.tick_labels.number_format = number_format
            va.tick_labels.number_format_is_linked = False
            ca.format.line.color.rgb = rgb(self.t["line"])
            ca.tick_labels.font.size = Pt(12)
            ca.has_major_gridlines = False
        if labels and (pie or len(categories) * len(series) <= 16):
            plot.has_data_labels = True
            dl = plot.data_labels
            dl.font.size = Pt(11)
            dl.font.color.rgb = rgb("FFFFFF" if pie or kind.startswith("stacked") else self.t["body"])
            dl.number_format = number_format
            dl.number_format_is_linked = False
            if kind in ("column", "bar"):
                dl.position = XL_LABEL_POSITION.OUTSIDE_END
            elif kind == "line":
                dl.position = XL_LABEL_POSITION.ABOVE
        return chart

    def chart(self, headline: str, categories: Sequence, series: dict, kind: str = "column",
              number_format: str = "#,##0", kicker: str = "", source: str = "", notes: str = "",
              takeaway: str = ""):
        """A native, editable chart across the slide, with an optional one-line takeaway beneath it."""
        s = self._frame(headline, kicker, source, notes)
        h = BOTTOM - TOP - (Inches(0.7) if takeaway else 0)
        self._chart(s, MARGIN, TOP, CONTENT_W, h, categories, series, kind, number_format)
        if takeaway:
            self.text(s, MARGIN, BOTTOM - Inches(0.55), CONTENT_W, Inches(0.55), takeaway, size=16,
                      color=self.t["body"])
        return s

    def chart_with_points(self, headline: str, categories: Sequence, series: dict, points: Sequence[str],
                          kind: str = "column", number_format: str = "#,##0", kicker: str = "", source: str = "",
                          notes: str = ""):
        """The chart on the left, two to four takeaways on a panel to its right."""
        s = self._frame(headline, kicker, source, notes)
        cw = int(CONTENT_W * 0.62)
        self._chart(s, MARGIN, TOP, cw, BOTTOM - TOP, categories, series, kind, number_format)
        px = MARGIN + cw + Inches(0.35)
        pw = CONTENT_W - cw - Inches(0.35)
        self.rect(s, px, TOP, pw, BOTTOM - TOP, self.t["panel"], rounded=True, radius=0.04)
        points = list(points)[:4]
        row = int((BOTTOM - TOP - Inches(0.5)) / max(1, len(points)))
        for i, p in enumerate(points):
            y = TOP + Inches(0.3) + i * row
            self.text(s, px + Inches(0.3), y, Inches(0.5), Inches(0.5), f"{i + 1}", size=20, bold=True,
                      color=self.t["accent"])
            self.text(s, px + Inches(0.75), y + Inches(0.03), pw - Inches(1.0), row - Inches(0.1), p, size=16,
                      color=self.t["ink"])
        return s

    def table(self, headline: str, header: Sequence[str], rows: Sequence[Sequence], kicker: str = "",
              source: str = "", notes: str = "", align_numbers: bool = True):
        """A clean table: a dark header row, light banding, numbers aligned right."""
        s = self._frame(headline, kicker, source, notes)
        rows = [list(map(str, r)) for r in rows][:12]
        n = len(rows) + 1
        rh = min(Inches(0.5), int((BOTTOM - TOP) / n))
        shape = s.shapes.add_table(n, len(header), MARGIN, TOP, CONTENT_W, rh * n)
        tbl = shape.table
        for r in range(n):
            tbl.rows[r].height = rh
            for c in range(len(header)):
                cell = tbl.cell(r, c)
                value = header[c] if r == 0 else rows[r - 1][c]
                cell.text = value
                cell.margin_left = cell.margin_right = Inches(0.15)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.fill.solid()
                cell.fill.fore_color.rgb = rgb(self.t["cover"] if r == 0 else (self.t["panel"] if r % 2 == 0
                                                                                 else self.t["bg"]))
                p = cell.text_frame.paragraphs[0]
                numeric = r > 0 and align_numbers and value.replace(",", "").replace("£", "").replace("$", "") \
                    .replace("%", "").replace("+", "").replace("-", "").replace(".", "").strip().isdigit()
                p.alignment = PP_ALIGN.RIGHT if numeric or (r == 0 and c > 0 and align_numbers) else PP_ALIGN.LEFT
                for run in p.runs:
                    run.font.name, run.font.size = FONT, Pt(14)
                    run.font.bold = r == 0
                    run.font.color.rgb = rgb("FFFFFF" if r == 0 else self.t["ink"])
        return s

    def two_column(self, headline: str, left_title: str, left_points: Sequence[str], right_title: str,
                   right_points: Sequence[str], kicker: str = "", source: str = "", notes: str = ""):
        """Two panels side by side: before and after, options, risks and mitigations."""
        s = self._frame(headline, kicker, source, notes)
        gap = Inches(0.35)
        cw = int((CONTENT_W - gap) / 2)
        for i, (title, points) in enumerate(((left_title, left_points), (right_title, right_points))):
            x = MARGIN + i * (cw + gap)
            self.rect(s, x, TOP, cw, BOTTOM - TOP, self.t["panel"], rounded=True, radius=0.04)
            self.text(s, x + Inches(0.35), TOP + Inches(0.3), cw - Inches(0.7), Inches(0.5), title, size=20,
                      bold=True, color=self.t["series"][i])
            self.text(s, x + Inches(0.35), TOP + Inches(1.0), cw - Inches(0.7), BOTTOM - TOP - Inches(1.2),
                      list(points)[:5], size=17, color=self.t["ink"], bullet=True, after=10)
        return s

    def big_number(self, headline: str, number: str, caption: str, kicker: str = "", source: str = "",
                   notes: str = ""):
        """One figure that carries the message, very large, with a line that explains it."""
        s = self._frame(headline, kicker, source, notes)
        self.text(s, MARGIN, TOP + Inches(0.5), CONTENT_W, Inches(2.2), number, size=110, bold=True,
                  color=self.t["accent"], spacing=0.9)
        self.text(s, MARGIN, TOP + Inches(2.9), Inches(9), Inches(1.5), caption, size=22, color=self.t["body"])
        return s

    def closing(self, headline: str, steps: Sequence[str], kicker: str = "Next steps", notes: str = ""):
        """The last slide: numbered next steps or decisions needed."""
        s = self._frame(headline, kicker, notes=notes)
        steps = list(steps)[:5]
        row = int((BOTTOM - TOP) / max(1, len(steps)))
        for i, step in enumerate(steps):
            y = TOP + i * row
            self.rect(s, MARGIN, y + Inches(0.05), Inches(0.55), Inches(0.55), self.t["accent"], rounded=True,
                      radius=0.5)
            self.text(s, MARGIN, y + Inches(0.05), Inches(0.55), Inches(0.55), str(i + 1), size=18, bold=True,
                      color="FFFFFF", align="center", anchor="middle")
            self.text(s, MARGIN + Inches(0.85), y + Inches(0.1), CONTENT_W - Inches(0.85), row, step, size=20,
                      color=self.t["ink"])
        return s

    def save(self, path: str) -> str:
        self.prs.save(path)
        return path


def demo(path: str = "work/house-demo.pptx", theme: str = "slate") -> str:
    """Every slide type once, on invented figures, to see the style."""
    d = Deck(theme=theme, footer="Invented data · house style demo")
    months = ["Jan", "Feb", "Mar", "Apr"]
    d.title("Sales review: January to April", "Two regions, four months, one clear trend", "Prepared 25 November 2026")
    d.agenda(["Where we are", "What drove growth", "Region by region", "Next steps"])
    d.kpis("Revenue grew by a third, led by North", [("£71.3k", "Revenue, Jan–Apr", "+33.5% Jan to Apr", True),
                                                     ("981", "Orders", "+32% Jan to Apr", True),
                                                     ("57%", "North's share of revenue", "+3 pts", True)],
           kicker="Where we are", source="inputs/orders.csv")
    d.chart_with_points("North pulled ahead from February", months,
                        {"North": [8400, 9300, 10800, 11900], "South": [7100, 7600, 7400, 8800]},
                        ["North grew every month, by 42% overall", "South dipped in March, then recovered",
                         "The gap widened from £1.3k to £3.1k"], number_format="£#,##0", kicker="What drove growth",
                        source="inputs/orders.csv")
    d.chart("Both regions trend upwards", months, {"North": [120, 134, 151, 163], "South": [95, 101, 99, 118]},
            kind="line", kicker="Orders", source="inputs/orders.csv",
            takeaway="Order counts follow revenue closely, so growth is volume, not price.")
    d.table("North leads on every measure", ["Region", "Orders", "Revenue", "Growth"],
            [["North", "568", "£40,400", "+42%"], ["South", "413", "£30,900", "+24%"]], kicker="Region by region",
            source="inputs/orders.csv")
    d.two_column("South needs a plan for its March dip", "What we saw", ["Orders fell 2% in March",
                 "Revenue fell 3%", "April recovered to a new high"], "What we will try",
                 ["Check stock levels for March", "Compare with last year", "Run a spring promotion test"],
                 kicker="Region by region")
    d.big_number("One number to remember", "+33.5%", "Total revenue growth from January to April, across both "
                 "regions.", kicker="Summary")
    d.closing("Three decisions for this month", ["Keep North's pricing as it is",
              "Fund a South promotion test in May", "Review again with May's figures"])
    return d.save(path)


if __name__ == "__main__":
    print(demo(*(sys.argv[1:3] or [])))
