/* Face detection and 128-number face descriptors, run in the browser with @vladmandic/face-api (MIT) from jsDelivr. */
const BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';

export interface Face {
  box: { x: number; y: number; width: number; height: number };
  descriptor: number[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let loading: Promise<any> | null = null;

/** Loads the library and its three small models once. */
export function loadFaceModel(): Promise<unknown> {
  loading ??= (async () => {
    const f = await import(/* @vite-ignore */ `${BASE}/dist/face-api.esm.js`);
    await f.tf.ready();
    const url = `${BASE}/model`;
    await Promise.all([
      f.nets.tinyFaceDetector.loadFromUri(url),
      f.nets.faceLandmark68Net.loadFromUri(url),
      f.nets.faceRecognitionNet.loadFromUri(url),
    ]);
    return f;
  })();
  return loading;
}

/** Every face in the current video frame, largest first. */
export async function findFaces(video: HTMLVideoElement): Promise<Face[]> {
  const f = await loadFaceModel().then((m) => m as any);
  const found = await f
    .detectAllFaces(video, new f.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return found
    .map((r: any): Face => ({
      box: { x: r.detection.box.x, y: r.detection.box.y, width: r.detection.box.width, height: r.detection.box.height },
      descriptor: Array.from(r.descriptor as Float32Array).map((v) => +v.toFixed(5)),
    }))
    .sort((a: Face, b: Face) => b.box.width * b.box.height - a.box.width * a.box.height);
}
