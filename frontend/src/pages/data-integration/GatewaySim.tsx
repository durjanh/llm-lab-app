import { useState } from 'react';
import {
  CONSUMERS,
  DEFAULT_GATEWAY,
  MINUTES,
  OUTAGE,
  simulateGateway,
  type GatewayConfig,
  type Split,
} from './gateway';

const LAYERS: [keyof Split, string, string][] = [
  ['cache', 'Cache hit', 'di-f-cache'],
  ['ptu', 'Provisioned', 'di-f-ptu'],
  ['payg', 'Pay-as-you-go', 'di-f-payg'],
  ['limited', '429 at the gateway', 'di-f-limited'],
  ['backend429', '429 from the backend', 'di-f-b429'],
  ['failed', 'Failed', 'di-f-failed'],
];

const k = (n: number) => `${Math.round(n).toLocaleString('en-GB')}k`;
const money = (n: number) => `£${n.toFixed(2)}`;

/** Twenty minutes of three apps' traffic through one AI gateway, drawn as a stacked bar per minute. */
function Chart({ minutes }: { minutes: Split[] }) {
  const w = 640;
  const h = 200;
  const pad = 26;
  const max = Math.max(1, ...minutes.map((m) => m.demand));
  const bw = (w - pad) / MINUTES;
  return (
    <svg viewBox={`0 0 ${w} ${h + 22}`} className="di-chart" role="img" aria-labelledby="di-chart-t">
      <title id="di-chart-t">Tokens each minute, by where they went</title>
      <line x1={pad} y1={h} x2={w} y2={h} className="di-axis" />
      <text x={pad - 4} y={12} textAnchor="end" className="di-tick">
        {k(max)}
      </text>
      <text x={pad - 4} y={h} textAnchor="end" className="di-tick">
        0
      </text>
      {minutes.map((m, i) => {
        let y = h;
        return (
          <g key={i}>
            {LAYERS.map(([key, , cls]) => {
              const v = m[key];
              const bh = (v / max) * (h - 10);
              y -= bh;
              return bh > 0.2 ? (
                <rect key={key} x={pad + i * bw + 2} y={y} width={bw - 4} height={bh} className={cls} />
              ) : null;
            })}
            {i % 5 === 0 && (
              <text x={pad + i * bw + bw / 2} y={h + 16} textAnchor="middle" className="di-tick">
                {i}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Sliders and switches for the gateway, the chart, and the bill per app. */
export function GatewaySim() {
  const [cfg, setCfg] = useState<GatewayConfig>(DEFAULT_GATEWAY);
  const r = simulateGateway(cfg);
  const set = <K extends keyof GatewayConfig>(key: K, v: GatewayConfig[K]) => setCfg((p) => ({ ...p, [key]: v }));
  const sum = (key: keyof Split) => r.consumers.reduce((a, t) => a + (t[key] as number), 0);
  const demand = sum('demand');

  return (
    <div className="card di-demo">
      <div className="di-sliders">
        <label>
          <span>
            Traffic <b>×{cfg.traffic.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.25}
            value={cfg.traffic}
            onChange={(e) => set('traffic', +e.target.value)}
          />
        </label>
        <label>
          <span>
            Limit per app <b>{k(cfg.limitK)} tokens a minute</b>
          </span>
          <input
            type="range"
            min={25}
            max={400}
            step={25}
            value={cfg.limitK}
            onChange={(e) => set('limitK', +e.target.value)}
          />
        </label>
        <label>
          <span>
            Provisioned capacity <b>{k(cfg.ptuK)} tokens a minute</b>
          </span>
          <input
            type="range"
            min={0}
            max={400}
            step={25}
            value={cfg.ptuK}
            onChange={(e) => set('ptuK', +e.target.value)}
          />
        </label>
      </div>
      <div className="chips di-switches">
        {(
          [
            ['cache', 'Semantic cache'],
            ['spillover', 'Spill over to pay-as-you-go'],
            ['breaker', 'Circuit breaker'],
            ['outage', `Provisioned backend fails, minutes ${OUTAGE[0]}–${OUTAGE[1] - 1}`],
          ] as [keyof GatewayConfig, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={cfg[key] ? 'chip-btn on' : 'chip-btn'}
            aria-pressed={!!cfg[key]}
            onClick={() => setCfg((p) => ({ ...p, [key]: !p[key] }))}
          >
            {label}
          </button>
        ))}
        <button type="button" className="chip-btn" onClick={() => setCfg(DEFAULT_GATEWAY)}>
          Reset
        </button>
      </div>

      <div className="di-chart-wrap">
        <Chart minutes={r.minutes} />
      </div>
      <div className="di-legend small">
        {LAYERS.map(([key, label, cls]) => (
          <span key={key}>
            <i className={cls} /> {label}
          </span>
        ))}
        <span className="muted">· the contract summariser sends a batch in minutes 5–8</span>
      </div>

      <div className="stats" aria-live="polite">
        <div className="stat">
          <div className="v">{k(demand)}</div>
          <div className="k">tokens asked for</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round((sum('cache') / demand) * 100)}%</div>
          <div className="k">answered from the cache</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round(((sum('limited') + sum('backend429')) / demand) * 100)}%</div>
          <div className="k">refused with 429</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round((sum('failed') / demand) * 100)}%</div>
          <div className="k">failed in the outage</div>
        </div>
        <div className="stat">
          <div className="v">{money(r.ptuCost + r.paygCost)}</div>
          <div className="k">bill, of which {money(r.idleCost)} idle provisioned capacity</div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>App</th>
              <th className="num">Asked</th>
              <th className="num">Cache</th>
              <th className="num">429</th>
              <th className="num">Provisioned</th>
              <th className="num">Pay-as-you-go</th>
              <th className="num">Failed</th>
              <th className="num">Charged</th>
            </tr>
          </thead>
          <tbody>
            {r.consumers.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="num">{k(t.demand)}</td>
                <td className="num">{k(t.cache)}</td>
                <td className="num">{k(t.limited + t.backend429)}</td>
                <td className="num">{k(t.ptu)}</td>
                <td className="num">{k(t.payg)}</td>
                <td className="num">{k(t.failed)}</td>
                <td className="num">{money(t.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        {CONSUMERS.map(
          (c) => `${c.name}: ${c.rpm} requests a minute of about ${c.tokens.toLocaleString('en-GB')} tokens`,
        ).join(' · ')}
        . Prices are invented for the sake of the sums. Each app is charged for the provisioned capacity it used plus
        its own pay-as-you-go tokens; idle provisioned capacity is the platform team's cost to explain.
      </p>
    </div>
  );
}
