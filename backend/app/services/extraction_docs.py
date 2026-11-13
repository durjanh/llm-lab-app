"""The structured extraction lab's invented document set: 24 labelled documents of three types in deliberately varied
layouts, three worked examples for the few-shot toggle, and the ground truth for every field. Every company, number and
person here is made up. Standard library only."""
from __future__ import annotations

from typing import Any

# The fields that are scored against the ground truth. None in the truth means the document does not say.
FIELDS = ["vendor", "document_number", "date", "currency", "stated_total", "payment_terms_days", "vat_number", "category"]
CATEGORIES = ["office_supplies", "it_equipment", "food_and_drink", "transport", "services", "utilities", "other", "unclear"]
DOC_TYPES = ["invoice", "receipt", "purchase_order"]


def _doc(doc_id: str, doc_type: str, split: str, layout: str, text: str, truth: dict[str, Any], lines: list[float],
         conflict: bool = False, needs_contract: bool = False, note: str = "") -> dict[str, Any]:
    full = {f: None for f in FIELDS}
    full.update(truth)
    return {"id": doc_id, "type": doc_type, "split": split, "layout": layout, "text": text.strip("\n"), "truth": full,
            "line_amounts": lines, "conflict": conflict, "needs_contract": needs_contract, "note": note}


def _long_order() -> tuple[str, float, list[float]]:
    """A 30-line purchase order, too long for a small output limit: the batch demo splits it into chunks."""
    items = [("Treated timber 47x100 3.6m", 24, 6.80), ("Plasterboard 12.5mm", 30, 7.45), ("Cement 25kg", 40, 5.60),
             ("Building sand bulk bag", 6, 38.00), ("Insulation roll 100mm", 12, 17.25), ("Damp proof course 30m", 5, 21.90),
             ("Roofing felt 10m", 8, 19.50), ("Roofing battens 25x50", 60, 1.95), ("Galvanised nails 1kg", 15, 4.40),
             ("Decorators caulk", 36, 2.15), ("Skirting board 2.4m", 50, 3.30), ("Architrave 2.1m", 50, 2.85),
             ("Door lining set", 10, 22.00), ("Internal door", 10, 34.50), ("Door handle pair", 10, 8.90),
             ("Hinges 3 inch pair", 20, 2.60), ("Screws box 200", 25, 6.10), ("Wall plugs pack 100", 25, 2.95),
             ("Floor adhesive 15kg", 6, 28.40), ("Tile spacers bag", 12, 1.40), ("Wall tiles 300x600 box", 18, 31.00),
             ("Grout 5kg", 8, 9.75), ("Sealant tube", 24, 3.15), ("Paint white 10L", 14, 41.00), ("Primer 5L", 10, 24.50),
             ("Brush set", 12, 7.80), ("Dust sheet 4x5m", 20, 3.60), ("Masking tape roll", 48, 1.25),
             ("Safety gloves pair", 30, 1.90), ("Skip hire permit", 1, 65.00)]
    rows, amounts = [], []
    for name, qty, unit in items:
        amount = round(qty * unit, 2)
        amounts.append(amount)
        rows.append(f"{name:<30} {qty:>4}  {unit:>7.2f}  {amount:>9.2f}")
    total = round(sum(amounts), 2)
    text = ("PURCHASE ORDER PO-9001\nIssued: 1 December 2026\nSupplier: Ridgeway Builders Merchant\nCurrency: GBP\n\n"
            "Item                           Qty    Unit    Line total\n" + "\n".join(rows)
            + f"\n\nOrder total: £{total:,.2f}\nPayment terms: 30 days from delivery")
    return text, total, amounts


_LONG_TEXT, _LONG_TOTAL, _LONG_LINES = _long_order()

DOCUMENTS: list[dict[str, Any]] = [
    _doc("inv-01", "invoice", "validation", "table", """
HARLOW & FINCH STATIONERY LTD
VAT Reg: GB 204 5518 12
INVOICE  HF-20417        Date: 14 March 2026
Bill to: Marlow Dental Practice

Qty  Item                       Unit    Amount
 5   A4 copier paper (box)      4.20    21.00
 2   Whiteboard markers (pack)  3.75     7.50
 1   Desk tidy                 12.00    12.00

Total due: £40.50
Payment terms: 30 days net
""", {"vendor": "Harlow & Finch Stationery Ltd", "document_number": "HF-20417", "date": "2026-03-14", "currency": "GBP",
      "stated_total": 40.50, "payment_terms_days": 30, "vat_number": "GB 204 5518 12", "category": "office_supplies"},
         [21.00, 7.50, 12.00]),
    _doc("inv-02", "invoice", "validation", "prose", """
Hi Marlow team, this is our invoice for the laptop refresh. Brightwater IT Services Ltd (VAT GB 318 7742 90) is charging
you two business laptops at £649 each, so £1,298, plus the setup fee of £85. That comes to £1,383 altogether. Our
reference is BWT/2026/0092, dated 2 April 2026. Please pay within 14 days.
""", {"vendor": "Brightwater IT Services Ltd", "document_number": "BWT/2026/0092", "date": "2026-04-02", "currency": "GBP",
      "stated_total": 1383.00, "payment_terms_days": 14, "vat_number": "GB 318 7742 90", "category": "it_equipment"},
         [1298.00, 85.00]),
    _doc("inv-03", "invoice", "test", "inline amounts, decimal point, euros", """
Rechnung / Invoice no. 7731-B from Kellner Verpackungen GmbH, 21/05/2026. 200 cartons at EUR 0.85 = EUR 170.00; pallet
delivery EUR 45.00. Total EUR 215.00. Terms: 60 days. VAT ID DE298114507.
""", {"vendor": "Kellner Verpackungen GmbH", "document_number": "7731-B", "date": "2026-05-21", "currency": "EUR",
      "stated_total": 215.00, "payment_terms_days": 60, "vat_number": "DE298114507", "category": "other"},
         [170.00, 45.00]),
    _doc("inv-04", "invoice", "test", "table, line items do not sum to the total", """
NORTHGATE CLEANING SERVICES
Invoice 55102        Date 03/06/2026

Office clean - June              £320.00
Window cleaning                  £ 95.00
Consumables                      £ 41.50
--------------------------------------
TOTAL                            £486.50
Payment terms: 30 days
""", {"vendor": "Northgate Cleaning Services", "document_number": "55102", "date": "2026-06-03", "currency": "GBP",
      "stated_total": 486.50, "payment_terms_days": 30, "category": "services"},
         [320.00, 95.00, 41.50], conflict=True, note="The lines add up to 456.50, not 486.50."),
    _doc("inv-05", "invoice", "validation", "terms only in an attached contract", """
COBALT FREIGHT LTD - INVOICE CF-8830
Date: 9 July 2026
Haulage Leeds to Bristol, 3 pallets: £540.00
Fuel surcharge: £48.00
Total: £588.00
Payment terms: as set out in the attached contract (ref CF/MSA/12).
""", {"vendor": "Cobalt Freight Ltd", "document_number": "CF-8830", "date": "2026-07-09", "currency": "GBP",
      "stated_total": 588.00, "payment_terms_days": None, "category": "transport"},
         [540.00, 48.00], needs_contract=True, note="Payment terms exist only in a contract that is not provided."),
    _doc("inv-06", "invoice", "test", "prose with no date and no invoice number", """
Greenfield Catering - please find our charge for the staff lunch: sandwich platter £86.00, soft drinks £24.00, total
£110.00. Payment within 7 days. Thanks, Greenfield Catering.
""", {"vendor": "Greenfield Catering", "currency": "GBP", "stated_total": 110.00, "payment_terms_days": 7,
      "category": "food_and_drink"}, [86.00, 24.00], note="No date and no number are printed."),
    _doc("inv-07", "invoice", "test", "informal measurements", """
Stonebridge Farm Produce - invoice SF-219 - 11 Aug 2026
2 dozen eggs @ £3.60 a dozen = £7.20; half a kilo of butter £4.10; three and a half kg potatoes £5.25; a crate of apples
£12.00. Total £28.55. Net 14 days.
""", {"vendor": "Stonebridge Farm Produce", "document_number": "SF-219", "date": "2026-08-11", "currency": "GBP",
      "stated_total": 28.55, "payment_terms_days": 14, "category": "food_and_drink"}, [7.20, 4.10, 5.25, 12.00]),
    _doc("inv-08", "invoice", "validation", "ambiguous currency symbol", """
Pacific Line Consulting Inc.
Inv #PLC-0457                         5 Oct 2026
Strategy workshop (2 days)            $1,800.00
Travel                                  $240.00
Total                                 $2,040.00
Terms: Net 30
""", {"vendor": "Pacific Line Consulting Inc.", "document_number": "PLC-0457", "date": "2026-10-05", "currency": "unclear",
      "stated_total": 2040.00, "payment_terms_days": 30, "category": "services"}, [1800.00, 240.00],
         note="A bare dollar sign could be US, Canadian or Australian dollars."),
    _doc("inv-09", "invoice", "test", "table with a discount line", """
Ashdown Electrical Wholesale          VAT No 561 2230 08
INV 90311 | 27 Nov 2026 | GBP

Cable 2.5mm (100m)    x3   @ 58.00     174.00
Socket back boxes     x20  @  1.15      23.00
Trade discount (10%)                   -19.70
TOTAL (inc. VAT)                       177.30
Terms: 30 days
""", {"vendor": "Ashdown Electrical Wholesale", "document_number": "90311", "date": "2026-11-27", "currency": "GBP",
      "stated_total": 177.30, "payment_terms_days": 30, "vat_number": "561 2230 08", "category": "other"},
         [174.00, 23.00, -19.70]),

    _doc("rec-01", "receipt", "validation", "till table", """
THE CORNER BAKERY
12 High St, Bristol
Receipt 004217     08/09/2026 09:41
Sourdough loaf            3.80
Pain au chocolat x2       5.00
Flat white                2.90
TOTAL GBP                11.70
Paid by card
""", {"vendor": "The Corner Bakery", "document_number": "004217", "date": "2026-09-08", "currency": "GBP",
      "stated_total": 11.70, "category": "food_and_drink"}, [3.80, 5.00, 2.90]),
    _doc("rec-02", "receipt", "validation", "friendly prose", """
Thanks for shopping at Penny Lane Pharmacy! You bought shampoo (£4.99), plasters (£2.49) and a toothbrush for £1.99 on
22 June 2026. Total paid: £9.47. VAT no. GB 774 0021 55.
""", {"vendor": "Penny Lane Pharmacy", "date": "2026-06-22", "currency": "GBP", "stated_total": 9.47,
      "vat_number": "GB 774 0021 55", "category": "other"}, [4.99, 2.49, 1.99]),
    _doc("rec-03", "receipt", "validation", "decimal commas, litres", """
AUTOSTOP TANKSTELLE
Beleg Nr 118830
04.07.2026
Diesel 42,5 L x 1,59        67,58
Gesamt EUR                  67,58
""", {"vendor": "AutoStop Tankstelle", "document_number": "118830", "date": "2026-07-04", "currency": "EUR",
      "stated_total": 67.58, "category": "transport"}, [67.58]),
    _doc("rec-04", "receipt", "test", "bare: no date, no number", """
Lantern Coffee House
Latte        3.40
Brownie      2.80
Total       £6.20
Thank you!
""", {"vendor": "Lantern Coffee House", "currency": "GBP", "stated_total": 6.20, "category": "food_and_drink"},
         [3.40, 2.80]),
    _doc("rec-05", "receipt", "test", "informal measurements", """
Dunmore Hardware
Receipt DH-5521 - 17 Feb 2026
Rope, 6 metres @ 1.10/m        6.60
Screws (a handful, loose)      1.50
Paint, 2.5 litre tin          18.95
Total £27.05
""", {"vendor": "Dunmore Hardware", "document_number": "DH-5521", "date": "2026-02-17", "currency": "GBP",
      "stated_total": 27.05, "category": "other"}, [6.60, 1.50, 18.95]),
    _doc("rec-06", "receipt", "validation", "lines do not sum to the total", """
RIVERSIDE DELI
Receipt 7712   30 Jan 2026
Soup of the day     4.50
Cheese toastie      3.20
Salad box           7.80
Total £16.50
""", {"vendor": "Riverside Deli", "document_number": "7712", "date": "2026-01-30", "currency": "GBP",
      "stated_total": 16.50, "category": "food_and_drink"}, [4.50, 3.20, 7.80], conflict=True,
         note="The lines add up to 15.50, not 16.50."),
    _doc("rec-07", "receipt", "test", "dollars, tip as a line", """
HARBOR VIEW GRILL
Check #2231 - 12 Sept 2026
Burger        14.00
Fries          5.00
Soda           3.00
Tip            4.00
Total charged USD 26.00
""", {"vendor": "Harbor View Grill", "document_number": "2231", "date": "2026-09-12", "currency": "USD",
      "stated_total": 26.00, "category": "food_and_drink"}, [14.00, 5.00, 3.00, 4.00]),
    _doc("rec-08", "receipt", "test", "ambiguous category", """
Orchard & Pine
Receipt 3301     14 Dec 2026
Gift card (value £25.00)      25.00
Total £25.00
""", {"vendor": "Orchard & Pine", "document_number": "3301", "date": "2026-12-14", "currency": "GBP",
      "stated_total": 25.00, "category": "unclear"}, [25.00], note="A gift card does not say what it will buy."),

    _doc("po-01", "purchase_order", "validation", "table", """
PURCHASE ORDER PO-3302
Issued: 5 January 2026
Supplier: Harlow & Finch Stationery Ltd

Item                    Qty   Unit price   Line total
Lever arch files         40      1.85         74.00
Printer toner (black)     4     62.50        250.00

Order total: £324.00 (excl. VAT)
Payment terms: 30 days from delivery
""", {"vendor": "Harlow & Finch Stationery Ltd", "document_number": "PO-3302", "date": "2026-01-05", "currency": "GBP",
      "stated_total": 324.00, "payment_terms_days": 30, "category": "office_supplies"}, [74.00, 250.00]),
    _doc("po-02", "purchase_order", "validation", "prose, number words", """
Please supply to Marlow Dental Practice: twelve boxes of nitrile gloves at £6.40 a box and two sharps bins at £9.00 each,
from Medisource Supplies Ltd. Our PO number is MDP-0119, raised on 19 March 2026. We pay 45 days after invoice. The
order comes to £94.80.
""", {"vendor": "Medisource Supplies Ltd", "document_number": "MDP-0119", "date": "2026-03-19", "currency": "GBP",
      "stated_total": 94.80, "payment_terms_days": 45, "category": "other"}, [76.80, 18.00]),
    _doc("po-03", "purchase_order", "test", "inline, informal measurements", """
PO 8841 - 9 May 2026 - to Quarry & Sons Aggregates. 4 tonnes of sharp sand @ £42 a tonne (£168), and a skip-load of
topsoil, roughly 6 cubic yards (£210). Total £378. Delivery to site by the 20th. Terms: 7 days from receipt.
""", {"vendor": "Quarry & Sons Aggregates", "document_number": "8841", "date": "2026-05-09", "currency": "GBP",
      "stated_total": 378.00, "payment_terms_days": 7, "category": "other"}, [168.00, 210.00]),
    _doc("po-04", "purchase_order", "validation", "terms only in an attached contract", """
Purchase order PO-5509, dated 2026-08-03, to Delta Print Works for 5,000 brochures, £1,250.00 in total. Pricing and
payment terms are as per the attached framework contract.
""", {"vendor": "Delta Print Works", "document_number": "PO-5509", "date": "2026-08-03", "currency": "GBP",
      "stated_total": 1250.00, "payment_terms_days": None, "category": "services"}, [1250.00], needs_contract=True,
         note="Payment terms exist only in a contract that is not provided."),
    _doc("po-05", "purchase_order", "validation", "lines do not sum to the total", """
PO 7120 / 14 Sep 2026 / Supplier: Vantage Lab Supplies / Currency: GBP
1. Pipette tips (box 960) x 10 @ 14.20 = 142.00
2. Petri dishes (sleeve 20) x 25 @ 3.10 = 77.50
3. Lab coats x 6 @ 18.00 = 108.00
Order total: 297.50
Terms: 30 days
""", {"vendor": "Vantage Lab Supplies", "document_number": "7120", "date": "2026-09-14", "currency": "GBP",
      "stated_total": 297.50, "payment_terms_days": 30, "category": "other"}, [142.00, 77.50, 108.00], conflict=True,
         note="The lines add up to 327.50, not 297.50."),
    _doc("po-06", "purchase_order", "test", "no currency, no number", """
Ordered 2 Nov 2026 from Linton Office Furniture: one standing desk 429.00 and two chairs at 139.00 each. Total 707.00.
Terms 30 days.
""", {"vendor": "Linton Office Furniture", "date": "2026-11-02", "stated_total": 707.00, "payment_terms_days": 30,
      "category": "other"}, [429.00, 278.00], note="No currency is printed and there is no order number."),
    _doc("po-07", "purchase_order", "test", "long table, 30 lines (chunking)", _LONG_TEXT,
         {"vendor": "Ridgeway Builders Merchant", "document_number": "PO-9001", "date": "2026-12-01", "currency": "GBP",
          "stated_total": _LONG_TOTAL, "payment_terms_days": 30, "category": "other"}, _LONG_LINES,
         note="Too long for a small output limit: the batch demo splits it."),
]

# Three worked examples for the few-shot toggle. They are not in the set above, so they cannot leak the answers.
EXAMPLES: list[dict[str, Any]] = [
    {"layout": "table with a discount and no VAT number", "text": """
Fernside Garden Supplies
Invoice FS-1180   16 April 2026
Compost 50L  x4 @ 6.50     26.00
Plant pots   x10 @ 1.20    12.00
Loyalty discount           -3.80
Total GBP                  34.20
Terms: 21 days
""", "extraction": {
        "vendor": "Fernside Garden Supplies", "document_number": "FS-1180", "date": "2026-04-16", "currency": "GBP",
        "line_items": [{"description": "Compost 50L", "quantity": 4, "unit": None, "amount": 26.00},
                       {"description": "Plant pots", "quantity": 10, "unit": None, "amount": 12.00},
                       {"description": "Loyalty discount", "quantity": None, "unit": None, "amount": -3.80}],
        "stated_total": 34.20, "calculated_total": 34.20, "conflict_detected": False, "payment_terms_days": 21,
        "vat_number": None, "category": "other", "category_detail": "garden supplies",
        "confidence": {"vendor": 0.98, "document_number": 0.98, "date": 0.97, "currency": 0.97, "stated_total": 0.98,
                       "payment_terms_days": 0.95, "vat_number": 0.9, "category": 0.7}}},
    {"layout": "prose receipt with a vague measure and no date", "text": """
Quick Bite Kiosk. Two coffees at £2.10 each, a bag of crisps £1.00 and a good scoop of fruit salad £3.50. Altogether
£8.70, thanks!
""", "extraction": {
        "vendor": "Quick Bite Kiosk", "document_number": None, "date": None, "currency": "GBP",
        "line_items": [{"description": "Coffee", "quantity": 2, "unit": None, "amount": 4.20},
                       {"description": "Crisps", "quantity": 1, "unit": "bag", "amount": 1.00},
                       {"description": "Fruit salad", "quantity": None, "unit": "scoop", "amount": 3.50}],
        "stated_total": 8.70, "calculated_total": 8.70, "conflict_detected": False, "payment_terms_days": None,
        "vat_number": None, "category": "food_and_drink", "category_detail": None,
        "confidence": {"vendor": 0.95, "document_number": 0.9, "date": 0.9, "currency": 0.9, "stated_total": 0.97,
                       "payment_terms_days": 0.9, "vat_number": 0.9, "category": 0.95}}},
    {"layout": "order that defers to an attached contract, bare dollar sign", "text": """
PO 4410 to Meridian Courier Co, 8/2/2026. Monthly courier service, $950.00. Payment terms: see attached service
agreement.
""", "extraction": {
        "vendor": "Meridian Courier Co", "document_number": "4410", "date": "2026-02-08", "currency": "unclear",
        "line_items": [{"description": "Monthly courier service", "quantity": 1, "unit": "month", "amount": 950.00}],
        "stated_total": 950.00, "calculated_total": 950.00, "conflict_detected": False, "payment_terms_days": None,
        "vat_number": None, "category": "transport", "category_detail": None,
        "confidence": {"vendor": 0.95, "document_number": 0.95, "date": 0.8, "currency": 0.6, "stated_total": 0.97,
                       "payment_terms_days": 0.9, "vat_number": 0.9, "category": 0.85}}},
]

BY_ID = {d["id"]: d for d in DOCUMENTS}
