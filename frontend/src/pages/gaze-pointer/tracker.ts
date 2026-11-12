/* The camera side: MediaPipe's FaceLandmarker (Apache 2.0), run in the browser from jsDelivr and Google's model
   store. Each video frame gives 478 face points, 52 expression scores (blendshapes) and the head's rotation. This file
   turns them into four gaze features for the calibration to map, and the scores the clicks use. Nothing leaves the
   browser: the library, its WebAssembly and the model are downloaded, then every frame is processed here. */

const VERSION = '0.10.21';
export const LIBRARY = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export interface FaceFrame {
  /** Where the eyes point: iris across and down within each eye (averaged), then the head's yaw and pitch. */
  features: number[];
  /** A few points to draw on the preview, as fractions of the video frame. */
  points: { x: number; y: number; kind: 'iris' | 'eye' | 'nose' }[];
  /** The blendshape scores the clicks use, each 0 to 1. */
  scores: Record<string, number>;
}

export interface Tracker {
  detect(video: HTMLVideoElement, tMs: number): FaceFrame | null;
  close(): void;
}

// Landmark numbers in MediaPipe's face mesh: each eye's outer and inner corner, upper and lower lid, and iris centre.
const EYES = [
  { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 },
  { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 },
];
const NOSE = 1;
const WANTED = ['jawOpen', 'mouthPressLeft', 'mouthPressRight', 'mouthClose', 'eyeBlinkLeft', 'eyeBlinkRight'];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function landmarker(vision: any, files: any, delegate: 'GPU' | 'CPU') {
  return vision.FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

/** Loads the library, its WebAssembly and the model (about 4 MB together), on the graphics card if it can. */
export async function createTracker(): Promise<Tracker> {
  const vision: any = await import(/* @vite-ignore */ `${LIBRARY}/vision_bundle.mjs`);
  const files = await vision.FilesetResolver.forVisionTasks(`${LIBRARY}/wasm`);
  let face: any;
  try {
    face = await landmarker(vision, files, 'GPU');
  } catch {
    face = await landmarker(vision, files, 'CPU');
  }
  let lastT = -1;
  return {
    detect(video, tMs) {
      if (video.readyState < 2) return null;
      const t = tMs <= lastT ? lastT + 1 : tMs; // the library wants strictly rising times
      lastT = t;
      const r = face.detectForVideo(video, t);
      const lm: { x: number; y: number }[] | undefined = r.faceLandmarks?.[0];
      if (!lm || lm.length < 474) return null;
      let gx = 0;
      let gy = 0;
      for (const e of EYES) {
        const width = Math.hypot(lm[e.outer].x - lm[e.inner].x, lm[e.outer].y - lm[e.inner].y) || 1e-6;
        gx += (lm[e.iris].x - (lm[e.outer].x + lm[e.inner].x) / 2) / width;
        gy += (lm[e.iris].y - (lm[e.top].y + lm[e.bottom].y) / 2) / width;
      }
      // The head's rotation, from the 4×4 transform (column-major): yaw about the vertical, pitch about the side.
      const m: number[] | undefined = r.facialTransformationMatrixes?.[0]?.data;
      const yaw = m ? Math.atan2(-m[2], Math.hypot(m[6], m[10])) : 0;
      const pitch = m ? Math.atan2(m[6], m[10]) : 0;
      const scores: Record<string, number> = {};
      for (const c of r.faceBlendshapes?.[0]?.categories ?? []) {
        if (WANTED.includes(c.categoryName)) scores[c.categoryName] = c.score;
      }
      const points: FaceFrame['points'] = [];
      for (const e of EYES) {
        points.push({ ...lm[e.iris], kind: 'iris' });
        for (const k of [e.outer, e.inner, e.top, e.bottom]) points.push({ ...lm[k], kind: 'eye' });
      }
      points.push({ ...lm[NOSE], kind: 'nose' });
      return { features: [gx / 2, gy / 2, yaw, pitch], points, scores };
    },
    close() {
      face.close?.();
    },
  };
}
