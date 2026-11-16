"""Unstructured: make a PDF and a DOCX of the handbook, partition both, chunk by title, then answer from the chunks.

Checks that all 12 section titles come back as Title elements (DOCX and PDF), that the chunks hold every gold fact,
then does simple retrieval (local BGE embeddings, cosine, top 3) and answers the gold questions with Claude.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # examples/stack/rag
import shared
from shared import checks, config, data

NAME = "rag/unstructured"

# The fast PDF parser has no layout model. It calls a short capitalised line "narrative text" when it holds a verb
# ("Annual leave", "Performance reviews"). A lower cap-ratio threshold turns such short lines into Titles.
os.environ.setdefault("UNSTRUCTURED_NARRATIVE_TEXT_CAP_THRESHOLD", "0.3")


def make_docx(path: Path) -> None:
    import docx

    doc = docx.Document()
    doc.add_heading("Northwind Employee Handbook", level=0)
    for title, body in data.SECTIONS:
        doc.add_heading(title, level=1)
        doc.add_paragraph(body)
    doc.save(path)


def make_pdf(path: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    # Space around each heading, so the PDF parser sees it as a block of its own and not as the first line of the body.
    heading = ParagraphStyle("Heading", parent=styles["Heading1"], spaceBefore=36, spaceAfter=28)
    story = [Paragraph("Northwind Employee Handbook", styles["Title"])]
    for title, body in data.SECTIONS:
        story += [Paragraph(title, heading), Paragraph(body, styles["BodyText"]), Spacer(1, 8)]
    SimpleDocTemplate(str(path), pagesize=A4).build(story)


def titles_of(elements) -> set[str]:
    return {e.text.strip() for e in elements if e.category == "Title"}


def title_chunks(elements):
    """Chunks by title with no merging of small sections, so each chunk is one handbook section."""
    from unstructured.chunking.title import chunk_by_title

    return chunk_by_title(elements, max_characters=1500, combine_text_under_n_chars=0, new_after_n_chars=1200)


if shared.need_claude(NAME):
    import numpy as np
    from sentence_transformers import SentenceTransformer
    from unstructured.partition.docx import partition_docx
    from unstructured.partition.pdf import partition_pdf

    wanted = {t for t, _ in data.SECTIONS}
    with tempfile.TemporaryDirectory() as tmp:
        docx_path, pdf_path = Path(tmp) / "handbook.docx", Path(tmp) / "handbook.pdf"
        make_docx(docx_path)
        make_pdf(pdf_path)
        docx_elements = partition_docx(filename=str(docx_path))
        pdf_elements = partition_pdf(filename=str(pdf_path), strategy="fast")

    docx_found, pdf_found = wanted & titles_of(docx_elements), wanted & titles_of(pdf_elements)
    print(f"  Title elements: docx {len(docx_found)}/12, pdf {len(pdf_found)}/12", flush=True)
    for label, found in (("docx", docx_found), ("pdf", pdf_found)):
        if found != wanted:
            print(f"  {label} missing: {sorted(wanted - found)}", flush=True)

    docx_chunks, pdf_chunks = title_chunks(docx_elements), title_chunks(pdf_elements)
    facts = sum(any(g.correct(c.text) for c in pdf_chunks) for g in data.GOLD)
    print(f"  chunks: docx {len(docx_chunks)}, pdf {len(pdf_chunks)}; gold facts found in pdf chunks {facts}/12", flush=True)

    # Retrieval over the PDF chunks (the harder format): the first line of a chunk is its section title.
    texts = [c.text for c in pdf_chunks]
    section_of = [next((t for t in wanted if tx.startswith(t)), "?") for tx in texts]
    encoder = SentenceTransformer(config.LOCAL_EMBEDDING, device="cpu")
    vectors = encoder.encode(texts, normalize_embeddings=True)

    def answer(question):
        q = encoder.encode([question], normalize_embeddings=True)[0]
        top = np.argsort(-(vectors @ q))[:3]
        return shared.claude(question, [texts[i] for i in top]), [section_of[i] for i in top]

    answers_ok = shared.evaluate(NAME + "#answers", answer)  # prints an interim line; the final line follows
    ok = answers_ok and docx_found == wanted and pdf_found == wanted and facts == 12
    checks.report(NAME, ok, f"sections recovered docx {len(docx_found)}/12, pdf {len(pdf_found)}/12; gold facts in chunks {facts}/12")
