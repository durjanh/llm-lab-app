import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { Bandits, Cliff, Discounting, GridLab } from './interactive';
import './reinforcement-learning.css';

/*
  Reinforcement learning from bandits to Q-learning (course week 24). A static page: every simulation in rl.ts runs
  in the browser from a seeded generator, so each run repeats exactly.
*/

const SECTIONS: [string, string][] = [
  ['loop', 'The loop'],
  ['discount', 'Return and discounting'],
  ['bandits', 'Bandits'],
  ['mdp', 'Grid worlds'],
  ['cliff', 'Q-learning and SARSA'],
  ['explore', 'Exploring'],
  ['llms', 'RL in language models'],
  ['code', 'In Python'],
  ['used', 'Used in the lab'],
];

const CODE = `# Tabular Q-learning, written out in full. The environment only needs reset() and step(action).
import random

def q_learning(env, n_states, n_actions, episodes=500, alpha=0.5, gamma=0.99, epsilon=0.1, seed=0):
    rand = random.Random(seed)
    Q = [[0.0] * n_actions for _ in range(n_states)]

    def choose(s):
        if rand.random() < epsilon:                       # explore
            return rand.randrange(n_actions)
        best = max(Q[s])                                  # exploit, breaking ties at random
        return rand.choice([a for a in range(n_actions) if Q[s][a] == best])

    returns = []
    for _ in range(episodes):
        s, done, total = env.reset(), False, 0.0
        while not done:
            a = choose(s)
            s2, reward, done = env.step(a)
            target = reward if done else reward + gamma * max(Q[s2])   # SARSA would use Q[s2][choose(s2)]
            Q[s][a] += alpha * (target - Q[s][a])
            s, total = s2, total + reward
        returns.append(total)
    return Q, returns`;

function Tags({ text }: { text: string }) {
  return <p className="small muted rl-tags">Week 24 · {text}</p>;
}

export default function ReinforcementLearningPage() {
  return (
    <main className="page-reinforcement-learning">
      <p className="kicker">Course week 24</p>
      <h1>Reinforcement learning, from bandits to Q-learning</h1>
      <p className="lede">
        Supervised learning is told the right answer for every example. Reinforcement learning is told only how well it
        did, often long after the choice that mattered, and has to find good choices by trying them. This page builds it
        up in four steps you can run: rewards over time, choosing between options under uncertainty, planning when the
        rules are known, and learning when they are not.
      </p>
      <nav className="rl-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="loop" className="rl-section">
        <h2>The agent and the environment</h2>
        <Tags text="the vocabulary" />
        <div className="grid2">
          <svg viewBox="0 0 420 170" className="rl-loop" role="img" aria-labelledby="rl-loop-t">
            <title id="rl-loop-t">The agent acts; the environment returns a new state and a reward</title>
            <defs>
              <marker id="rl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L10 5L0 10z" className="rl-head" />
              </marker>
            </defs>
            <rect x="20" y="55" width="120" height="60" rx="10" className="rl-box" />
            <text x="80" y="90" textAnchor="middle" className="rl-box-t">
              Agent
            </text>
            <rect x="280" y="55" width="120" height="60" rx="10" className="rl-box" />
            <text x="340" y="90" textAnchor="middle" className="rl-box-t">
              Environment
            </text>
            <path d="M140 70 C200 20 220 20 280 70" className="rl-edge" />
            <text x="210" y="30" textAnchor="middle" className="rl-axis">
              action
            </text>
            <path d="M280 100 C220 150 200 150 140 100" className="rl-edge" />
            <text x="210" y="158" textAnchor="middle" className="rl-axis">
              new state and reward
            </text>
          </svg>
          <div>
            <p>
              At each step the <b>agent</b> sees a <b>state</b>, picks an <b>action</b>, and the <b>environment</b>{' '}
              answers with a new state and a <b>reward</b>, a single number. A <b>policy</b> is the agent’s rule for
              choosing actions. The goal is the policy that earns the most reward in total, not the most right now.
            </p>
            <p>
              That last part is what makes it hard. A move that costs a little now can open the way to a large reward
              later, and the agent has to work out which earlier choices deserve the credit.
            </p>
          </div>
        </div>
      </section>

      <section id="discount" className="rl-section">
        <h2>Return and discounting</h2>
        <Tags text="how much the future counts" />
        <p>
          The <b>return</b> is the total of the rewards from now on. Most problems weigh later rewards less, multiplying
          a reward t steps away by γ<sup>t</sup>, where γ (gamma) is the discount factor between 0 and 1. A small γ
          makes a short-sighted agent; a γ near 1 makes a patient one. Discounting also keeps the total finite when an
          episode could go on for ever.
        </p>
        <Discounting />
      </section>

      <section id="bandits" className="rl-section">
        <h2>Bandits: explore or exploit</h2>
        <Tags text="one state, many choices" />
        <p>
          The simplest case has one state and several actions. Five invented versions of a sign-up page each convert
          visitors at a rate nobody knows. Show the page that looks best so far and you may never discover a better one;
          keep trying them all and you lose sign-ups to the weak ones. The cost of not knowing is <b>regret</b>: the
          sign-ups lost compared with always showing the best page.
        </p>
        <ul>
          <li>
            <b>ε-greedy</b> shows the best page so far, except for a fixed share ε of visitors who see one at random.
          </li>
          <li>
            <b>UCB1</b> adds a bonus to each page’s average that shrinks the more it is shown, and picks the highest
            total: optimism where evidence is thin. c sets the size of the bonus.
          </li>
          <li>
            <b>Thompson sampling</b> keeps a belief about each page’s rate, draws one plausible rate from each, and
            shows the page with the highest draw. Uncertain pages sometimes draw high and get tried.
          </li>
        </ul>
        <Bandits />
        <p>
          With the defaults, ε-greedy’s regret keeps climbing in a straight line, because a tenth of visitors are still
          sent at random long after the answer is clear. UCB1 and Thompson sampling explore less as they grow sure. Try
          the textbook c = √2: on pages this close together it explores for far longer than it needs to. Bandits are
          used for exactly this kind of choice, in place of a fixed A/B test, when sending traffic to a losing option
          costs money (compare the A/B testing section of <Link to="/llmops">LLMOps</Link>).
        </p>
      </section>

      <section id="mdp" className="rl-section">
        <h2>Markov decision processes and value iteration</h2>
        <Tags text="planning when the rules are known" />
        <p>
          Add states and the choice now changes where you end up. A <b>Markov decision process</b> describes the states,
          the actions, the chance of each outcome and the reward for each. “Markov” means the next state depends only on
          the current one and the action, not on the history. Here, the states are the cells of a grid. Reaching the
          goal pays +1, the pit costs −1, every other step has a small cost, and each move can slip sideways.
        </p>
        <p>
          The <b>value</b> of a cell is the return you can expect from it if you act well. When the rules are known,
          value iteration finds the values by repeating one update until nothing changes. The best policy is then to
          move towards the highest-value neighbour. Raise the slip chance to 40% and the cell just left of the pit stops
          going up past it, because a slip to the right would drop it in. Then make each step cost 0.4: it goes up
          again, and the cell below the pit walks straight into it, because ending the episode costs less than
          wandering. The reward you choose decides the behaviour you get.
        </p>
        <GridLab />
      </section>

      <section id="cliff" className="rl-section">
        <h2>Learning from experience: Q-learning and SARSA</h2>
        <Tags text="when the rules are not known" />
        <p>
          Usually nobody can write down the slip chances. <b>Q-learning</b> learns a value for each action in each
          state, Q(s, a), from experience alone. After every step it nudges the old estimate towards what it just saw:
          the reward plus γ times the best Q-value of the next state. α (alpha) is the size of the nudge. It explores
          with ε-greedy choices, like the bandit above.
        </p>
        <p>
          <b>SARSA</b> makes one change: it nudges towards the Q-value of the action it will actually take next, random
          exploration included. That makes it learn the value of the policy it is really following, mistakes and all,
          where Q-learning learns the value of playing perfectly from the next step on. The difference shows on a cliff.
          The start and goal sit at either end of a cliff edge; each step costs 1 and a fall costs 100.
        </p>
        <Cliff />
        <p>
          Q-learning learns the shortest path, right along the edge, but while it is still exploring a random step sends
          it over, so it earns less per episode. SARSA prices in its own random steps and walks further from the edge: a
          longer path, fewer falls. Set ε to 0 and the difference disappears, because then neither agent ever takes a
          random step.
        </p>
      </section>

      <section id="explore" className="rl-section">
        <h2>Exploration, again</h2>
        <Tags text="the thread through the topic" />
        <p>
          Every method on this page balances trying things against using what it knows. ε-greedy does it bluntly, with a
          fixed share of random choices. UCB and Thompson sampling do it by how uncertain they are, which is why they
          waste less. The same balance drives Bayesian optimisation, which chooses the next hyperparameters to try by
          weighing a promising guess against an uncertain one; see <Link to="/tuning">hyperparameter tuning</Link>.
        </p>
        <p>
          Tables of values only work when the states can be listed. For large problems, such as games played from pixels
          or a robot’s joint angles, a neural network estimates Q or the policy instead. The ideas on this page stay the
          same; the table becomes a function.
        </p>
      </section>

      <section id="llms" className="rl-section">
        <h2>Reinforcement learning in language models</h2>
        <Tags text="where you meet it today" />
        <p>
          A language model generating an answer is an agent: the state is the text so far, each action is the next
          token, and the reward comes at the end, for the whole answer. In{' '}
          <b>reinforcement learning from human feedback</b> (RLHF), people compare pairs of answers, a reward model
          learns to score answers the way they do, and the language model is tuned to earn high scores with a penalty
          for straying far from where it started. In reasoning models, the reward can instead be a check that can be
          run, such as whether the maths is right or the tests pass, and methods such as GRPO compare a group of answers
          to the same question against each other.
        </p>
        <p>
          The risks are the ones from this page at a larger scale. A reward model is an imperfect stand-in for what
          people want, so a policy can learn to please the scorer instead (reward hacking). See{' '}
          <Link to="/preference-tuning">preference tuning</Link> for RLHF and DPO, and{' '}
          <Link to="/reasoning-models">reasoning models</Link> for GRPO and reward hacking.
        </p>
      </section>

      <section id="code" className="rl-section">
        <h2>In Python</h2>
        <Tags text="the update rule in a few lines" />
        <CodeBlock html={highlight(CODE)} />
      </section>

      <section id="used" className="rl-section">
        <h2>Where this is used in the lab</h2>
        <ul>
          <li>
            <Link to="/preference-tuning">Preference tuning</Link>: RLHF, reward models and DPO.
          </li>
          <li>
            <Link to="/reasoning-models">Reasoning models</Link>: GRPO, verifiable rewards and reward hacking.
          </li>
          <li>
            <Link to="/tuning">Hyperparameter tuning</Link>: exploration against exploitation in Bayesian optimisation.
          </li>
          <li>
            <Link to="/llmops">LLMOps</Link>: A/B testing, the fixed-split alternative to a bandit.
          </li>
        </ul>
        <div className="takeaways">
          <h3>What to take away</h3>
          <ul>
            <li>Reinforcement learning maximises total reward over time, so it must credit earlier choices.</li>
            <li>Every method trades exploring against exploiting; the smarter ones explore by uncertainty.</li>
            <li>Value iteration plans with known rules; Q-learning and SARSA learn the same values by trying.</li>
            <li>Off-policy (Q-learning) learns the best policy; on-policy (SARSA) learns the one it follows.</li>
            <li>In language models the reward is a stand-in for what people want, and can be gamed.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
