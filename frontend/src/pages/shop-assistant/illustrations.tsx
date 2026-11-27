import type { ReactNode } from 'react';

/* Product pictures without photos: one flat drawing per kind of product (the generator's 24 subcategories), filled
   in the product's own colour. They are drawn here, so a million products need no image files, nothing is fetched
   from outside, and a navy jumper looks like a navy jumper. A kind with no drawing (an imported product's own
   subcategory) returns null, and the caller shows its department's icon instead. */

/** The generator's colours (shop_data.COLOURS), as paint. */
const COLOURS: Record<string, string> = {
  black: '#2b2d2f',
  navy: '#23365e',
  grey: '#8d9295',
  white: '#f4f3ef',
  olive: '#6b7340',
  rust: '#a8532f',
  'forest green': '#2f5b40',
  sand: '#cdb48a',
  burgundy: '#6e2233',
  'sky blue': '#79b1d9',
  mustard: '#d2a32a',
  charcoal: '#42474b',
  cream: '#efe6cf',
  red: '#c23b33',
  teal: '#2f8a85',
};

/** A colour mixed towards another: `mix(c, '#000', 0.3)` is c 30% darker. */
function mix(hex: string, towards: string, amount: number): string {
  const read = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = read(hex);
  const b = read(towards);
  return `#${a
    .map((v, i) =>
      Math.round(v + (b[i] - v) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The paint for one product: its colour, a shade, a highlight and an outline that shows on white or cream. */
export interface Paint {
  c: string;
  d: string;
  l: string;
  o: string;
}

export function paint(colour: unknown, fallback: string): Paint {
  const c = (typeof colour === 'string' && COLOURS[colour.toLowerCase()]) || fallback;
  return { c, d: mix(c, '#000000', 0.28), l: mix(c, '#ffffff', 0.35), o: mix(c, '#000000', 0.55) };
}

const line = (o: string, w = 1.6) => ({
  stroke: o,
  strokeWidth: w,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
});

type Drawing = (p: Paint) => ReactNode;

const jacketBody = (p: Paint) => (
  <path d="M30 26 42 20 50 28 58 20 70 26 82 46 73 51 70 45V82H30V45L27 51 18 46Z" fill={p.c} {...line(p.o)} />
);

const DRAWINGS: Record<string, Drawing> = {
  jackets: (p) => (
    <>
      {jacketBody(p)}
      <path d="M42 20 50 34 58 20" fill={p.l} {...line(p.o)} />
      <path d="M50 34V82" {...line(p.d, 2)} />
      <path d="M35 64h8M57 64h8" {...line(p.d, 2)} />
    </>
  ),
  'waterproof jackets': (p) => (
    <>
      {jacketBody(p)}
      <path d="M38 26Q50 4 62 26Q50 32 38 26Z" fill={p.d} {...line(p.o)} />
      <path d="M50 30V82" {...line(p.o, 2.2)} />
      <path d="M32 58l10 6M68 58l-10 6" {...line(p.l, 2)} />
      <circle cx="44" cy="31" r="1.4" fill={p.o} />
      <circle cx="56" cy="31" r="1.4" fill={p.o} />
    </>
  ),
  jumpers: (p) => (
    <>
      <path d="M30 26Q50 33 70 26L84 50 76 55 70 47V82H30V47L24 55 16 50Z" fill={p.c} {...line(p.o)} />
      <path d="M40 25Q50 33 60 25" fill="none" {...line(p.d, 3)} />
      <path d="M30 76H70V82H30Z" fill={p.d} />
      <path d="M17 50 24 55 21 58 14 53Z M83 50 76 55 79 58 86 53Z" fill={p.d} />
      <path d="M36 44h28M36 54h28M36 64h28" {...line(p.l, 1.2)} opacity={0.6} />
    </>
  ),
  shirts: (p) => (
    <>
      <path d="M32 24 44 20 50 26 56 20 68 24 80 40 72 46 68 40V84H32V40L28 46 20 40Z" fill={p.c} {...line(p.o)} />
      <path d="M44 20 50 30 46 33 39 24ZM56 20 50 30 54 33 61 24Z" fill={p.l} {...line(p.o, 1.2)} />
      <path d="M50 30V84" {...line(p.d, 1.4)} />
      {[42, 54, 66, 78].map((y) => (
        <circle key={y} cx="52.5" cy={y} r="1.4" fill={p.o} />
      ))}
      <path d="M58 46h7v6h-7z" fill="none" {...line(p.d, 1.2)} />
    </>
  ),
  trousers: (p) => (
    <>
      <path d="M33 18H67L71 84H54L50 40 46 84H29Z" fill={p.c} {...line(p.o)} />
      <path d="M33 18H67V25H33Z" fill={p.d} {...line(p.o, 1.2)} />
      <path d="M50 25V38M40 30q4 4 8 0M60 30q-4 4-8 0" fill="none" {...line(p.d, 1.4)} />
    </>
  ),
  dresses: (p) => (
    <>
      <path d="M41 14H59L61 30Q65 35 62 41L77 84H23L38 41Q35 35 39 30Z" fill={p.c} {...line(p.o)} />
      <path d="M41 14 44 30M59 14 56 30" {...line(p.d, 1.4)} />
      <path d="M38 41H62" {...line(p.d, 3)} />
      <path d="M44 50 38 82M56 50 62 82" {...line(p.l, 1.2)} opacity={0.6} />
    </>
  ),
  socks: (p) => {
    const sock = (dx: number, dy: number, fill: string) => (
      <g transform={`translate(${dx} ${dy})`}>
        <path
          d="M28 16H44V54Q44 60 50 64L62 70Q69 75 65 81Q61 86 52 83L34 75Q28 72 28 66Z"
          fill={fill}
          {...line(p.o)}
        />
        <path d="M28 16H44V25H28Z" fill={p.d} />
        <path d="M58 71Q64 74 64 80" fill="none" {...line(p.d, 3)} />
      </g>
    );
    return (
      <>
        {sock(14, -4, p.d)}
        {sock(0, 4, p.c)}
      </>
    );
  },
  bedding: (p) => (
    <>
      <rect x="18" y="58" width="64" height="16" rx="6" fill={p.c} {...line(p.o)} />
      <rect x="22" y="44" width="56" height="14" rx="6" fill={p.l} {...line(p.o)} />
      <rect x="26" y="30" width="48" height="14" rx="6" fill={p.c} {...line(p.o)} />
      <path d="M30 37h40M26 51h48M22 66h56" {...line(p.d, 1.2)} strokeDasharray="3 3" />
    </>
  ),
  kitchen: (p) => (
    <>
      <path d="M66 52 91 41 93 46 69 58Z" fill={p.o} {...line(p.o)} />
      <ellipse cx="42" cy="56" rx="27" ry="19" fill={p.d} {...line(p.o)} />
      <ellipse cx="42" cy="54" rx="21" ry="13" fill={p.c} />
      <ellipse cx="36" cy="50" rx="8" ry="3.5" fill={p.l} opacity={0.5} />
    </>
  ),
  lighting: (p) => (
    <>
      <path d="M34 18H66L77 50H23Z" fill={p.c} {...line(p.o)} />
      <path d="M38 24H50L46 44H30Z" fill={p.l} opacity={0.45} />
      <rect x="48" y="50" width="4" height="25" fill={p.o} />
      <ellipse cx="50" cy="78" rx="16" ry="4.5" fill={p.d} {...line(p.o)} />
    </>
  ),
  cushions: (p) => (
    <>
      <path d="M22 24Q50 17 78 24Q85 50 78 76Q50 83 22 76Q15 50 22 24Z" fill={p.c} {...line(p.o)} />
      <path d="M28 30Q50 25 72 30Q77 50 72 70Q50 75 28 70Q23 50 28 30Z" fill="none" {...line(p.d, 1.2)} />
      <circle cx="50" cy="50" r="3" fill={p.d} {...line(p.o, 1)} />
    </>
  ),
  storage: (p) => (
    <>
      <path d="M22 40H78L72 82H28Z" fill={p.c} {...line(p.o)} />
      <rect x="19" y="35" width="62" height="7" rx="2" fill={p.d} {...line(p.o)} />
      <path d="M24 52H76M25 63H75M27 73H73" {...line(p.d, 1.6)} />
      <path d="M36 42 34 82M50 42V82M64 42 66 82" {...line(p.d, 1.2)} opacity={0.6} />
      <rect x="44" y="37" width="12" height="3" rx="1.5" fill={p.o} />
    </>
  ),
  mugs: (p) => (
    <>
      <path d="M66 44Q83 44 83 56Q83 68 66 68" fill="none" {...line(p.o, 8)} />
      <path d="M66 44Q83 44 83 56Q83 68 66 68" fill="none" {...line(p.c, 5)} />
      <rect x="26" y="32" width="42" height="50" rx="7" fill={p.c} {...line(p.o)} />
      <rect x="31" y="38" width="6" height="36" rx="3" fill={p.l} opacity={0.45} />
      <path d="M40 26q-3-3 0-6t0-6M52 26q-3-3 0-6t0-6" fill="none" {...line('#a7afa9', 1.8)} opacity={0.8} />
    </>
  ),
  headphones: (p) => (
    <>
      <path d="M24 58Q24 18 50 18Q76 18 76 58" fill="none" {...line(p.o, 9)} />
      <path d="M24 58Q24 18 50 18Q76 18 76 58" fill="none" {...line(p.c, 6)} />
      <rect x="14" y="50" width="20" height="30" rx="8" fill={p.c} {...line(p.o)} />
      <rect x="66" y="50" width="20" height="30" rx="8" fill={p.c} {...line(p.o)} />
      <rect x="29" y="55" width="6" height="20" rx="3" fill={p.d} />
      <rect x="65" y="55" width="6" height="20" rx="3" fill={p.d} />
    </>
  ),
  speakers: (p) => (
    <>
      <rect x="29" y="14" width="42" height="72" rx="9" fill={p.c} {...line(p.o)} />
      <circle cx="50" cy="61" r="14" fill={p.d} {...line(p.o)} />
      <circle cx="50" cy="61" r="5" fill={p.o} />
      <circle cx="50" cy="31" r="7" fill={p.d} {...line(p.o)} />
      <circle cx="50" cy="31" r="2.4" fill={p.o} />
    </>
  ),
  chargers: (p) => (
    <>
      <path d="M60 58Q80 58 80 72Q80 86 64 84" fill="none" {...line(p.o, 5)} />
      <path d="M60 58Q80 58 80 72Q80 86 64 84" fill="none" {...line(p.d, 3)} />
      <rect x="54" y="80" width="10" height="7" rx="2" fill={p.o} />
      <rect x="34" y="20" width="4" height="10" rx="1" fill="#8f979b" />
      <rect x="48" y="20" width="4" height="10" rx="1" fill="#8f979b" />
      <rect x="24" y="30" width="38" height="40" rx="8" fill={p.c} {...line(p.o)} />
      <circle cx="43" cy="50" r="4" fill={p.l} />
    </>
  ),
  'smart plugs': (p) => (
    <>
      <rect x="27" y="20" width="46" height="60" rx="12" fill={p.c} {...line(p.o)} />
      <circle cx="50" cy="45" r="15" fill={p.l} {...line(p.o, 1.2)} />
      <rect x="44" y="38" width="3" height="8" rx="1" fill={p.o} />
      <rect x="53" y="38" width="3" height="8" rx="1" fill={p.o} />
      <rect x="48.5" y="49" width="3" height="5" rx="1" fill={p.o} />
      <circle cx="50" cy="70" r="3.5" fill="#56c08c" {...line(p.o, 1)} />
    </>
  ),
  keyboards: (p) => (
    <>
      <rect x="10" y="34" width="80" height="34" rx="5" fill={p.c} {...line(p.o)} />
      {[0, 1, 2].map((row) =>
        Array.from({ length: 10 }, (_, k) => (
          <rect
            key={`${row}-${k}`}
            x={15 + k * 7.2 + (row === 1 ? 2 : 0)}
            y={39 + row * 8}
            width="5.4"
            height="5.4"
            rx="1.2"
            fill={p.l}
          />
        )),
      )}
      <rect x="30" y="63" width="40" height="3" rx="1.2" fill={p.l} />
    </>
  ),
  smartwatches: (p) => (
    <>
      <rect x="40" y="8" width="20" height="84" rx="7" fill={p.d} {...line(p.o)} />
      <rect x="31" y="29" width="38" height="42" rx="11" fill={p.c} {...line(p.o)} />
      <rect x="36" y="34" width="28" height="32" rx="7" fill="#17201d" />
      <path d="M42 46h16M42 53h10" {...line('#7fd1a8', 2)} />
      <rect x="69" y="44" width="4" height="10" rx="2" fill={p.o} />
    </>
  ),
  'walking boots': (p) => (
    <>
      <path d="M30 16H55L57 51Q73 53 83 61Q87 66 85 74H21Q19 60 25 51Z" fill={p.c} {...line(p.o)} />
      <rect x="19" y="72" width="68" height="9" rx="3" fill="#3a3330" {...line(p.o)} />
      <path d="M30 16H55V23H30Z" fill={p.d} />
      <path d="M36 30 50 30M36 38 51 38M36 46 52 46" {...line(p.l, 2)} />
      <path d="M57 51Q47 56 40 66" fill="none" {...line(p.d, 1.4)} />
    </>
  ),
  tents: (p) => (
    <>
      <path d="M10 80H90" {...line('#8a7f6a', 2)} />
      <path d="M14 79 50 22 86 79Z" fill={p.c} {...line(p.o)} />
      <path d="M50 22 40 79H60Z" fill={p.d} {...line(p.o, 1.2)} />
      <path d="M50 22 53 14M14 79 6 84M86 79 94 84" {...line(p.o, 1.2)} />
    </>
  ),
  rucksacks: (p) => (
    <>
      <path d="M40 22Q40 12 50 12Q60 12 60 22" fill="none" {...line(p.o, 3)} />
      <rect x="27" y="22" width="46" height="62" rx="15" fill={p.c} {...line(p.o)} />
      <path d="M27 40Q50 28 73 40V36Q73 22 50 22Q27 22 27 36Z" fill={p.d} {...line(p.o, 1.2)} />
      <rect x="35" y="54" width="30" height="22" rx="7" fill={p.d} {...line(p.o, 1.2)} />
      <path d="M40 60H60" {...line(p.l, 1.6)} />
    </>
  ),
  'sleeping bags': (p) => (
    <>
      <path d="M33 13Q50 4 67 13L71 82Q50 92 29 82Z" fill={p.c} {...line(p.o)} />
      <ellipse cx="50" cy="22" rx="10" ry="7" fill={p.d} {...line(p.o, 1.2)} />
      {[36, 48, 60, 72].map((y) => (
        <path key={y} d={`M31 ${y}Q50 ${y + 5} 69 ${y}`} fill="none" {...line(p.d, 1.4)} />
      ))}
      <path d="M62 30V78" {...line(p.l, 1.6)} />
    </>
  ),
  flasks: (p) => (
    <>
      <rect x="38" y="11" width="24" height="13" rx="3" fill={p.d} {...line(p.o)} />
      <rect x="35" y="22" width="30" height="64" rx="9" fill={p.c} {...line(p.o)} />
      <rect x="35" y="40" width="30" height="5" fill={p.l} />
      <rect x="40" y="50" width="5" height="28" rx="2.5" fill={p.l} opacity={0.45} />
    </>
  ),
};

/** The drawing for a product, or null when its kind has none. */
export function ProductDrawing({
  subcategory,
  colour,
  fallback,
}: {
  subcategory?: string;
  colour?: unknown;
  fallback: string;
}) {
  const draw = DRAWINGS[(subcategory ?? '').toLowerCase()];
  if (!draw) return null;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className="sh-pic-drawing">
      <ellipse cx="50" cy="90" rx="30" ry="4" fill="rgb(0 0 0 / 12%)" />
      {draw(paint(colour, fallback))}
    </svg>
  );
}

export const DRAWN_KINDS = Object.keys(DRAWINGS);
