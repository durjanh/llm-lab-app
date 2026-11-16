# Unstructured

**What it is.** A library that turns documents (PDF, DOCX, HTML, ...) into typed elements (`Title`, `NarrativeText`,
`ListItem`, ...), which you can chunk by title for a RAG index. It is the parsing step, not a retrieval framework.

**How it does this task.** `run.py` builds a PDF (reportlab) and a DOCX (python-docx) of the handbook in a temp folder,
with a heading before each section. It partitions them (`partition_docx`, `partition_pdf(strategy="fast")`) and checks
that all 12 section titles are `Title` elements in both. `chunk_by_title(combine_text_under_n_chars=0)` gives one chunk
per section; every gold fact must appear in a chunk. Retrieval is plain cosine similarity on BGE small over the PDF
chunks (top 3), and Claude answers. PASS needs all 12 sections recovered and at least 11 answers correct.

**Versions.** unstructured 0.27.37 (extras `pdf`, `docx`), reportlab 5.1.0, python-docx 1.2.0, sentence-transformers 6.3.0.

**Limits and surprises.**
- DOCX is easy: heading styles map straight to `Title` (12/12 first time).
- PDF with the `fast` strategy has no layout model, only text rules. First run: **0/12** titles, because the heading and
  the first sentence were merged into one block. Spacing the headings out gave 9/12; "Annual leave", "Parental leave" and
  "Performance reviews" were still `NarrativeText`, because the rules treat a short line holding a verb ("leave",
  "reviews") as narrative. Lowering `UNSTRUCTURED_NARRATIVE_TEXT_CAP_THRESHOLD` to 0.3 (set in `run.py`) fixed it.
  Real PDFs would need the `hi_res` strategy, which needs the system package `tesseract` (not installed here, so not run).
- The document title becomes a 13th chunk. The package prints a promotional notice on import.

Ran on 2026-11-15: PASS, all 12 sections recovered from both the DOCX and the PDF, gold facts in chunks 12/12, 12/12
answers correct, 12/12 retrieval hits (one earlier run got a one-word answer, "The", for the pension question; the
re-run was fine, so a rare short reply from the model).
