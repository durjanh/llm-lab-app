/* The form checks: joint angles from the pose model's points, and the rules a coach would apply to them. No model is
   involved here; it is geometry on the 33 points MediaPipe finds. Points arrive as fractions of the frame and are turned
   into pixels first, so an angle on a wide frame is the true angle. */

export interface Pt {
  x: number;
  y: number;
  v: number; // how sure the model is that the point is visible, 0 to 1
}

export type Exercise = 'plank' | 'wall-sit' | 'lunge' | 'custom';
export type View = 'side' | 'front' | 'unknown';

export interface Measure {
  key: string;
  label: string;
  value: number;
  unit: string;
  ideal: string;
  ok: boolean;
}

export interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail: string; // what is wrong, in numbers, for the coach and the panel
  cue: string; // what to say aloud when it stays wrong
  joints: number[]; // points drawn red while it fails
}

export interface Assessment {
  view: View;
  inPosition: boolean;
  hint: string; // what to do when not in position, or when the camera cannot see enough
  measures: Measure[];
  checks: Check[];
  similarity?: number;
}

export const EXERCISES: Record<Exercise, { label: string; setup: string }> = {
  plank: { label: 'Plank', setup: 'Side-on to the camera, whole body in view, forearms or hands on the floor.' },
  'wall-sit': { label: 'Wall sit', setup: 'Side-on, back flat against a wall, slide down until the knees are bent.' },
  lunge: { label: 'Lunge stretch', setup: 'Side-on, one foot forward with the knee bent, the back leg long.' },
  custom: { label: 'Your own pose', setup: 'Teach the page a pose by holding it, then match it again.' },
};

// MediaPipe's point numbers. Left and right are the person's own.
export const P = {
  nose: 0,
  lEar: 7,
  rEar: 8,
  lSh: 11,
  rSh: 12,
  lEl: 13,
  rEl: 14,
  lWr: 15,
  rWr: 16,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnk: 27,
  rAnk: 28,
  lHeel: 29,
  rHeel: 30,
  lToe: 31,
  rToe: 32,
} as const;

/** The lines of the stick figure drawn over the video. */
export const BONES: [number, number][] = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [27, 31],
  [28, 30],
  [30, 32],
  [28, 32],
  [7, 11],
  [8, 12],
];

const DEG = 180 / Math.PI;
const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });

/** The angle at b, between the lines to a and to c, in degrees (180 is a straight line). */
export function angle(a: Pt, b: Pt, c: Pt): number {
  const v1 = Math.atan2(a.y - b.y, a.x - b.x);
  const v2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(v1 - v2) * DEG;
  if (d > 180) d = 360 - d;
  return d;
}

/** How far the line from a to b is from horizontal, 0 to 90 degrees. */
export const fromHorizontal = (a: Pt, b: Pt) => {
  const d = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * DEG);
  return d > 90 ? 180 - d : d;
};
export const fromVertical = (a: Pt, b: Pt) => 90 - fromHorizontal(a, b);

/** How far p sits below the line from a to b, in pixels (negative: above). Screen y grows downwards. */
function below(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1);
  return p.y - (a.y + t * dy);
}

/** The points in pixels, so angles are true on a frame that is not square. */
export const toPixels = (points: Pt[], w: number, h: number): Pt[] =>
  points.map((p) => ({ x: p.x * w, y: p.y * h, v: p.v }));

/** The side nearer the camera: the model is surer of the points it can see. */
function nearSide(p: Pt[]): 'l' | 'r' {
  const sum = (ids: number[]) => ids.reduce((s, i) => s + p[i].v, 0);
  return sum([11, 13, 15, 23, 25, 27]) >= sum([12, 14, 16, 24, 26, 28]) ? 'l' : 'r';
}

function joints(p: Pt[]) {
  const s = nearSide(p);
  const pick = (l: number, r: number) => (s === 'l' ? l : r);
  const ids = {
    ear: pick(P.lEar, P.rEar),
    sh: pick(P.lSh, P.rSh),
    el: pick(P.lEl, P.rEl),
    wr: pick(P.lWr, P.rWr),
    hip: pick(P.lHip, P.rHip),
    knee: pick(P.lKnee, P.rKnee),
    ank: pick(P.lAnk, P.rAnk),
  };
  return {
    ids,
    ear: p[ids.ear],
    sh: p[ids.sh],
    el: p[ids.el],
    wr: p[ids.wr],
    hip: p[ids.hip],
    knee: p[ids.knee],
    ank: p[ids.ank],
  };
}

/** Side-on or front-on: from the side the two shoulders nearly overlap; from the front they are a torso apart. */
export function viewOf(p: Pt[]): View {
  const torso = dist(mid(p[P.lSh], p[P.rSh]), mid(p[P.lHip], p[P.rHip]));
  if (torso < 1) return 'unknown';
  return dist(p[P.lSh], p[P.rSh]) / torso > 0.45 ? 'front' : 'side';
}

/** A point the model is not sure it can see, or one outside the frame. */
const unseen = (q: Pt, w: number, h: number) => q.v < 0.4 || q.x < 0 || q.y < 0 || q.x > w || q.y > h;

const measure = (key: string, label: string, value: number, unit: string, ideal: string, ok: boolean): Measure => ({
  key,
  label,
  value: round(value, unit === '°' ? 0 : 2),
  unit,
  ideal,
  ok,
});

function plank(p: Pt[]): Assessment {
  const j = joints(p);
  const body = angle(j.sh, j.hip, j.ank);
  const bend = 180 - body;
  const sag = below(j.hip, j.sh, j.ank) > 0;
  const level = fromHorizontal(j.sh, j.ank);
  const knee = angle(j.hip, j.knee, j.ank);
  const elbow = angle(j.sh, j.el, j.wr);
  const support = elbow > 140 ? j.wr : j.el; // straight arms: a high plank on the hands; bent: on the forearms
  const supportName = elbow > 140 ? 'hands' : 'elbows';
  const torso = dist(j.sh, j.hip) || 1;
  const facing = Math.sign(j.sh.x - j.hip.x) || 1;
  const reach = ((j.sh.x - support.x) * facing) / torso; // + : shoulders ahead of the support
  const neck = angle(j.ear, j.sh, j.hip);
  const headLow = below(j.ear, j.hip, j.sh) > 0;

  const checks: Check[] = [
    {
      key: 'line',
      label: 'Hips in line',
      ok: bend <= 10,
      detail: bend <= 10 ? '' : `hips ${sag ? 'sagging' : 'too high'} by ${round(bend)}°`,
      cue: sag
        ? 'Lift your hips a little. Squeeze your stomach and glutes.'
        : 'Lower your hips a little, into one straight line.',
      joints: [j.ids.sh, j.ids.hip, j.ids.ank],
    },
    {
      key: 'knees',
      label: 'Knees straight',
      ok: knee >= 160,
      detail: knee >= 160 ? '' : `knees bent to ${round(knee)}°`,
      cue: 'Straighten your legs. Push back through your heels.',
      joints: [j.ids.knee],
    },
    {
      key: 'shoulders',
      label: `Shoulders over ${supportName}`,
      ok: Math.abs(reach) <= 0.3,
      detail: Math.abs(reach) <= 0.3 ? '' : `shoulders ${reach > 0 ? 'ahead of' : 'behind'} the ${supportName}`,
      cue: `Stack your shoulders over your ${supportName}.`,
      joints: [j.ids.sh, elbow > 140 ? j.ids.wr : j.ids.el],
    },
    {
      key: 'head',
      label: 'Head in line',
      ok: neck >= 145,
      detail: neck >= 145 ? '' : `head ${headLow ? 'dropping' : 'lifted'}, neck at ${round(neck)}°`,
      cue: headLow
        ? 'Lift your head a little. Look at the floor just ahead of your hands.'
        : 'Let your head relax. Look at the floor.',
      joints: [j.ids.ear],
    },
  ];
  return {
    view: 'unknown',
    inPosition: level < 40 && j.hip.y < Math.max(j.wr.y, j.el.y, j.ank.y) + torso * 0.2,
    hint: 'Get into a plank: body roughly level with the floor, side-on to the camera.',
    measures: [
      measure('body', 'Body line (shoulder, hip, ankle)', body, '°', '170° to 180°', bend <= 10),
      measure('knee', 'Knee angle', knee, '°', 'above 160°', knee >= 160),
      measure('reach', `Shoulders past ${supportName}`, reach, ' torso lengths', 'within ±0.3', Math.abs(reach) <= 0.3),
      measure('neck', 'Neck (ear, shoulder, hip)', neck, '°', 'above 145°', neck >= 145),
      measure('level', 'Body tilt from the floor', level, '°', 'under 40°', level < 40),
    ],
    checks,
  };
}

function wallSit(p: Pt[]): Assessment {
  const j = joints(p);
  const knee = angle(j.hip, j.knee, j.ank);
  const hip = angle(j.sh, j.hip, j.knee);
  const back = fromVertical(j.hip, j.sh);
  const shin = fromVertical(j.knee, j.ank);
  const forward = Math.sign(j.knee.x - j.hip.x) || 1;
  const kneesAhead = (j.knee.x - j.ank.x) * forward > 0;
  const kneeOk = knee >= 80 && knee <= 105;
  return {
    view: 'unknown',
    inPosition: fromHorizontal(j.hip, j.knee) < 50 && back < 35 && knee < 140,
    hint: 'Back against the wall, side-on to the camera, and slide down until your knees bend.',
    measures: [
      measure('knee', 'Knee angle', knee, '°', '80° to 105°', kneeOk),
      measure('hip', 'Hip angle (shoulder, hip, knee)', hip, '°', '75° to 110°', hip >= 75 && hip <= 110),
      measure('back', 'Back from upright', back, '°', 'under 15°', back <= 15),
      measure('shin', 'Shins from upright', shin, '°', 'under 15°', shin <= 15),
    ],
    checks: [
      {
        key: 'depth',
        label: 'Thighs level',
        ok: kneeOk,
        detail: kneeOk ? '' : knee > 105 ? `too high: knees at ${round(knee)}°` : `too low: knees at ${round(knee)}°`,
        cue:
          knee > 105
            ? 'Slide a little lower, until your thighs are level with the floor.'
            : 'Come up a little, so your knees are at a right angle.',
        joints: [j.ids.hip, j.ids.knee, j.ids.ank],
      },
      {
        key: 'back',
        label: 'Back flat on the wall',
        ok: back <= 15,
        detail: back <= 15 ? '' : `leaning ${round(back)}° off upright`,
        cue: 'Press your back and shoulders flat against the wall.',
        joints: [j.ids.sh, j.ids.hip],
      },
      {
        key: 'shins',
        label: 'Knees over ankles',
        ok: shin <= 15,
        detail: shin <= 15 ? '' : kneesAhead ? 'knees past the ankles' : 'feet too far out',
        cue: kneesAhead
          ? 'Walk your feet out a little, so your knees sit over your ankles.'
          : 'Bring your feet in a little, under your knees.',
        joints: [j.ids.knee, j.ids.ank],
      },
    ],
  };
}

function lunge(p: Pt[]): Assessment {
  const leg = (h: number, k: number, a: number) => ({ h, k, a, angle: angle(p[h], p[k], p[a]) });
  const left = leg(P.lHip, P.lKnee, P.lAnk);
  const right = leg(P.rHip, P.rKnee, P.rAnk);
  const [front, back] = left.angle <= right.angle ? [left, right] : [right, left];
  const hips = mid(p[P.lHip], p[P.rHip]);
  const shoulders = mid(p[P.lSh], p[P.rSh]);
  const forward = Math.sign(p[front.a].x - p[back.a].x) || 1;
  const shin = fromVertical(p[front.k], p[front.a]);
  const kneePast = (p[front.k].x - p[front.a].x) * forward > 0;
  const torso = fromVertical(hips, shoulders);
  const legLength = dist(p[front.h], p[front.k]) + dist(p[front.k], p[front.a]) || 1;
  const stance = Math.abs(p[front.a].x - p[back.a].x) / legLength;
  const frontOk = front.angle >= 80 && front.angle <= 115;
  return {
    view: 'unknown',
    inPosition: stance > 0.7 && front.angle < 140,
    hint: 'Step one foot well forward and bend that knee, side-on to the camera.',
    measures: [
      measure('front', 'Front knee angle', front.angle, '°', '80° to 115°', frontOk),
      measure('shin', 'Front shin from upright', shin, '°', 'under 15°', shin <= 15),
      measure('back', 'Back knee angle', back.angle, '°', 'above 140°', back.angle >= 140),
      measure('torso', 'Body from upright', torso, '°', 'under 20°', torso <= 20),
      measure('stance', 'Stance length', stance, ' leg lengths', 'above 0.7', stance > 0.7),
    ],
    checks: [
      {
        key: 'depth',
        label: 'Front knee bent',
        ok: frontOk,
        detail: frontOk
          ? ''
          : front.angle > 115
            ? `front knee only bent to ${round(front.angle)}°`
            : `front knee closed to ${round(front.angle)}°`,
        cue:
          front.angle > 115
            ? 'Sink your hips a little lower.'
            : 'Come up a touch, so your front knee is at a right angle.',
        joints: [front.h, front.k, front.a],
      },
      {
        key: 'shin',
        label: 'Knee over ankle',
        ok: shin <= 15,
        detail: shin <= 15 ? '' : kneePast ? 'front knee past the toes' : 'front foot too far forward',
        cue: kneePast
          ? 'Move your front foot forward, so the knee stays over the ankle.'
          : 'Bring your front foot back a little, under the knee.',
        joints: [front.k, front.a],
      },
      {
        key: 'back',
        label: 'Back leg long',
        ok: back.angle >= 140,
        detail: back.angle >= 140 ? '' : `back knee bent to ${round(back.angle)}°`,
        cue: 'Lengthen your back leg and press the back heel away.',
        joints: [back.k],
      },
      {
        key: 'torso',
        label: 'Upright body',
        ok: torso <= 20,
        detail: torso <= 20 ? '' : `leaning ${round(torso)}° forward`,
        cue: 'Lift your chest, and stack your shoulders over your hips.',
        joints: [P.lSh, P.rSh, P.lHip, P.rHip],
      },
    ],
  };
}

/** The checks for one frame. Points are in pixels; w and h are the frame's size. */
export function assess(exercise: Exclude<Exercise, 'custom'>, p: Pt[], w: number, h: number): Assessment {
  const view = viewOf(p);
  const j = joints(p);
  const missing = [j.sh, j.hip, j.knee, j.ank].some((q) => unseen(q, w, h));
  const base = exercise === 'plank' ? plank(p) : exercise === 'wall-sit' ? wallSit(p) : lunge(p);
  base.view = view;
  if (missing) {
    return {
      ...base,
      inPosition: false,
      hint: 'The camera cannot see your whole body. Step back until your feet are in the picture.',
    };
  }
  if (view === 'front') {
    return {
      ...base,
      inPosition: false,
      hint: 'Turn side-on to the camera: these angles can only be measured from the side.',
    };
  }
  return base;
}

/* Your own pose: the sensor in the build that inspired this page learns a pose by being shown it, then reports how
   similar each new pose is. The same here, on 13 points: each pose is moved so the hips are at the centre and scaled
   by the torso's length, so where you stand and how far away you are do not matter. */

export const POSE_POINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const POINT_NAMES: Record<number, string> = {
  0: 'head',
  11: 'left shoulder',
  12: 'right shoulder',
  13: 'left elbow',
  14: 'right elbow',
  15: 'left hand',
  16: 'right hand',
  23: 'left hip',
  24: 'right hip',
  25: 'left knee',
  26: 'right knee',
  27: 'left foot',
  28: 'right foot',
};
const SIGMA = 0.3; // how far (in torso lengths) a point can be and still count as half right

export interface TaughtPose {
  name: string;
  points: [number, number][]; // POSE_POINTS, normalised
}

/** A pose in torso lengths from the middle of the hips, or null when the torso cannot be measured. */
export function normalise(p: Pt[]): [number, number][] | null {
  const hips = mid(p[P.lHip], p[P.rHip]);
  const torso = dist(mid(p[P.lSh], p[P.rSh]), hips);
  if (torso < 10) return null;
  return POSE_POINTS.map((i) => [(p[i].x - hips.x) / torso, (p[i].y - hips.y) / torso]);
}

/** The average of several captures, which steadies the jitter of any one frame. */
export function averagePose(frames: [number, number][][]): [number, number][] {
  return POSE_POINTS.map((_, k) => [
    frames.reduce((s, f) => s + f[k][0], 0) / frames.length,
    frames.reduce((s, f) => s + f[k][1], 0) / frames.length,
  ]);
}

/** How alike two poses are, 0 to 1: the average over the points of a bell curve on each point's distance. */
export function compare(taught: TaughtPose, p: Pt[]): Assessment {
  const now = normalise(p);
  const view = viewOf(p);
  if (!now)
    return {
      view,
      inPosition: false,
      hint: 'Stand where the camera can see your shoulders and hips.',
      measures: [],
      checks: [],
      similarity: 0,
    };
  const scores = now.map(([x, y], k) => {
    const [tx, ty] = taught.points[k];
    return Math.exp(-((x - tx) ** 2 + (y - ty) ** 2) / (2 * SIGMA * SIGMA));
  });
  const similarity = scores.reduce((s, v) => s + v, 0) / scores.length;
  const worst = scores
    .map((s, k) => ({ s, k }))
    .filter((x) => x.s < 0.5)
    .sort((a, b) => a.s - b.s)
    .slice(0, 3);
  const checks: Check[] = worst.map(({ k }) => {
    const [x, y] = now[k];
    const [tx, ty] = taught.points[k];
    const name = POINT_NAMES[POSE_POINTS[k]];
    const dx = Math.abs(x) - Math.abs(tx);
    const dy = y - ty;
    const way = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? 'higher' : 'lower') : dx > 0 ? 'closer in' : 'further out';
    return {
      key: `p${POSE_POINTS[k]}`,
      label: `${name[0].toUpperCase()}${name.slice(1)}`,
      ok: false,
      detail: `${name} ${round(Math.hypot(x - tx, y - ty), 1)} torso lengths off; move it ${way}`,
      cue: `Move your ${name} ${way}.`,
      joints: [POSE_POINTS[k]],
    };
  });
  if (!checks.length)
    checks.push({ key: 'all', label: 'Every point close', ok: true, detail: '', cue: '', joints: [] });
  return {
    view,
    inPosition: similarity >= 0.8,
    hint: `Match “${taught.name}”: the red points are furthest from it.`,
    measures: [
      measure('similarity', 'Similarity to the taught pose', similarity, '', '0.8 or more', similarity >= 0.8),
    ],
    checks,
    similarity: round(similarity, 2),
  };
}

/* The drawn figure, for trying the page without a camera (or without room for a plank): a side-on stick figure whose
   pose follows a slider, given as 33 points in a 640 by 480 frame, like the camera's. */

export const DEMO_SLIDER: Record<Exclude<Exercise, 'custom'>, { label: string; low: string; high: string }> = {
  plank: { label: 'Hips', low: 'too high', high: 'sagging' },
  'wall-sit': { label: 'Depth', low: 'too low', high: 'too high' },
  lunge: { label: 'Front knee', low: 'deep', high: 'shallow' },
};

const pt = (x: number, y: number, v = 0.95): Pt => ({ x, y, v });

/** A side-on figure facing right. amount runs from -1 to 1; 0 is good form. */
export function demoPose(exercise: Exercise, amount: number, t: number): Pt[] {
  const wobble = (k: number) => Math.sin(t / 380 + k) * 1.5;
  let near: Record<string, Pt>;
  let farLegs: { hip: Pt; knee: Pt; ank: Pt } | null = null;
  if (exercise === 'plank') {
    const ank = pt(110, 400);
    const sh = pt(500, 330);
    const len = dist(ank, sh);
    const ux = (sh.x - ank.x) / len;
    const uy = (sh.y - ank.y) / len;
    const along = (d: number, off: number) => pt(ank.x + ux * d - uy * off, ank.y + uy * d + ux * off);
    const hip = along(235, amount * 55); // positive: below the line
    const knee = pt((hip.x + ank.x) / 2, (hip.y + ank.y) / 2 + 2);
    near = { sh, hip, knee, ank, el: pt(505, 402), wr: pt(575, 404), ear: pt(545, 318) };
  } else if (exercise === 'wall-sit') {
    const phi = (amount * 40) / DEG; // thigh below horizontal at the knee: positive means the hips are higher
    const ank = pt(304, 404); // feet on the floor; the hips slide up and down the wall
    const knee = pt(300, 289);
    const hip = pt(knee.x - 120 * Math.cos(phi), knee.y - 120 * Math.sin(phi));
    const sh = pt(hip.x + 2, hip.y - 150);
    near = {
      sh,
      hip,
      knee,
      ank,
      el: pt(sh.x + 18, sh.y + 75),
      wr: pt(sh.x + 68, sh.y + 110),
      ear: pt(sh.x + 13, sh.y - 40),
    };
  } else {
    const ank = pt(430, 400);
    const knee = pt(428, 285);
    const theta = (amount * 40) / DEG; // thigh above horizontal: positive means a shallower lunge
    const hip = pt(knee.x - 120 * Math.cos(theta), knee.y - 120 * Math.sin(theta));
    const sh = pt(hip.x + 8, hip.y - 150);
    const dy = 400 - hip.y;
    const dx = Math.sqrt(Math.max(235 ** 2 - dy ** 2, 400));
    const back = pt(hip.x - dx, 400);
    farLegs = { hip: pt(hip.x + 4, hip.y - 3), knee: pt((hip.x + back.x) / 2, (hip.y + back.y) / 2 + 8), ank: back };
    near = {
      sh,
      hip,
      knee,
      ank,
      el: pt(sh.x + 10, sh.y + 75),
      wr: pt(sh.x + 30, sh.y + 140),
      ear: pt(sh.x + 12, sh.y - 40),
    };
  }
  const far = (q: Pt) => pt(q.x + 5, q.y - 4, 0.6); // the far side, just behind and less sure
  const out: Pt[] = Array.from({ length: 33 }, () => pt(near.ear.x, near.ear.y));
  const set = (i: number, q: Pt) => {
    out[i] = pt(q.x + wobble(i), q.y + wobble(i + 3), q.v);
  };
  for (const i of [0, 1, 2, 3, 4, 5, 6, 9, 10]) set(i, pt(near.ear.x + 18, near.ear.y + 6));
  set(P.lEar, near.ear);
  set(P.rEar, far(near.ear));
  set(P.lSh, near.sh);
  set(P.rSh, far(near.sh));
  set(P.lEl, near.el);
  set(P.rEl, far(near.el));
  set(P.lWr, near.wr);
  set(P.rWr, far(near.wr));
  for (const i of [17, 19, 21]) set(i, near.wr);
  for (const i of [18, 20, 22]) set(i, far(near.wr));
  set(P.lHip, near.hip);
  set(P.lKnee, near.knee);
  set(P.lAnk, near.ank);
  const legs = farLegs ?? { hip: far(near.hip), knee: far(near.knee), ank: far(near.ank) };
  set(P.rHip, legs.hip);
  set(P.rKnee, legs.knee);
  set(P.rAnk, legs.ank);
  const foot = (ank: Pt, flat: boolean) => [
    pt(ank.x - 12, ank.y + (flat ? 6 : 2), ank.v),
    pt(ank.x + 22, ank.y + (flat ? 8 : 6), ank.v),
  ];
  const [lh, lt] =
    exercise === 'plank'
      ? [pt(near.ank.x - 8, near.ank.y - 14), pt(near.ank.x + 6, near.ank.y + 8)]
      : foot(near.ank, true);
  const [rh, rt] = exercise === 'plank' ? [far(lh), far(lt)] : foot(legs.ank, true);
  set(P.lHeel, lh);
  set(P.lToe, lt);
  set(P.rHeel, rh);
  set(P.rToe, rt);
  return out;
}
