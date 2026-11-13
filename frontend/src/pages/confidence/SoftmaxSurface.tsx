import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * Softmax temperature as a surface. Three classes A, B and C get scores z = (x, y, 0); the height over each point is
 * the model's confidence, max p_i, and the colour is the class it picks. Changing T reshapes every confidence at once
 * while the coloured regions on the floor (what the model picks) stay exactly where they are: temperature never
 * changes a prediction, only how sure it looks.
 */

const CLASSES = [
  { name: 'A', colour: '#3f8f6b', light: '#a9d3bd' },
  { name: 'B', colour: '#4466c7', light: '#b4c3ef' },
  { name: 'C', colour: '#c4534f', light: '#ecb7b4' },
] as const;
const RANGE = 3; // x and y run from -3 to 3
const N = 72; // grid cells per side
const HEIGHT = 3.2; // scene units for confidence 1; confidence 1/3 sits on the floor
const T_MIN = 0.1;
const T_MAX = 5;

export function softmax(x: number, y: number, t: number): number[] {
  const z = [x / t, y / t, 0];
  const top = Math.max(...z);
  const e = z.map((v) => Math.exp(v - top));
  const sum = e[0] + e[1] + e[2];
  return e.map((v) => v / sum);
}

const argmax = (p: number[]) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[1] >= p[2] ? 1 : 2);
const heightOf = (confidence: number) => ((confidence - 1 / 3) / (2 / 3)) * HEIGHT;
const pct = (v: number) => `${(v * 100).toFixed(v > 0.9999 || v < 0.0001 ? 4 : 2)}%`;

/** The temperature slider is logarithmic, so 0.1 to 1 gets as much room as 1 to 5. */
const tFromSlider = (s: number) => T_MIN * Math.pow(T_MAX / T_MIN, s);
const sliderFromT = (t: number) => Math.log(t / T_MIN) / Math.log(T_MAX / T_MIN);

interface Scene {
  setT: (t: number) => void;
  setPoint: (x: number, y: number) => void;
  dispose: () => void;
}

/** Builds the three.js scene in the host element. Returns null when the browser cannot start WebGL. */
function build(host: HTMLDivElement, labels: HTMLDivElement, onPick: (x: number, y: number) => void): Scene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-4, 9, 6);
  scene.add(sun);

  // Scene axes: world x = the score x, world z = the score y (towards the viewer as y grows), world y = confidence.
  const vertices = (N + 1) * (N + 1);
  const positions = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  const index: number[] = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      // Cut each cell along x = y, where A and B meet, so that crease follows triangle edges, not a saw-tooth.
      index.push(a, a + N + 1, a + N + 2, a, a + N + 2, a + 1);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(index);
  const surface = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.94 }),
  );
  scene.add(surface);

  // Grid lines drawn on the surface, every half unit, rebuilt with it.
  const lineCount = 13;
  const linePoints = new Float32Array(lineCount * 2 * N * 2 * 3);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(linePoints, 3)),
    new THREE.LineBasicMaterial({ color: 0x1f2937, transparent: true, opacity: 0.18 }),
  );
  scene.add(lines);

  // The floor shows the decision regions: which class the model picks. They do not depend on T.
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 256;
  const ctx = floorCanvas.getContext('2d')!;
  for (let py = 0; py < 256; py++)
    for (let px = 0; px < 256; px++) {
      const x = -RANGE + (px / 255) * 2 * RANGE;
      const y = -RANGE + (py / 255) * 2 * RANGE;
      ctx.fillStyle = CLASSES[argmax(softmax(x, y, 1))].light;
      ctx.fillRect(px, py, 1, 1);
    }
  const floorTexture = new THREE.CanvasTexture(floorCanvas);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * RANGE, 2 * RANGE),
    new THREE.MeshBasicMaterial({ map: floorTexture, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  scene.add(floor);

  // Axes along the floor's edges and a confidence axis at the back corner.
  const axisMaterial = new THREE.LineBasicMaterial({ color: 0x6b7280 });
  const axis = (a: THREE.Vector3, b: THREE.Vector3) =>
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), axisMaterial));
  axis(new THREE.Vector3(-RANGE, 0, RANGE), new THREE.Vector3(RANGE, 0, RANGE));
  axis(new THREE.Vector3(RANGE, 0, -RANGE), new THREE.Vector3(RANGE, 0, RANGE));
  axis(new THREE.Vector3(-RANGE, 0, -RANGE), new THREE.Vector3(-RANGE, HEIGHT, -RANGE));

  // The chosen point: a ball on the surface and a stem down to the floor.
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 20, 14),
    new THREE.MeshLambertMaterial({ color: 0x111827 }),
  );
  scene.add(ball);
  const stemGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const stem = new THREE.Line(stemGeometry, new THREE.LineBasicMaterial({ color: 0x111827 }));
  scene.add(stem);

  // Labels are HTML, placed each frame where their 3D anchor lands on screen.
  const anchors: { el: HTMLSpanElement; at: () => THREE.Vector3 }[] = [];
  const label = (text: string, cls: string, at: () => THREE.Vector3) => {
    const el = document.createElement('span');
    el.className = `sf-label ${cls}`;
    el.textContent = text;
    labels.appendChild(el);
    anchors.push({ el, at });
  };
  let t = 1;
  let labelsDirty = true; // labels are re-placed only after the view or the surface changes
  let point = { x: 2, y: 1 };
  const surfaceAt = (x: number, y: number) => new THREE.Vector3(x, heightOf(Math.max(...softmax(x, y, t))), y);
  label('A', 'big a', () => surfaceAt(2.2, -1.6).add(new THREE.Vector3(0, 0.25, 0)));
  label('B', 'big b', () => surfaceAt(-1.6, 2.2).add(new THREE.Vector3(0, 0.25, 0)));
  label('C', 'big c', () => surfaceAt(-2.2, -2.2).add(new THREE.Vector3(0, 0.25, 0)));
  label('x', 'axis', () => new THREE.Vector3(0, 0, RANGE + 0.6));
  label('y', 'axis', () => new THREE.Vector3(RANGE + 0.6, 0, 0));
  label('−3', 'tick', () => new THREE.Vector3(-RANGE, 0, RANGE + 0.4));
  label('3', 'tick', () => new THREE.Vector3(RANGE + 0.3, 0, RANGE + 0.3));
  label('−3', 'tick', () => new THREE.Vector3(RANGE + 0.4, 0, -RANGE));
  label('confidence 1', 'tick', () => new THREE.Vector3(-RANGE - 0.15, HEIGHT, -RANGE));
  label('⅓', 'tick', () => new THREE.Vector3(-RANGE - 0.15, 0, -RANGE));

  const colour = new THREE.Color();
  const pale = new THREE.Color();
  function rebuild() {
    let v = 0;
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++, v++) {
        const x = -RANGE + (i / N) * 2 * RANGE;
        const y = -RANGE + (j / N) * 2 * RANGE;
        const p = softmax(x, y, t);
        const k = argmax(p);
        positions.set([x, heightOf(p[k]), y], v * 3);
        // Paler where the model is less sure, so the near-tie ridges read at a glance.
        colour.set(CLASSES[k].colour);
        pale.set('#f3f4f6');
        colour.lerp(pale, 0.55 * (1 - (p[k] - 1 / 3) / (2 / 3)));
        colours.set([colour.r, colour.g, colour.b], v * 3);
      }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeVertexNormals();
    let w = 0;
    for (let l = 0; l < lineCount; l++) {
      const fixed = -RANGE + (l / (lineCount - 1)) * 2 * RANGE;
      for (let s = 0; s < N; s++) {
        const a = -RANGE + (s / N) * 2 * RANGE;
        const b = -RANGE + ((s + 1) / N) * 2 * RANGE;
        for (const [x, y] of [
          [fixed, a],
          [fixed, b],
          [a, fixed],
          [b, fixed],
        ]) {
          linePoints.set([x, heightOf(Math.max(...softmax(x, y, t))) + 0.004, y], w);
          w += 3;
        }
      }
    }
    lines.geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    labelsDirty = true;
    placePoint();
  }
  function placePoint() {
    const top = surfaceAt(point.x, point.y);
    ball.position.copy(top);
    stemGeometry.setFromPoints([new THREE.Vector3(point.x, 0, point.y), top]);
  }

  // Drag to turn the view; click the surface or floor to move the point.
  let yaw = -0.62;
  let pitch = 0.6;
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const placeCamera = () => {
    const r = 16.5;
    camera.position.set(r * Math.cos(pitch) * Math.sin(yaw), r * Math.sin(pitch), r * Math.cos(pitch) * Math.cos(yaw));
    camera.lookAt(0, HEIGHT * 0.28, 0.4);
    labelsDirty = true;
  };
  const canvas = renderer.domElement;
  const ray = new THREE.Raycaster();
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    yaw -= dx * 0.008;
    pitch = Math.min(1.35, Math.max(0.12, pitch + dy * 0.006));
    drag.x = e.clientX;
    drag.y = e.clientY;
    placeCamera();
  };
  const up = (e: PointerEvent) => {
    if (drag && !drag.moved) {
      const box = canvas.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1),
        camera,
      );
      const hit = ray.intersectObjects([surface, floor])[0];
      if (hit) onPick(Math.max(-RANGE, Math.min(RANGE, hit.point.x)), Math.max(-RANGE, Math.min(RANGE, hit.point.z)));
    }
    drag = null;
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);

  const size = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    labelsDirty = true;
  };
  const observer = new ResizeObserver(size);
  observer.observe(host);
  size();
  placeCamera();
  rebuild();

  const projected = new THREE.Vector3();
  const sight = new THREE.Raycaster();
  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    renderer.render(scene, camera);
    if (!labelsDirty) return;
    labelsDirty = false;
    const w = host.clientWidth;
    const h = host.clientHeight;
    for (const a of anchors) {
      const at = a.at();
      // Hide a label the surface stands in front of, as the surface would hide a real one.
      const towards = at.clone().sub(camera.position);
      const distance = towards.length();
      sight.set(camera.position, towards.normalize());
      sight.far = distance - 0.3;
      a.el.style.visibility = sight.intersectObject(surface).length ? 'hidden' : 'visible';
      projected.copy(at).project(camera);
      a.el.style.transform = `translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  };
  draw();

  return {
    setT(next) {
      t = next;
      rebuild();
    },
    setPoint(x, y) {
      point = { x, y };
      placePoint();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      floorTexture.dispose();
      renderer.dispose();
      canvas.remove();
      labels.replaceChildren();
    },
  };
}

const PRESETS = [
  {
    label: 'A wrong answer made to look certain',
    x: 2,
    y: 1,
    t: 0.1,
    note: 'Say the truth here is B. At T = 0.1 the model is 99.99% sure of A.',
  },
  {
    label: 'The same point, cooled to T = 0.55',
    x: 2,
    y: 1,
    t: 0.55,
    note: 'The example in the formula: about 84% A.',
  },
  { label: 'The same point, warmed to T = 3', x: 2, y: 1, t: 3, note: 'Still picks A, now only about 44% sure.' },
  { label: 'A near tie', x: 1, y: 0.9, t: 1, note: 'Close to the ridge between A and B: unsure at any T.' },
];

export function SoftmaxSurface() {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [failed, setFailed] = useState(false);
  const [t, setT] = useState(0.55);
  const [point, setPoint] = useState({ x: 2, y: 1 });
  const [playing, setPlaying] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!host.current || !labels.current) return;
    const made = build(host.current, labels.current, (x, y) => {
      setPoint({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
      setNote('');
    });
    if (!made) setFailed(true);
    scene.current = made;
    return () => {
      made?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => scene.current?.setT(t), [t]);
  useEffect(() => scene.current?.setPoint(point.x, point.y), [point]);

  // Playing sweeps T back and forth on the log scale, about eight seconds each way.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let s = sliderFromT(t);
    let direction = 1;
    const step = (now: number) => {
      s += direction * ((now - last) / 8000);
      last = now;
      if (s >= 1 || s <= 0) {
        direction = -direction;
        s = Math.min(1, Math.max(0, s));
      }
      setT(tFromSlider(s));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // restarts from wherever the slider is when play is pressed
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = softmax(point.x, point.y, t);
  const pick = argmax(p);

  return (
    <div className="sf">
      <div className="sf-head">
        <div className="sf-formula">
          p<sub>i</sub>(x, y; T) = e
          <sup>
            z<sub>i</sub>/T
          </sup>{' '}
          / Σ<sub>j ∈ {'{A, B, C}'}</sub> e
          <sup>
            z<sub>j</sub>/T
          </sup>
          , &nbsp;with z = (x, y, 0)
        </div>
        <div className="sf-probs">
          {CLASSES.map((c, i) => (
            <div key={c.name} className={`sf-prob${i === pick ? ' top' : ''}`}>
              <div style={{ color: c.colour }}>
                p<sub>{c.name}</sub> ≈ <b className="mono">{pct(p[i])}</b>
              </div>
              <div className="sf-track">
                <i style={{ width: `${p[i] * 100}%`, background: c.colour }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sf-stage">
        <div ref={host} className="sf-canvas" />
        <div ref={labels} className="sf-labels" />
        {failed && (
          <p className="sf-fail small">
            This browser could not start 3D drawing (WebGL). The numbers above still follow the controls.
          </p>
        )}
      </div>
      <div className="sf-controls">
        <button className="btn small" onClick={() => setPlaying((v) => !v)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <label className="sf-t">
          T ≈ <b className="mono">{t.toFixed(2)}</b>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={sliderFromT(t)}
            onChange={(e) => {
              setPlaying(false);
              setT(tFromSlider(Number(e.target.value)));
            }}
            aria-label="Temperature"
          />
        </label>
        <label>
          x <b className="mono">{point.x.toFixed(1)}</b>
          <input
            type="range"
            min={-3}
            max={3}
            step={0.1}
            value={point.x}
            onChange={(e) => setPoint({ ...point, x: Number(e.target.value) })}
          />
        </label>
        <label>
          y <b className="mono">{point.y.toFixed(1)}</b>
          <input
            type="range"
            min={-3}
            max={3}
            step={0.1}
            value={point.y}
            onChange={(e) => setPoint({ ...point, y: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="sf-presets">
        {PRESETS.map((pr) => (
          <button
            key={pr.label}
            className="btn small"
            onClick={() => {
              setPlaying(false);
              setPoint({ x: pr.x, y: pr.y });
              setT(pr.t);
              setNote(pr.note);
            }}
          >
            {pr.label}
          </button>
        ))}
      </div>
      <p className="small">
        {note && <b>{note} </b>}
        At (x, y) = ({point.x.toFixed(1)}, {point.y.toFixed(1)}) the model picks <b>{CLASSES[pick].name}</b> at every
        temperature; only how sure it looks changes. Drag to turn the view; click the surface to move the point.
      </p>
    </div>
  );
}
