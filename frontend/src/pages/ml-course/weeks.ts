/* The course plan: 26 weeks (an orientation week, then 25), each pointing at the lab pages that teach it. */

export interface Week {
  n: number;
  title: string;
  /** Which of the course's five parts it belongs to. */
  part: string;
  /** What a learner should be able to do by the end of the week. */
  goals: string[];
  /** Lab pages to work through, in order: [route, label]. */
  pages: [string, string][];
  /** The one thing to do with your hands this week, beyond the Python exercise. */
  task: string;
}

/** Where a week's Python work lives and how to run its tests; week 25's is the capstone folder. */
export function exerciseFor(n: number): { folder: string; brief: string; command: string } {
  if (n === 25)
    return {
      folder: 'capstone',
      brief:
        'In examples/ml-course/capstone/: improve starter.py against the same five black boxes, within their budgets, and write up the log.',
      command: '.venv/bin/python capstone/starter.py',
    };
  const folder = `week${String(n).padStart(2, '0')}`;
  return {
    folder,
    brief: `In examples/ml-course/${folder}/: fill in exercise.py until its tests pass.`,
    command: `.venv/bin/python -m pytest ${folder} -q`,
  };
}

export const PARTS = [
  'Getting ready',
  'Classical machine learning',
  'Neural networks and tuning',
  'Language models and responsible AI',
  'Beyond supervised learning',
] as const;

export const WEEKS: Week[] = [
  {
    n: 0,
    title: 'Orientation and tools',
    part: 'Getting ready',
    goals: [
      'Set up Python, a virtual environment and the course exercises',
      'Run a test, read a failure and fix it',
      'Know how the lab pages, the exercises and the quizzes fit together',
    ],
    pages: [
      ['/architecture', 'How the lab is built'],
      ['/roadmap', 'The GenAI roadmap'],
    ],
    task: 'Set up examples/ml-course, run week 0 against the exercise, then make its tests pass.',
  },
  {
    n: 1,
    title: 'Maths I: vectors, matrices and derivatives',
    part: 'Getting ready',
    goals: [
      'Read a dot product as a similarity and a matrix as a transformation',
      'Explain why one layer of a network is a matrix times a vector',
      'Find a derivative as the slope of a curve, and a gradient on a surface',
    ],
    pages: [
      ['/ml-maths', 'Maths for ML'],
      ['/embeddings', 'Embeddings, where dot products earn their keep'],
    ],
    task: 'Transform the grid with three different matrices and predict each determinant before you look.',
  },
  {
    n: 2,
    title: 'Maths II: gradient descent and optimisers',
    part: 'Getting ready',
    goals: [
      'Run gradient descent by hand and choose a learning rate that converges',
      'Explain momentum and Adam, and when each helps',
      'Follow the chain rule through a small computation graph',
    ],
    pages: [
      ['/ml-maths', 'Maths for ML: gradient descent'],
      ['/deep-learning', 'Deep learning notebooks: background maths'],
    ],
    task: 'Find a learning rate that diverges on the ravine surface, then fix it twice: once smaller, once with momentum.',
  },
  {
    n: 3,
    title: 'What machine learning is, and messy data',
    part: 'Classical machine learning',
    goals: [
      'Tell supervised from unsupervised learning, and learning from statistics',
      'Name the three kinds of missing data and what each does to a model',
      'Choose between dropping, imputing and flagging missing values',
    ],
    pages: [
      ['/ml', 'The machine learning toolbox'],
      ['/probability-stats', 'Probability and statistics: missing data'],
    ],
    task: 'On the missing-data table, make mean imputation give a biased answer and explain why.',
  },
  {
    n: 4,
    title: 'Probability: Bayes, distributions and simulation',
    part: 'Classical machine learning',
    goals: [
      "Apply Bayes' rule and see why base rates dominate",
      'Pick a distribution for a quantity and estimate its parameters',
      'Estimate a probability by Monte Carlo simulation and say how accurate it is',
    ],
    pages: [['/probability-stats', 'Probability and statistics']],
    task: 'Set the screening test to 99% accurate and the condition to 1 in 1,000. How likely is a positive to be real?',
  },
  {
    n: 5,
    title: 'Statistics: summaries, outliers, likelihood and the bootstrap',
    part: 'Classical machine learning',
    goals: [
      'Describe data with the right summary and spot outliers by two rules',
      'Fit a model by maximum likelihood and connect it to least squares',
      'Put a confidence interval on any statistic with the bootstrap',
    ],
    pages: [['/probability-stats', 'Probability and statistics']],
    task: 'Drag one outlier until the mean and the median disagree by more than 20%.',
  },
  {
    n: 6,
    title: 'Generalisation: splits, bias and variance',
    part: 'Classical machine learning',
    goals: [
      'Explain why a model needs training, validation and test data',
      'Read a learning curve and say whether more data would help',
      'Place a model on the bias–variance trade-off',
    ],
    pages: [
      ['/model-evaluation', 'Evaluating models honestly'],
      ['/deep-learning', 'Deep learning notebooks: bias–variance and double descent'],
    ],
    task: 'Find the model complexity where validation error is lowest, and say what happens either side of it.',
  },
  {
    n: 7,
    title: 'Measuring a classifier',
    part: 'Classical machine learning',
    goals: [
      'Build a confusion matrix and read sensitivity, specificity and precision from it',
      'Choose a threshold from costs, not from habit',
      'Read ROC, precision–recall and lift charts',
    ],
    pages: [
      ['/model-evaluation', 'Evaluating models honestly'],
      ['/confidence', 'Confidence and calibration'],
    ],
    task: 'Set a cost matrix where a missed case costs 20 times a false alarm and find the threshold it implies.',
  },
  {
    n: 8,
    title: 'Evaluating fairly: cross-validation, imbalance and leakage',
    part: 'Classical machine learning',
    goals: [
      'Run k-fold and stratified k-fold and report the spread, not just the mean',
      'Handle class imbalance without leaking the test data',
      'Split time-ordered data by time',
    ],
    pages: [['/model-evaluation', 'Evaluating models honestly']],
    task: 'Oversample before the split, then inside each fold, and explain the difference in score.',
  },
  {
    n: 9,
    title: 'Nearest neighbours',
    part: 'Classical machine learning',
    goals: [
      'Classify and regress with k-NN and choose k',
      'Explain why scaling features changes the answer',
      'Say why k-NN struggles in high dimensions',
    ],
    pages: [
      ['/ml', 'The toolbox: k-nearest neighbours'],
      ['/vector-db', 'Vector database: nearest neighbours at scale'],
    ],
    task: 'On the two-moons data, find the k that over-fits and the k that under-fits.',
  },
  {
    n: 10,
    title: 'Decision trees',
    part: 'Classical machine learning',
    goals: [
      'Choose a split by information gain or Gini by hand',
      'Control depth and leaf size to stop a tree memorising',
      'Read a tree as a set of rules',
    ],
    pages: [
      ['/probability-stats', 'Entropy and Gini'],
      ['/ml', 'The toolbox: decision tree'],
    ],
    task: 'Work out the best first split on the small table by hand, then check it on the page.',
  },
  {
    n: 11,
    title: 'Ensembles: bagging, random forests and boosting',
    part: 'Classical machine learning',
    goals: [
      'Explain why averaging many trees lowers variance',
      'Explain how boosting fixes the previous model’s mistakes',
      'Pick between a forest, boosting and a tabular foundation model',
    ],
    pages: [
      ['/ml', 'The toolbox: random forest and gradient boosting'],
      ['/tabular', 'Tabular foundation models'],
    ],
    task: 'Compare a single deep tree with a forest on the checkerboard data and explain the difference.',
  },
  {
    n: 12,
    title: 'Naive Bayes and logistic regression',
    part: 'Classical machine learning',
    goals: [
      'Build a naive Bayes classifier from counts',
      'Read logistic regression coefficients as odds ratios',
      'Say when a linear boundary is enough',
    ],
    pages: [
      ['/probability-stats', 'Naive Bayes'],
      ['/ml', 'The toolbox: logistic regression and naive Bayes'],
    ],
    task: 'Find a dataset on the toolbox where logistic regression fails, and one feature that would fix it.',
  },
  {
    n: 13,
    title: 'Support vector machines and kernels',
    part: 'Classical machine learning',
    goals: [
      'Explain the margin and the role of support vectors',
      'Use C to trade margin width against errors',
      'Explain what a kernel does without computing it',
    ],
    pages: [['/ml', 'The toolbox: support vector machine']],
    task: 'Separate the circle-in-a-ring data with a linear SVM (you cannot), then with a kernel.',
  },
  {
    n: 14,
    title: 'Bayesian optimisation and Gaussian processes',
    part: 'Neural networks and tuning',
    goals: [
      'Fit a Gaussian process and read its uncertainty band',
      'Compare expected improvement and upper confidence bound',
      'Explain the exploration–exploitation trade-off',
    ],
    pages: [['/tuning', 'Tuning and Bayesian optimisation']],
    task: 'Add five points to the 1D GP so the next suggestion explores, then five so it exploits.',
  },
  {
    n: 15,
    title: 'Neural networks I: from a neuron to backpropagation',
    part: 'Neural networks and tuning',
    goals: [
      'Build a shallow network and explain what each hidden unit adds',
      'Follow backpropagation through a small network',
      'Choose an activation function and say why',
    ],
    pages: [
      ['/deep-learning', 'Deep learning notebooks: shallow networks and backpropagation'],
      ['/ml', 'The toolbox: neural network (MLP)'],
    ],
    task: 'Train the toolbox MLP on two spirals with too few hidden units, then enough.',
  },
  {
    n: 16,
    title: 'Neural networks II: depth, regularisation and libraries',
    part: 'Neural networks and tuning',
    goals: [
      'Explain initialisation, residual connections and normalisation',
      'Use L2, dropout and early stopping to control over-fitting',
      'Write the same network in numpy and in PyTorch',
    ],
    pages: [
      ['/deep-learning', 'Deep learning notebooks: initialisation to batch norm'],
      ['/training', 'Watch a language model learn'],
    ],
    task: 'Watch the training lab memorise a small dataset, then stop it before it does.',
  },
  {
    n: 17,
    title: 'Convolutional networks',
    part: 'Neural networks and tuning',
    goals: [
      'Apply a filter by hand and read a feature map',
      'Explain pooling, stride and receptive field',
      'Adapt a small CNN to a new image task',
    ],
    pages: [
      ['/deep-learning', 'Deep learning notebooks: convolutional networks'],
      ['/vision', 'Images as tokens'],
    ],
    task: 'Design a 3×3 filter that finds vertical edges and check it on the exercise image.',
  },
  {
    n: 18,
    title: 'Hyperparameter tuning',
    part: 'Neural networks and tuning',
    goals: [
      'Explain why random search beats grid search when few settings matter',
      'Run successive halving on a budget',
      'Tune without over-fitting the validation set',
    ],
    pages: [
      ['/tuning', 'Tuning and Bayesian optimisation'],
      ['/model-evaluation', 'Nested cross-validation'],
    ],
    task: 'Give grid and random search the same budget on the page and compare their best scores over ten seeds.',
  },
  {
    n: 19,
    title: 'Language models I: tokens, attention and prompting',
    part: 'Language models and responsible AI',
    goals: [
      'Explain next-token prediction and what a token is',
      'Follow attention through one transformer layer',
      'Write a prompt with a clear task, context and output format',
    ],
    pages: [
      ['/what-is-gpt', 'What is GPT'],
      ['/tokens', 'Tokens'],
      ['/transformer', 'Transformer explainer'],
      ['/prompting', 'Prompting'],
    ],
    task: 'Count the tokens in one sentence in English and in another language, and explain the difference.',
  },
  {
    n: 20,
    title: 'Language models II: scale, few-shot learning and fine-tuning',
    part: 'Language models and responsible AI',
    goals: [
      'Explain how loss falls with model size, data and compute',
      'Use few-shot examples and say when fine-tuning is the better tool',
      'Fine-tune a small model with LoRA and measure the change',
    ],
    pages: [
      ['/training-at-scale', 'Training at scale'],
      ['/course', 'The LLM course'],
      ['/lora', 'Fine-tuning with LoRA'],
    ],
    task: 'Train a tiny transformer on the training lab and watch attention form.',
  },
  {
    n: 21,
    title: 'Interpretability, fairness and documentation',
    part: 'Language models and responsible AI',
    goals: [
      'Explain a prediction globally and for one person',
      'Measure group fairness and explain why the measures conflict',
      'Write a model card and a datasheet',
    ],
    pages: [
      ['/interpretability', 'Interpretability and fairness'],
      ['/delivery', 'Delivery: risks and ethics'],
    ],
    task: 'Write a model card for your capstone model so far.',
  },
  {
    n: 22,
    title: 'Unsupervised learning I: clustering',
    part: 'Beyond supervised learning',
    goals: [
      'Run k-means and choose k with the elbow and silhouette',
      'Read a dendrogram from hierarchical clustering',
      'Say when density-based clustering is the better choice',
    ],
    pages: [['/ml', 'The toolbox: k-means, hierarchical clustering and DBSCAN']],
    task: 'Find a dataset on the toolbox where k-means gives the wrong groups and DBSCAN the right ones.',
  },
  {
    n: 23,
    title: 'Unsupervised learning II: PCA and embeddings',
    part: 'Beyond supervised learning',
    goals: [
      'Project data onto its principal components and read the variance explained',
      'Use PCA to compress features before a model',
      'Connect PCA to the embedding maps used for retrieval',
    ],
    pages: [
      ['/ml', 'The toolbox: PCA'],
      ['/embeddings', 'Embeddings and RAG: the meaning map'],
    ],
    task: 'Keep enough components for 95% of the variance in the exercise data, and count them.',
  },
  {
    n: 24,
    title: 'Reinforcement learning',
    part: 'Beyond supervised learning',
    goals: [
      'Compare ε-greedy, UCB and Thompson sampling on a bandit',
      'Solve a small MDP with value iteration',
      'Train a Q-learning agent and explain its policy',
    ],
    pages: [
      ['/reinforcement-learning', 'Reinforcement learning'],
      ['/preference-tuning', 'Preference tuning: RL in language models'],
      ['/reasoning-models', 'Reasoning models'],
    ],
    task: 'On the cliff walk, explain why SARSA learns the safe path and Q-learning the short one.',
  },
  {
    n: 25,
    title: 'Capstone: optimise a black box, then ship it',
    part: 'Beyond supervised learning',
    goals: [
      'Find the best inputs of an unknown function on a fixed query budget',
      'Record each decision and its reason',
      'Publish the work as a portfolio project',
    ],
    pages: [
      ['/capstone', 'Capstone'],
      ['/tuning', 'Tuning and Bayesian optimisation'],
      ['/mlops', 'MLOps'],
    ],
    task: 'Finish every round, export your decision log, and write the README.',
  },
];
