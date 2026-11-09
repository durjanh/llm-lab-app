---
name: xlsx
description: Makes and edits Excel workbooks (.xlsx) with openpyxl - tables, formulas, number formats and native charts. Use whenever a task asks for a spreadsheet, workbook or Excel file.
---

# Excel workbooks

Write a Python script with openpyxl, save it in `work/`, and run it.

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = "Data"
ws.append(["number", "square"])
for n in range(1, 11):
    ws.append([n, f"=A{n + 1}^2"])          # a formula, so the sheet recalculates
for cell in ws[1]:
    cell.font = Font(bold=True)
ws.freeze_panes = "A2"
chart = BarChart(); chart.title = "Squares"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=11), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=11))
ws.add_chart(chart, "D2")
wb.save("outputs/squares.xlsx")
```

- Use formulas where a value depends on other cells, so the workbook stays correct when someone edits it.
- Bold header row, frozen panes under it, column widths that fit the content (`ws.column_dimensions["A"].width`).
- Number formats for money, percentages and dates (`cell.number_format = "£#,##0.00"`).
- Native charts (openpyxl.chart) rather than pictures, so they stay editable.
- To check the values a formula gives, convert a copy with `soffice --headless --convert-to csv --outdir work outputs/squares.xlsx`.
