"""Sample data for the case-handling lab: a council's housing-repair complaints.

Three legacy "systems of record" (tenancy, repairs, contact history), the policies the decisions
must follow, and open cases. All invented. The policies are written so the right decision and
compensation can be worked out exactly, which is what makes the evaluation possible.
"""
from __future__ import annotations

TODAY = "2026-10-30"

TENANCY = {
    "T-1042": {"tenant_id": "T-1042", "name": "Mrs Amina Okafor", "address": "Flat 4, Elm Court, Leeds LS7 2AB",
               "property_id": "P-881", "tenancy_start": "2019-03-01", "household": "Tenant and two children (ages 3 and 6)",
               "vulnerability_flags": ["young children in household"], "preferred_contact": "email"},
    "T-2210": {"tenant_id": "T-2210", "name": "Mr Desmond Clarke", "address": "12 Mill Lane, Leeds LS11 5QT",
               "property_id": "P-415", "tenancy_start": "2011-06-13", "household": "Tenant lives alone",
               "vulnerability_flags": ["over 75", "uses a walking frame"], "preferred_contact": "letter"},
    "T-3307": {"tenant_id": "T-3307", "name": "Ms Priya Nair", "address": "Flat 9, Ash House, Leeds LS6 1RT",
               "property_id": "P-902", "tenancy_start": "2023-01-09", "household": "Tenant and partner",
               "vulnerability_flags": [], "preferred_contact": "email"},
    "T-4120": {"tenant_id": "T-4120", "name": "Mr Tomasz Wiśniewski", "address": "3 Beech Row, Leeds LS9 8HD",
               "property_id": "P-233", "tenancy_start": "2016-10-02", "household": "Tenant, partner and one child",
               "vulnerability_flags": [], "preferred_contact": "phone"},
    "T-5018": {"tenant_id": "T-5018", "name": "Mrs Grace Adeyemi", "address": "Flat 2, Oak Tower, Leeds LS2 9JW",
               "property_id": "P-560", "tenancy_start": "2014-04-22", "household": "Tenant lives alone",
               "vulnerability_flags": ["respiratory condition (asthma)"], "preferred_contact": "email"},
}

REPAIRS = {
    "P-881": [{"job_id": "R-7781", "type": "damp and mould", "priority": "urgent", "reported": "2026-08-04",
               "target_days": 7, "completed": "2026-09-15", "notes": "Mould treatment and extractor fan replaced. First visit 2026-08-20, no parts."}],
    "P-415": [{"job_id": "R-6620", "type": "heating failure (no heating)", "priority": "emergency", "reported": "2026-10-20",
               "target_days": 7, "completed": None, "heaters_supplied": False,
               "notes": "Engineer attended 2026-10-21, part ordered. Temporary heaters not supplied."}],
    "P-902": [{"job_id": "R-7012", "type": "dripping kitchen tap", "priority": "routine", "reported": "2026-09-01",
               "target_days": 28, "completed": "2026-09-22", "notes": "Washer replaced."}],
    "P-233": [{"job_id": "R-6930", "type": "broken front door lock", "priority": "emergency", "reported": "2026-09-30",
               "target_days": 1, "made_safe": "2026-09-30", "completed": "2026-10-02",
               "notes": "Door secured with a temporary board on 2026-09-30; lock replaced 2026-10-02."}],
    "P-560": [{"job_id": "R-7105", "type": "damp and mould", "priority": "urgent", "reported": "2026-09-10",
               "target_days": 7, "completed": "2026-10-08", "notes": "Leaking gutter fixed, mould wash. Tenant asked for a dehumidifier."}],
}

CONTACTS = {
    "C-301": [{"date": "2026-08-11", "channel": "phone", "replied": True, "summary": "Tenant chased mould repair; told an engineer would visit within a week."},
              {"date": "2026-08-27", "channel": "email", "replied": False, "summary": "Tenant says children are coughing; asked for an update. No reply was sent."}],
    "C-302": [{"date": "2026-10-22", "channel": "phone", "replied": True, "summary": "Tenant's daughter called: father is cold at night, no heaters provided."}],
    "C-303": [],
    "C-304": [{"date": "2026-09-30", "channel": "phone", "replied": True, "summary": "Out-of-hours call: door lock broken after attempted break-in. Board fitted the same night."}],
    "C-305": [{"date": "2026-09-24", "channel": "email", "replied": True, "summary": "Tenant chased; says the mould is affecting her asthma. Reply sent 2026-09-25."}],
}

CASES = [
    {"case_id": "C-301", "tenant_id": "T-1042", "received": "2026-10-03", "channel": "email",
     "complaint": "I reported black mould in my children's bedroom on 4 August. Nobody came for over two weeks and when they did they "
                  "had no parts. It was only fixed on 15 September. My kids were coughing the whole time and nobody answered my email. "
                  "I want an apology and compensation."},
    {"case_id": "C-302", "tenant_id": "T-2210", "received": "2026-10-23", "channel": "letter",
     "complaint": "My heating stopped on 20 October. A man came the next day but said he needs a part. I am 79 and it is very cold at "
                  "night. Nobody has given me a heater. When will it be fixed?"},
    {"case_id": "C-303", "tenant_id": "T-3307", "received": "2026-10-01", "channel": "email",
     "complaint": "My kitchen tap was dripping for three weeks before it was fixed. That's too slow and I want compensation for the wasted water."},
    {"case_id": "C-304", "tenant_id": "T-4120", "received": "2026-10-05", "channel": "phone",
     "complaint": "After a break-in attempt my front door lock was broken. You boarded it up but it took two days to fit a new lock. "
                  "My family did not feel safe. I want this looked into."},
    {"case_id": "C-305", "tenant_id": "T-5018", "received": "2026-10-12", "channel": "email",
     "complaint": "I reported damp and mould on 10 September and it took until 8 October to fix. I have asthma and it made it worse. "
                  "I'd like compensation and a dehumidifier."},
]

# Expected outcomes, worked out by hand from the policies below: the evaluation's gold set.
EXPECTED = {
    "C-301": {"decision": "upheld", "compensation_gbp": 325},    # due 11 Aug, done 15 Sep: 35 days x £5 = £175; no reply £50; children £100
    "C-302": {"decision": "upheld", "compensation_gbp": 180},    # heating due 27 Oct, open on 30 Oct: 3 days x £10 = £30; no heaters £50; over 75 £100
    "C-303": {"decision": "not_upheld", "compensation_gbp": 0},  # routine, fixed in 21 of 28 days
    "C-304": {"decision": "not_upheld", "compensation_gbp": 0},  # made safe the same day, lock replaced within 7 days
    "C-305": {"decision": "upheld", "compensation_gbp": 205},    # due 17 Sep, done 8 Oct: 21 days x £5 = £105; asthma £100
}

POLICIES = [
    ("Complaints policy", """# Complaints policy

## Stages and timescales
A complaint is any expression of dissatisfaction about our service. Stage 1 complaints are acknowledged within 5 working days and answered within 10 working days of acknowledgement. Every response must state whether the complaint is upheld, partly upheld or not upheld, explain the reasons with reference to the facts and this policy, set out any remedy, and tell the resident how to escalate to Stage 2 and then to the Housing Ombudsman.

## Deciding the outcome
Decide on the council's service, not on how the resident felt about it. Uphold the complaint when the council missed a repair timescale or made a service failure on the matter complained about. Partly uphold only when the resident complained about two or more separate repairs or services and at least one of them was delivered within its standard. Do not uphold when every timescale and standard was met, even if the resident was unhappy; explain this respectfully, with the dates. The outcome must agree with the compensation: if any delay or service failure payment is due, the complaint is upheld or partly upheld; if none is due, it is not upheld.

## Human approval
Every Stage 1 response is drafted by the case-handling assistant and must be approved by a named caseworker before it is sent. The caseworker may edit the response. Decisions are recorded in the audit log."""),
    ("Repair timescales", """# Repair timescales

## Priorities
Emergency repairs (a risk to health, safety or security, such as no heating, no water, or an insecure front door) must be made safe within 24 hours (1 day). Urgent repairs (such as damp and mould, or a serious leak) must be completed within 7 calendar days. Routine repairs must be completed within 28 calendar days.

## Making safe
For an emergency, the target is met when the home is made safe within 24 hours, for example by boarding an insecure door or isolating a leak. A permanent follow-on repair must then be completed within 7 calendar days. Fitting a temporary board and replacing the lock within 7 days meets the standard.

## Heating
When heating cannot be restored within 24 hours, temporary heaters must be supplied within 24 hours of the report, and the repair must be completed within 7 calendar days of the report. That 7-day date is the target for delay payments, at the emergency rate. Not supplying temporary heaters is a service failure."""),
    ("Compensation policy", """# Compensation policy

## Delay payments
When a repair misses its target, pay a delay payment for each day after the target date until the repair was completed (or until today, if it is still open): £5 per day for urgent and routine repairs, and £10 per day for emergency repairs. Count calendar days. For example, an urgent repair reported on 1 March with a 7-day target is due on 8 March; if completed on 18 March, that is 10 days late, so £50.

## Service failure payment
Pay a single £50 service failure payment when we failed to do something we should have done, such as not replying to a resident's contact within 10 working days, or not supplying temporary heaters when required.

## Vulnerability payment
Pay a single additional £100 when a household member has a recorded vulnerability that the failure made worse, such as damp and mould affecting a child or a person with a respiratory condition, or a lack of heating affecting a person over 75.

## Total
The total is the sum of the delay payment, any service failure payment and any vulnerability payment. Do not pay compensation for complaints that are not upheld. Goodwill items (such as a dehumidifier) are not compensation; they may be offered separately at the caseworker's discretion."""),
    ("Damp and mould", """# Damp and mould

Damp and mould is treated as an urgent repair (7 calendar days) and is a hazard to health, especially for children and people with respiratory conditions. After treating the cause, the council should check within 6 weeks that the mould has not returned. A dehumidifier may be offered as a goodwill measure where damp is likely to recur; it is at the caseworker's discretion."""),
    ("Data protection in complaint responses", """# Data protection in complaint responses

Only include personal information the resident has already given or that is needed to explain the decision. Do not mention other residents. Do not include health details beyond what the resident raised themselves. Address the response to the tenant by name and send it by their preferred contact method."""),
]
