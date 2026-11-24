import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for weeks 6 (generalisation), 7 (measuring a classifier) and 8 (evaluating fairly). */
export const QUIZ: QuizQuestion[] = [
  {
    week: 6,
    q: 'Why keep a test set apart when you already have a validation set?',
    options: [
      'The test set is larger',
      'Choosing a model by validation score makes that score optimistic, so you need untouched data for an honest estimate',
      'The validation set is only for neural networks',
      'Test sets let you train for longer',
    ],
    answer: 1,
    why: 'Every decision made by looking at validation scores fits the validation set a little. The page shows fifty equally good models: the best validation score beats the truth, and a fresh test set brings it back down.',
  },
  {
    week: 6,
    q: 'Training error is low and validation error is high, and the gap shrinks as you add data. What is happening?',
    options: [
      'High bias: the model is too simple',
      'High variance: the model is fitting noise in a small training set',
      'The validation set is mislabelled',
      'The learning rate is too low',
    ],
    answer: 1,
    why: 'A large gap that closes with more data is the signature of variance. More data, regularisation or a simpler model all help. High bias shows as both errors high and close together.',
  },
  {
    week: 6,
    q: 'On the complexity curve, validation error falls and then rises as the polynomial degree grows. Which degree do you choose?',
    options: [
      'The highest degree, because its training error is lowest',
      'Degree 0, because it cannot overfit',
      'The degree where validation error is lowest, or a simpler one with nearly the same error',
      'Whichever degree has the largest gap between training and validation error',
    ],
    answer: 2,
    why: 'Training error always falls with complexity, so it cannot choose. The bottom of the validation curve balances bias against variance; when two are close, the simpler model is the safer bet.',
  },
  {
    week: 6,
    q: 'A model predicts next month’s sales. How should you split the data?',
    options: [
      'Shuffle all months and split at random',
      'Train on earlier months and validate and test on later ones',
      'Use the latest months for training',
      'Split by product, ignoring dates',
    ],
    answer: 1,
    why: 'A random split lets the model see the future while training, so its scores flatter it. Splitting by time copies how it will be used: trained on the past, judged on what comes next.',
  },
  {
    week: 7,
    q: 'One person in a hundred has a condition. A model calls everyone healthy. What is its accuracy and sensitivity?',
    options: ['99% and 99%', '99% and 0%', '1% and 100%', '50% and 50%'],
    answer: 1,
    why: 'It is right about the 99 healthy people, so accuracy is 99%, but it finds none of the sick ones, so sensitivity is 0%. With rare positives, accuracy hides exactly the cases you care about.',
  },
  {
    week: 7,
    q: 'You lower the decision threshold of a screening test. What usually happens?',
    options: [
      'Sensitivity rises and specificity falls',
      'Both rise',
      'Sensitivity falls and specificity rises',
      'Nothing: the threshold does not affect the confusion matrix',
    ],
    answer: 0,
    why: 'A lower threshold calls more people positive: more of the sick are caught (sensitivity up), and more of the well are sent for follow-up (specificity down).',
  },
  {
    week: 7,
    q: 'A model has an ROC AUC of 0.85. What does that mean?',
    options: [
      'It is right 85% of the time',
      '85% of its positive calls are correct',
      'A randomly chosen positive scores higher than a randomly chosen negative 85% of the time',
      'It finds 85% of positives at a threshold of 0.5',
    ],
    answer: 2,
    why: 'AUC measures ranking, across all thresholds. It says nothing about any one threshold, and it does not change with prevalence, which is why the precision–recall curve is worth reading too when positives are rare.',
  },
  {
    week: 7,
    q: 'A cumulative gains chart shows the top 10% of scores contain 40% of all buyers. What is the lift at 10%?',
    options: ['0.4', '4', '10', '40'],
    answer: 1,
    why: 'Lift is the share of positives found divided by the share contacted: 40% ÷ 10% = 4. Contacting that top tenth finds four times as many buyers as picking the same number at random.',
  },
  {
    week: 8,
    q: 'Why use stratified k-fold when positives are rare?',
    options: [
      'It makes training faster',
      'It keeps the share of positives about the same in every fold, so no fold has too few to score',
      'It removes the need for a test set',
      'It increases the number of positives',
    ],
    answer: 1,
    why: 'Plain shuffling can leave a fold with one positive or none, and sensitivity on that fold swings wildly or cannot be computed. Stratifying deals each class out evenly.',
  },
  {
    week: 8,
    q: 'You oversample the positives, then split into training and test sets. Why is the test score now too good?',
    options: [
      'Oversampling always improves models',
      'Copies of the same positive land in both sets, so the model is tested on rows it has memorised',
      'The test set is now smaller',
      'Oversampling changes the features',
    ],
    answer: 1,
    why: 'Resampling must happen inside the training data only, after the split (and inside each fold in cross-validation). Otherwise duplicates or synthetic near-copies leak test rows into training.',
  },
  {
    week: 8,
    q: 'What does nested cross-validation give you that ordinary cross-validation with tuning does not?',
    options: [
      'A faster search',
      'An estimate of performance that is not biased by the tuning, because outer folds never take part in it',
      'More training data',
      'A single best set of hyperparameters with no variance',
    ],
    answer: 1,
    why: 'The inner loop tunes on each outer training set; the outer fold scores the tuned model on data the tuning never saw. Tuning and scoring on the same folds gives an optimistic number.',
  },
  {
    week: 8,
    q: 'Your 5-fold scores are 0.71, 0.78, 0.74, 0.69 and 0.80. What should you report?',
    options: [
      'Only the best, 0.80',
      'The mean, 0.744, with the spread across folds',
      'Only the first fold',
      'The median of the training scores',
    ],
    answer: 1,
    why: 'The mean is the estimate and the spread says how much it depends on which rows were held out. Repeating the cross-validation with new shuffles narrows the uncertainty further.',
  },
];
