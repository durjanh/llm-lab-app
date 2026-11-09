# Charts

Part of the pptx skill. Read it before you make or change a chart.

## Which chart

Make any chart the user asks for, if it suits the data. python-pptx makes these as native charts, which stay editable in PowerPoint (`from pptx.enum.chart import XL_CHART_TYPE`):

| Type | Use it for | Data |
|---|---|---|
| `COLUMN_CLUSTERED`, `BAR_CLUSTERED` | comparing values across a few categories; bars when the labels are long | `CategoryChartData` |
| `COLUMN_STACKED`, `BAR_STACKED`, `COLUMN_STACKED_100` | parts of each total, or their shares | `CategoryChartData`, one series per part |
| `LINE_MARKERS`, `LINE` | change over time, in order | `CategoryChartData` |
| `AREA`, `AREA_STACKED` | totals over time and what they are made of | `CategoryChartData` |
| `PIE`, `DOUGHNUT` | parts of one whole: shares that add up to 100%, at most six slices | `CategoryChartData`, one series |
| `XY_SCATTER` | how two measures relate | `XyChartData` |
| `BUBBLE` | three measures at once | `BubbleChartData` |
| `RADAR` | several measures for a few items, on the same scale | `CategoryChartData` |

Not native in python-pptx:
- **Waterfall:** a stacked column whose lower series is the running total with no fill (`series.format.fill.background()`), and whose upper series is the change.
- **Bar and line together:** a column chart and a line chart in the same place with matching axes, the line chart's plot area and background transparent; or a matplotlib picture.
- **Funnel, treemap, gauge:** shapes (a funnel is stacked, narrowing rectangles), or a matplotlib picture.

A picture cannot be edited in PowerPoint: say so when you use one.

**When the type asked for does not suit the data, do not build it.** Say in a sentence why (a pie of values that are not parts of one whole, a line through categories that have no order, a pie with twelve slices, a scatter with only one measure). Suggest two or three types that suit the data, each with a line on what it would show, and ask which the user wants. Build the one they choose, or the original if they still want it.

## Making one

```python
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.util import Inches, Pt

data = CategoryChartData()
data.categories = ["July", "August", "September"]
data.add_series("Tickets logged", (81, 86, 79))
frame = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(5.6), Inches(2.3), Inches(7.1), Inches(4.6), data)
chart = frame.chart
```

Then, for every chart:

```python
chart.has_title = False               # or chart.chart_title.text_frame.text = "..."; otherwise "Chart Title" can appear
chart.has_legend = len(chart.plots[0].series) > 1   # a legend only when there is more than one series
if chart.has_legend:
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM; chart.legend.include_in_layout = False
axis = chart.value_axis               # not for pie or doughnut
axis.minimum_scale = 0                # bars, columns and areas start at zero, or small differences look huge
axis.has_major_gridlines = True
axis.major_gridlines.format.line.color.rgb = RGBColor.from_string("D9D9D9")
axis.format.line.fill.background()    # no axis line: the gridlines are enough
axis.tick_labels.font.size = Pt(12)
chart.category_axis.tick_labels.font.size = Pt(12)
plot = chart.plots[0]
plot.gap_width = 80                   # space between bars, as a percentage of a bar's width
plot.has_data_labels = True
labels = plot.data_labels
labels.number_format, labels.number_format_is_linked = "0", False   # "0%", "£#,##0", "0.0"
labels.position = XL_LABEL_POSITION.OUTSIDE_END
labels.font.size = Pt(14); labels.font.bold = True
for i, series in enumerate(plot.series):  # brand colours: the template's accents, from theme.py
    series.format.fill.solid(); series.format.fill.fore_color.rgb = RGBColor.from_string(["2EC4B6", "1F6FEB"][i % 2])
chart.font.name = "Calibri"           # the template's body font
```

- One bar in a different colour: `point = series.points[2]; point.format.fill.solid(); point.format.fill.fore_color.rgb = ...`.
- Pie and doughnut: colour each point, show percentages with `labels.show_percentage = True` and `labels.number_format = "0%"`, and set `plot.first_slice_ang` if needed.
- Lines: `series.smooth = False`, `series.marker.style` and `series.format.line.width = Pt(2.5)`.
- On a dark slide, set `chart.font.color.rgb` to a light colour, so the axis labels can be read.

## Changing one that is there already

Keep the chart and replace its data, so its formatting stays: `chart.replace_data(data)` with new `CategoryChartData`. Check its numbers first with `slide_text.py`, which prints every series.
