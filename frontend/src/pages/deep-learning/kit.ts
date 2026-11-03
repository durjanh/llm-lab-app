/* Small maths for the deep-learning notebooks: seeded randomness, ranges, activations and data. */
import { useEffect, useRef } from 'react';

/** A seeded random number generator, so a demo looks the same each time it loads. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A normally distributed sample (Box–Muller), from a uniform generator. */
export function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function linspace(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = sum(e);
  return e.map((v) => v / s);
}

export type Activation = 'relu' | 'sigmoid' | 'tanh' | 'leaky' | 'gelu' | 'swish' | 'linear' | 'heaviside';

export const ACTIVATIONS: Record<Activation, { name: string; f: (z: number) => number; df: (z: number) => number }> = {
  relu: { name: 'ReLU', f: (z) => Math.max(0, z), df: (z) => (z > 0 ? 1 : 0) },
  leaky: { name: 'Leaky ReLU', f: (z) => (z > 0 ? z : 0.1 * z), df: (z) => (z > 0 ? 1 : 0.1) },
  sigmoid: { name: 'Sigmoid', f: sigmoid, df: (z) => sigmoid(z) * (1 - sigmoid(z)) },
  tanh: { name: 'Tanh', f: Math.tanh, df: (z) => 1 - Math.tanh(z) ** 2 },
  gelu: {
    name: 'GELU',
    f: (z) => 0.5 * z * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3))),
    df: (z) => {
      const h = 1e-4;
      const g = ACTIVATIONS.gelu.f;
      return (g(z + h) - g(z - h)) / (2 * h);
    },
  },
  swish: { name: 'Swish (SiLU)', f: (z) => z * sigmoid(z), df: (z) => sigmoid(z) + z * sigmoid(z) * (1 - sigmoid(z)) },
  heaviside: { name: 'Heaviside step', f: (z) => (z > 0 ? 1 : 0), df: () => 0 },
  linear: { name: 'Linear (none)', f: (z) => z, df: () => 1 },
};

/** Runs `step` once per animation frame while `running`; `step` may return false to stop. */
export function useAnimation(running: boolean, step: () => boolean | void): void {
  const latest = useRef(step);
  latest.current = step;
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const tick = () => {
      if (latest.current() === false) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
}

/** Formats a number for a readout: a few significant figures, no "-0". */
export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) < 1e-12) return '0';
  const a = Math.abs(v);
  return a >= 1e4 || a < 1e-3 ? v.toExponential(2) : String(+v.toPrecision(digits));
}
