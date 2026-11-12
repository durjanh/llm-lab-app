import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  BEAD_RADIUS,
  CELL_THICK,
  CELL_WIDTH,
  CHAIN_BEADS,
  CHAIN_SPACING,
  CHAIN_STEP,
  CLOUD_RADIUS,
  FINGER_RADIUS,
  LAYERS,
  RIDGE_DEPTH,
  RIDGE_PERIOD,
  VIEW_HEIGHT,
  layerOpacity,
  type FilmState,
  type Layer,
} from './film';

/* The film in 3D. Every layer of detail (fingertip, ridges, cells, cell surface, fat molecules, atoms) is built
   once, in its own unit of length, for the upper finger; the lower finger is the same shapes mirrored and in another
   colour. Each frame only rescales and fades the layers for the camera's current scale, so the picture is a pure
   function of the film state and scrubbing works in both directions. */

const BACKGROUND = 0x0b1020;
const FOV = 40;
const DISTANCE = VIEW_HEIGHT / 2 / Math.tan((FOV / 2) * (Math.PI / 180));
const SIDES = [
  { sign: 1, colour: 0xf0b27c, dark: 0x6e4526, cloud: 0xffc48a },
  { sign: -1, colour: 0x74b9dc, dark: 0x234a63, cloud: 0x8fd4ff },
] as const;
type Side = (typeof SIDES)[number];

/** A repeatable random number from an integer, so the scene is the same every time it is built. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function canvasTexture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) paint(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Rings around the fingertip, for the far view: light skin with darker furrows. */
const ringTexture = () =>
  canvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#a9a9a9';
    const rings = 56; // a quarter of the way round an 8 mm fingertip is about 28 ridges
    for (let i = 0; i < rings; i++) ctx.fillRect(0, (i + 0.6) * (size / rings), size, (size / rings) * 0.4);
  });

/** Soft lumps, for the surface of one cell. Drawn at wrapped positions so the tile repeats without a seam. */
const lumpTexture = () =>
  canvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 46; i++) {
      const [x, y, r] = [hash(i) * size, hash(i + 50) * size, 14 + hash(i + 100) * 22];
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          g.addColorStop(0, 'rgba(255,255,255,0.55)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
        }
      }
    }
  });

/** Dots packed like the ends of the fat molecules, for the scale just before single molecules can be drawn. */
const dotTexture = () =>
  canvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#444';
    ctx.fillRect(0, 0, size, size);
    const n = 8;
    const step = size / n;
    for (let row = 0; row < n; row++) {
      for (let col = -1; col <= n; col++) {
        const x = (col + (row % 2 ? 0.5 : 0)) * step;
        const y = (row + 0.5) * step;
        const g = ctx.createRadialGradient(x, y, 0, x, y, step * 0.48);
        g.addColorStop(0, '#fff');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - step / 2, y - step / 2, step, step);
      }
    }
  });

const solid = (colour: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color: colour, roughness: 0.75, metalness: 0, transparent: true, ...extra });

/* Each builder returns one finger's layer with its closest point at the origin and the finger's body towards +y. */

function dome(side: Side, textures: THREE.Texture[]): THREE.Object3D {
  const rings = ringTexture();
  textures.push(rings);
  const group = new THREE.Group();
  const tip = new THREE.SphereGeometry(FINGER_RADIUS, 72, 36, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  tip.translate(0, FINGER_RADIUS, 0);
  group.add(new THREE.Mesh(tip, solid(side.colour, { map: rings })));
  const shaft = new THREE.CylinderGeometry(FINGER_RADIUS, FINGER_RADIUS, 60, 72, 1, true);
  shaft.translate(0, FINGER_RADIUS + 30, 0);
  group.add(new THREE.Mesh(shaft, solid(side.colour)));
  return group;
}

function ridges(side: Side): THREE.Object3D {
  const width = 24;
  const geometry = new THREE.PlaneGeometry(width, width, 640, 32);
  geometry.rotateX(-Math.PI / 2);
  const at = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < at.count; i++) {
    const [x, z] = [at.getX(i), at.getZ(i)];
    const curve = (x * x + z * z) / (2 * FINGER_RADIUS); // the fingertip's own curve, close to its tip
    at.setY(i, curve + (RIDGE_DEPTH / 2) * (1 - Math.cos((2 * Math.PI * x) / RIDGE_PERIOD)));
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, solid(side.colour, { side: THREE.DoubleSide }));
}

function cells(side: Side): THREE.Object3D {
  const group = new THREE.Group();
  const radius = CELL_WIDTH / 2 - 0.4;
  const pitch = CELL_WIDTH / 2;
  const span = 26;
  const plates = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(radius, radius, CELL_THICK, 6),
    solid(0xffffff),
    (2 * span + 1) ** 2,
  );
  const [place, base, shade] = [new THREE.Object3D(), new THREE.Color(side.colour), new THREE.Color(side.dark)];
  let i = 0;
  for (let row = -span; row <= span; row++) {
    for (let col = -span; col <= span; col++) {
      const centre = row === 0 && col === 0;
      const seed = (row + 60) * 131 + col + 60;
      place.position.set(
        Math.sqrt(3) * pitch * (col + (row & 1 ? 0.5 : 0)),
        CELL_THICK / 2 + (centre ? 0 : hash(seed) * 0.7), // the middle cell is the one that will touch
        1.5 * pitch * row,
      );
      place.rotation.set(centre ? 0 : (hash(seed + 1) - 0.5) * 0.05, 0, centre ? 0 : (hash(seed + 2) - 0.5) * 0.05);
      place.updateMatrix();
      plates.setMatrixAt(i, place.matrix);
      plates.setColorAt(i, base.clone().lerp(shade, hash(seed + 3) * 0.28));
      i++;
    }
  }
  group.add(plates);
  const mortar = new THREE.PlaneGeometry(1700, 1700);
  mortar.rotateX(-Math.PI / 2);
  mortar.translate(0, CELL_THICK + 0.3, 0);
  group.add(new THREE.Mesh(mortar, solid(side.dark, { side: THREE.DoubleSide })));
  return group;
}

/** A flat sheet whose relief is a repeating bump texture: `tile` is the texture's width in the layer's unit. */
function sheet(side: Side, width: number, tile: [number, number], bumps: THREE.Texture, textures: THREE.Texture[]) {
  bumps.repeat.set(width / tile[0], width / tile[1]);
  textures.push(bumps);
  const geometry = new THREE.PlaneGeometry(width, width);
  geometry.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geometry, solid(side.colour, { side: THREE.DoubleSide, bumpMap: bumps, bumpScale: 2 }));
}

/** Where the fat molecules stand: packed like oranges, out to `reach` nanometres from the middle one. */
function chainSites(reach: number): [number, number][] {
  const sites: [number, number][] = [];
  const rows = Math.ceil(reach / (CHAIN_SPACING * 0.866));
  for (let row = -rows; row <= rows; row++) {
    for (let col = -Math.ceil(reach / CHAIN_SPACING) - 1; col <= Math.ceil(reach / CHAIN_SPACING) + 1; col++) {
      const x = CHAIN_SPACING * (col + (row & 1 ? 0.5 : 0));
      const z = CHAIN_SPACING * 0.866 * row;
      if (Math.hypot(x, z) <= reach) sites.push([x, z]);
    }
  }
  return sites.sort((a, b) => Math.hypot(...a) - Math.hypot(...b)); // nearest the middle first
}

const ATOM_SITES = 19; // the middle molecule and two rings round it are drawn as atoms with clouds

function chains(side: Side): THREE.Object3D {
  const group = new THREE.Group();
  const sites = chainSites(6.5);
  const beads = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(BEAD_RADIUS, 1),
    solid(0xffffff, { roughness: 0.55 }),
    sites.length * CHAIN_BEADS,
  );
  const [place, base, tip] = [new THREE.Object3D(), new THREE.Color(side.colour), new THREE.Color(side.cloud)];
  sites.forEach(([x, z], s) => {
    const inner = s < ATOM_SITES;
    const recess = inner ? 0 : hash(s) * 0.07;
    const lean = inner ? 0 : hash(s + 500) * 0.14;
    const towards = hash(s + 900) * Math.PI * 2;
    for (let j = 0; j < CHAIN_BEADS; j++) {
      const zig = (j % 2 ? 1 : -1) * 0.04;
      const up = j * CHAIN_STEP;
      place.position.set(x + zig + Math.cos(towards) * lean * up, recess + up, z + Math.sin(towards) * lean * up);
      place.updateMatrix();
      beads.setMatrixAt(s * CHAIN_BEADS + j, place.matrix);
      beads.setColorAt(s * CHAIN_BEADS + j, j === 0 ? tip : base);
    }
  });
  group.add(beads);
  const body = new THREE.PlaneGeometry(500, 500);
  body.rotateX(-Math.PI / 2);
  body.translate(0, CHAIN_BEADS * CHAIN_STEP, 0);
  group.add(new THREE.Mesh(body, solid(side.dark, { side: THREE.DoubleSide })));
  return group;
}

/** The nearest atoms as what they are: a nucleus (drawn far too large to be seen at all) in a cloud of electrons. */
function atoms(side: Side, clouds: { mesh: THREE.Object3D; weight: number }[]): THREE.Object3D {
  const group = new THREE.Group();
  const glow = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
  const outer = new THREE.SphereGeometry(CLOUD_RADIUS, 32, 24);
  const inner = new THREE.SphereGeometry(CLOUD_RADIUS * 0.6, 24, 16);
  const nucleus = new THREE.SphereGeometry(0.012, 12, 8);
  const outerMaterial = new THREE.MeshBasicMaterial({ color: side.cloud, opacity: 0.2, ...glow });
  const innerMaterial = new THREE.MeshBasicMaterial({ color: side.cloud, opacity: 0.28, ...glow });
  const nucleusMaterial = new THREE.MeshBasicMaterial({ color: 0xfff6d5, transparent: true });
  chainSites(6.5)
    .slice(0, ATOM_SITES)
    .forEach(([x, z], s) => {
      for (let j = 0; j < 2; j++) {
        const atom = new THREE.Group();
        atom.position.set(x + (j % 2 ? 1 : -1) * 0.04, j * CHAIN_STEP, z);
        const cloud = new THREE.Group();
        cloud.add(new THREE.Mesh(outer, outerMaterial), new THREE.Mesh(inner, innerMaterial));
        atom.add(cloud, new THREE.Mesh(nucleus, nucleusMaterial));
        group.add(atom);
        // Only the atoms that face the other finger are squeezed, the middle one most.
        if (j === 0) clouds.push({ mesh: cloud, weight: s === 0 ? 1 : s < 7 ? 0.7 : 0.4 });
      }
    });
  return group;
}

interface Built {
  layer: Layer;
  groups: THREE.Object3D[];
  materials: { material: THREE.Material; base: number }[];
}

/** Builds the scene and returns how to draw a frame, resize and dispose of it. Throws if WebGL cannot start. */
function build(host: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const fog = new THREE.Fog(BACKGROUND, 1, 10);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 400);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1c2740, 1.1));
  const above = new THREE.DirectionalLight(0xfff1dd, 1.7);
  above.position.set(2, 3, 4);
  const below = new THREE.DirectionalLight(0xdcefff, 1.4);
  below.position.set(-2, -3, 4);
  const inside = new THREE.PointLight(0xffffff, 1.2, 0, 0); // in the gap, so both facing surfaces are lit
  inside.position.set(0, 0, 1.4);
  scene.add(above, below, inside);

  const textures: THREE.Texture[] = [];
  const clouds: { mesh: THREE.Object3D; weight: number }[] = [];
  const make: Record<Layer['id'], (side: Side) => THREE.Object3D> = {
    dome: (side) => dome(side, textures),
    ridges,
    cells,
    envelope: (side) => sheet(side, 12000, [160, 160], lumpTexture(), textures),
    grain: (side) => sheet(side, 600, [4, 3.464], dotTexture(), textures),
    chains,
    atoms: (side) => atoms(side, clouds),
  };
  const built: Built[] = LAYERS.map((layer) => {
    const groups = SIDES.map((side) => {
      const group = make[layer.id](side);
      group.userData.sign = side.sign;
      scene.add(group);
      return group;
    });
    const materials = new Map<THREE.Material, number>();
    for (const group of groups) {
      group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && !materials.has(m)) materials.set(m, m.opacity);
      });
    }
    return { layer, groups, materials: [...materials].map(([material, base]) => ({ material, base })) };
  });

  // Where the clouds are squeezed together the push shows as light.
  const flare = canvasTexture(128, (ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,240,200,0.45)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
  textures.push(flare);
  const flareMaterial = new THREE.SpriteMaterial({
    map: flare,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const push = new THREE.Sprite(flareMaterial);
  scene.add(push);

  // The gap being measured: a thin line from one surface to the other.
  const ruleMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthTest: false });
  const rule = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.5, 0)]),
    ruleMaterial,
  );
  rule.renderOrder = 10;
  scene.add(rule);

  function draw(state: FilmState) {
    const distance = DISTANCE * state.pull;
    const sway = 0.24 * Math.sin(state.t * 0.21 + 0.4);
    camera.position.set(Math.sin(sway) * distance, 0.14 * state.pull, Math.cos(sway) * distance);
    camera.lookAt(0, 0, 0);
    fog.near = distance + 0.5;
    fog.far = distance + 5.5;

    const atomsShown = layerOpacity(LAYERS[LAYERS.length - 1], state.unit);
    built.forEach(({ layer, groups, materials }, order) => {
      // Once the nearest atoms are drawn as clouds, the molecules behind them fade to a faint frame.
      const opacity = layerOpacity(layer, state.unit) * (layer.id === 'chains' ? 1 - 0.7 * atomsShown : 1);
      const size = layer.natural / state.unit;
      for (const group of groups) {
        const sign = group.userData.sign as number;
        group.visible = opacity > 0.01;
        group.scale.set(size, sign * size, size);
        // Finer layers sit a hair nearer the gap, so two layers never fight for the same surface while they cross-fade.
        group.position.y = sign * (state.sceneGap / 2 - order * 0.002);
      }
      for (const { material, base } of materials) {
        material.opacity = base * opacity;
        material.depthWrite = opacity > 0.5 && base === 1 && !(layer.id === 'chains' && atomsShown > 0.5);
      }
    });

    for (const { mesh, weight } of clouds) {
      const squeeze = 0.28 * state.press * weight;
      const shiver = 0.004 * Math.sin(state.t * 23 + weight * 5); // heat: atoms are never still
      mesh.scale.y = 1 - squeeze;
      mesh.position.y = CLOUD_RADIUS * squeeze + shiver;
    }

    const pushing = Math.max(0, Math.min(1, state.force / 3e-11)) * atomsShown;
    push.visible = pushing > 0.01;
    push.scale.set(1.3, 0.25 + 0.2 * pushing, 1);
    flareMaterial.opacity = pushing;

    rule.scale.y = state.sceneGap;
    ruleMaterial.opacity = 0.65 * (1 - 0.6 * atomsShown);
    renderer.render(scene, camera);
  }

  function resize(width: number, height: number) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => x.dispose());
    });
    textures.forEach((t) => t.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { draw, resize, dispose, canvas: renderer.domElement };
}

/** The film as a three.js scene. Calls onFail when the browser cannot start, or loses, WebGL. */
export function Film3D({ state, onFail }: { state: FilmState; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReturnType<typeof build> | null>(null);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let made: ReturnType<typeof build>;
    try {
      made = build(el);
    } catch {
      onFail();
      return;
    }
    scene.current = made;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width < 2 || height < 2) return;
      made.resize(width, height);
      made.draw(latest.current);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    const lost = (e: Event) => {
      e.preventDefault();
      onFail();
    };
    made.canvas.addEventListener('webglcontextlost', lost);
    return () => {
      observer.disconnect();
      made.canvas.removeEventListener('webglcontextlost', lost);
      scene.current = null;
      made.dispose();
    };
    // Built once: onFail only switches the page to the flat picture.
  }, []);

  useEffect(() => {
    scene.current?.draw(state);
  }, [state]);

  return <div ref={host} className="at-picture" role="img" aria-label="The film, drawn in 3D" />;
}
