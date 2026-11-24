import type { QuizQuestion } from './types';

/*
  Self-check questions for the course weeks taught by pages that were already in the lab: the toolbox of
  algorithms (/ml), the deep-learning notebooks, and the language-model pages. Four per week, written for this
  course; the explanations point back to what each page shows.
*/
export const QUIZ: QuizQuestion[] = [
  // Week 0: orientation and tools
  {
    week: 0,
    q: 'Why does the course keep its Python packages in examples/ml-course/.venv rather than the lab’s main environment?',
    options: [
      'The main environment is too slow',
      'Heavy packages such as PyTorch must not be added to the backend’s environment',
      'Python only allows one package per environment',
      'The exercises need a different Python language',
    ],
    answer: 1,
    why: 'Each example with heavy or conflicting packages gets its own environment, so the backend’s stays small and stable.',
  },
  {
    week: 0,
    q: 'You run the week’s tests on a fresh exercise file and every test fails with NotImplementedError. What does that mean?',
    options: [
      'Your set-up is broken',
      'The tests are wrong',
      'Nothing is filled in yet, which is the expected starting point',
      'PyTorch is missing',
    ],
    answer: 2,
    why: 'Each exercise function starts as a stub that raises NotImplementedError; the tests pass one by one as you fill them in.',
  },
  {
    week: 0,
    q: 'Why is a NumPy expression like (x - x.mean(axis=0)) / x.std(axis=0) preferred to a Python loop over rows?',
    options: [
      'It gives a different answer',
      'It runs the arithmetic in compiled code over whole arrays, so it is far faster and shorter',
      'Loops are not allowed in Python',
      'It uses less memory in every case',
    ],
    answer: 1,
    why: 'Vectorised operations apply one instruction to the whole array; broadcasting lines up the column statistics with every row.',
  },
  {
    week: 0,
    q: 'What does pandas’ groupby followed by mean() do?',
    options: [
      'Sorts the table by a column',
      'Splits rows by a column’s values, averages each part, and combines the results',
      'Removes duplicate rows',
      'Joins two tables',
    ],
    answer: 1,
    why: 'It is split-apply-combine: one average per group, returned as one row per group.',
  },

  // Week 3: what machine learning is
  {
    week: 3,
    q: 'What makes a problem supervised rather than unsupervised learning?',
    options: [
      'It uses a neural network',
      'Each training example comes with the answer the model should learn to give',
      'A person watches the training',
      'The data is small',
    ],
    answer: 1,
    why: 'Supervised learning learns a mapping from inputs to known labels; unsupervised learning finds structure, such as clusters, with no labels.',
  },
  {
    week: 3,
    q: 'Why must the test rows be kept apart until the very end?',
    options: [
      'They are usually lower quality',
      'They stand in for future data, so any decision that used them makes the reported score optimistic',
      'Libraries refuse to train on them',
      'They make training slower',
    ],
    answer: 1,
    why: 'A score on data that influenced the model, its settings or its preprocessing no longer estimates performance on new data.',
  },
  {
    week: 3,
    q: 'A blood test is missing far more often for younger patients. What should a model be given?',
    options: [
      'Only the rows with no gaps',
      'The gap filled with zero',
      'The gap filled (for example with the training median) and a flag saying it was missing',
      'The test value from the most similar patient in the test set',
    ],
    answer: 2,
    why: 'Here the absence itself carries information. Dropping rows biases the data; the flag keeps the signal after filling.',
  },
  {
    week: 3,
    q: 'How does machine learning differ from classical statistics, as the lab frames it?',
    options: [
      'Statistics never uses data',
      'Machine learning is judged mainly by predictions on unseen data; statistics often aims to explain and quantify effects',
      'Machine learning cannot fit a straight line',
      'They are unrelated fields',
    ],
    answer: 1,
    why: 'The methods overlap (linear and logistic regression appear in both); the emphasis differs between prediction and inference.',
  },

  // Week 9: nearest neighbours
  {
    week: 9,
    q: 'What does k-nearest neighbours learn during training?',
    options: [
      'A set of weights',
      'Nothing: it stores the training data and does its work at prediction time',
      'A decision tree',
      'The best value of k',
    ],
    answer: 1,
    why: 'The /ml page notes it does no training at all; prediction searches for the closest stored points and votes.',
  },
  {
    week: 9,
    q: 'With k = 1, the boundary on the /ml page follows every noisy point. What happens as k grows large?',
    options: [
      'The boundary becomes smoother, and eventually too smooth to follow the real shape',
      'Accuracy always rises',
      'The model stops working',
      'Training takes longer',
    ],
    answer: 0,
    why: 'Small k means high variance; large k averages over many points, raising bias. Cross-validation finds the balance.',
  },
  {
    week: 9,
    q: 'One feature is measured in thousands and another in fractions. What should you do before k-NN?',
    options: [
      'Nothing; k-NN ignores scale',
      'Drop the larger feature',
      'Standardise the features, fitted on the training rows',
      'Use a larger k',
    ],
    answer: 2,
    why: 'Distance adds up differences across features, so an unscaled large feature decides every distance by itself.',
  },
  {
    week: 9,
    q: 'Why does k-NN struggle with many features?',
    options: [
      'It cannot handle more than ten columns',
      'In many dimensions points become nearly equally far apart, so "nearest" means little',
      'It needs labels for every feature',
      'It overfits less',
    ],
    answer: 1,
    why: 'This is the curse of dimensionality: distances concentrate and neighbours stop being meaningfully similar.',
  },

  // Week 10: trees in use
  {
    week: 10,
    q: 'How does a decision tree choose each question?',
    options: [
      'At random',
      'It picks the feature and threshold that make the groups beneath most pure, for example by Gini impurity',
      'It asks the most common question first',
      'It uses the feature with the largest values',
    ],
    answer: 1,
    why: 'Each split greedily maximises the drop in impurity, weighted by the size of each side.',
  },
  {
    week: 10,
    q: 'An unlimited-depth tree scores 100% on its training data and much less on new data. What is happening?',
    options: [
      'Underfitting',
      'Overfitting: it has carved out a region for every noisy training point',
      'The data has no signal',
      'The test data is mislabelled',
    ],
    answer: 1,
    why: 'Limiting depth or leaf size, or averaging many trees, trades a little training accuracy for better generalisation.',
  },
  {
    week: 10,
    q: 'Why are trees popular with people who must explain a decision?',
    options: [
      'They are always the most accurate',
      'A shallow tree’s path is a short list of readable if-then rules',
      'They need no data',
      'They cannot overfit',
    ],
    answer: 1,
    why: 'Each prediction follows a visible path of questions, though deep trees and forests lose that readability.',
  },
  {
    week: 10,
    q: 'Do decision trees need features standardised?',
    options: [
      'Yes, always',
      'No: splits compare one feature with a threshold, so rescaling a feature does not change which rows go where',
      'Only for categorical features',
      'Only when the tree is deep',
    ],
    answer: 1,
    why: 'Unlike distance- or gradient-based models, a tree’s splits are unaffected by monotonic rescaling.',
  },

  // Week 11: ensembles
  {
    week: 11,
    q: 'What does bagging reduce?',
    options: [
      'Bias',
      'Variance: averaging trees that overfit in different ways cancels much of the noise',
      'Training time',
      'The number of features',
    ],
    answer: 1,
    why: 'Each tree sees a different bootstrap sample; their errors are partly independent and average out.',
  },
  {
    week: 11,
    q: 'What does a random forest add to bagging?',
    options: [
      'Deeper trees',
      'A random subset of features considered at each split, so the trees differ more',
      'A learning rate',
      'Labels for unlabelled data',
    ],
    answer: 1,
    why: 'Less similar trees make the average more effective, because their errors are less correlated.',
  },
  {
    week: 11,
    q: 'How does gradient boosting build its model?',
    options: [
      'Many deep trees trained independently',
      'Small trees one after another, each fitted to the errors still left, added with a small learning rate',
      'One tree, pruned',
      'A neural network on top of a tree',
    ],
    answer: 1,
    why: 'Each tree corrects the ensemble’s current residuals; more rounds fit better until held-out accuracy stops improving.',
  },
  {
    week: 11,
    q: 'On a typical business table of mixed numeric and categorical columns, which family usually scores best with little tuning?',
    options: ['k-nearest neighbours', 'Gradient-boosted trees', 'A single linear regression', 'k-means'],
    answer: 1,
    why: 'Boosted trees are the usual strong baseline on tabular data; the /tabular page compares them with a tabular foundation model.',
  },

  // Week 12: logistic regression
  {
    week: 12,
    q: 'What does logistic regression output?',
    options: [
      'A class label only',
      'A probability, from a weighted sum passed through the sigmoid',
      'A cluster number',
      'A distance',
    ],
    answer: 1,
    why: 'The sigmoid maps any score to between 0 and 1; a threshold (often 0.5) turns it into a label.',
  },
  {
    week: 12,
    q: 'What shape is logistic regression’s decision boundary on the raw inputs?',
    options: [
      'Always a circle',
      'A straight line (a flat surface in more dimensions), unless you add features such as squares',
      'Any shape at all',
      'A staircase',
    ],
    answer: 1,
    why: 'The 50% boundary is where the weighted sum is zero, which is linear in whatever features you give it.',
  },
  {
    week: 12,
    q: 'Why is logistic regression trained on log loss rather than accuracy?',
    options: [
      'Accuracy cannot be computed',
      'Log loss is smooth, so gradients exist, and it rewards honest probabilities, punishing confident mistakes hardest',
      'Log loss is always smaller',
      'It trains faster on any data',
    ],
    answer: 1,
    why: 'Accuracy is flat almost everywhere and jumps at the threshold, so gradient descent has nothing to follow.',
  },
  {
    week: 12,
    q: 'A coefficient in a logistic regression is +0.7 for a standardised feature. What does it mean?',
    options: [
      'The probability rises by 0.7',
      'Each standard deviation increase multiplies the odds by e^0.7, about 2',
      'The feature causes the outcome',
      'The feature is irrelevant',
    ],
    answer: 1,
    why: 'Coefficients act on the log-odds. They describe association in this model, not cause.',
  },

  // Week 13: support vector machines
  {
    week: 13,
    q: 'Which training points decide where a support vector machine puts its boundary?',
    options: [
      'All of them equally',
      'Only the support vectors: points on or inside the margin',
      'The points furthest from the boundary',
      'A random sample',
    ],
    answer: 1,
    why: 'Points comfortably outside the margin contribute nothing to the hinge loss, so moving them does not move the boundary.',
  },
  {
    week: 13,
    q: 'What does the C parameter trade off?',
    options: [
      'Speed against memory',
      'A wide margin against fitting every training point',
      'The number of classes',
      'Kernel width against depth',
    ],
    answer: 1,
    why: 'Large C punishes every violation, giving a narrow margin that can overfit; small C tolerates some mistakes for a wider margin.',
  },
  {
    week: 13,
    q: 'What does a kernel let an SVM do?',
    options: [
      'Train without data',
      'Draw curved boundaries by comparing points through a similarity, as if in a richer feature space, without building it',
      'Handle missing values',
      'Output probabilities directly',
    ],
    answer: 1,
    why: 'The RBF kernel separates a ring from a disc, which no straight line can.',
  },
  {
    week: 13,
    q: 'With an RBF kernel, what does a very large gamma tend to do?',
    options: [
      'Make the boundary a straight line',
      'Make each point’s influence very local, so the boundary wraps tightly round training points and overfits',
      'Remove the margin',
      'Ignore the support vectors',
    ],
    answer: 1,
    why: 'Gamma sets how quickly similarity falls with distance; large values give islands round individual points.',
  },

  // Week 15: neural networks I
  {
    week: 15,
    q: 'Why does a network need a non-linear activation such as tanh or ReLU between layers?',
    options: [
      'To make training faster',
      'Without it, stacked linear layers collapse into one linear layer and cannot bend a boundary',
      'To keep weights positive',
      'To reduce the number of weights',
    ],
    answer: 1,
    why: 'A composition of linear maps is linear; the non-linearity is what lets depth add expressive power.',
  },
  {
    week: 15,
    q: 'What does backpropagation compute?',
    options: [
      'The best learning rate',
      'How the loss changes with every weight, by the chain rule from the output back through each layer',
      'The network’s predictions',
      'Which features to drop',
    ],
    answer: 1,
    why: 'It reuses each layer’s intermediate values so all gradients cost about as much as one forward pass.',
  },
  {
    week: 15,
    q: 'Why can a single neuron not learn XOR?',
    options: [
      'XOR has too many rows',
      'XOR’s two classes cannot be separated by one straight line; a hidden layer is needed',
      'Neurons cannot output 0',
      'XOR needs a convolution',
    ],
    answer: 1,
    why: 'One neuron draws one linear boundary. A hidden layer combines several, which is enough for XOR.',
  },
  {
    week: 15,
    q: 'What is gradient checking for?',
    options: [
      'Speeding up training',
      'Confirming backpropagation’s gradients by comparing them with slow numerical differences',
      'Choosing the activation function',
      'Preventing overfitting',
    ],
    answer: 1,
    why: 'A bug in the backward pass often still trains, badly. Comparing with central differences catches it.',
  },

  // Week 16: neural networks II
  {
    week: 16,
    q: 'What does dropout do during training?',
    options: [
      'Removes training examples',
      'Switches off a random share of units at each step, so no unit can rely on particular others',
      'Lowers the learning rate',
      'Deletes layers',
    ],
    answer: 1,
    why: 'It acts like training many thinned networks and averaging them; it is turned off when the model is used.',
  },
  {
    week: 16,
    q: 'What does weight decay (L2 regularisation) favour?',
    options: [
      'Large weights',
      'Small weights, giving smoother functions that generalise better',
      'More layers',
      'Sparser data',
    ],
    answer: 1,
    why: 'It adds the squared weights to the loss, pulling every weight towards zero unless the data justifies it.',
  },
  {
    week: 16,
    q: 'The deep-learning notebooks show double descent. What is it?',
    options: [
      'Loss falling twice as fast',
      'Test error rising near the point where the model can just fit the training data, then falling again as it grows larger',
      'Training in two stages',
      'Two learning rates',
    ],
    answer: 1,
    why: 'Past the interpolation threshold, larger models can generalise better again, which the classic U-shaped curve does not predict.',
  },
  {
    week: 16,
    q: 'Why do residual (skip) connections help very deep networks train?',
    options: [
      'They reduce the number of weights',
      'They give gradients a direct path back through the layers, so they neither vanish nor shatter',
      'They replace activation functions',
      'They make the network shallower',
    ],
    answer: 1,
    why: 'Each block learns a change to its input rather than a whole new function, which keeps signals and gradients well behaved.',
  },

  // Week 17: convolutional networks
  {
    week: 17,
    q: 'Why does a convolutional layer need far fewer weights than a fully connected one on an image?',
    options: [
      'It uses smaller numbers',
      'One small filter is shared across every position in the image',
      'It ignores colour',
      'It skips every other pixel',
    ],
    answer: 1,
    why: 'Weight sharing means a pattern learned once is detected everywhere, with a handful of weights per filter.',
  },
  {
    week: 17,
    q: 'What does max pooling contribute?',
    options: [
      'More detail',
      'A smaller map that keeps each patch’s strongest response, making the output tolerant to small shifts',
      'Colour correction',
      'New labels',
    ],
    answer: 1,
    why: 'Pooling halves the resolution and keeps whether a feature appeared nearby rather than exactly where.',
  },
  {
    week: 17,
    q: 'In a trained image network, what do early and late layers tend to detect?',
    options: [
      'Both detect whole objects',
      'Early layers find edges and simple textures; later layers combine them into parts and objects',
      'Early layers find objects; later layers find edges',
      'Neither detects anything interpretable',
    ],
    answer: 1,
    why: 'Each layer builds on the last, so features grow from local edges to larger, more abstract patterns.',
  },
  {
    week: 17,
    q: 'What does a 3 by 3 filter with weights [1, 0, −1] in every row respond to?',
    options: [
      'Uniform brightness',
      'Vertical edges, where brightness changes from left to right',
      'Horizontal edges only',
      'Colour',
    ],
    answer: 1,
    why: 'It subtracts the right column from the left, so it is zero on flat areas and large across a vertical edge.',
  },

  // Week 19: language models I
  {
    week: 19,
    q: 'What is a GPT model trained to do?',
    options: [
      'Classify documents',
      'Predict the next token from the tokens before it',
      'Translate only',
      'Search the web',
    ],
    answer: 1,
    why: 'Everything else, from answering questions to writing code, emerges from next-token prediction at scale plus later tuning.',
  },
  {
    week: 19,
    q: 'What does lowering the sampling temperature do?',
    options: [
      'Makes outputs more varied',
      'Sharpens the distribution towards the likeliest tokens, making output more predictable',
      'Makes the model smaller',
      'Changes the vocabulary',
    ],
    answer: 1,
    why: 'Logits are divided by the temperature before the softmax; a small temperature exaggerates the gaps between them.',
  },
  {
    week: 19,
    q: 'In attention, why are the scores divided by the square root of the key dimension?',
    options: [
      'To save memory',
      'To keep the dot products from growing with dimension and saturating the softmax',
      'To make them positive',
      'To normalise the values',
    ],
    answer: 1,
    why: 'Dot products of random vectors grow with their length; without scaling the softmax puts almost all weight on one token.',
  },
  {
    week: 19,
    q: 'Why does a decoder-only model use a causal mask in training?',
    options: [
      'To speed it up',
      'So each position cannot see the tokens it is being trained to predict',
      'To remove padding',
      'To limit the vocabulary',
    ],
    answer: 1,
    why: 'Without the mask, predicting the next token would be trivial: the answer would be visible.',
  },

  // Week 20: language models II
  {
    week: 20,
    q: 'What do scaling laws describe?',
    options: [
      'How to resize images',
      'How loss falls predictably, roughly as a power law, as parameters, data and compute grow',
      'How to choose a tokenizer',
      'The speed of inference',
    ],
    answer: 1,
    why: 'Fitted on small runs, they predict a larger model’s loss and guide how to split a compute budget.',
  },
  {
    week: 20,
    q: 'What does few-shot prompting rely on?',
    options: [
      'Updating the model’s weights',
      'Examples in the prompt that show the task and format, learnt in context without any training',
      'A larger vocabulary',
      'A separate classifier',
    ],
    answer: 1,
    why: 'In-context learning lets a large model pick up a pattern from a handful of examples at inference time.',
  },
  {
    week: 20,
    q: 'What does LoRA train when fine-tuning?',
    options: [
      'Every weight in the model',
      'Small low-rank matrices added beside frozen weights',
      'Only the embeddings',
      'A new tokenizer',
    ],
    answer: 1,
    why: 'A rank-r update to a d by d matrix has 2dr weights instead of d², so fine-tuning fits on modest hardware.',
  },
  {
    week: 20,
    q: 'A small model is fine-tuned on a narrow task and keeps improving on its training examples but not on new ones. What is happening?',
    options: [
      'It needs a higher temperature',
      'It is memorising the training set; more varied data or fewer steps would help',
      'The tokenizer is wrong',
      'LoRA cannot be used',
    ],
    answer: 1,
    why: 'The /training page shows the same gap between memorising and learning that every model family has.',
  },

  // Week 22: clustering
  {
    week: 22,
    q: 'What does each k-means iteration do?',
    options: [
      'Merges the two closest clusters',
      'Assigns every point to its nearest centre, then moves each centre to the mean of its points',
      'Removes outliers',
      'Labels points as noise',
    ],
    answer: 1,
    why: 'The two steps repeat until assignments stop changing; each step can only lower the total squared distance.',
  },
  {
    week: 22,
    q: 'How does the elbow method suggest a value of k?',
    options: [
      'It picks the k with the lowest inertia',
      'It looks for the k after which adding clusters stops reducing inertia much',
      'It always gives k = 3',
      'It uses labels',
    ],
    answer: 1,
    why: 'Inertia always falls with k, so the lowest value is useless; the bend shows where extra clusters stop paying.',
  },
  {
    week: 22,
    q: 'On two interleaved half-moons, why does k-means fail where single-linkage clustering succeeds?',
    options: [
      'k-means needs more data',
      'k-means assumes compact, round clusters; single linkage follows chains of nearby points along any shape',
      'Single linkage uses labels',
      'k-means cannot use two clusters',
    ],
    answer: 1,
    why: 'Each k-means cluster is the region nearest a centre, which is always convex, so curved clusters are cut in half.',
  },
  {
    week: 22,
    q: 'What does DBSCAN offer that k-means does not?',
    options: [
      'Faster training on all data',
      'No need to choose k, clusters of any shape, and points labelled as noise',
      'Better results in every case',
      'Labels for each cluster',
    ],
    answer: 1,
    why: 'It grows clusters from dense core points; its settings are the neighbourhood size and the minimum number of points.',
  },

  // Week 23: PCA and embeddings
  {
    week: 23,
    q: 'What is the first principal component?',
    options: [
      'The feature with the largest values',
      'The direction along which the data varies most',
      'The average row',
      'The most common label',
    ],
    answer: 1,
    why: 'Each further component is at right angles to the previous ones and captures the most remaining variance.',
  },
  {
    week: 23,
    q: 'Why centre the data before PCA?',
    options: [
      'It is required by Python',
      'Otherwise the first component points at the mean rather than along the spread',
      'To remove outliers',
      'To make the values positive',
    ],
    answer: 1,
    why: 'PCA finds directions of variance about the mean; without centring the offset dominates.',
  },
  {
    week: 23,
    q: 'The /embeddings page squashes 384-dimensional sentence vectors to two dimensions for its map. What is lost?',
    options: [
      'Nothing',
      'Most of the variance: two components keep only part of the structure, so nearby points on the map are a rough guide',
      'The labels',
      'The vocabulary',
    ],
    answer: 1,
    why: 'Similarity search uses all dimensions; the 2-D picture is for people, not for retrieval.',
  },
  {
    week: 23,
    q: 'Why compare embeddings by cosine similarity rather than straight-line distance?',
    options: [
      'Cosine is faster to compute in every case',
      'It compares direction, which carries meaning, and ignores length, which often reflects things like text length',
      'Distances can be negative',
      'Embeddings have no length',
    ],
    answer: 1,
    why: 'Normalised vectors make the two equivalent in ranking; most embedding models expect cosine or a dot product of unit vectors.',
  },
];
