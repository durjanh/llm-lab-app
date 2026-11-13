import { useEffect, useRef, useState } from 'react';
import { findFaces, loadFaceModel } from '@/lib/faceModel';
import { storeWatchService as desk, type DeskState } from '@/services/storewatchService';
import {
  DEFAULT_ZONES,
  Desk,
  P,
  SKELETON,
  describeZones,
  type DeskEvent,
  type Rule,
  type Track,
  type Zone,
} from './rules';
import { createVision, type Detected, type Vision } from './vision';

const ZONES_KEY = 'llm-lab.storewatch.zones';
const SUSPICIOUS: Rule[] = ['possible_concealment', 'left_without_paying'];
const COOL_DOWN_MS = 15_000; // the same rule on the same person asks the model at most this often
const HEARTBEAT_MS = 60_000; // otherwise, a slow look while someone is carrying an item
const SESSION_CAP_USD = 1.0; // after this, the desk carries on with its own rules only
const CLIP_SEGMENT_MS = 12_000; // two recorders, staggered, each restarted this often
const POST_ROLL_MS = 3_000; // keep recording this long after an event before the clip is cut
const FRAME_EVERY_MS = 700;
const ZONE_COLOURS: Record<Zone['kind'], string> = { shelf: '#3b82f6', till: '#16a34a', exit: '#dc2626' };

function loadZones(): Zone[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ZONES_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length === 3) return saved as Zone[];
  } catch {
    /* use the defaults */
  }
  return structuredClone(DEFAULT_ZONES);
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** A short two-tone chime for a high-score alert. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 660].forEach((f, i) => {
      const o = new OscillatorNode(ctx, { frequency: f, type: 'triangle' });
      const g = new GainNode(ctx, { gain: 0 });
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.02);
      g.gain.linearRampToValueAtTime(0, t + 0.2);
      o.start(t);
      o.stop(t + 0.22);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* no sound available */
  }
}

/** One frame for the behaviour model, 480 pixels wide, with each person's head blurred when asked. */
function snapshot(video: HTMLVideoElement, seen: Detected, blur: boolean): string {
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = Math.round((video.videoHeight / video.videoWidth) * 480) || 360;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(video, 0, 0, c.width, c.height);
  if (blur) {
    for (const person of seen.people) {
      const head = person.slice(0, 11).filter((p) => p.v > 0.3);
      if (head.length < 2) continue;
      const xs = head.map((p) => p.x * c.width);
      const ys = head.map((p) => p.y * c.height);
      const size = Math.max(Math.max(...xs) - Math.min(...xs), 30) * 1.9;
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, size / 2, size * 0.62, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = 'blur(14px)';
      ctx.drawImage(c, 0, 0);
      ctx.drawImage(c, 0, 0);
      ctx.restore();
    }
  }
  return c.toDataURL('image/jpeg', 0.6);
}

function crop(video: HTMLVideoElement, box: { x: number; y: number; width: number; height: number }): string {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const pad = box.width * 0.2;
  c.getContext('2d')!.drawImage(
    video,
    box.x - pad,
    box.y - pad,
    box.width + 2 * pad,
    box.height + 2 * pad,
    0,
    0,
    96,
    96,
  );
  return c.toDataURL('image/jpeg', 0.75);
}

interface Recorder {
  rec: MediaRecorder;
  chunks: Blob[];
  start: number;
  reserved: boolean;
}

export interface VisitSummary {
  id: number;
  active: boolean;
  concealed: boolean;
  handled: string[];
  paid: boolean;
  left: boolean;
  events: DeskEvent[];
}

export interface LiveStats {
  people: number;
  visits: number;
}

interface Props {
  state: DeskState;
  threshold: number;
  onState: (s: DeskState) => void;
  onError: (message: string) => void;
  onStats: (s: LiveStats) => void;
  onDoorFace: (matchId: number, liveFace: string) => void;
}

/** The live desk: a webcam or a video file, people and items found in the browser, rules in code, and the behaviour
 *  model asked only when the rules raise suspicion. Every alert carries a short clip with the overlays drawn in. */
export function LiveDesk({ state, threshold, onState, onError, onStats, onDoorFace }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(true);
  const r = useRef({
    vision: null as Vision | null,
    desk: new Desk(),
    stream: null as MediaStream | null,
    fileUrl: '',
    raf: 0,
    started: performance.now(),
    lastDetect: -1e9,
    lastItems: -1e9,
    lastFrame: -1e9,
    lastUi: -1e9,
    lastCall: -1e9,
    seen: { people: [], items: [] } as Detected,
    frames: [] as { t: number; url: string }[],
    cool: new Map<string, number>(),
    busy: false,
    faces: new Map<number, { descriptor: number[]; thumb: string }>(),
    recorders: [] as (Recorder | null)[],
    recordStream: null as MediaStream | null,
    cycle: 0,
    door: 0,
    doorBusy: false,
    knownMatches: new Set<number>(),
    drag: null as { zone: number; corner: number } | null,
    spentAtStart: state.camera_spent_usd,
    callsAtStart: state.camera_calls,
  });
  const [source, setSource] = useState<'none' | 'loading' | 'camera' | 'file'>('none');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [note, setNote] = useState('');
  const [zones, setZones] = useState<Zone[]>(loadZones);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [events, setEvents] = useState<DeskEvent[]>([]);
  const [visits, setVisits] = useState<VisitSummary[]>([]);
  const [blur, setBlur] = useState(true);
  const [useModel, setUseModel] = useState(state.camera_available);
  const [muted, setMuted] = useState(false);
  const [door, setDoor] = useState(false);
  const [flash, setFlash] = useState(false);
  const [asking, setAsking] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const live = useRef({ threshold, onState, onError, onStats, onDoorFace, blur, useModel, muted, state });
  live.current = { threshold, onState, onError, onStats, onDoorFace, blur, useModel, muted, state };

  const spent = Math.max(0, state.camera_spent_usd - r.current.spentAtStart);
  const calls = Math.max(0, state.camera_calls - r.current.callsAtStart);
  const capped = spent >= SESSION_CAP_USD;

  // ----- recording: two staggered recorders over the drawn canvas, so a clip always has a few seconds before -----

  const startRecorder = (slot: number) => {
    const stream = r.current.recordStream;
    if (!stream || typeof MediaRecorder === 'undefined') return;
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    try {
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_200_000 });
      const entry: Recorder = { rec, chunks: [], start: performance.now() - r.current.started, reserved: false };
      rec.ondataavailable = (e) => e.data.size && entry.chunks.push(e.data);
      rec.start(1000);
      r.current.recorders[slot] = entry;
    } catch {
      r.current.recorders[slot] = null;
    }
  };

  const startRecording = () => {
    const c = canvas.current;
    if (!c || r.current.recordStream) return;
    r.current.recordStream = c.captureStream(15);
    startRecorder(0);
    window.setTimeout(() => mounted.current && r.current.recordStream && startRecorder(1), CLIP_SEGMENT_MS / 2);
    r.current.cycle = window.setInterval(() => {
      const now = performance.now() - r.current.started;
      r.current.recorders.forEach((entry, slot) => {
        if (!entry || entry.reserved || now - entry.start < CLIP_SEGMENT_MS) return;
        entry.rec.onstop = null;
        entry.rec.stop();
        startRecorder(slot);
      });
    }, 1000);
  };

  const stopRecording = () => {
    clearInterval(r.current.cycle);
    r.current.recorders.forEach((e) => e?.rec.state !== 'inactive' && e?.rec.stop());
    r.current.recorders = [];
    r.current.recordStream?.getTracks().forEach((t) => t.stop());
    r.current.recordStream = null;
  };

  /** Cuts a clip that holds the moment `at`: the longest-running recorder, stopped a few seconds after it. */
  const clipAround = (at: number): Promise<{ blob: Blob; startS: number } | null> => {
    const candidates = r.current.recorders
      .map((e, slot) => ({ e, slot }))
      .filter((x): x is { e: Recorder; slot: number } => !!x.e && !x.e.reserved && x.e.start <= at)
      .sort((a, b) => a.e.start - b.e.start);
    const pick = candidates[0];
    if (!pick) return Promise.resolve(null);
    pick.e.reserved = true;
    return new Promise((resolve) => {
      window.setTimeout(() => {
        pick.e.rec.onstop = () => {
          const blob = new Blob(pick.e.chunks, { type: pick.e.rec.mimeType || 'video/webm' });
          resolve(blob.size ? { blob, startS: Math.max(0, (at - pick.e.start) / 1000 - 2) } : null);
          if (mounted.current && r.current.recordStream) startRecorder(pick.slot);
        };
        pick.e.rec.stop();
      }, POST_ROLL_MS);
    });
  };

  // ----- faces: captured once per person who handles an item, for the alert and the watchlist -----

  const captureFace = async (track: Track) => {
    const v = video.current;
    if (!v || r.current.faces.has(track.id)) return;
    try {
      await loadFaceModel();
      const found = await findFaces(v);
      const w = v.videoWidth;
      const h = v.videoHeight;
      const face =
        found.find((f) => {
          const cx = (f.box.x + f.box.width / 2) / w;
          const cy = (f.box.y + f.box.height / 2) / h;
          return (
            cx >= track.box.x - 0.05 &&
            cx <= track.box.x + track.box.w + 0.05 &&
            cy >= track.box.y - 0.1 &&
            cy <= track.box.y + track.box.h
          );
        }) ?? (found.length === 1 ? found[0] : undefined);
      if (face) r.current.faces.set(track.id, { descriptor: face.descriptor, thumb: crop(v, face.box) });
    } catch {
      /* no face this time: the alert can still be raised */
    }
  };

  // ----- asking the behaviour model, only when the rules say it matters -----

  const ask = async (track: Track, rule: Rule | null, at: number) => {
    const v = video.current;
    if (!v || r.current.busy) return;
    const key = `${track.id}:${rule ?? 'heartbeat'}`;
    if (at - (r.current.cool.get(key) ?? -1e9) < COOL_DOWN_MS) return;
    r.current.cool.set(key, at);
    r.current.busy = true;
    r.current.lastCall = at;
    const st = live.current.state;
    const overCap = st.camera_spent_usd - r.current.spentAtStart >= SESSION_CAP_USD;
    const modelled = live.current.useModel && st.camera_available && !overCap;
    setAsking(
      modelled ? `Asking the behaviour model about person ${track.id}…` : `Scoring person ${track.id} by the rules…`,
    );
    const clip = rule ? clipAround(at) : Promise.resolve(null);
    try {
      await new Promise((ok) => setTimeout(ok, 1500)); // a frame or two after the moment, too
      if (!r.current.faces.has(track.id)) await captureFace(track);
      const before = r.current.frames.filter((f) => f.t <= at).slice(-3);
      const after = r.current.frames.filter((f) => f.t > at).slice(-2);
      const frames = [...before, ...after].map((f) => f.url);
      if (!frames.length) frames.push(snapshot(v, r.current.seen, live.current.blur));
      const face = r.current.faces.get(track.id);
      const result = await desk.cameraAnalyse({
        frames: frames.slice(-6),
        descriptor: face?.descriptor ?? null,
        thumbnail: face?.thumb ?? null,
        layout: describeZones(zonesRef.current),
        events: track.events.slice(-14).map((e) => `${clock(e.at)} ${e.text}`),
        rules: rule ? [rule] : [],
        track: track.id,
        use_model: modelled,
      });
      if (!mounted.current) return;
      live.current.onState(result);
      const lc = result.last_camera;
      setNote(`Person ${track.id}: score ${lc.score}${lc.modelled ? '' : ' (rules only)'}. ${lc.what}`);
      if (lc.score >= result.high_score) {
        setFlash(true);
        window.setTimeout(() => mounted.current && setFlash(false), 1600);
        if (!live.current.muted) chime();
      }
      const made = await clip;
      if (lc.alert_id && made) live.current.onState(await desk.attachClip(lc.alert_id, made.blob, made.startS));
    } catch (err) {
      live.current.onError((err as Error).message);
    } finally {
      r.current.busy = false;
      if (mounted.current) setAsking('');
    }
  };

  // ----- the frame loop: draw, detect, apply the rules -----

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const unit = w / 640;
    ctx.lineWidth = 2 * unit;
    ctx.font = `${13 * unit}px system-ui, sans-serif`;
    zonesRef.current.forEach((z) => {
      ctx.beginPath();
      z.points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
      ctx.closePath();
      ctx.fillStyle = `${ZONE_COLOURS[z.kind]}22`;
      ctx.strokeStyle = ZONE_COLOURS[z.kind];
      ctx.fill();
      ctx.setLineDash(editingRef.current ? [] : [6 * unit, 4 * unit]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ZONE_COLOURS[z.kind];
      ctx.fillText(z.kind.toUpperCase(), z.points[0].x * w + 6 * unit, z.points[0].y * h + 16 * unit);
      if (editingRef.current)
        z.points.forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x * w, p.y * h, 7 * unit, 0, Math.PI * 2);
          ctx.fill();
        });
    });
    for (const it of r.current.seen.items) {
      const bag = ['handbag', 'backpack', 'suitcase'].includes(it.label);
      ctx.strokeStyle = bag ? '#a855f7' : '#facc15';
      ctx.strokeRect(it.box.x * w, it.box.y * h, it.box.w * w, it.box.h * h);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${it.label} ${Math.round(it.score * 100)}%`, it.box.x * w + 3 * unit, it.box.y * h - 4 * unit);
    }
    for (const t of r.current.desk.tracks) {
      const colour = t.concealed ? '#ef4444' : t.handled.length && !t.paid ? '#f59e0b' : t.paid ? '#22c55e' : '#e5e7eb';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.5 * unit;
      ctx.strokeRect(t.box.x * w, t.box.y * h, t.box.w * w, t.box.h * h);
      ctx.lineWidth = 2 * unit;
      ctx.globalAlpha = 0.85;
      for (const [a, b] of SKELETON) {
        const pa = t.points[a];
        const pb = t.points[b];
        if (!pa || !pb || pa.v < 0.4 || pb.v < 0.4) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      [P.lWrist, P.rWrist].forEach((i, k) => {
        const p = t.points[i];
        if (!p || p.v < 0.4) return;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 7 * unit, 0, Math.PI * 2);
        ctx.fillStyle = t.hands[k].holding ? '#facc15' : colour;
        ctx.fill();
      });
      const status = t.concealed
        ? 'possible concealment'
        : t.handled.length && !t.paid
          ? `carrying ${t.handled.join(', ')}`
          : t.paid
            ? 'paid'
            : 'browsing';
      const label = `#${t.id} · ${status}`;
      const tw = ctx.measureText(label).width + 10 * unit;
      ctx.fillStyle = colour;
      ctx.fillRect(t.box.x * w, t.box.y * h - 20 * unit, tw, 20 * unit);
      ctx.fillStyle = '#111827';
      ctx.fillText(label, t.box.x * w + 5 * unit, t.box.y * h - 6 * unit);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - 22 * unit, 210 * unit, 22 * unit);
    ctx.fillStyle = '#fff';
    ctx.fillText(`CAM 1 · ${new Date().toLocaleTimeString('en-GB')}`, 6 * unit, h - 7 * unit);
  };

  const tick = () => {
    if (!mounted.current) return;
    r.current.raf = requestAnimationFrame(tick);
    const v = video.current;
    const c = canvas.current;
    if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    const ctx = c.getContext('2d')!;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const now = performance.now() - r.current.started;
    if (r.current.vision && now - r.current.lastDetect >= 66) {
      const withItems = now - r.current.lastItems >= 200;
      if (withItems) r.current.lastItems = now;
      try {
        const seen = r.current.vision.detect(v, performance.now(), withItems);
        if (!withItems) seen.items = r.current.seen.items;
        r.current.seen = seen;
      } catch {
        /* a frame the models could not read */
      }
      r.current.lastDetect = now;
      const fresh = r.current.desk.update(r.current.seen, zonesRef.current, now);
      if (fresh.length) {
        setEvents((list) => [...fresh.slice().reverse(), ...list].slice(0, 80));
        for (const e of fresh) {
          const t = r.current.desk.find(e.track);
          if (!t) continue;
          if (e.kind === 'item' && e.text.includes('picked up')) void captureFace(t);
          if (e.rule && SUSPICIOUS.includes(e.rule)) void ask(t, e.rule, now);
        }
      }
      // A slow look at anyone carrying something, so a slow theft is still seen.
      const carrying = r.current.desk.tracks.find((t) => t.handled.length && !t.paid);
      if (carrying && live.current.useModel && now - r.current.lastCall >= HEARTBEAT_MS) void ask(carrying, null, now);
    }
    draw(ctx, c.width, c.height);
    if (now - r.current.lastFrame >= FRAME_EVERY_MS) {
      r.current.lastFrame = now;
      r.current.frames.push({ t: now, url: snapshot(v, r.current.seen, live.current.blur) });
      if (r.current.frames.length > 14) r.current.frames.shift();
    }
    if (now - r.current.lastUi >= 400) {
      r.current.lastUi = now;
      const d = r.current.desk;
      const summary = (t: Track, active: boolean): VisitSummary => ({
        id: t.id,
        active,
        concealed: t.concealed,
        handled: [...t.handled],
        paid: t.paid,
        left: t.left,
        events: t.events.slice(-8),
      });
      setVisits([...d.tracks.map((t) => summary(t, true)), ...d.gone.slice(0, 6).map((t) => summary(t, false))]);
      setElapsed(now);
      live.current.onStats({ people: d.tracks.length, visits: d.visits });
    }
  };

  useEffect(() => {
    mounted.current = true; // React's development mode runs the clean-up once on mount; set it back here
    const ref = r.current;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(ref.raf);
      clearInterval(ref.door);
      clearInterval(ref.cycle);
      ref.recorders.forEach((e) => e?.rec.state !== 'inactive' && e?.rec.stop());
      ref.recordStream?.getTracks().forEach((t) => t.stop());
      ref.stream?.getTracks().forEach((t) => t.stop());
      if (ref.fileUrl) URL.revokeObjectURL(ref.fileUrl);
      ref.vision?.close();
      ref.vision = null;
    };
  }, []);

  const ensureVision = async () => {
    if (r.current.vision) return;
    setNote('Loading the pose and item models (about 12 MB the first time)…');
    r.current.vision = await createVision();
  };

  const begin = () => {
    cancelAnimationFrame(r.current.raf);
    r.current.desk = new Desk();
    r.current.started = performance.now();
    r.current.lastDetect = r.current.lastItems = r.current.lastFrame = r.current.lastUi = r.current.lastCall = -1e9;
    r.current.frames = [];
    r.current.faces.clear();
    setEvents([]);
    r.current.raf = requestAnimationFrame(tick);
    window.setTimeout(() => mounted.current && startRecording(), 500);
  };

  const stop = () => {
    stopRecording();
    cancelAnimationFrame(r.current.raf);
    r.current.stream?.getTracks().forEach((t) => t.stop());
    r.current.stream = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
      video.current.removeAttribute('src');
    }
    if (r.current.fileUrl) URL.revokeObjectURL(r.current.fileUrl);
    r.current.fileUrl = '';
    stopDoor();
    setSource('none');
    setNote('');
  };

  const startCamera = async (id = deviceId) => {
    stop();
    setSource('loading');
    try {
      await ensureVision();
      if (!mounted.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(id ? { deviceId: { exact: id } } : {}) },
        audio: false,
      });
      if (!mounted.current) return stream.getTracks().forEach((t) => t.stop());
      r.current.stream = stream;
      const v = video.current!;
      v.srcObject = stream;
      v.loop = false;
      await v.play();
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));
      setDeviceId(stream.getVideoTracks()[0]?.getSettings().deviceId ?? id);
      setSource('camera');
      setNote('Watching the camera. Pick something up, then hide it, put it back or take it to the till.');
      begin();
    } catch (err) {
      setSource('none');
      setNote('');
      live.current.onError(`The camera could not start: ${(err as Error).message}`);
    }
  };

  const openFile = async (file: File) => {
    stop();
    setSource('loading');
    try {
      await ensureVision();
      if (!mounted.current) return;
      const url = URL.createObjectURL(file);
      r.current.fileUrl = url;
      const v = video.current!;
      v.srcObject = null;
      v.src = url;
      v.loop = true;
      v.muted = true;
      await v.play();
      setSource('file');
      setNote(`Playing ${file.name} on a loop, through the same rules as the camera.`);
      begin();
    } catch (err) {
      setSource('none');
      setNote('');
      live.current.onError(`The video could not play: ${(err as Error).message}`);
    }
  };

  // ----- the door camera: every face in view is compared with the live watchlist -----

  const stopDoor = () => {
    clearInterval(r.current.door);
    setDoor(false);
  };
  const startDoor = async () => {
    setDoor(true);
    setNote('Loading the face model for the door check (about 7 MB the first time)…');
    await loadFaceModel().catch((e: Error) => live.current.onError(e.message));
    r.current.knownMatches = new Set(live.current.state.matches.map((m) => m.id));
    r.current.door = window.setInterval(async () => {
      const v = video.current;
      if (!v || r.current.doorBusy || v.readyState < 2) return;
      r.current.doorBusy = true;
      try {
        for (const face of (await findFaces(v)).slice(0, 3)) {
          const result = await desk.cameraDoor(face.descriptor, live.current.threshold);
          for (const m of result.matches) {
            if (r.current.knownMatches.has(m.id)) continue;
            r.current.knownMatches.add(m.id);
            live.current.onDoorFace(m.id, crop(v, face.box));
            if (m.high && !live.current.muted) chime();
          }
          live.current.onState(result);
        }
      } catch (err) {
        stopDoor();
        live.current.onError((err as Error).message);
      } finally {
        r.current.doorBusy = false;
      }
    }, 1200);
    setNote('Door check on: faces in view are compared with the live watchlist, and forgotten if nobody matches.');
  };

  // ----- editing zones: drag the corners on the picture -----

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing) return;
    const p = toPoint(e);
    let best: { zone: number; corner: number; d: number } | null = null;
    zones.forEach((z, zi) =>
      z.points.forEach((q, ci) => {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < 0.05 && (!best || d < best.d)) best = { zone: zi, corner: ci, d };
      }),
    );
    if (best) {
      r.current.drag = best;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = r.current.drag;
    if (!drag) return;
    const p = toPoint(e);
    setZones((zs) =>
      zs.map((z, zi) =>
        zi !== drag.zone
          ? z
          : {
              ...z,
              points: z.points.map((q, ci) =>
                ci === drag.corner ? { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) } : q,
              ),
            },
      ),
    );
  };
  const onPointerUp = () => {
    if (!r.current.drag) return;
    r.current.drag = null;
    try {
      localStorage.setItem(ZONES_KEY, JSON.stringify(zonesRef.current));
    } catch {
      /* zones stay for this visit only */
    }
  };

  const running = source === 'camera' || source === 'file';
  return (
    <section className="card sw-live" id="camera">
      <div className="sw-row sw-sources">
        <button className="btn primary" disabled={source === 'loading'} onClick={() => void startCamera()}>
          {source === 'camera' ? 'Restart camera' : 'Start camera'}
        </button>
        {devices.length > 1 && (
          <select value={deviceId} onChange={(e) => void startCamera(e.target.value)} aria-label="Camera">
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <label className="btn">
          Open a video file
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mov"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void openFile(f);
            }}
          />
        </label>
        {running && (
          <button className="btn" onClick={stop}>
            Stop
          </button>
        )}
        <span className="sw-spacer" />
        <button className={`btn small ${editing ? 'primary' : ''}`} onClick={() => setEditing((x) => !x)}>
          {editing ? 'Done with zones' : 'Set up zones'}
        </button>
        {editing && (
          <button
            className="btn small"
            onClick={() => {
              setZones(structuredClone(DEFAULT_ZONES));
              localStorage.removeItem(ZONES_KEY);
            }}
          >
            Reset zones
          </button>
        )}
      </div>

      <div className={`sw-stage ${flash ? 'flash' : ''} ${editing ? 'editing' : ''}`}>
        <video ref={video} muted playsInline className="sw-source-video" />
        <canvas
          ref={canvas}
          className="sw-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        {!running && (
          <div className="sw-stage-empty">
            {source === 'loading' ? (
              <p>Starting…</p>
            ) : (
              <>
                <p>
                  <b>Start the camera</b> or <b>open a video file</b>.
                </p>
                <p className="small">
                  People, poses and items are found in your browser. Rules in code watch the shelf, the till and the
                  exit; the behaviour model is asked only when they raise suspicion.
                </p>
              </>
            )}
          </div>
        )}
        {asking && <div className="sw-asking">{asking}</div>}
      </div>

      <div className="sw-row sw-switches">
        <label className="sw-check" title={state.camera_available ? '' : 'Needs Azure OpenAI settings in .env'}>
          <input
            type="checkbox"
            checked={useModel && state.camera_available}
            disabled={!state.camera_available}
            onChange={(e) => setUseModel(e.target.checked)}
          />{' '}
          Ask the behaviour model on suspicion
        </label>
        <label className="sw-check">
          <input type="checkbox" checked={blur} onChange={(e) => setBlur(e.target.checked)} /> Blur faces before frames
          leave the browser
        </label>
        <label className="sw-check">
          <input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} /> Alert sound
        </label>
        <button
          className={`btn small ${door ? 'primary' : ''}`}
          disabled={!running}
          onClick={() => (door ? stopDoor() : void startDoor())}
        >
          {door ? 'Door camera: on' : 'Door camera: off'}
        </button>
      </div>
      <p className="small muted sw-budget">
        {running ? `Watching for ${clock(elapsed)}. ` : ''}
        Behaviour model: {calls} call{calls === 1 ? '' : 's'}, ${spent.toFixed(4)} on this page
        {capped
          ? `; the $${SESSION_CAP_USD.toFixed(2)} cap is reached, so the rules carry on alone`
          : ` (cap $${SESSION_CAP_USD.toFixed(2)})`}
        . The rules on the picture are free.
      </p>
      {note && <p className="small sw-note">{note}</p>}

      <div className="sw-feeds">
        <div>
          <h3>Live events</h3>
          {events.length === 0 && <p className="small muted">Nothing yet.</p>}
          <ul className="sw-events">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className={`k-${e.kind} ${e.rule && SUSPICIOUS.includes(e.rule) ? 'bad' : ''}`}>
                <span className="mono">{clock(e.at)}</span> {e.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Visits</h3>
          {visits.length === 0 && <p className="small muted">Nobody yet.</p>}
          {visits.map((v) => (
            <div
              key={v.id}
              className={`sw-visitstrip ${v.active ? 'on' : ''} ${v.concealed ? 'bad' : v.handled.length && !v.paid ? 'warn' : ''}`}
            >
              <b>#{v.id}</b>
              <span className="small muted">{v.active ? 'in view' : v.left ? 'left by the exit' : 'out of view'}</span>
              <div className="sw-chips">
                {v.events
                  .filter((e) => e.kind !== 'person')
                  .map((e, i) => (
                    <span key={i} className={`sw-chip k-${e.kind}`} title={`${clock(e.at)} ${e.text}`}>
                      {e.text.replace(`Person ${v.id}`, '').replace(/^[:\s]+/, '')}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
