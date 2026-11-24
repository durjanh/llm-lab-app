import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { ChainRule, Derivative, Descent, GradientField, LayerDemo, MatrixPlay, Vectors } from './parts';
import './ml-maths.css';

/*
  Maths for machine learning: the linear algebra and calculus a model actually uses, each idea something to move
  before its formula. Weeks 1 and 2 of the lab's 25-week course. Static; the maths is in mlmaths.ts.
*/

const SECTIONS: [string, string][] = [
  ['vectors', 'Vectors'],
  ['matrices', 'Matrices'],
  ['layer', 'A layer'],
  ['derivatives', 'Derivatives'],
  ['gradient', 'The gradient'],
  ['chain', 'The chain rule'],
  ['descent', 'Gradient descent'],
  ['code', 'In code'],
  ['used', 'Where it is used'],
];

const Week = ({ n }: { n: number }) => <span className="mm-week">Week {n}</span>;

const CODE = `import numpy as np

# Fit y = w*x + b to invented points by gradient descent on the mean squared error.
rng = np.random.default_rng(3)
x = rng.uniform(-2, 2, 50)
y = 1.7 * x - 0.4 + rng.normal(0, 0.3, 50)

w, b, lr = 0.0, 0.0, 0.1
for step in range(200):
    err = (w * x + b) - y            # forward: the prediction errors
    loss = np.mean(err ** 2)
    dw = 2 * np.mean(err * x)        # backward: the chain rule, by hand
    db = 2 * np.mean(err)
    w, b = w - lr * dw, b - lr * db  # step downhill
print(round(w, 2), round(b, 2), round(loss, 3))`;

export default function MlMathsPage() {
  return (
    <main className="page-ml-maths">
      <p className="kicker">Course · Weeks 1 and 2</p>
      <h1>Maths for machine learning</h1>
      <p className="lede">
        Most of machine learning rests on two ideas. Data and weights are vectors and matrices, and a model is a chain
        of matrix products. Training is going downhill on a loss, guided by derivatives. This page builds both from
        things you can move, and gives the formula after you have seen what it does.
      </p>
      <nav className="mm-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="vectors" className="mm-section">
        <h2>
          Vectors: direction, length and similarity <Week n={1} />
        </h2>
        <p>
          A vector is a list of numbers, and with two numbers you can draw it as an arrow. Its length is the square root
          of the sum of squares. The dot product multiplies matching entries and adds them up. It is large when two
          arrows point the same way, zero at right angles and negative when they oppose. Divide by both lengths and you
          get the cosine similarity, which ignores length and keeps only direction. That is how an{' '}
          <Link to="/embeddings">embedding search</Link> decides that two sentences mean similar things, only with
          hundreds of numbers instead of two. Drag the tips.
        </p>
        <Vectors />
      </section>

      <section id="matrices" className="mm-section">
        <h2>
          Matrices transform space <Week n={1} />
        </h2>
        <p>
          A matrix is a rule for moving every point at once. A 2×2 matrix is fully decided by where it sends the two
          unit arrows: its first column is where the x arrow lands, its second where the y arrow lands. The grid lines
          stay straight and evenly spaced, which is what makes the map linear. The determinant measures how areas
          change. When it is zero, the plane collapses onto a line and information is lost for good.
        </p>
        <MatrixPlay />
      </section>

      <section id="layer" className="mm-section">
        <h2>
          A network layer is a matrix times a vector <Week n={1} />
        </h2>
        <p>
          A dense layer stores its weights as a matrix W with one row per output unit. Given an input vector x, it
          computes W·x + b and passes each result through a simple non-linear function. Without that function, two
          layers would multiply into a single matrix and depth would add nothing. Move the inputs and watch which units
          switch on.
        </p>
        <LayerDemo />
      </section>

      <section id="derivatives" className="mm-section">
        <h2>
          Derivatives are slopes <Week n={1} />
        </h2>
        <p>
          The derivative of f at x is the slope of the curve there. Take a second point a small distance h away and draw
          the line through both: that is the secant. As h shrinks, the secant turns into the tangent and its slope
          becomes the derivative. Training only needs one fact from this: the sign of the derivative tells you which way
          to move a weight to reduce the loss.
        </p>
        <Derivative />
      </section>

      <section id="gradient" className="mm-section">
        <h2>
          Partial derivatives and the gradient <Week n={2} />
        </h2>
        <p>
          A loss depends on many weights at once. A partial derivative asks how the loss changes when you nudge one
          weight and hold the rest still. Put all of them in a vector and you have the gradient, which points in the
          direction of steepest increase. With two weights you can draw the loss as a landscape, darker where it is
          lower. Click anywhere on it.
        </p>
        <GradientField />
      </section>

      <section id="chain" className="mm-section">
        <h2>
          The chain rule, as a graph <Week n={2} />
        </h2>
        <p>
          A model is a chain of simple steps, and the chain rule says the derivative of the chain is the product of each
          step&apos;s local derivative. Drawn as a graph, that becomes a recipe. Compute the values forward, then send
          one gradient backward, with each node multiplying in its own derivative. This is backpropagation; the{' '}
          <Link to="/deep-learning">deep learning notebooks</Link> do it for whole networks.
        </p>
        <ChainRule />
      </section>

      <section id="descent" className="mm-section">
        <h2>
          Gradient descent, momentum and Adam <Week n={2} />
        </h2>
        <p>
          Gradient descent repeats one step: work out the gradient, then move a little way against it. The size of that
          step is the learning rate. Too small and training crawls. Too big and it overshoots, bounces, and can fly off.
          Momentum keeps a running velocity, so it builds speed along a consistent slope and smooths out zig-zags. Adam
          also keeps a running size for each coordinate&apos;s gradient and divides by it, so steep and shallow
          directions move at similar rates. Each landscape below shows a different way to fail: a ravine, a saddle, and
          two valleys of different depths.
        </p>
        <Descent />
        <p className="note">
          Real losses have millions of dimensions, not two, but the same failures occur: learning rates that diverge,
          long flat stretches, and solutions that depend on where you started. That is why learning-rate schedules,
          warm-up and Adam-style optimisers are the norm in practice.
        </p>
      </section>

      <section id="code" className="mm-section">
        <h2>The same thing in code</h2>
        <p>
          A straight line fitted by gradient descent, with the gradients worked out by hand. Libraries such as PyTorch
          compute those two derivative lines automatically, by building the graph from the chain rule section as the
          forward pass runs.
        </p>
        <CodeBlock html={highlight(CODE)} />
      </section>

      <section id="used" className="mm-section">
        <h2>Where this is used in the lab</h2>
        <ul>
          <li>
            <Link to="/embeddings">Embeddings and RAG</Link>: cosine similarity between sentence vectors.
          </li>
          <li>
            <Link to="/deep-learning">Deep learning notebooks</Link>: background maths, backpropagation and
            initialisation.
          </li>
          <li>
            <Link to="/training">Training lab</Link>: gradient descent on a real language model, with the loss going
            down.
          </li>
          <li>
            <Link to="/transformer">Transformer explainer</Link>: attention as dot products between query and key
            vectors.
          </li>
          <li>
            <Link to="/lora">Fine-tuning with LoRA</Link>: a weight update written as the product of two thin matrices.
          </li>
          <li>
            <Link to="/probability-stats">Probability and statistics</Link>: the other half of the maths, weeks 3 to 5.
          </li>
        </ul>
      </section>
    </main>
  );
}
