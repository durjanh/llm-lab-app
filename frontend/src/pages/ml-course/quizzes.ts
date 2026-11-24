/* Every week's self-check questions, gathered from the pages that teach them. */
import { QUIZ as capstone } from '@/pages/capstone/quiz';
import { QUIZ as interpretability } from '@/pages/interpretability/quiz';
import { QUIZ as maths } from '@/pages/ml-maths/quiz';
import { QUIZ as evaluation } from '@/pages/model-evaluation/quiz';
import { QUIZ as probability } from '@/pages/probability-stats/quiz';
import { QUIZ as rl } from '@/pages/reinforcement-learning/quiz';
import { QUIZ as tuning } from '@/pages/tuning/quiz';
import { QUIZ as existing } from './quizExisting';
import type { QuizQuestion } from './types';

export const ALL_QUIZ: QuizQuestion[] = [
  ...existing,
  ...maths,
  ...probability,
  ...evaluation,
  ...tuning,
  ...interpretability,
  ...rl,
  ...capstone,
];

/** The questions for one week, in the order the pages listed them. */
export const quizFor = (week: number, all: QuizQuestion[] = ALL_QUIZ) => all.filter((q) => q.week === week);
