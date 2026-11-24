/* Shared shapes for the 25-week course: its quizzes come from the pages that teach each week. */

/** One multiple-choice self-check question, tied to a week of the course. */
export interface QuizQuestion {
  /** The course week, 0 to 25. */
  week: number;
  q: string;
  options: string[];
  /** Index into `options` of the right answer. */
  answer: number;
  /** Why the answer is right, shown after the reader picks one. */
  why: string;
}
