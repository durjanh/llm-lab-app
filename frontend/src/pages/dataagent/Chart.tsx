import type { DataQueryResult as QueryResult, Viz } from '@/services';

const COLOURS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', '#a855f7', '#14b8a6', '#eab308'];
const W = 760;
const H = 300;
const PAD = { l: 52, r: 12, t: 12, b: 40 };

export const label = (col: string) => {
  const [name, tf] = col.split(':');
  const last = name.split('.').pop() ?? name;
  const words = last.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return tf ? `${words} (${tf.replace('_', ' ')})` : words;
};
/** Whole numbers with separators; small ratios keep two significant figures, so 0.014 does not read as 0.01. */
const num = (v: number) =>
  Math.abs(v) >= 1000
    ? v.toLocaleString('en-GB', { maximumFractionDigits: 0 })
    : Math.abs(v) < 1 && v !== 0
      ? String(+v.toPrecision(2))
      : String(+v.toFixed(2));

/** A tidy step for four gridlines: 1, 2 or 5 times a power of ten. */
const niceStep = (max: number) => {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
};
/** Calendar timeframes; the newest of these is the current period, which has not finished yet. */
const CALENDAR = ['date', 'week', 'month', 'quarter', 'year'];

/** Rows as series: one per measure, or one per value of the series column. */
function series(rows: QueryResult['rows'], viz: Viz): { name: string; points: Map<string, number> }[] {
  const x = viz.x!;
  const ys = viz.y?.length ? viz.y : [];
  if (viz.series) {
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const key = String(r[viz.series] ?? '—');
      if (!out.has(key)) out.set(key, new Map());
      out.get(key)!.set(String(r[x]), Number(r[ys[0]] ?? 0));
    }
    return [...out].slice(0, 8).map(([name, points]) => ({ name, points }));
  }
  return ys.map((y) => ({ name: label(y), points: new Map(rows.map((r) => [String(r[x]), Number(r[y] ?? 0)])) }));
}

export function Table({ rows, columns, max = 200 }: { rows: QueryResult['rows']; columns: string[]; max?: number }) {
  return (
    <div className="da-table-wrap">
      <table className="da-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{label(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} className={typeof r[c] === 'number' ? 'n' : ''}>
                  {r[c] === null ? '∅' : typeof r[c] === 'number' ? num(r[c] as number) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && (
        <p className="small muted">
          First {max} of {rows.length} rows.
        </p>
      )}
    </div>
  );
}

/** Line, area, bar, a single number, or a table, from the rows and the visualisation spec. */
export function Chart({
  rows,
  columns,
  viz,
  height = H,
}: {
  rows: QueryResult['rows'];
  columns: string[];
  viz: Viz;
  height?: number;
}) {
  if (viz.kind === 'table' || !viz.x || !rows.length) {
    if (viz.kind === 'number' && rows.length) {
      const col = viz.y?.[0] ?? columns[columns.length - 1];
      return (
        <div className="da-number">
          <b>{num(Number(rows[0][col] ?? 0))}</b>
          <span>{label(col)}</span>
        </div>
      );
    }
    return <Table rows={rows} columns={columns} />;
  }
  if (viz.kind === 'number') {
    const col = viz.y?.[0] ?? columns[columns.length - 1];
    return (
      <div className="da-number">
        <b>{num(Number(rows[0][col] ?? 0))}</b>
        <span>{label(col)}</span>
      </div>
    );
  }
  const s = series(rows, viz);
  // A semantic column says its timeframe (merged_at:month); a SQL column is a period if its values look like one.
  const dated = rows.every((r) => r[viz.x!] === null || /^\d{4}(-\d{2}|-Q\d)?(-\d{2})?$/.test(String(r[viz.x!])));
  const tf = viz.x.split(':')[1] ?? (dated ? 'period' : undefined);
  const calendar = CALENDAR.includes(tf) || tf === 'period';
  const xs = [...new Set(rows.filter((r) => !calendar || r[viz.x!] !== null).map((r) => String(r[viz.x!])))];
  if (calendar) xs.sort(); // no null period on a time axis; the table still shows that row
  const partial = calendar && viz.kind !== 'bar' && xs.length > 2;
  const stacked = viz.kind === 'area' && !!viz.series;
  const totals = xs.map((x) =>
    stacked
      ? s.reduce((t, ser) => t + (ser.points.get(x) ?? 0), 0)
      : Math.max(...s.map((ser) => ser.points.get(x) ?? 0)),
  );
  const step = niceStep(Math.max(...totals) > 0 ? Math.max(...totals) : 1);
  const max = step * 4;
  const ih = height - PAD.t - PAD.b;
  const iw = W - PAD.l - PAD.r;
  const px = (i: number) => PAD.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const py = (v: number) => PAD.t + ih - (v / max) * ih;
  const ticks = [0, 1, 2, 3, 4].map((k) => k * step);
  const every = Math.max(1, Math.ceil(xs.length / 8));
  const band = iw / xs.length;
  const base = xs.map(() => 0);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} className="da-chart" role="img" aria-label={viz.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={py(t)} y2={py(t)} stroke="var(--line)" />
            <text x={PAD.l - 6} y={py(t) + 4} textAnchor="end" className="da-tick">
              {num(t)}
            </text>
          </g>
        ))}
        {xs.map(
          (x, i) =>
            i % every === 0 && (
              <text
                key={x}
                x={viz.kind === 'bar' ? PAD.l + band * (i + 0.5) : px(i)}
                y={height - PAD.b + 16}
                textAnchor="middle"
                className="da-tick"
              >
                {x.length > 12 ? x.slice(0, 12) : x}
              </text>
            ),
        )}
        {viz.kind === 'bar'
          ? s.map((ser, k) =>
              xs.map((x, i) => {
                const v = ser.points.get(x) ?? 0;
                const w = (band * 0.8) / s.length;
                return (
                  <rect
                    key={`${k}-${x}`}
                    x={PAD.l + band * i + band * 0.1 + w * k}
                    y={py(v)}
                    width={Math.max(1, w - 1)}
                    height={PAD.t + ih - py(v)}
                    fill={COLOURS[k % COLOURS.length]}
                  >
                    <title>{`${ser.name} · ${x}: ${num(v)}`}</title>
                  </rect>
                );
              }),
            )
          : s.map((ser, k) => {
              const vals = xs.map((x) => ser.points.get(x) ?? 0);
              const top = vals.map((v, i) => (stacked ? base[i] + v : v));
              const pts = top.map((v, i) => `${px(i)},${py(v)}`);
              const line = (partial ? pts.slice(0, -1) : pts).join(' ');
              const tail = partial ? pts.slice(-2).join(' ') : '';
              const area =
                viz.kind === 'area'
                  ? `${pts.join(' ')} ${[...xs.keys()]
                      .reverse()
                      .map((i) => `${px(i)},${py(stacked ? base[i] : 0)}`)
                      .join(' ')}`
                  : '';
              if (stacked) top.forEach((v, i) => (base[i] = v));
              return (
                <g key={ser.name}>
                  {area && <polygon points={area} fill={COLOURS[k % COLOURS.length]} opacity={0.35} />}
                  <polyline points={line} fill="none" stroke={COLOURS[k % COLOURS.length]} strokeWidth={1.8} />
                  {tail && (
                    <polyline
                      points={tail}
                      fill="none"
                      stroke={COLOURS[k % COLOURS.length]}
                      strokeWidth={1.8}
                      strokeDasharray="4 3"
                    />
                  )}
                </g>
              );
            })}
        <text x={PAD.l + iw / 2} y={height - 4} textAnchor="middle" className="da-axis">
          {label(viz.x)}
        </text>
      </svg>
      {(s.length > 1 || partial) && (
        <div className="da-legend">
          {s.length > 1 &&
            s.map((ser, k) => (
              <span key={ser.name}>
                <i style={{ background: COLOURS[k % COLOURS.length] }} />
                {ser.name}
              </span>
            ))}
          {partial && <span className="muted">Dashed: the current {tf}, not finished yet</span>}
        </div>
      )}
    </div>
  );
}
