import type { ReactNode } from 'react';

/* Small building blocks shared by the Delivery page's sections. */

export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Section({
  id,
  title,
  tags,
  children,
}: {
  id: string;
  title: string;
  tags: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="dl-section">
      <h2>{title}</h2>
      <p className="small muted dl-tags">{tags}</p>
      {children}
    </section>
  );
}

export function List({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}
