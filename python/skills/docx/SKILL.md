---
name: docx
description: Makes and edits Word documents (.docx) with python-docx - headings, paragraphs, lists, tables and pictures. Use whenever a task asks for a Word document, report or letter.
---

# Word documents

Write a Python script with python-docx, save it in `work/`, and run it.

```python
from docx import Document
from docx.shared import Pt
doc = Document()
doc.add_heading("Report title", level=0)
doc.add_paragraph("A short opening paragraph.")
doc.add_heading("Findings", level=1)
for point in ["First point", "Second point"]:
    doc.add_paragraph(point, style="List Bullet")
table = doc.add_table(rows=1, cols=2); table.style = "Light Grid Accent 1"
table.rows[0].cells[0].text, table.rows[0].cells[1].text = "Item", "Value"
row = table.add_row().cells; row[0].text, row[1].text = "Apples", "12"
doc.save("outputs/report.docx")
```

- Use the built-in heading styles, so the document has a navigable outline.
- Keep tables narrow enough for the page; put a heading or sentence before each one.
- Pictures: `doc.add_picture(path, width=Inches(6))`; make charts with matplotlib first.
- To check how it looks, convert it: `soffice --headless --convert-to pdf --outdir work outputs/report.docx`, then `pdftoppm -png -scale-to 900 work/report.pdf work/page` and read the page count.
