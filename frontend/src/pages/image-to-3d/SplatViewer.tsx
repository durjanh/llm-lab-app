import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

/**
 * Draws a Gaussian splat .ply with Spark (MIT, World Labs) on three.js: drag to turn it, scroll to zoom. Each splat is
 * a small coloured, see-through ellipsoid; there is no mesh. Splat files usually store the object upside down for
 * three.js, so `flip` turns it 180 degrees about X, as Spark's own examples do.
 */
export default function SplatViewer({ bytes, flip, label }: { bytes: ArrayBuffer; flip: boolean; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [splats, setSplats] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setState('loading');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    } catch {
      setState('failed'); // no WebGL here
      return;
    }
    let disposed = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    camera.position.set(0, 0, 3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;
    controls.addEventListener('start', () => (controls.autoRotate = false)); // the person has taken over
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    // Spark may hand the buffer to a worker, which empties it: give it a copy so a re-render can draw it again.
    const mesh = new SplatMesh({ fileBytes: bytes.slice(0), fileName: 'object.ply' });
    if (flip) mesh.quaternion.set(1, 0, 0, 0);
    scene.add(mesh);
    mesh.initialized
      .then(() => {
        if (disposed) return;
        mesh.updateMatrix();
        const box = mesh.getBoundingBox(true).applyMatrix4(mesh.matrix);
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        controls.target.copy(centre);
        camera.position.copy(centre).add(new THREE.Vector3(0, size * 0.15, size * 1.25));
        camera.near = size / 100;
        camera.far = size * 20;
        camera.updateProjectionMatrix();
        setSplats(mesh.packedSplats?.numSplats ?? 0);
        setState('ready');
      })
      .catch(() => !disposed && setState('failed'));

    const fit = () => {
      const w = el.clientWidth || 320;
      const h = Math.round(Math.min(w * 0.8, 560));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
    return () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      watch.disconnect();
      controls.dispose();
      mesh.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bytes, flip]);

  return (
    <div className="i3-viewer">
      <div ref={host} className="i3-canvas" role="img" aria-label={label} />
      <p className="small muted i3-viewer-note">
        {state === 'loading' && 'Loading the splats…'}
        {state === 'failed' &&
          'This browser could not draw the splats (it needs WebGL 2). The .ply can still be saved.'}
        {state === 'ready' &&
          `${splats.toLocaleString()} splats. Drag to turn it, scroll or pinch to zoom, right-drag to move.`}
      </p>
    </div>
  );
}
