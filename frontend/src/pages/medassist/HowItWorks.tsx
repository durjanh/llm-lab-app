/**
 * How MedAssist works, as one figure: what the agent works with (the practice's instructions, its documents in
 * Foundry, and the rules locked in code), and the loop each patient message goes through. The model decides what to
 * do; the code decides what it is allowed to do. Static: it explains the flow the chat above runs.
 */

type Tone = 'plain' | 'writes' | 'foundry' | 'locked' | 'agent' | 'ok' | 'stop' | 'note';

interface BoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: Tone;
  label?: string;
  title: string;
  lines?: string[];
}

function Box({ x, y, w, h, tone, label, title, lines = [] }: BoxProps) {
  const top = label ? 22 : 0;
  return (
    <g className={`ma-flow-box ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={8} />
      {label && (
        <text x={x + 14} y={y + 19} className="ma-flow-label">
          {label}
        </text>
      )}
      <text x={x + 14} y={y + top + 22} className="ma-flow-title">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 14} y={y + top + 40 + i * 15} className="ma-flow-sub">
          {line}
        </text>
      ))}
    </g>
  );
}

function Step({ y, n, title, sub }: { y: number; n: number; title: string; sub: string }) {
  return <Box x={540} y={y} w={230} h={56} tone="plain" title={`${n}  ${title}`} lines={[sub]} />;
}

function Diamond({ cx, cy, lines }: { cx: number; cy: number; lines: string[] }) {
  return (
    <g className="ma-flow-box plain">
      <polygon points={`${cx},${cy - 36} ${cx + 78},${cy} ${cx},${cy + 36} ${cx - 78},${cy}`} />
      {lines.map((line, i) => (
        <text key={line} x={cx} y={cy - 3 + i * 15} textAnchor="middle" className="ma-flow-title small">
          {line}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d, dashed = false }: { d: string; dashed?: boolean }) {
  return <path d={d} className={`ma-flow-arrow${dashed ? ' dashed' : ''}`} markerEnd="url(#ma-flow-head)" />;
}

function Note({
  x,
  y,
  text,
  anchor = 'start',
}: {
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} className="ma-flow-note">
      {text}
    </text>
  );
}

export function HowItWorks() {
  return (
    <figure className="ma-flow card">
      <svg viewBox="0 0 1000 640" role="img" aria-labelledby="ma-flow-title ma-flow-desc">
        <title id="ma-flow-title">How MedAssist works</title>
        <desc id="ma-flow-desc">
          The agent works from the practice's instructions and documents, and calls tools whose rules are locked in
          code. Each patient message goes round a loop: the agent decides; a tool call runs in our code against the
          practice database; the rules allow or refuse it; the result goes back to the agent, until it replies.
        </desc>
        <defs>
          <marker
            id="ma-flow-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="ma-flow-head" />
          </marker>
        </defs>

        {/* What the agent works with */}
        <Box
          x={20}
          y={30}
          w={250}
          h={86}
          tone="writes"
          label="THE PRACTICE WRITES"
          title="Instructions"
          lines={['999 first · no doses', 'answers only from the documents']}
        />
        <Box
          x={20}
          y={150}
          w={250}
          h={86}
          tone="foundry"
          label="IN FOUNDRY"
          title="Practice documents"
          lines={['hours, tests, prescriptions', 'File Search reads them']}
        />
        <Box
          x={20}
          y={270}
          w={250}
          h={100}
          tone="locked"
          label="LOCKED · IN CODE"
          title="The rules, inside the tools"
          lines={['the portal fixes the patient', 'choose, then book', 'cancel in two steps · audit all']}
        />
        <text x={244} y={292} className="ma-flow-lock" aria-hidden="true">
          🔒
        </text>
        <Note x={145} y={392} anchor="middle" text="what the agent works with" />

        {/* The agent */}
        <g className="ma-flow-box agent">
          <rect x={310} y={111} width={170} height={86} rx={8} />
          <text x={395} y={147} textAnchor="middle" className="ma-flow-title light">
            MedAssist agent
          </text>
          <text x={395} y={167} textAnchor="middle" className="ma-flow-sub light">
            a model in Foundry
          </text>
        </g>
        <Arrow d="M270 73 H395 V109" />
        <Note x={286} y={66} text="guide" />
        <Arrow d="M310 190 H272" dashed />
        <Note x={276} y={208} text="searches" />
        <Arrow d="M395 197 V320 H272" dashed />
        <Note x={402} y={262} text="calls tools" />
        <Arrow d="M480 143 H538" />
        <Note x={486} y={135} text="decides" />

        {/* The loop, for each patient message */}
        <Step y={40} n={1} title="Patient writes" sub="signed in: the portal says who" />
        <Arrow d="M655 96 V124" />
        <Step y={126} n={2} title="Agent decides" sub="reply · search · or call a tool" />
        <Box
          x={800}
          y={126}
          w={180}
          h={56}
          tone="note"
          title="Search, calculate"
          lines={['Foundry runs these itself']}
        />
        <Arrow d="M770 154 H798" dashed />

        <Arrow d="M655 182 V202" />
        <Diamond cx={655} cy={240} lines={['a tool call', 'for our code?']} />
        <Arrow d="M733 240 H798" />
        <Note x={752} y={232} text="no" />
        <Box x={800} y={216} w={180} h={50} tone="ok" title="Reply in words" lines={['records panel updates']} />
        <Arrow d="M980 241 H992 V68 H772" dashed />
        <Note x={880} y={61} anchor="middle" text="next message" />

        <Arrow d="M655 276 V298" />
        <Note x={662} y={292} text="yes" />
        <Step y={300} n={3} title="Our code runs the tool" sub="against the practice database" />
        <Arrow d="M655 356 V372" />
        <Diamond cx={655} cy={410} lines={['do the rules', 'allow it?']} />
        <Arrow d="M733 410 H798" />
        <Note x={750} y={402} text="yes" />
        <Box x={800} y={386} w={180} h={50} tone="ok" title="Saved" lines={['booking · text · audit log']} />
        <Arrow d="M655 446 V468" />
        <Note x={662} y={462} text="no" />
        <Box x={560} y={470} w={190} h={50} tone="stop" title="Refused" lines={['the reason, for the agent']} />

        <Arrow d="M655 520 V548" />
        <Arrow d="M890 436 V578 H772" />
        <Step y={550} n={4} title="Result goes back" sub="the agent sees what happened" />
        <Arrow d="M540 586 H514 V170 H538" />
        <text x={505} y={378} className="ma-flow-note" transform="rotate(-90 505 378)" textAnchor="middle">
          up to 6 rounds, then a reply
        </text>
      </svg>
      <figcaption className="small muted">
        <b>How it works.</b> The practice writes the instructions and the documents; the rules are locked in code. For
        each message the agent decides what to do. Searching and calculating run in Foundry. Anything that reads or
        changes the patient's record comes back to our code, where the rules allow it or refuse it, and the result goes
        back to the agent, round after round, until it replies. The model decides what to do; the code decides what it
        is allowed to do. The same loop runs in the Python backend and in the .NET API.
      </figcaption>
    </figure>
  );
}
