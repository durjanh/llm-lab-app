---
name: pdf
description: Makes PDFs with reportlab (fact sheets, reports, tables) and reads or combines existing PDFs with pypdf and pdfplumber. Use whenever a task asks for a PDF or works with one.
---

# PDFs

To make one, write a Python script with reportlab's platypus, save it in `work/`, and run it.

```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
styles = getSampleStyleSheet()
doc = SimpleDocTemplate("outputs/sheet.pdf", pagesize=A4, title="Fact sheet")
table = Table([["n", "prime"], ["2", "yes"], ["4", "no"]])
table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                           ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)]))
doc.build([Paragraph("Fact sheet", styles["Title"]), Spacer(1, 12), table])
```

- Platypus flows text across pages for you; use it rather than drawing at fixed positions.
- Another way: write HTML and convert it with `soffice --headless --convert-to pdf`, or a Word file made with the docx skill.
- To read a PDF: `pdfplumber.open(path)` gives each page's text and tables. To combine or split: `pypdf.PdfReader` and `PdfWriter`.
- Check the result: `pdftoppm -png -scale-to 900 outputs/sheet.pdf work/page` and count the pages.
