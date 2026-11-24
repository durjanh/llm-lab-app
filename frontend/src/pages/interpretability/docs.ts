/*
  The model card and the datasheet on the interpretability page: the questions each asks, a worked answer for the
  invented loan model, and the Markdown the form renders. Kept apart from the page so the tests can check the
  output.
*/

export interface DocField {
  key: string;
  label: string;
  /** What a good answer covers, shown under the box. */
  hint: string;
  example: string;
}

export interface DocSection {
  heading: string;
  fields: DocField[];
}

export const MODEL_CARD: DocSection[] = [
  {
    heading: 'Model details',
    fields: [
      {
        key: 'name',
        label: 'Name and version',
        hint: 'What people will search for, and the exact version this card describes.',
        example: 'loan-repay v3 (logistic regression, 4 features)',
      },
      {
        key: 'owner',
        label: 'Owner and contact',
        hint: 'A team, not a person who might leave.',
        example: 'Credit risk analytics team; questions to the model owner on duty.',
      },
    ],
  },
  {
    heading: 'Intended use',
    fields: [
      {
        key: 'use',
        label: 'Intended use',
        hint: 'The decision it supports and who acts on its output.',
        example:
          'Ranks personal loan applications up to £15,000 by chance of repayment. An underwriter makes the decision; the score is one input.',
      },
      {
        key: 'notFor',
        label: 'Out of scope',
        hint: 'Uses people will be tempted to try that it was not built or tested for.',
        example:
          'Mortgages, business lending, setting interest rates, or declining without a person reviewing the case.',
      },
    ],
  },
  {
    heading: 'Data and evaluation',
    fields: [
      {
        key: 'data',
        label: 'Training data',
        hint: 'Where it came from, the period, and who is missing from it.',
        example:
          '600 past applications that were approved, so applicants who were declined are not represented and their outcomes are unknown.',
      },
      {
        key: 'metrics',
        label: 'Metrics',
        hint: 'Overall and for each group that matters, with the threshold used.',
        example:
          'AUC 0.79 overall. At a 0.5 threshold, approval 75% in North and 53% in South; repayment among approved 78% and 70%.',
      },
    ],
  },
  {
    heading: 'Risks and limits',
    fields: [
      {
        key: 'fairness',
        label: 'Fairness findings',
        hint: 'Gaps found between groups, what causes them, and what was decided.',
        example:
          'Years at address tracks the branch area (correlation 0.36), so it acts as a proxy. Its weight is four times what the outcomes support; removing it nearly halves the approval gap at almost no cost in AUC.',
      },
      {
        key: 'limits',
        label: 'Known limits',
        hint: 'Conditions under which the scores should not be trusted.',
        example:
          'Not validated for incomes above £110k or for applicants with no credit history. Scores drift if lending policy changes who applies.',
      },
    ],
  },
];

export const DATASHEET: DocSection[] = [
  {
    heading: 'Motivation and composition',
    fields: [
      {
        key: 'why',
        label: 'Why was it collected?',
        hint: 'The original purpose, which may differ from how it is used now.',
        example: 'To audit repayment of personal loans issued in two branch areas over three years.',
      },
      {
        key: 'what',
        label: 'What does each row represent?',
        hint: 'The unit, the number of rows, and the label.',
        example:
          'One approved loan: four applicant features at the time of application, the branch area, and whether it was repaid.',
      },
      {
        key: 'sensitive',
        label: 'Sensitive or protected information',
        hint: 'Fields that identify people or relate to protected characteristics, directly or by proxy.',
        example:
          'No names or addresses. The branch area is not protected in itself but correlates with income and renting.',
      },
    ],
  },
  {
    heading: 'Collection and labelling',
    fields: [
      {
        key: 'how',
        label: 'How was it collected?',
        hint: 'Systems, people and any sampling.',
        example:
          'Exported from the lending system. Only approved loans have outcomes, so the sample is filtered by past decisions.',
      },
      {
        key: 'label',
        label: 'How was the label decided?',
        hint: 'The rule, and where it could be wrong.',
        example:
          'Repaid means no arrears over 90 days. Loans refinanced early count as repaid, which may hide some difficulty.',
      },
    ],
  },
  {
    heading: 'Uses and maintenance',
    fields: [
      {
        key: 'uses',
        label: 'Recommended and discouraged uses',
        hint: 'What it is fit for, and what it is not.',
        example:
          'Fit for modelling repayment of small personal loans. Not fit for judging people who were declined, since none are in it.',
      },
      {
        key: 'upkeep',
        label: 'Maintenance',
        hint: 'Who keeps it, how often it is refreshed, and how errors are reported.',
        example: 'Refreshed quarterly by the data team; corrections logged with a version number.',
      },
    ],
  },
];

export type Answers = Record<string, string>;

/** The worked example's answers, used to fill the form. */
export function exampleAnswers(doc: DocSection[]): Answers {
  return Object.fromEntries(doc.flatMap((s) => s.fields.map((f) => [f.key, f.example])));
}

/** The form's answers as a Markdown document. Unanswered questions stay visible, so gaps are obvious. */
export function renderMarkdown(title: string, doc: DocSection[], answers: Answers): string {
  const lines = [`# ${title}`, ''];
  for (const s of doc) {
    lines.push(`## ${s.heading}`, '');
    for (const f of s.fields) {
      const a = (answers[f.key] ?? '').trim();
      lines.push(`**${f.label}**`, '', a || '_Not answered yet._', '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** How many questions are answered. */
export function answered(doc: DocSection[], answers: Answers): { done: number; total: number } {
  const keys = doc.flatMap((s) => s.fields.map((f) => f.key));
  return { done: keys.filter((k) => (answers[k] ?? '').trim()).length, total: keys.length };
}
