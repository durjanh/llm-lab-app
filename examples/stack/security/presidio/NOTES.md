# Presidio

Microsoft's open-source PII detector (`presidio-analyzer`) and redactor (`presidio-anonymizer`). It runs locally: a spaCy model (`en_core_web_lg`, about 400 MB) finds names, and pattern recognisers with checksums find emails, cards and phones.

## How it does the task
`run.py` builds an `AnalyzerEngine` on spaCy, adds three UK recognisers (postcode, NI number, UK phone), restricts it to the entity types the task is about, then anonymises each text. The score counts how many of the 23 labelled values were covered by a detected span, and whether any email, phone, NI number or card value is still readable after anonymising.

## Limits
- The built-in set is US-centred. It has UK_NHS and, in recent versions, a UK NI recogniser, but the NI one rejects invalid prefixes (our invented numbers use QQ), and the phone recogniser rejects Ofcom's drama numbers (07700 900xxx). So the three UK recognisers here are plain regexes. They were written against this test set, so the 100% is flattering: real data has more shapes.
- Unrestricted, it also reports dates, places and organisations ("Annual", "London", "the Report Phishing") on the clean texts. We pass an entity list to avoid that. In real use you tune this per application.
- Names depend on the NER model and can be missed in lower-case or unusual text.
- Presidio finds PII. It does not detect prompt injection.

Ran on 2026-11-15: PASS, 23/23 entities, 0 core values left, 0 false alarms on the 4 clean texts. Before the entity list and the phone regex it scored 22/23 with 4 false alarms. spaCy 3.8.18, presidio 2.2.366.
