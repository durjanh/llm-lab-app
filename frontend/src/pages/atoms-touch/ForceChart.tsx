import { REST_GAP, force, formatForce, formatLength, type FilmState } from './film';

/* The force between one pair of atoms against the distance between their centres, worked out by the page from the
   same formula the film uses. The dot is where the film is now. */

const [W, H] = [460, 250];
const PAD = { left: 52, right: 14, top: 14, bottom: 38 };
const [R0, R1] = [0.255e-9, 0.9e-9]; // metres along the bottom
const [F0, F1] = [-8e-12, 60e-12]; // newtons up the side

const x = (r: number) => PAD.left + ((r - R0) / (R1 - R0)) * (W - PAD.left - PAD.right);
const y = (f: number) => H - PAD.bottom - ((Math.min(F1, f) - F0) / (F1 - F0)) * (H - PAD.top - PAD.bottom);

const CURVE = Array.from({ length: 260 }, (_, i) => R0 + ((R1 - R0) * i) / 259)
  .map((r, i) => `${i ? 'L' : 'M'}${x(r).toFixed(1)},${y(force(r)).toFixed(1)}`)
  .join(' ');

export function ForceChart({ state }: { state: FilmState }) {
  const inRange = state.gap <= R1;
  const f = state.force;
  return (
    <figure className="at-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Force between two atoms against the distance between them">
        <rect x={x(R0)} y={PAD.top} width={x(REST_GAP) - x(R0)} height={y(0) - PAD.top} className="at-zone push" />
        <rect x={x(REST_GAP)} y={y(0)} width={x(R1) - x(REST_GAP)} height={y(F0) - y(0)} className="at-zone pull" />
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="at-axis" />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} className="at-axis" />
        {[0, 20e-12, 40e-12, 60e-12].map((v) => (
          <text key={v} x={PAD.left - 6} y={y(v) + 4} textAnchor="end" className="at-tick">
            {(v * 1e12).toFixed(0)}
          </text>
        ))}
        {[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((nm) => (
          <text key={nm} x={x(nm * 1e-9)} y={H - PAD.bottom + 15} textAnchor="middle" className="at-tick">
            {nm.toFixed(1)}
          </text>
        ))}
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 4} textAnchor="middle" className="at-label">
          Distance between the two atoms’ centres (nanometres)
        </text>
        <text
          transform={`translate(13 ${(PAD.top + H - PAD.bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
          className="at-label"
        >
          Force (piconewtons)
        </text>
        <text x={x(REST_GAP) + 8} y={PAD.top + 26} className="at-note">
          Push: the clouds cannot overlap
        </text>
        <text x={x(0.47e-9)} y={y(F0) - 6} className="at-note">
          Pull: weak attraction
        </text>
        <path d={CURVE} className="at-curve" />
        <line x1={x(REST_GAP)} x2={x(REST_GAP)} y1={y(0) - 5} y2={y(0) + 5} className="at-axis" />
        {inRange ? (
          <circle cx={x(state.gap)} cy={y(f)} r={6} className="at-dot" data-testid="force-dot" />
        ) : (
          <text x={W - PAD.right - 4} y={y(0) - 8} textAnchor="end" className="at-note">
            The film is far off to the right →
          </text>
        )}
      </svg>
      <figcaption className="small" data-testid="force-text">
        {inRange ? (
          <>
            Now: centres {formatLength(state.gap)} apart, force on one pair of atoms{' '}
            <b>
              {formatForce(f)}
              {Math.abs(f) < 5e-14 ? '' : f > 0 ? ' (push)' : ' (pull)'}
            </b>
            .
          </>
        ) : (
          <>
            Now: {formatLength(state.shownGap)} apart. The atoms are far too distant to feel each other: no force yet.
          </>
        )}
      </figcaption>
    </figure>
  );
}
