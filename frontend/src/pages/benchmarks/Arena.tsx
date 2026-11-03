import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { rng } from '../deep-learning/kit';
import { bradleyTerry, eloOnline } from './stats';
import { Slider } from './ui';

// Six models with hidden strengths on the Elo scale (mean 1000): the arena never sees these.
const MODELS = [
  { name: 'Model A', strength: 1120 },
  { name: 'Model B', strength: 1085 },
  { name: 'Model C', strength: 1070 },
  { name: 'Model D', strength: 980 },
  { name: 'Model E', strength: 925 },
  { name: 'Model F', strength: 820 },
];
const COLOURS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--brand)'];
const COLOUR_KEYS = ['s1', 's2', 's3', 's4', 's5', 'brand'] as const;
const N = MODELS.length;
const BOOTSTRAPS = 120;

/** Votes between random pairs; the winner follows the Bradley–Terry chance from the hidden strengths. */
function simulateVotes(count: number, seed: number): [number, number][] {
  const r = rng(seed);
  const votes: [number, number][] = [];
  for (let v = 0; v < count; v++) {
    const i = Math.floor(r() * N);
    let j = Math.floor(r() * (N - 1));
    if (j >= i) j++;
    const pI = 1 / (1 + 10 ** ((MODELS[j].strength - MODELS[i].strength) / 400));
    votes.push(r() < pI ? [i, j] : [j, i]);
  }
  return votes;
}

function shuffled<T>(xs: T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const rankOf = (ratings: number[]) => {
  const order = ratings.map((r, i) => [r, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  return ratings.map((_, i) => order.indexOf(i) + 1);
};

/** An arena: pairwise votes turned into ratings, by online Elo and by Bradley–Terry, with bootstrap intervals. */
export default function Arena() {
  const [count, setCount] = useState(600);
  const [k, setK] = useState(32);
  const [seed, setSeed] = useState(1);
  const [order, setOrder] = useState(0); // which shuffle of the same votes

  const votes = useMemo(() => simulateVotes(count, seed), [count, seed]);
  const ordered = useMemo(() => (order ? shuffled(votes, 1000 + order) : votes), [votes, order]);
  const elo = useMemo(() => eloOnline(N, ordered, k), [ordered, k]);
  const eloOriginal = useMemo(() => eloOnline(N, votes, k), [votes, k]);
  const bt = useMemo(() => bradleyTerry(N, ordered), [ordered]);
  const btOriginal = useMemo(() => bradleyTerry(N, votes), [votes]);

  // Bootstrap: refit on votes drawn with replacement, and read off the 2.5th and 97.5th percentiles.
  const intervals = useMemo(() => {
    const r = rng(seed * 7 + count);
    const fits = Array.from({ length: BOOTSTRAPS }, () => bradleyTerry(N, votes.map(() => votes[Math.floor(r() * votes.length)]), 1000, 80));
    return MODELS.map((_, i) => {
      const xs = fits.map((f) => f[i]).sort((a, b) => a - b);
      return [xs[Math.floor(0.025 * BOOTSTRAPS)], xs[Math.ceil(0.975 * BOOTSTRAPS) - 1]];
    });
  }, [votes, seed, count]);

  // How the Bradley–Terry ratings settle as votes come in.
  const checkpoints = useMemo(() => {
    const steps = [25, 50, 100, 200, 400, 800, 1600, 3200].filter((s) => s <= count);
    if (!steps.includes(count)) steps.push(count);
    return steps.map((s) => ({ votes: s, ratings: bradleyTerry(N, votes.slice(0, s), 1000, 120) }));
  }, [votes, count]);

  const eloRank = rankOf(elo);
  const btRank = rankOf(bt);
  const trueRank = rankOf(MODELS.map((m) => m.strength));
  const eloShift = Math.max(...elo.map((v, i) => Math.abs(v - eloOriginal[i])));
  const btShift = Math.max(...bt.map((v, i) => Math.abs(v - btOriginal[i])));
  // Neighbours on the leaderboard whose intervals overlap: the ranking cannot honestly separate them.
  const byRank = MODELS.map((_, i) => i).sort((a, b) => bt[b] - bt[a]);
  const ties = byRank.slice(1).map((i, r) => [byRank[r], i]).filter(([a, b]) => intervals[b][1] >= intervals[a][0]);
  const tieText = ties.map(([a, b]) => `${MODELS[a].name} and ${MODELS[b].name}`).join('; ');
  const lo = Math.min(...checkpoints.flatMap((c) => c.ratings), ...MODELS.map((m) => m.strength)) - 20;
  const hi = Math.max(...checkpoints.flatMap((c) => c.ratings), ...MODELS.map((m) => m.strength)) + 20;

  return (
    <section className="bm-section">
      <h2>Arenas: ratings from people's votes</h2>
      <p>
        LMArena (Chatbot Arena) shows people two anonymous answers to their own prompt and asks which is better. Thousands of
        such votes become a leaderboard. Here six models with hidden strengths are voted on at random; the winner of each vote
        follows the Bradley–Terry chance <b>1 / (1 + 10<sup>(R<sub>loser</sub> − R<sub>winner</sub>)/400</sup>)</b>.
      </p>
      <div className="bm-controls">
        <Slider label="votes" value={count} min={50} max={3200} step={50} onChange={setCount} />
        <Slider label="Elo K" value={k} min={4} max={64} step={4} onChange={setK} />
        <button className="btn small" onClick={() => setOrder((o) => o + 1)}>
          Shuffle the vote order
        </button>
        <button className="btn small" onClick={() => (setSeed((s) => s + 1), setOrder(0))}>
          New votes
        </button>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Hidden strength</th>
              <th className="num">Online Elo (rank)</th>
              <th className="num">Bradley–Terry (rank)</th>
              <th className="num">95% interval</th>
            </tr>
          </thead>
          <tbody>
            {MODELS.map((m, i) => (
              <tr key={m.name}>
                <td>
                  <i className="bm-dot" style={{ background: COLOURS[i] }} /> {m.name}
                </td>
                <td className="num">
                  {m.strength} ({trueRank[i]})
                </td>
                <td className={`num ${eloRank[i] !== trueRank[i] ? 'bm-warn' : ''}`}>
                  {elo[i].toFixed(0)} ({eloRank[i]})
                </td>
                <td className={`num ${btRank[i] !== trueRank[i] ? 'bm-warn' : ''}`}>
                  {bt[i].toFixed(0)} ({btRank[i]})
                </td>
                <td className="num">
                  {intervals[i][0].toFixed(0)}–{intervals[i][1].toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        {order === 0 ? (
          'Shuffle the vote order: the same votes, in a different order.'
        ) : (
          <>
            Same {count.toLocaleString('en-GB')} votes, shuffled {order} time{order === 1 ? '' : 's'}: online Elo moved by up to{' '}
            <b>{eloShift.toFixed(0)} points</b>; Bradley–Terry moved by <b>{btShift.toFixed(1)}</b>.
          </>
        )}{' '}
        Online Elo updates after each vote, so recent votes count more and the order matters. Bradley–Terry fits all the votes
        at once and depends only on who beat whom how often, which is why LMArena's leaderboard uses it. Amber marks a rank that differs
        from the true order.{' '}
        {ties.length
          ? `Neighbours whose intervals overlap cannot honestly be separated by this leaderboard: ${tieText}.`
          : 'No neighbouring intervals overlap: with these votes, every rank is clear.'}
      </p>
      <div className="card bm-card">
        <b className="small">How the Bradley–Terry ratings settle as votes come in</b>
        <Plot
          x={[Math.log2(checkpoints[0].votes), Math.log2(count)]}
          y={[lo, hi]}
          height={230}
          xLabel="votes (log₂)"
          yLabel="rating"
          ariaLabel="Bradley–Terry ratings against the number of votes"
          draw={(f) => {
            const xs = checkpoints.map((c) => Math.log2(c.votes));
            MODELS.forEach((m, i) => {
              f.line(xs, xs.map(() => m.strength), f.c[COLOUR_KEYS[i]], 1, [3, 4]);
              f.line(xs, checkpoints.map((c) => c.ratings[i]), f.c[COLOUR_KEYS[i]], 2.5);
            });
          }}
        />
        <p className="bm-note">Solid: fitted rating. Dashed: the hidden strength it should converge to.</p>
      </div>
    </section>
  );
}
