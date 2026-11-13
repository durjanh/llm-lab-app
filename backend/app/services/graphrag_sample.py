"""An invented company's memos, for the GraphRAG page: people, teams, projects, suppliers and decisions that run across
several documents, so questions about who works with whom, and about the themes of the whole set, are worth asking.

Quillmere Robotics and everyone in it are made up. None of these details are real.
"""
from __future__ import annotations

COLLECTION = "quillmere"
TITLE = "Quillmere Robotics memos (invented)"

DOCUMENTS: dict[str, str] = {
    "Board update, March": """# Board update, March

Quillmere Robotics is a fictional company, used for training. None of these details are real.

## Summary from the chief executive

Tom Okafor, chief executive, reported that Project Heron, the warehouse picking robot, is six weeks behind plan. The
delay comes from motor overheating found in field trials at the Rotterdam warehouse of Northgate Logistics, our first
customer. Priya Shah, head of engineering, leads the fix.

## Decisions

- The board agreed to move Heron's launch from June to August.
- Finance, led by Ines Duarte, will hold back 15% of the Heron budget until the motor fix passes testing.
- The board asked for a supplier review of Kestrel Components, who make Heron's drive motors.
""",
    "Engineering memo: Heron motors": """# Engineering memo: Heron motors

From Priya Shah, head of engineering, to the engineering team and procurement.

## What we found

Heron's drive motors from Kestrel Components run 18 degrees hotter than their data sheet under continuous picking
loads. Samuel Reyes in the test lab reproduced the fault in Leeds. Kestrel's account manager, Joanna Lind, confirmed a
change in their winding supplier last autumn.

## What we will do

- Samuel Reyes will run a 500-hour soak test on a revised motor batch.
- Aisha Bello, firmware lead, will add a thermal limit that slows the arm before the motor overheats.
- Procurement will ask Kestrel for a second source of windings and a written quality plan.
""",
    "Procurement note: suppliers": """# Procurement note: suppliers

From Marta Novak, head of procurement.

## Kestrel Components

Kestrel supplies drive motors for Heron and for the older Wren robot. After Priya Shah's memo, I met Joanna Lind at
Kestrel. They will deliver a revised batch in four weeks. If the soak test fails, our fallback is Ostrava Drives, who
quoted 12% more per motor.

## Brightwave Cells

Brightwave supplies battery packs for Heron. Project Lantern, run by Leo Marsh, is redesigning the pack to charge
faster. Brightwave asked for a two-year volume commitment before they change their production line. Ines Duarte in
finance must approve any commitment over one year.
""",
    "Operations report: Rotterdam trial": """# Operations report: Rotterdam trial

From Femi Adeyemi, field operations lead.

## The trial

Four Heron robots have worked at Northgate Logistics' Rotterdam warehouse since January, picking parcels on the night
shift. Northgate's site manager, Clara Visser, rates the picking accuracy highly but wants fewer stoppages.

## Problems

- Two robots stopped with motor temperature alarms, which Aisha Bello's thermal limit should prevent.
- Battery swaps take too long on the night shift. Leo Marsh's Project Lantern pack would halve the time.

## Next steps

Field operations will install the new firmware in April. Clara Visser agreed to extend the trial to the end of
August, which matches the board's new launch date.
""",
    "Safety review": """# Safety review

From Hannah Cole, safety officer, to Tom Okafor and Priya Shah.

## Scope

I reviewed Heron against our safety policy after the motor overheating reports from Rotterdam.

## Findings

- No one was hurt. The robots stopped as designed when the temperature alarm tripped.
- The thermal limit in Aisha Bello's firmware must be tested by Samuel Reyes's lab before it ships, not after.
- Battery packs from Brightwave Cells need a new fire test if Project Lantern changes the cell chemistry.

## Decision

Heron may not ship to any new customer until both the motor soak test and the firmware test pass. The Rotterdam
trial with Northgate Logistics may continue under the current limits.
""",
}

QUESTIONS = {
    "local": ["Who is Joanna Lind and what is she dealing with?", "What does Aisha Bello work on?",
              "Who works with Kestrel Components?"],
    "global": ["What are the main risks across the company right now?", "What themes run through these memos?",
               "Which decisions are waiting on a test?"],
}
