/* A small, safe maths parser for the whiteboard's graphs. The model's expression is parsed here into a function of x
   and the parameters; nothing from the model is ever run as JavaScript. The backend checks the same whitelist first. */

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Vars = Record<string, number>;
type Fn = (v: Vars) => number;
type Token = { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

function tokens(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z_]\w*)|(\*\*|[-+*/^()]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected '${src.slice(i).trim()[0]}' in ${src}`);
    if (m[1]) out.push({ kind: 'num', value: parseFloat(m[1]) });
    else if (m[2]) out.push({ kind: 'name', value: m[2] });
    else out.push({ kind: 'op', value: m[3] === '**' ? '^' : m[3] });
    i = re.lastIndex;
  }
  return out;
}

/** Parses an expression into a function of x and the named parameters. Throws on anything else. */
export function compile(src: string, params: string[]): Fn {
  const ts = tokens(src);
  let pos = 0;
  const peek = () => ts[pos];
  const isOp = (v: string) => peek()?.kind === 'op' && peek()?.value === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected '${v}' in ${src}`);
    pos++;
  };

  function expr(): Fn {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = ts[pos++].value;
      const l = left;
      const r = term();
      left = op === '+' ? (v) => l(v) + r(v) : (v) => l(v) - r(v);
    }
    return left;
  }
  function term(): Fn {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = ts[pos++].value;
      const l = left;
      const r = unary();
      left = op === '*' ? (v) => l(v) * r(v) : (v) => l(v) / r(v);
    }
    return left;
  }
  function unary(): Fn {
    if (isOp('-')) {
      pos++;
      const u = unary();
      return (v) => -u(v);
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return power();
  }
  function power(): Fn {
    const base = primary();
    if (isOp('^')) {
      pos++;
      const exp = unary(); // right-associative: 2^3^2 = 2^(3^2)
      return (v) => Math.pow(base(v), exp(v));
    }
    return base;
  }
  function primary(): Fn {
    const t = peek();
    if (!t) throw new Error(`Unexpected end of ${src}`);
    pos++;
    if (t.kind === 'num') return () => t.value;
    if (t.kind === 'op' && t.value === '(') {
      const inner = expr();
      expect(')');
      return inner;
    }
    if (t.kind === 'name') {
      const name = t.value;
      if (FUNCS[name]) {
        expect('(');
        const arg = expr();
        expect(')');
        const f = FUNCS[name];
        return (v) => f(arg(v));
      }
      if (name === 'x') return (v) => v.x;
      if (name in CONSTS) return () => CONSTS[name];
      if (params.includes(name)) return (v) => v[name];
      throw new Error(`Unknown name '${name}' in ${src}`);
    }
    throw new Error(`Unexpected '${t.value}' in ${src}`);
  }

  const fn = expr();
  if (pos !== ts.length) throw new Error(`Unexpected '${String(ts[pos].value)}' in ${src}`);
  return fn;
}
