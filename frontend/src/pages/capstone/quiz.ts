import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for week 25, the capstone. */
export const QUIZ: QuizQuestion[] = [
  {
    week: 25,
    q: 'In round 3 your best reading jumps from 0.71 to 0.93 on a black box with noticeable noise. What is the sensible next step?',
    options: [
      'Declare it the optimum and stop',
      'Spend one query near that point to check it was not a lucky reading',
      'Move all remaining queries far away',
      'Reset and start again',
    ],
    answer: 1,
    why: 'With noise, one high reading may be luck. A nearby or repeated measurement tells you whether the region is really good before you spend the rest of the budget there.',
  },
  {
    week: 25,
    q: 'Why does the capstone score regret using the clean value of your best-measured point, not your highest reading?',
    options: [
      'Clean values are easier to compute',
      'So a lucky noisy reading does not count as finding a good setting',
      'Because readings are always too low',
      'It makes no difference',
    ],
    answer: 1,
    why: 'What matters is how good the setting you would actually choose is. Scoring the clean value of that setting rewards a good choice, not a fortunate measurement.',
  },
  {
    week: 25,
    q: 'With six inputs and around 38 evaluations in all, which statement is true?',
    options: [
      'A grid with three values per input fits easily in the budget',
      'You will sample the space densely',
      'You must rely on a model’s assumptions (smoothness, a few peaks) to decide where to look',
      'Random search is guaranteed to find the optimum',
    ],
    answer: 2,
    why: 'Three values per input is 729 points. With so few evaluations in six dimensions, almost all of the space is unseen, so the surrogate’s assumptions, and your reasoning about them, decide where to measure.',
  },
  {
    week: 25,
    q: 'What makes the capstone a convincing portfolio project?',
    options: [
      'The final score alone',
      'A clear README: the problem, the method, a decision log per round, plots of progress, and what you would do differently',
      'As much code as possible',
      'Hiding the rounds where the method failed',
    ],
    answer: 1,
    why: 'Readers judge reasoning more than a number. Showing why each round’s queries were chosen, including the ones that did not work, demonstrates judgement under a budget.',
  },
];
