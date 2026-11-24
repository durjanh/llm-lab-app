import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for week 24 of the course: reinforcement learning. */

export const QUIZ: QuizQuestion[] = [
  {
    week: 24,
    q: 'With a discount factor γ of 0.9, roughly how far ahead does the agent still care about rewards?',
    options: ['About 1 step', 'About 10 steps', 'About 90 steps', 'Forever, equally'],
    answer: 1,
    why: 'A reward t steps away is worth γ^t now, and 1 / (1 − γ) = 10 is a useful rule of thumb for the horizon. At 0.99 it is about 100 steps.',
  },
  {
    week: 24,
    q: 'An epsilon-greedy bandit keeps epsilon at 0.1 for ever. What happens to its regret over a long run?',
    options: [
      'It stops growing once the best arm is found',
      'It keeps growing roughly in a straight line, because a tenth of all choices are still random',
      'It falls back to zero',
      'It grows faster than any other method can',
    ],
    answer: 1,
    why: 'Fixed random exploration never stops, so it keeps paying for picking poor arms. UCB and Thompson sampling explore less as they grow sure, so their regret flattens.',
  },
  {
    week: 24,
    q: 'How does Thompson sampling decide which arm to try?',
    options: [
      'It always picks the arm with the best average so far',
      'It picks at random with a fixed probability',
      'It draws a plausible payout rate for each arm from what it has seen, and picks the arm whose draw is highest',
      'It picks the arm it has tried least',
    ],
    answer: 2,
    why: 'Each arm keeps a belief about its payout rate. Arms it is unsure about sometimes draw high and get tried; as evidence builds, the beliefs narrow and the best arm wins nearly every draw.',
  },
  {
    week: 24,
    q: 'Value iteration needs something that Q-learning does not. What?',
    options: [
      'A reward signal',
      'The environment’s transition probabilities and rewards, written down in advance',
      'A discount factor',
      'A neural network',
    ],
    answer: 1,
    why: 'Value iteration plans with a known model of the world. Q-learning learns the same action values from experience alone, by trying actions and seeing what happens.',
  },
  {
    week: 24,
    q: 'On the cliff walk with epsilon = 0.1, why does SARSA learn a path further from the edge than Q-learning?',
    options: [
      'SARSA uses a larger learning rate',
      'SARSA learns the value of the policy it actually follows, slips included, so it prices in the chance of a random step off the cliff',
      'Q-learning cannot learn on grid worlds',
      'SARSA ignores the cliff penalty',
    ],
    answer: 1,
    why: 'Q-learning learns the best path assuming perfect play afterwards, so it hugs the edge and falls more while exploring. SARSA is on-policy: it learns what its own exploring behaviour earns, so it keeps a safe distance.',
  },
  {
    week: 24,
    q: 'In reinforcement learning from human feedback, what plays the part of the reward?',
    options: [
      'The number of tokens in the answer',
      'A reward model trained on people’s preferences between pairs of answers',
      'The next-token prediction loss',
      'The temperature setting',
    ],
    answer: 1,
    why: 'People compare answers, a reward model learns to score them the same way, and the language model is then tuned to earn high scores, with a penalty for drifting too far from where it started.',
  },
];
