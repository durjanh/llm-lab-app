"""Sample data shared by the LLM Lab scripts and the local server."""
from __future__ import annotations

# A fictional company handbook. It is long enough (well over 1,024 tokens) for
# prompt caching to apply on every current Claude model.
HANDBOOK_SECTIONS: list[tuple[str, str]] = [
    ("Annual leave",
     "Full-time employees receive 25 days of paid annual leave per year, plus public holidays. "
     "Leave accrues monthly and up to 5 unused days can be carried into the next year. "
     "Book leave through the HR portal at least two weeks in advance for absences longer than three days. "
     "Part-time employees receive leave pro rata to their contracted hours."),
    ("Sickness absence",
     "If you are ill, tell your line manager before 10am on your first day of absence. "
     "You can self-certify for up to 7 calendar days. For longer absences, a fit note from a doctor is required. "
     "Company sick pay covers up to 20 working days per year at full salary. "
     "After a long absence, your manager will arrange a return-to-work conversation."),
    ("Parental leave",
     "Birth parents receive 26 weeks of leave at full pay followed by 13 weeks at statutory pay. "
     "Partners receive 6 weeks at full pay, which can be taken in up to three blocks within the first year. "
     "Adoptive parents receive the same entitlements as birth parents. Tell HR at least 15 weeks before the expected date."),
    ("Expenses",
     "Claim business expenses within 30 days using the Expenses app, with a photo of every receipt. "
     "Taxis are reimbursed only when public transport is unavailable or you are travelling between 10pm and 6am. "
     "Meals while travelling are covered up to £35 per day. Alcohol is never reimbursed. "
     "Mileage in a personal car is paid at 45p per mile for the first 10,000 miles in a tax year."),
    ("Travel",
     "Book all flights and hotels through the travel desk. Economy class is standard for flights under six hours, "
     "and premium economy is allowed for longer flights. Hotels should cost no more than £180 per night in London "
     "and £140 per night elsewhere in the UK. International hotel limits are listed on the travel desk page. "
     "Rail travel is standard class unless the journey is longer than three hours."),
    ("Remote working",
     "Employees may work remotely up to three days per week, agreed with their manager. "
     "Teams meet in the office every Tuesday. When working abroad, you may work remotely for a maximum of 20 days "
     "per year and must inform HR beforehand. Working from abroad requires a check of tax and insurance rules first."),
    ("Equipment",
     "Every employee receives a laptop, a monitor and a headset. Report lost or stolen equipment to the IT service desk "
     "within 24 hours by calling extension 4400. Do not install unapproved software; request it through the IT portal "
     "instead. Laptops are replaced every four years, or sooner if they fail."),
    ("Information security",
     "Lock your screen whenever you leave your desk. Never share your password, including with IT staff. "
     "Report suspicious emails using the Report Phishing button. Customer data must only be stored in approved systems "
     "and never on personal devices. Multi-factor authentication is required for every company system."),
    ("Learning and development",
     "Each employee has a learning budget of £1,000 per year for courses, books and conferences. "
     "Requests above £500 need approval from your manager. You also get five learning days per year. "
     "Unused learning budget does not carry over into the next year."),
    ("Performance reviews",
     "Reviews happen twice a year, in April and October. Each review covers goals, feedback from colleagues and a "
     "development plan. Pay reviews take place once a year in April and are based on the April review."),
    ("Pensions and benefits",
     "The company pays 6% of salary into your pension when you pay at least 4%. Private medical insurance covers "
     "employees and can be extended to family members at a discounted rate. The cycle-to-work scheme lets you spread "
     "the cost of a bike over 12 months through salary sacrifice."),
    ("Code of conduct",
     "Treat colleagues, customers and suppliers with respect. Declare any gift worth more than £50. "
     "Conflicts of interest must be reported to your manager and to the compliance team. "
     "Concerns about wrongdoing can be raised confidentially through the speak-up line."),
]

HANDBOOK = "# Northwind Employee Handbook\n\n" + "\n\n".join(f"## {t}\n{body}" for t, body in HANDBOOK_SECTIONS)

# A small labelled test set. Each item: (review, expected label).
REVIEWS: list[tuple[str, str]] = [
    ("I loved every minute of this film, the acting was brilliant.", "positive"),
    ("What a waste of time. The plot made no sense.", "negative"),
    ("The food was delicious and the staff were so friendly.", "positive"),
    ("Terrible service, cold food, and we waited an hour.", "negative"),
    ("This phone is fast, the battery lasts all day, highly recommend.", "positive"),
    ("It broke after two days and support never replied.", "negative"),
    ("A heartwarming story with a perfect ending.", "positive"),
    ("Boring, predictable and far too long.", "negative"),
    ("Not bad at all, I would happily go back.", "positive"),
    ("Oh great, another update that deletes my settings. Just what I needed.", "negative"),
    ("The screen is gorgeous but the battery barely lasts a morning.", "mixed"),
    ("Lovely hotel, shame about the noisy building work next door.", "mixed"),
]

# Records used to compare data formats by token count.
PEOPLE: list[dict] = [
    {"id": 1, "name": "Ada Lovelace", "role": "Engineer", "city": "London", "start": 2019},
    {"id": 2, "name": "Alan Turing", "role": "Researcher", "city": "Manchester", "start": 2020},
    {"id": 3, "name": "Grace Hopper", "role": "Architect", "city": "New York", "start": 2018},
    {"id": 4, "name": "Katherine Johnson", "role": "Analyst", "city": "Hampton", "start": 2021},
    {"id": 5, "name": "Tim Berners-Lee", "role": "Engineer", "city": "Geneva", "start": 2017},
    {"id": 6, "name": "Margaret Hamilton", "role": "Lead", "city": "Boston", "start": 2016},
]
