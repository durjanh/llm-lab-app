import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { polyhedron, scale, type Section, type Solid, type Vec, unit } from './geometry';

/** Whether this browser can draw WebGL (some locked-down or GPU-less browsers cannot). */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Without WebGL: the solid and its section drawn flat, from a fixed angle, so the page still works. */
function FlatSolid({ solid, section }: { solid: Solid; section: Section | null }) {
  const poly = polyhedron(solid);
  const yaw = -0.6;
  const pitch = 0.45;
  const project = ([x, y, z]: Vec): [number, number] => {
    const x1 = x * Math.cos(yaw) - z * Math.sin(yaw);
    const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
    const y1 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
    return [x1, -y1];
  };
  const size = Math.max(solid.width, solid.depth, solid.height) * 1.1;
  const r = Math.min(solid.width, solid.depth, solid.height) / 2;
  return (
    <svg
      className="wb-3d"
      viewBox={`${-size} ${-size} ${2 * size} ${2 * size}`}
      role="img"
      aria-label={`A ${solid.shape}`}
    >
      {solid.shape === 'sphere' && <circle cx={0} cy={0} r={r} fill="none" stroke="#f8fafc" strokeWidth={size / 150} />}
      {poly?.edges.map(([a, b], i) => {
        const [x1, y1] = project(poly.vertices[a]);
        const [x2, y2] = project(poly.vertices[b]);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#f8fafc" strokeWidth={size / 150} />;
      })}
      {section && (
        <polygon
          points={section.points.map((p) => project(p).join(',')).join(' ')}
          fill="#3b82f6"
          fillOpacity={0.7}
          stroke="#60a5fa"
          strokeWidth={size / 150}
        />
      )}
      {section &&
        !section.curved &&
        section.points.map((p, i) => {
          const [x, y] = project(p);
          return <circle key={i} cx={x} cy={y} r={size / 60} fill="#f472b6" />;
        })}
      <text x={-size * 0.95} y={size * 0.95} fontSize={size / 14} fill="#9ca3af">
        Flat view: this browser cannot draw 3D (WebGL)
      </text>
    </svg>
  );
}

/**
 * The solid in 3D: drag to turn it, scroll to zoom. Flat-faced solids are built from the same vertices the section is
 * computed from, so what you see and what is measured agree. The cutting plane is translucent and the section blue.
 */
export function Solid3D({
  solid,
  normal,
  offset,
  section,
  showPlane,
}: {
  solid: Solid;
  normal: Vec;
  offset: number;
  section: Section | null;
  showPlane: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<{ scene: THREE.Scene; dynamic: THREE.Group } | null>(null);
  const [flat, setFlat] = useState(() => !hasWebGL());

  // The scene, camera, controls and the solid itself: made again when the solid changes.
  useEffect(() => {
    const el = host.current;
    if (!el || flat) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFlat(true); // the context could not be made after all: draw it flat instead
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    const size = Math.max(solid.width, solid.depth, solid.height);
    camera.position.set(size * 1.9, size * 1.3, size * 2.3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(3, 5, 4);
    scene.add(light);

    const faces = new THREE.MeshStandardMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const lines = new THREE.LineBasicMaterial({ color: 0xf8fafc });
    const poly = polyhedron(solid);
    const r = Math.min(solid.width, solid.depth, solid.height) / 2;
    let geometry: THREE.BufferGeometry;
    if (solid.shape === 'sphere') geometry = new THREE.SphereGeometry(r, 48, 32);
    else if (solid.shape === 'cylinder') {
      geometry = new THREE.CylinderGeometry(solid.width / 2, solid.width / 2, solid.height, 48);
      geometry.scale(1, 1, solid.depth / solid.width);
    } else if (solid.shape === 'cone') {
      geometry = new THREE.ConeGeometry(solid.width / 2, solid.height, 48);
      geometry.scale(1, 1, solid.depth / solid.width);
    } else geometry = new ConvexGeometry(poly!.vertices.map((v) => new THREE.Vector3(...v)));
    scene.add(new THREE.Mesh(geometry, faces));

    if (poly && !poly.curved) {
      const segs = poly.edges.flatMap(([a, b]) => [...poly.vertices[a], ...poly.vertices[b]]);
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
      scene.add(new THREE.LineSegments(edgeGeo, lines));
      const dots = new THREE.BufferGeometry();
      dots.setAttribute('position', new THREE.Float32BufferAttribute(poly.vertices.flat(), 3));
      scene.add(new THREE.Points(dots, new THREE.PointsMaterial({ color: 0xf8fafc, size: 0.09 })));
    } else {
      scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), lines));
    }
    const dynamic = new THREE.Group();
    scene.add(dynamic);
    world.current = { scene, dynamic };

    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
      world.current = null;
    };
  }, [solid, flat]);

  // The plane and the section: redrawn whenever they move.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    for (const child of [...w.dynamic.children]) {
      w.dynamic.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    }
    const n = unit(normal);
    if (showPlane) {
      const size = Math.max(solid.width, solid.depth, solid.height) * 2.2;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...n));
      plane.position.set(...scale(n, offset));
      w.dynamic.add(plane);
    }
    if (section && section.points.length >= 3) {
      const pts = section.points;
      const centre = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]] as Vec, [0, 0, 0] as Vec);
      const c = centre.map((x) => x / pts.length);
      const tri: number[] = [];
      pts.forEach((p, i) => tri.push(...c, ...p, ...pts[(i + 1) % pts.length]));
      const fill = new THREE.BufferGeometry();
      fill.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
      w.dynamic.add(
        new THREE.Mesh(
          fill,
          new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
        ),
      );
      const outline = new THREE.BufferGeometry();
      outline.setAttribute('position', new THREE.Float32BufferAttribute([...pts.flat(), ...pts[0]], 3));
      w.dynamic.add(new THREE.Line(outline, new THREE.LineBasicMaterial({ color: 0x60a5fa })));
      if (!section.curved) {
        const corners = new THREE.BufferGeometry();
        corners.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
        w.dynamic.add(new THREE.Points(corners, new THREE.PointsMaterial({ color: 0xf472b6, size: 0.11 })));
      }
    }
  }, [solid, normal, offset, section, showPlane]);

  if (flat) return <FlatSolid solid={solid} section={section} />;
  return <div ref={host} className="wb-3d" role="img" aria-label={`A ${solid.shape.replace('_', ' ')} you can turn`} />;
}
