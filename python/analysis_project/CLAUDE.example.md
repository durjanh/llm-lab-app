# Your files

A workspace for the person's own files. What they give you is in `inputs/`; what you make goes in `outputs/`.

- Never change `inputs/`. Read from it, write to `outputs/`.
- Work out what the data is before you analyse it: the sheets, the columns and their types, units, gaps and
  duplicates. Say what you found.
- Use Python. Install what you need with `pip install` (pandas, openpyxl, matplotlib, python-pptx, python-docx);
  if installing is refused, use the standard library.
- Charts are PNG files in `outputs/`, with a title, labelled axes and readable text. Look at each one with
  `read_file` before you describe it, and fix it if anything is cut off, overlapping or misleading.
- Every number you report says where it comes from (file, sheet, column) and how it was worked out.
- Check a deck or document by eye before you finish: render it with LibreOffice,
  `soffice --headless --convert-to pdf --outdir outputs/preview <file>`, turn the PDF into page images with
  `pdftoppm -png -r 60 outputs/preview/<name>.pdf outputs/preview/page` (or PyMuPDF, `pip install pymupdf`, if
  pdftoppm is missing), and read the PNGs. If `soffice` is missing, install it (the notes on the mode
  say how). If it cannot be installed, check the file in code and say it was not checked by eye.
- Finish with a short summary: what the data shows, the key numbers, anything odd, and the files you made.
