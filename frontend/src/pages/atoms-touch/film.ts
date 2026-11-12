/* The film's script, as arithmetic. Given a time in seconds, stateAt() says how wide the gap between the two
   fingertips is, how far the camera has moved in, and which part of the story is on screen. Both pictures (the 3D
   scene and the flat cross-section) and the force chart are drawn from this one state, so they always agree.

   The gap starts at 10 mm and halves 25 times, which lands on 298 picometres: the distance at which two atoms rest
   against each other in this model. Each halving is one beat: the gap closes to half, then the camera moves in to
   twice the magnification. */

export const START_GAP = 0.01; // metres: 10 mm
export const HALVINGS = 25;
export const REST_GAP = START_GAP / 2 ** HALVINGS; // 2.98e-10 m

/* The force between one pair of atoms, as a Lennard-Jones curve. The numbers are illustrative: between those for a
   hydrogen-to-hydrogen and a carbon-to-carbon contact, and chosen so the force is zero at the resting gap. */
export const SIGMA = REST_GAP / 2 ** (1 / 6); // metres: where the energy crosses zero (0.265 nm)
export const EPSILON = 4.8e-22; // joules: the depth of the energy well (0.003 eV)

/** The force on one pair of atoms r metres apart, in newtons. Positive pushes them apart; negative pulls. */
export function force(r: number): number {
  const s6 = (SIGMA / r) ** 6;
  return ((24 * EPSILON) / r) * (2 * s6 * s6 - s6);
}

export interface Stage {
  id: string;
  title: string;
  /** Seconds. */
  from: number;
  to: number;
  /** Halvings done at the start and at the end of the stage. */
  n0: number;
  n1: number;
  scale: string;
  caption: string;
}

export const STAGES: Stage[] = [
  {
    id: 'fingertips',
    title: 'Two fingertips',
    from: 0,
    to: 6,
    n0: 0,
    n1: 3,
    scale: 'millimetres',
    caption: 'Two fingertips, 10 millimetres apart. Each time the gap halves, the camera moves in to keep it in view.',
  },
  {
    id: 'ridges',
    title: 'Skin ridges',
    from: 6,
    to: 14,
    n0: 3,
    n1: 8,
    scale: 'tenths of a millimetre',
    caption: 'The ridges of a fingerprint are about half a millimetre apart. Only their crests will meet.',
  },
  {
    id: 'cells',
    title: 'Cells',
    from: 14,
    to: 24,
    n0: 8,
    n1: 16,
    scale: 'micrometres',
    caption: 'The surface is a pavement of flat, dead skin cells, each about 30 micrometres across and 1 thick.',
  },
  {
    id: 'molecules',
    title: 'Molecules',
    from: 24,
    to: 35,
    n0: 16,
    n1: 23,
    scale: 'nanometres',
    caption: 'One cell’s surface, then its coat of fat molecules: chains of carbon atoms about 2 nanometres long.',
  },
  {
    id: 'atoms',
    title: 'Atoms',
    from: 35,
    to: 44,
    n0: 23,
    n1: 25,
    scale: 'tenths of a nanometre',
    caption:
      'Each atom is a tiny nucleus in a cloud of electrons. As the clouds come within reach they pull on each other, faintly.',
  },
  {
    id: 'push',
    title: 'The push back',
    from: 44,
    to: 56,
    n0: 25,
    n1: 25,
    scale: 'picometres',
    caption:
      'Two electrons cannot share one state, so the clouds cannot overlap. Press harder: the gap gives a few picometres and the push climbs steeply. That push is touch.',
  },
];

export const DURATION = STAGES[STAGES.length - 1].to;
const CLOSE = 0.6; // the share of each beat spent closing the gap; the rest is the camera moving in

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const ease = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

export interface FilmState {
  t: number;
  /** Index into STAGES. */
  stage: number;
  /** Whole halvings completed. */
  halvings: number;
  /** The true gap in metres. */
  gap: number;
  /** The gap as the readout shows it: stepped while it halves, live while the fingers press. */
  shownGap: number;
  /** Metres per scene unit: how far the camera has moved in. The scene is about 1.9 units tall. */
  unit: number;
  /** The gap in scene units, between 0.5 and 1. */
  sceneGap: number;
  /** How hard the fingers are pressing in the last stage, 0 to 1. */
  press: number;
  /** The camera's distance, as a multiple of its usual one: it starts further back to show both fingertips. */
  pull: number;
  /** Newtons on one pair of atoms. */
  force: number;
}

/** How hard the fingers press during the last stage: in, hold, let go. x runs 0 to 1 across the stage. */
function pressAt(x: number): number {
  if (x < 0.12) return 0;
  if (x < 0.42) return ease((x - 0.12) / 0.3);
  if (x < 0.62) return 1;
  return 1 - ease((x - 0.62) / 0.14);
}

export function stateAt(time: number): FilmState {
  const t = Math.max(0, Math.min(DURATION, time));
  let stage = STAGES.findIndex((s) => t < s.to);
  if (stage < 0) stage = STAGES.length - 1;
  const s = STAGES[stage];
  const pull = 1 + 0.55 * (1 - ease(t / 4));

  if (s.id === 'push') {
    const x = (t - s.from) / (s.to - s.from);
    const press = pressAt(x);
    // After letting go the atoms spring back a little too far, then settle.
    const after = Math.max(0, x - 0.76);
    const bounce = x > 0.76 ? 0.025 * Math.exp(-after * 22) * Math.sin(after * 60) : 0;
    const tremble = press > 0.98 ? 0.004 * Math.sin(t * 31) : 0;
    const gap = REST_GAP * (1 - 0.09 * press + bounce + tremble);
    return {
      t,
      stage,
      halvings: HALVINGS,
      gap,
      shownGap: gap,
      unit: REST_GAP,
      sceneGap: gap / REST_GAP,
      press,
      pull,
      force: force(gap),
    };
  }

  const n = s.n0 + ((s.n1 - s.n0) * (t - s.from)) / (s.to - s.from);
  const k = Math.min(Math.floor(n), HALVINGS - 1);
  const f = n - k;
  const g = START_GAP / 2 ** k;
  const closing = f < CLOSE;
  const gap = closing ? g * (1 - 0.5 * ease(f / CLOSE)) : g / 2;
  const unit = closing ? g : g * (1 - 0.5 * ease((f - CLOSE) / (1 - CLOSE)));
  const halvings = closing ? k : k + 1;
  return {
    t,
    stage,
    halvings,
    gap,
    shownGap: START_GAP / 2 ** halvings,
    unit,
    sceneGap: gap / unit,
    press: 0,
    pull,
    force: force(gap),
  };
}

/** A length in metres with the unit a person would use for it: 1.25 mm, 39.1 µm, 153 nm, 298 pm. */
export function formatLength(metres: number): string {
  const [value, unit] =
    metres >= 1e-3
      ? [metres * 1e3, 'mm']
      : metres >= 1e-6
        ? [metres * 1e6, 'µm']
        : metres >= 1e-9
          ? [metres * 1e9, 'nm']
          : [metres * 1e12, 'pm'];
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/** A force in newtons as piconewtons or nanonewtons, signed. */
export function formatForce(newtons: number): string {
  const pn = newtons * 1e12;
  if (Math.abs(pn) < 0.05) return '0 pN';
  if (Math.abs(pn) >= 1000) return `${(pn / 1000).toFixed(0)} nN`;
  return `${pn > 0 ? '+' : '−'}${Math.abs(pn).toFixed(Math.abs(pn) < 10 ? 1 : 0)} pN`;
}

/* What the surfaces are made of at each magnification. A layer fades in as the camera's scale (metres per scene
   unit) falls from `in[0]` to `in[1]`, and out from `out[0]` to `out[1]`. `natural` is the length of one layer unit:
   the fingertip is drawn in millimetres, the cells in micrometres, the molecules in nanometres. */
export interface Layer {
  id: 'dome' | 'ridges' | 'cells' | 'envelope' | 'grain' | 'chains' | 'atoms';
  natural: number;
  in?: [number, number];
  out?: [number, number];
}

export const LAYERS: Layer[] = [
  { id: 'dome', natural: 1e-3, out: [1.6e-3, 7e-4] },
  { id: 'ridges', natural: 1e-3, in: [2.2e-3, 1e-3], out: [5e-5, 2e-5] },
  { id: 'cells', natural: 1e-6, in: [6e-5, 2.5e-5], out: [4e-7, 1.5e-7] },
  { id: 'envelope', natural: 1e-9, in: [5e-7, 2e-7], out: [3e-8, 1.2e-8] },
  { id: 'grain', natural: 1e-9, in: [4e-8, 1.5e-8], out: [2.5e-9, 1.2e-9] },
  { id: 'chains', natural: 1e-9, in: [3.5e-9, 1.6e-9] },
  { id: 'atoms', natural: 1e-9, in: [1.1e-9, 6e-10] },
];

/** How visible a layer is at this scale, 0 to 1. The fades run evenly across magnification, not across length. */
export function layerOpacity(layer: Layer, unit: number): number {
  const through = ([from, to]: [number, number]) => clamp01(Math.log(from / unit) / Math.log(from / to));
  const shown = layer.in ? through(layer.in) : 1;
  const hidden = layer.out ? through(layer.out) : 0;
  return shown * (1 - hidden);
}

/* The sizes both pictures draw from, in each layer's own unit. */
export const FINGER_RADIUS = 8; // mm
export const RIDGE_PERIOD = 0.45; // mm between ridge crests
export const RIDGE_DEPTH = 0.1; // mm from crest to valley
export const CELL_WIDTH = 30; // µm
export const CELL_THICK = 1; // µm
export const CHAIN_SPACING = 0.5; // nm between neighbouring fat molecules
export const CHAIN_STEP = 0.127; // nm along the chain from one carbon to the next
export const CHAIN_BEADS = 10;
export const BEAD_RADIUS = 0.1; // nm, as drawn
export const CLOUD_RADIUS = 0.149; // nm: half the resting gap, so resting clouds just meet

/** The height of the picture in scene units when the camera is at its usual distance. */
export const VIEW_HEIGHT = 1.9;

/** A round length (1, 2 or 5 times a power of ten, in metres) that is about a quarter of the picture wide. */
export function scaleBar(unit: number, pull: number): { metres: number; units: number } {
  const target = unit * VIEW_HEIGHT * pull * 0.3;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].reduce((best, m) => (m * power <= target ? m : best), 1);
  return { metres: step * power, units: (step * power) / unit };
}
