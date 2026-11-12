# Diet planner agent

An agent that asks a few questions, designs a week of meals, and remembers the person next time. The plan downloads as a PDF, a shopping list PDF and an Excel workbook. It runs on Claude, a GPT deployment or the local model.

The lab's `/diet` page and the command line share `diet.py`.

```sh
source .venv/bin/activate
python examples/diet/diet_agent.py --user alex                  # health details are not remembered
python examples/diet/diet_agent.py --user alex --consent        # allergies, conditions, weight and height may be
python examples/diet/diet_agent.py --model gpt-5.4-mini         # or the local model's id
python examples/diet/diet_agent.py --forget --user alex
```

In the chat, `/plan` prints the week, `/files` writes the three files to `generated/diet/<user>/`, `/memory` prints what is remembered and `/quit` ends.

## The model talks; code decides

| Rule | Where |
|---|---|
| Daily calories: Mifflin-St Jeor, an activity factor, the goal (−500, 0 or +300 kcal), never below 1,400 kcal (female) or 1,600 kcal (male). Protein 1.2 to 1.6 g per kg. | `targets_for`, called by the `set_profile` tool |
| No plan for under-18s. No weight loss for someone underweight (BMI under 18.5), pregnant or breastfeeding. No plan when an eating disorder is mentioned; a medical condition adds a note to see a GP or dietitian. | `targets_for` |
| A message with eating-disorder signs or a starvation target (for example "under 800 calories") gets a fixed reply pointing to the GP, Beat and NHS 111. No model sees it. | `EATING_DISORDER`, in `diet_turn` |
| The plan is saved only if it has 7 days, the right number of meals, each day within 10% of the calorie target, at least 85% of the protein target, nothing from the person's allergies, diet or dislikes, prep times within their limit, and no dinner more than twice. Otherwise the model gets the list of problems and tries again. | `Chat.check_plan`, called by the `save_week_plan` tool |
| Memory: the memory agent's store (`python/22_memory_agent.py`). Health details (allergies, conditions, body measurements) are written only if the person agreed; card numbers never. | `DietMemory.guard` |
| The shopping list totals and the files come from the checked plan. | `shopping_list`, `plan_pdf`, `shopping_pdf`, `plan_xlsx` |

Calories and protein per meal are the model's estimates; the code checks that they add up, but does not look up nutrition data. A real service would use a food database, and would need a dietitian's review before anyone relied on it.

Memory is kept in `generated/diet-memory/<user>/` (ignored by git). Tests: `pytest backend/tests/test_diet.py`.
