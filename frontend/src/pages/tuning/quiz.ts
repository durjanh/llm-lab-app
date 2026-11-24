import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for the course weeks this page teaches: 14 (Bayesian optimisation) and 18 (tuning). */
export const QUIZ: QuizQuestion[] = [
  {
    week: 14,
    q: 'A Gaussian process has been fitted to five noise-free observations. Where is its predictive spread smallest?',
    options: [
      'Halfway between the two observations furthest apart',
      'At the observed inputs themselves',
      'At the edge of the search range',
      'It is the same everywhere',
    ],
    answer: 1,
    why: 'With no noise the process must pass through each observation, so it is almost certain there. The spread grows with distance from the data, fastest when the length-scale is short.',
  },
  {
    week: 14,
    q: 'You shorten the kernel length-scale. What happens to the posterior?',
    options: [
      'It becomes smoother and more confident between points',
      'It ignores the observations',
      'It becomes wigglier and less sure between points',
      'Only the mean changes; the spread stays the same',
    ],
    answer: 2,
    why: 'A short length-scale says points a little apart are nearly unrelated, so the mean can bend sharply and the uncertainty rises quickly away from each observation.',
  },
  {
    week: 14,
    q: 'Using the upper confidence bound μ + κσ, which change makes the search explore more?',
    options: ['A larger κ', 'A smaller κ', 'Adding observation noise of zero', 'Fewer starting points'],
    answer: 0,
    why: 'κ sets how much the spread counts against the mean. A large κ rewards uncertain regions (exploration); κ near 0 just picks the highest mean (exploitation).',
  },
  {
    week: 14,
    q: 'Why is Bayesian optimisation worth its overhead for tuning a model that takes an hour to train?',
    options: [
      'It needs no starting points',
      'It always finds the global optimum',
      'Fitting a small surrogate is cheap next to an hour of training, so choosing each trial carefully saves real time',
      'It removes the need for a validation set',
    ],
    answer: 2,
    why: 'The surrogate and the acquisition take seconds. When each evaluation is expensive, spending seconds to choose a better next trial pays back many times. For cheap functions, random search is often just as good.',
  },
  {
    week: 18,
    q: 'Only one of two hyperparameters affects the validation loss much. With nine trials, why does random search usually beat a 3 × 3 grid?',
    options: [
      'Random points are evaluated faster',
      'The grid tests only three values of the hyperparameter that matters; random search tests nine',
      'The grid cannot include the edges',
      'Random search uses the test set',
    ],
    answer: 1,
    why: 'A grid repeats each value of each hyperparameter, so most of its trials vary only the one that does not matter. Random trials each try a new value of every hyperparameter.',
  },
  {
    week: 18,
    q: 'Which range suits a learning rate you believe lies somewhere between 0.00001 and 0.1?',
    options: [
      'Uniform between 0.00001 and 0.1',
      'Uniform on a log scale between those values',
      'Only the two end points',
      'A fixed value of 0.05',
    ],
    answer: 1,
    why: 'A uniform range would put nearly every trial above 0.01. Sampling the exponent uniformly gives each order of magnitude an equal share of trials.',
  },
  {
    week: 18,
    q: 'Successive halving trains 27 configurations for 1 epoch, keeps 9 for 3 epochs, then 3 for 9. What is its main risk?',
    options: [
      'It spends more than training all 27 fully',
      'It needs a Gaussian process',
      'A slow starter that would finish best can be dropped in an early round',
      'It cannot run in parallel',
    ],
    answer: 2,
    why: 'Early rounds judge on short training. A configuration that learns slowly but ends well looks poor at first. Hyperband runs several brackets with different starting budgets to limit that risk.',
  },
  {
    week: 18,
    q: 'After 400 tuning trials scored on one validation set, the best reaches 0.91. What should you report?',
    options: [
      '0.91, since validation data was held out',
      'The mean of all 400 scores',
      'The score of the chosen settings on a test set that played no part in the search',
      'The training score of the chosen settings',
    ],
    answer: 2,
    why: 'Picking the best of 400 favours settings that happened to suit this validation set, so 0.91 is optimistic. An untouched test set, or nested cross-validation, gives an honest estimate.',
  },
];
