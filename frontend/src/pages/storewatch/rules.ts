/* The live desk's rules, in plain code: zones, tracking people from frame to frame, and the events a shop cares about
   (picked up an item, possible concealment, put back, visited the till, left by the exit). They are free and instant,
   so they run on every frame; the behaviour model is asked only when they raise suspicion. Coordinates are fractions
   of the frame. This file has no browser or React dependency, so it can be tested on its own. */

import type { Box, Detected, Point } from './vision';

export type ZoneKind = 'shelf' | 'till' | 'exit';

export interface Zone {
  kind: ZoneKind;
  points: { x: number; y: number }[]; // four corners, clockwise
}

export const DEFAULT_ZONES: Zone[] = [
  {
    kind: 'shelf',
    points: [
      { x: 0.02, y: 0.08 },
      { x: 0.3, y: 0.08 },
      { x: 0.3, y: 0.75 },
      { x: 0.02, y: 0.75 },
    ],
  },
  {
    kind: 'till',
    points: [
      { x: 0.68, y: 0.05 },
      { x: 0.86, y: 0.05 },
      { x: 0.86, y: 0.42 },
      { x: 0.68, y: 0.42 },
    ],
  },
  {
    kind: 'exit',
    points: [
      { x: 0.88, y: 0.0 },
      { x: 1.0, y: 0.0 },
      { x: 1.0, y: 1.0 },
      { x: 0.88, y: 1.0 },
    ],
  },
];

export type Rule = 'possible_concealment' | 'left_without_paying' | 'long_dwell';

export interface DeskEvent {
  at: number; // ms since the desk started
  track: number;
  text: string;
  rule?: Rule;
  kind: 'zone' | 'item' | 'rule' | 'till' | 'exit' | 'person';
}

// Body points in MediaPipe's pose model.
export const P = { nose: 0, lShoulder: 11, rShoulder: 12, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24 } as const;
export const SKELETON: [number, number][] = [
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
  [0, 11],
  [0, 12],
];

const LOST_MS = 1500; // a person unseen this long has gone
const HOLD_MS = 350; // an item must stay in a hand this long to count as held
const GONE_MS = 600; // and be missing this long to count as gone
const TILL_MS = 1000; // time at the till that counts as paying
export const DWELL_MS = 25_000; // time at the shelf that is worth noting

export function inside(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

export function boxOf(points: Point[]): Box {
  const seen = points.filter((p) => p.v > 0.4);
  const use = seen.length >= 4 ? seen : points;
  const xs = use.map((p) => p.x);
  const ys = use.map((p) => p.y);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  return { x, y, w: Math.min(1, Math.max(...xs)) - x, h: Math.min(1, Math.max(...ys)) - y };
}

export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const both = w * h;
  return both / (a.w * a.h + b.w * b.h - both || 1);
}

/** Where a person "is" for the zones: between the hips when they are visible, otherwise the middle of their box. */
export function anchorOf(points: Point[], box: Box): { x: number; y: number } {
  const l = points[P.lHip];
  const r = points[P.rHip];
  if (l && r && l.v > 0.5 && r.v > 0.5) return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** The region where an item can disappear into clothes or a bag: shoulders to just below the hips, a little wider. */
export function bodyRegion(points: Point[]): Box | null {
  const pts = [P.lShoulder, P.rShoulder, P.lHip, P.rHip].map((i) => points[i]).filter((p) => p && p.v > 0.4);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const tall = Math.max(bottom - top, w);
  return { x: Math.min(...xs) - w * 0.35, y: top, w: w * 1.7, h: tall * 1.35 };
}

const within = (p: { x: number; y: number }, b: Box, pad = 0) =>
  p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

interface Hand {
  holding: string | null; // the item label in this hand
  since: number; // when it was first seen in the hand
  missing: number; // when it was last seen, while it is missing
  confirmed: boolean; // held long enough to count
}

export interface Track {
  id: number;
  box: Box;
  points: Point[];
  anchor: { x: number; y: number };
  firstSeen: number;
  lastSeen: number;
  zones: Set<ZoneKind>;
  zoneSince: Partial<Record<ZoneKind, number>>;
  hands: [Hand, Hand];
  handled: string[]; // items this person has held
  concealed: boolean;
  paid: boolean;
  left: boolean;
  dwellNoted: boolean;
  events: DeskEvent[];
}

const freshHand = (): Hand => ({ holding: null, since: 0, missing: 0, confirmed: false });

export class Desk {
  tracks: Track[] = [];
  gone: Track[] = [];
  nextId = 1;
  visits = 0;

  /** One frame: matches people to tracks, then applies the zone and item rules. Returns the new events. */
  update(seen: Detected, zones: Zone[], now: number): DeskEvent[] {
    const out: DeskEvent[] = [];
    const say = (t: Track, kind: DeskEvent['kind'], text: string, rule?: Rule) => {
      const e: DeskEvent = { at: now, track: t.id, kind, text, rule };
      t.events.push(e);
      if (t.events.length > 40) t.events.shift();
      out.push(e);
    };
    // Match each detected person to the track it overlaps most (greedy, best first).
    const people = seen.people.map((points) => ({ points, box: boxOf(points) }));
    const pairs: { i: number; t: Track; score: number }[] = [];
    // Overlap counts most; closeness of the anchors lets a fast walker keep their id between frames.
    people.forEach((p, i) => {
      const a = anchorOf(p.points, p.box);
      this.tracks.forEach((t) => {
        const near = Math.max(0, 1 - Math.hypot(a.x - t.anchor.x, a.y - t.anchor.y) / 0.25);
        const score = iou(p.box, t.box) + near * 0.5;
        if (score > 0.15) pairs.push({ i, t, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedPeople = new Set<number>();
    const usedTracks = new Set<Track>();
    for (const pair of pairs) {
      if (usedPeople.has(pair.i) || usedTracks.has(pair.t)) continue;
      usedPeople.add(pair.i);
      usedTracks.add(pair.t);
      Object.assign(pair.t, { points: people[pair.i].points, box: people[pair.i].box, lastSeen: now });
    }
    people.forEach((p, i) => {
      if (usedPeople.has(i)) return;
      const t: Track = {
        id: this.nextId++,
        box: p.box,
        points: p.points,
        anchor: anchorOf(p.points, p.box),
        firstSeen: now,
        lastSeen: now,
        zones: new Set(),
        zoneSince: {},
        hands: [freshHand(), freshHand()],
        handled: [],
        concealed: false,
        paid: false,
        left: false,
        dwellNoted: false,
        events: [],
      };
      this.tracks.push(t);
      this.visits++;
      say(t, 'person', `Person ${t.id} came into view`);
    });

    for (const t of this.tracks) {
      if (t.lastSeen !== now) continue;
      t.anchor = anchorOf(t.points, t.box);
      const wrists = [t.points[P.lWrist], t.points[P.rWrist]];
      // Zones: the person's anchor, or either hand, inside counts as being there.
      for (const z of zones) {
        const here = inside(t.anchor, z.points) || wrists.some((w) => w && w.v > 0.5 && inside(w, z.points));
        if (here && !t.zones.has(z.kind)) {
          t.zones.add(z.kind);
          t.zoneSince[z.kind] = now;
          say(t, 'zone', `Person ${t.id} at the ${z.kind}`);
        } else if (!here && t.zones.has(z.kind)) {
          t.zones.delete(z.kind);
          delete t.zoneSince[z.kind];
        }
      }
      if (t.zones.has('till') && !t.paid && now - (t.zoneSince.till ?? now) >= TILL_MS && t.handled.length) {
        t.paid = true;
        say(t, 'till', `Person ${t.id} went to the till with the ${t.handled[t.handled.length - 1]}`);
      }
      if (t.zones.has('shelf') && !t.dwellNoted && now - (t.zoneSince.shelf ?? now) >= DWELL_MS) {
        t.dwellNoted = true;
        say(t, 'rule', `Person ${t.id} has been at the shelf for ${Math.round(DWELL_MS / 1000)} s`, 'long_dwell');
      }
      if (t.zones.has('exit') && !t.left) this.leave(t, now, say);

      // Items in hands: an item box near a wrist is held; held then gone near the body is a possible concealment.
      const body = bodyRegion(t.points);
      wrists.forEach((w, h) => {
        const hand = t.hands[h];
        if (!w || w.v < 0.4) return;
        const item = seen.items.find(
          (it) => !['handbag', 'backpack', 'suitcase'].includes(it.label) && within(w, it.box, 0.04),
        );
        if (item) {
          if (hand.holding !== item.label) Object.assign(hand, { holding: item.label, since: now, confirmed: false });
          hand.missing = 0;
          if (!hand.confirmed && now - hand.since >= HOLD_MS) {
            hand.confirmed = true;
            if (!t.handled.includes(item.label)) t.handled.push(item.label);
            t.paid = false;
            say(t, 'item', `Person ${t.id} picked up a ${item.label}${t.zones.has('shelf') ? ' from the shelf' : ''}`);
          }
        } else if (hand.holding) {
          hand.missing ||= now;
          if (now - hand.missing < GONE_MS) return;
          if (hand.confirmed) {
            const bag = seen.items.find(
              (it) => ['handbag', 'backpack', 'suitcase'].includes(it.label) && within(w, it.box, 0.05),
            );
            if (t.zones.has('shelf')) {
              say(t, 'item', `Person ${t.id} put the ${hand.holding} back`);
              t.handled = t.handled.filter((x) => x !== hand.holding);
            } else if (t.zones.has('till')) {
              say(t, 'till', `Person ${t.id} put the ${hand.holding} down at the till`);
            } else if (bag || (body && within(w, body))) {
              t.concealed = true;
              say(
                t,
                'rule',
                `Person ${t.id}: the ${hand.holding} went out of sight ${bag ? `into a ${bag.label}` : 'at the body (pocket, coat or waistband)'}`,
                'possible_concealment',
              );
            }
          }
          Object.assign(hand, freshHand());
        }
      });
    }

    // People not seen for a while have gone; leaving from the exit zone counts as leaving the shop.
    for (const t of this.tracks.filter((t) => now - t.lastSeen > LOST_MS)) {
      const atExit = zones.some((z) => z.kind === 'exit' && (inside(t.anchor, z.points) || t.zones.has('exit')));
      if (atExit && !t.left) this.leave(t, now, say);
      else if (!t.left) say(t, 'person', `Person ${t.id} went out of view`);
      this.gone.unshift(t);
    }
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= LOST_MS);
    this.gone = this.gone.slice(0, 12);
    return out;
  }

  private leave(t: Track, now: number, say: (t: Track, kind: DeskEvent['kind'], text: string, rule?: Rule) => void) {
    t.left = true;
    const unpaid = t.handled.length > 0 && !t.paid;
    if (unpaid || t.concealed) {
      say(
        t,
        'exit',
        `Person ${t.id} left by the exit with ${t.handled.join(', ') || 'a hidden item'}, without the till`,
        'left_without_paying',
      );
    } else {
      say(t, 'exit', `Person ${t.id} left by the exit`);
    }
  }

  find(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id) ?? this.gone.find((t) => t.id === id);
  }
}

/** The zones in words, for the behaviour model: where each one is in the frame. */
export function describeZones(zones: Zone[]): string {
  const where = (z: Zone) => {
    const cx = z.points.reduce((s, p) => s + p.x, 0) / z.points.length;
    const cy = z.points.reduce((s, p) => s + p.y, 0) / z.points.length;
    const h = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'middle';
    const v = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
    return `${h === v ? 'centre' : `${v === 'middle' ? '' : `${v} `}${h}`}`.trim();
  };
  const names: Record<ZoneKind, string> = {
    shelf: 'The shelf (stock)',
    till: 'The till (paying)',
    exit: 'The exit (leaving the shop)',
  };
  return zones.map((z) => `${names[z.kind]} is at the ${where(z)} of the picture.`).join(' ');
}
