/**
 * Songs as scores for the two-voice syrinx synth. A songbird's syrinx sits where the windpipe splits into the two
 * bronchi, and each side has its own vibrating folds, so a bird can sing two notes at once or hand one sweep from side
 * to side. In many species the left side sings lower and the right side higher. These scores are stylised from that
 * physiology and from published descriptions of each song; they are not recordings.
 */

export type Voice = 'L' | 'R';

export interface Note {
  voice: Voice;
  /** Start and duration, in seconds. */
  t: number;
  d: number;
  /** Frequency at the start and the end of the note, in Hz. */
  f0: number;
  f1: number;
  /** Loudness, 0 to 1. */
  amp: number;
  /** 0 is a pure whistle; 1 is a buzzy note full of harmonics. */
  harm: number;
  /** Optional warble: rate in Hz and depth as a fraction of the frequency. */
  trill?: number;
  trillDepth?: number;
}

export interface Palette {
  body: string;
  wing: string;
  belly: string;
  beak: string;
  mask?: string;
  crest?: boolean;
  tail?: number; // tail length multiplier
}

export interface Song {
  id: string;
  name: string;
  style: string;
  about: string;
  palette: Palette;
  notes: Note[];
}

const note = (
  voice: Voice,
  t: number,
  d: number,
  f0: number,
  f1: number,
  amp = 0.8,
  harm = 0.1,
  extra: Partial<Note> = {},
): Note => ({
  voice,
  t,
  d,
  f0,
  f1,
  amp,
  harm,
  ...extra,
});

/** One sweep that starts on one side and finishes on the other, handing over at `at` Hz. */
function handoff(t: number, d: number, f0: number, f1: number, at: number, amp = 0.85): Note[] {
  const share = Math.abs(Math.log(at / f0)) / Math.abs(Math.log(f1 / f0));
  const first: Voice = f0 > at ? 'R' : 'L';
  const second: Voice = first === 'R' ? 'L' : 'R';
  return [
    note(first, t, d * share, f0, at, amp, 0.05),
    note(second, t + d * share, d * (1 - share), at, f1, amp, 0.05),
  ];
}

/** Rapid repeats of one short syllable. */
function repeat(count: number, gap: number, make: (t: number, i: number) => Note[], start = 0): Note[] {
  return Array.from({ length: count }, (_, i) => make(start + i * gap, i)).flat();
}

function woodThrush(): Note[] {
  const out: Note[] = [];
  let t = 0;
  for (const [low, high, trill] of [
    [2400, 3900, 6200],
    [2100, 3400, 5600],
  ]) {
    // Soft "bup bup bup" introduction.
    out.push(...repeat(3, 0.12, (s) => [note('L', s, 0.05, 1500, 1350, 0.35, 0.3)], t));
    t += 0.45;
    // The flute phrase: both sides at once, on notes that are not harmonics of each other.
    out.push(note('L', t, 0.18, low, low * 0.96, 0.75, 0.05), note('R', t, 0.18, high, high * 1.03, 0.6, 0.05));
    t += 0.2;
    out.push(
      note('L', t, 0.16, low * 0.83, low * 0.85, 0.75, 0.05),
      note('R', t, 0.16, high * 0.86, high * 0.84, 0.6, 0.05),
    );
    t += 0.18;
    out.push(
      note('L', t, 0.2, low * 1.2, low * 1.15, 0.75, 0.05),
      note('R', t, 0.2, high * 1.12, high * 1.16, 0.65, 0.05),
    );
    t += 0.24;
    // The trilled ending: the right side flutters high while the left holds a buzz.
    out.push(
      ...repeat(9, 0.04, (s, i) => [note('R', s, 0.03, trill + (i % 2) * 700, trill + (i % 2) * 500, 0.5, 0.15)], t),
    );
    out.push(note('L', t, 0.36, low * 0.9, low * 0.88, 0.3, 0.55));
    t += 0.9;
  }
  return out;
}

function cardinal(): Note[] {
  const out: Note[] = [];
  // "Birdy birdy birdy": fast downslurs, high part on the right side, low part on the left.
  out.push(...repeat(6, 0.26, (s) => handoff(s, 0.18, 6300, 1900, 3400)));
  // "Cheer cheer": slower upslurs, starting on the left and finishing on the right.
  out.push(...repeat(3, 0.42, (s) => handoff(s, 0.3, 1900, 4600, 3300, 0.9), 1.75));
  return out;
}

function canary(): Note[] {
  // Waterslager canaries sing mostly with the left side: low, bubbling rolls.
  const out: Note[] = [];
  let t = 0;
  for (const [f, rate, count] of [
    [1700, 0.055, 14],
    [2300, 0.045, 16],
    [1500, 0.06, 12],
    [2000, 0.05, 18],
  ]) {
    out.push(
      ...repeat(count, rate, (s, i) => [note('L', s, rate * 0.75, f * 1.08, f * 0.92 + (i % 3) * 40, 0.75, 0.35)], t),
    );
    t += count * rate + 0.12;
  }
  out.push(note('R', t, 0.25, 3600, 4200, 0.25, 0.05)); // one faint note from the right side, for contrast
  return out;
}

function zebraFinch(): Note[] {
  // Short, buzzy syllables: low notes full of harmonics, sung fast.
  const motif = (t: number): Note[] => [
    note('L', t, 0.1, 620, 600, 0.8, 0.95),
    note('L', t + 0.13, 0.08, 920, 520, 0.75, 0.85),
    note('R', t + 0.24, 0.07, 3100, 2900, 0.5, 1, { trill: 90, trillDepth: 0.08 }),
    note('L', t + 0.34, 0.12, 700, 690, 0.8, 0.9, { trill: 35, trillDepth: 0.03 }),
    note('R', t + 0.5, 0.05, 2400, 3800, 0.55, 0.6),
  ];
  return [
    note('L', 0, 0.06, 700, 690, 0.5, 0.8),
    note('L', 0.14, 0.06, 700, 690, 0.5, 0.8),
    ...motif(0.35),
    ...motif(0.95),
    ...motif(1.55),
  ];
}

function nightingale(): Note[] {
  const out: Note[] = [];
  // "Piu piu piu": whistles that grow louder.
  out.push(...repeat(6, 0.2, (s, i) => [note('R', s, 0.12, 2300, 3100, 0.25 + i * 0.13, 0.05)]));
  // A hard, fast "chuk" trill from the left side.
  out.push(...repeat(16, 0.045, (s) => [note('L', s, 0.03, 1900, 1500, 0.75, 0.7)], 1.3));
  // A long whistle that climbs, then a low ending.
  out.push(note('R', 2.1, 0.45, 3200, 4400, 0.8, 0.05, { trill: 18, trillDepth: 0.02 }));
  out.push(note('L', 2.65, 0.12, 1300, 1100, 0.7, 0.5));
  return out;
}

function lyrebird(): Note[] {
  const out: Note[] = [];
  // Mimicry 1, a whipbird: a long whistle, then a whip-crack sweep.
  out.push(note('R', 0, 0.55, 2100, 2200, 0.7, 0.05), note('R', 0.58, 0.05, 2200, 9000, 0.9, 0.2));
  out.push(note('L', 0.75, 0.08, 1500, 1300, 0.6, 0.3), note('L', 0.88, 0.08, 1500, 1300, 0.6, 0.3));
  // Mimicry 2, a laughing kookaburra-like run, on the left side.
  out.push(
    ...repeat(12, 0.09, (s, i) => [note('L', s, 0.07, i % 2 ? 1250 : 1800, i % 2 ? 1150 : 1650, 0.7, 0.7)], 1.2),
  );
  // Mimicry 3, a camera shutter: pairs of clicks, very short and full of harmonics.
  out.push(
    ...repeat(
      3,
      0.3,
      (s) => [note('R', s, 0.012, 4200, 3800, 0.9, 1), note('R', s + 0.06, 0.012, 3800, 3400, 0.8, 1)],
      2.45,
    ),
  );
  return out;
}

export const SONGS: Song[] = [
  {
    id: 'thrush',
    name: 'Wood thrush',
    style: 'Two voices at once, like a flute duet',
    about:
      'The wood thrush sings two notes at the same time, one from each side of the syrinx, at pitches that are not harmonics of each other. That is why its song sounds like two flutes.',
    palette: { body: '#a0714a', wing: '#86592f', belly: '#f3e7d3', beak: '#c9b59a' },
    notes: woodThrush(),
  },
  {
    id: 'cardinal',
    name: 'Northern cardinal',
    style: 'Sweeping whistles, handed from side to side',
    about:
      'A cardinal’s sweeps cover more range than one side of the syrinx can sing. The right side sings the high part and the left the low part, handing over mid-sweep so smoothly it sounds like one note.',
    palette: { body: '#c8312e', wing: '#a52522', belly: '#d9473f', beak: '#f08a3c', mask: '#1f1a1a', crest: true },
    notes: cardinal(),
  },
  {
    id: 'canary',
    name: 'Waterslager canary',
    style: 'Low rolls, almost all from the left side',
    about:
      'Bred for low, bubbling “water” rolls, these canaries sing mostly with the left side of the syrinx. Their brains are lopsided to match: the nerve to the left side does most of the work.',
    palette: { body: '#f2cf3d', wing: '#d9b12a', belly: '#f8e27a', beak: '#f2b880' },
    notes: canary(),
  },
  {
    id: 'finch',
    name: 'Zebra finch',
    style: 'Buzzy notes in fast rhythms',
    about:
      'Zebra finch syllables are short stacks of harmonics: the folds vibrate in a way that makes buzz rather than whistle. Young males learn one motif from a tutor and repeat it.',
    palette: { body: '#8d8f94', wing: '#74767b', belly: '#efe9e1', beak: '#e8572c', mask: '#2b2b2b' },
    notes: zebraFinch(),
  },
  {
    id: 'nightingale',
    name: 'Common nightingale',
    style: 'Whistles that swell, then hard trills',
    about:
      'Nightingales are loud and varied: swelling whistles, rapid hard trills and sudden low notes. A male may have more than 200 song types.',
    palette: { body: '#8a6a4f', wing: '#7a593f', belly: '#e6dccd', beak: '#9a8670', tail: 1.2 },
    notes: nightingale(),
  },
  {
    id: 'lyrebird',
    name: 'Superb lyrebird',
    style: 'Copies other birds, and machines',
    about:
      'The lyrebird has one of the most complex syrinxes of any bird and copies what it hears: other species, and sometimes camera shutters and alarms. Here: a whipbird, a laughing run and shutter clicks.',
    palette: { body: '#6f5a48', wing: '#5c4a3b', belly: '#9d8a78', beak: '#3b302a', tail: 1.8 },
    notes: lyrebird(),
  },
];

export const SYNTH_PALETTE: Palette = { body: '#6b7f96', wing: '#55687e', belly: '#c9d3df', beak: '#3d4652' };

export const songLength = (notes: Note[]) => notes.reduce((end, n) => Math.max(end, n.t + n.d), 0);
