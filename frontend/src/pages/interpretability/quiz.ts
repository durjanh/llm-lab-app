import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for week 21 of the course: interpretability, fairness and documentation. */

export const QUIZ: QuizQuestion[] = [
  {
    week: 21,
    q: 'You shuffle one feature column in the test set and the model’s AUC hardly moves. What does that tell you?',
    options: [
      'The feature has no relationship with the label',
      'The model does not rely on that feature, given the others it has',
      'The feature must be removed before deployment',
      'The model is overfitting to that feature',
    ],
    answer: 1,
    why: 'Permutation importance measures how much the model depends on a feature. A useful feature can still score near zero if a correlated feature carries the same information.',
  },
  {
    week: 21,
    q: 'For one applicant, the Shapley values of the four features add up to what?',
    options: [
      'One',
      'The model’s prediction for that applicant',
      'The prediction for that applicant minus the average prediction over the background data',
      'The model’s accuracy',
    ],
    answer: 2,
    why: 'Shapley values share out the difference between this prediction and the baseline (the average prediction) among the features, so they always sum to that difference.',
  },
  {
    week: 21,
    q: 'The partial dependence curve for income is flat, but the ICE curves fan out in opposite directions. What is happening?',
    options: [
      'Income has no effect on anyone',
      'Income interacts with another feature, so its effect differs between people and cancels out on average',
      'The model is calibrated',
      'There are too few rows to draw the curve',
    ],
    answer: 1,
    why: 'Partial dependence is the average of the ICE curves. Opposite effects for different people average to a flat line, which hides an interaction.',
  },
  {
    week: 21,
    q: 'Two groups repay at different rates. Which statement is true for a model that is good but not perfect?',
    options: [
      'You can equalise approval rates, true positive rates and precision at the same time with the right thresholds',
      'Equal precision, equal true positive rates and equal false positive rates cannot all hold at once',
      'Using the same threshold for both groups makes every fairness metric equal',
      'Removing the group column makes the model fair',
    ],
    answer: 1,
    why: 'When base rates differ, predictive parity and equalised odds conflict unless the model is perfect. You have to choose which kind of fairness matters for the decision, and say so.',
  },
  {
    week: 21,
    q: 'The branch area is not a model input, yet approval rates differ sharply by area. What is the likeliest cause?',
    options: [
      'Random noise in the scores',
      'Other inputs, such as years at the address, track the area and act as a proxy for it',
      'The threshold is too high',
      'The model is underfitting',
    ],
    answer: 1,
    why: 'Leaving a sensitive attribute out does not remove its influence when other features correlate with it. Check correlations and group outcomes, not only the input list.',
  },
  {
    week: 21,
    q: 'Which belongs in a model card rather than a datasheet?',
    options: [
      'How the label was decided when the data was collected',
      'Who the data was originally collected for',
      'The intended use, the uses it is not fit for, and metrics broken down by group',
      'How often the dataset is refreshed',
    ],
    answer: 2,
    why: 'A datasheet documents a dataset: why it exists, how it was collected and labelled. A model card documents a model: what it is for, how it performs and for whom, and its known limits.',
  },
];
