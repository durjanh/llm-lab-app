"""Sample files for the document automation lab, built in code so the repository holds no Word files.

- An engagement letter template, written with docxtpl fields: {{ variables }}, {%p if %} clauses,
  and a {%p for %} repeat. These are the counterparts of a document automation tool's variables, IF and REPEAT.
- A finished mutual NDA, for the AI to turn into a template.
- An intake email, for the AI to fill in the interview from.
"""
from __future__ import annotations

import io

from docx import Document
from docx.shared import Pt


def _document() -> Document:
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)
    return doc


def _bytes(doc: Document) -> bytes:
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def engagement_letter_template() -> bytes:
    doc = _document()
    doc.add_paragraph("{{ firm_name }}")
    doc.add_paragraph("{{ letter_date }}")
    doc.add_paragraph("{{ client_name }}\n{{ client_address }}")
    doc.add_paragraph("Dear {{ client_contact }},")
    doc.add_heading("Letter of engagement: {{ matter_title }}", level=2)
    doc.add_paragraph(
        "Thank you for instructing {{ firm_name }}. This letter sets out the terms on which we will act for "
        "{{ client_name }} in relation to {{ matter_description }}. Our work will start on {{ start_date }}.")
    doc.add_heading("Scope of work", level=3)
    doc.add_paragraph("We will provide the following:")
    doc.add_paragraph("{%p for item in deliverables %}")
    doc.add_paragraph("{{ item }}", style="List Bullet")
    doc.add_paragraph("{%p endfor %}")
    doc.add_heading("Fees", level=3)
    doc.add_paragraph("{%p if fixed_fee %}")
    doc.add_paragraph(
        "We will carry out the work described above for a fixed fee of {{ fee_amount }}, plus VAT. "
        "If the scope changes, we will agree any additional fees with you in writing before doing the work.")
    doc.add_paragraph("{%p else %}")
    doc.add_paragraph(
        "Our fees are charged on the time spent at an hourly rate of {{ hourly_rate }}, plus VAT. We estimate "
        "that the work will cost {{ fee_estimate }}, and we will tell you promptly if that estimate is likely to change.")
    doc.add_paragraph("{%p endif %}")
    doc.add_paragraph("{%p if include_confidentiality %}")
    doc.add_heading("Confidentiality", level=3)
    doc.add_paragraph(
        "We will keep your information confidential and will only use it to carry out this engagement, unless "
        "the law requires us to disclose it.")
    doc.add_paragraph("{%p endif %}")
    doc.add_heading("Governing law", level=3)
    doc.add_paragraph("This engagement is governed by {{ governing_law }}.")
    doc.add_paragraph("Yours sincerely,")
    doc.add_paragraph("{{ partner_name }}\nPartner, {{ firm_name }}")
    return _bytes(doc)


def finished_nda() -> bytes:
    doc = _document()
    doc.add_heading("Mutual Non-Disclosure Agreement", level=1)
    doc.add_paragraph(
        "This Agreement is made on 2 September 2026 between Northwind Traders Limited, a company registered in "
        "England and Wales with number 08123456, whose registered office is at 21 Kings Road, Manchester M1 4AB "
        "(\"Northwind\"), and Contoso Analytics Limited, a company registered in England and Wales with number "
        "11987654, whose registered office is at 5 Riverside Way, Bristol BS1 6HG (\"Contoso\").")
    doc.add_heading("1. Purpose", level=2)
    doc.add_paragraph(
        "The parties wish to share confidential information in order to evaluate a possible partnership for "
        "the supply of warehouse demand forecasting services (the \"Purpose\").")
    doc.add_heading("2. Confidential information", level=2)
    doc.add_paragraph(
        "Each party will keep the other party's confidential information secret, will use it only for the "
        "Purpose, and will disclose it only to its employees and advisers who need to know it for the Purpose.")
    doc.add_heading("3. Term", level=2)
    doc.add_paragraph(
        "This Agreement lasts for 3 years from the date above. The obligations of confidentiality continue for "
        "5 years after the Agreement ends.")
    doc.add_heading("4. Non-solicitation", level=2)
    doc.add_paragraph(
        "For 12 months after this Agreement ends, neither party will solicit any employee of the other party "
        "who was involved in the Purpose.")
    doc.add_heading("5. Governing law", level=2)
    doc.add_paragraph("This Agreement is governed by the law of England and Wales.")
    doc.add_paragraph("Signed for Northwind Traders Limited by Priya Shah, Director")
    doc.add_paragraph("Signed for Contoso Analytics Limited by Daniel Okafor, Chief Executive")
    return _bytes(doc)


INTAKE_EMAIL = """From: Sarah Mitchell <sarah.mitchell@brightwater-logistics.co.uk>
To: James Carter <j.carter@harlowandreed.co.uk>
Subject: Supplier contract review - engagement letter

Hi James,

Thanks for the call this morning. As discussed, please can Harlow & Reed act for us on the review of our
supplier contracts ahead of the renewal round. We'd like you to start on 3 November 2026.

Our details for the letter: Brightwater Logistics Ltd, 14 Harbour Road, Leeds LS10 1PQ. I'm the main
contact.

What we need:
- a review of our 12 main supplier contracts, with a risk summary for each
- a recommended standard set of terms for the renewals
- one workshop with our procurement team to go through the findings

We agreed a fixed fee of £4,500 plus VAT. Please do include a confidentiality section, as some of the
pricing is commercially sensitive. English law is fine.

Best regards,
Sarah Mitchell
Head of Procurement, Brightwater Logistics Ltd
"""

SAMPLES = {
    "engagement-letter-template.docx": engagement_letter_template,
    "mutual-nda.docx": finished_nda,
}
