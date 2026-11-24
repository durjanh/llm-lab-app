import type { QuizQuestion } from '@/pages/ml-course/types';

/* Self-check questions for weeks 1 and 2 of the course, answered by the Maths for ML page. */

export const QUIZ: QuizQuestion[] = [
  {
    week: 1,
    q: 'Two embedding vectors have a cosine similarity of 0. What does that tell you?',
    options: [
      'They are identical',
      'They are at right angles, so they share no direction',
      'One of them has length zero',
      'They point in opposite directions',
    ],
    answer: 1,
    why: 'Cosine similarity is the dot product divided by both lengths. Zero means the dot product is zero, which for non-zero vectors means they are perpendicular.',
  },
  {
    week: 1,
    q: 'A 2×2 matrix has determinant 0. Which statement is true?',
    options: [
      'It rotates the plane by 90 degrees',
      'It keeps every area the same',
      'It flattens the plane onto a line or a point, so it has no inverse',
      'It mirrors the plane',
    ],
    answer: 2,
    why: 'The determinant is the factor by which areas change. Zero means every shape loses its area, so different inputs land on the same output and the step cannot be undone.',
  },
  {
    week: 1,
    q: 'A dense layer maps 3 inputs to 2 outputs. What shape is its weight matrix W in out = W·x + b?',
    options: ['3 × 2', '2 × 3', '2 × 2', '3 × 3'],
    answer: 1,
    why: 'One row per output unit and one column per input, so 2 rows and 3 columns. Each row dotted with x gives one output.',
  },
  {
    week: 1,
    q: 'Why does a network need a non-linear function such as ReLU between layers?',
    options: [
      'To make the matrices smaller',
      'Without it, stacked layers multiply into a single matrix, so depth adds nothing',
      'To stop the gradients from being computed',
      'So the weights stay positive',
    ],
    answer: 1,
    why: 'W2(W1x) equals (W2W1)x, which is one linear map. The non-linearity between them is what lets depth represent curved decision boundaries.',
  },
  {
    week: 2,
    q: 'The gradient of the loss at the current weights is (3, −1). Which way does one step of gradient descent move?',
    options: ['Towards (+3, −1)', 'Towards (−3, +1)', 'Only along the first weight', 'It depends on the loss value'],
    answer: 1,
    why: 'The gradient points uphill. Descent moves against it, scaled by the learning rate: new weights = old − lr × (3, −1).',
  },
  {
    week: 2,
    q: 'For L = (w·x + b)², what is ∂L/∂w?',
    options: ['2(w·x + b)', '2(w·x + b)·x', '2x', 'w·x + b'],
    answer: 1,
    why: 'By the chain rule: ∂L/∂r = 2r with r = w·x + b, and ∂r/∂w = x. Multiply the two.',
  },
  {
    week: 2,
    q: 'Training loss jumps around and then becomes NaN in the first few steps. What is the most likely cause?',
    options: [
      'The learning rate is too high',
      'The learning rate is too low',
      'The model has too few parameters',
      'The training set is too large',
    ],
    answer: 0,
    why: 'A step bigger than the curvature allows overshoots the valley, lands higher up and grows each time until the numbers overflow.',
  },
  {
    week: 2,
    q: 'On a long, narrow valley, why does Adam usually make faster progress than plain gradient descent?',
    options: [
      'It ignores the gradient',
      'It always uses a larger learning rate',
      'It divides each coordinate’s step by a running size of its gradient, so steep and shallow directions move at similar speeds',
      'It restarts from a random point each step',
    ],
    answer: 2,
    why: 'Plain descent must keep its step small enough for the steep direction, which makes it crawl along the shallow one. Adam rescales each direction separately.',
  },
];
