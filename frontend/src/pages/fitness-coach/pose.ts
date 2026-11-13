/* The camera side: MediaPipe's pose landmarker (Apache 2.0), the "full" model, which finds 33 points on one person.
   It runs in the browser from jsDelivr and Google's model store; no frame leaves this computer. */
import type { Pt } from './form';

const VERSION = '0.10.21';
const LIBRARY = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

export interface PoseModel {
  /** The person's 33 points as fractions of the frame, or null when nobody is in view. */
  detect(video: HTMLVideoElement, tMs: number): Pt[] | null;
  close(): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const make = (vision: any, files: any, delegate: 'GPU' | 'CPU') =>
  vision.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

/** Loads the library, its WebAssembly and the model (about 9 MB), on the graphics card if it can. */
export async function createPoseModel(): Promise<PoseModel> {
  const vision: any = await import(/* @vite-ignore */ `${LIBRARY}/vision_bundle.mjs`);
  const files = await vision.FilesetResolver.forVisionTasks(`${LIBRARY}/wasm`);
  let task: any;
  try {
    task = await make(vision, files, 'GPU');
  } catch {
    task = await make(vision, files, 'CPU');
  }
  let last = -1;
  return {
    detect(video, tMs) {
      if (!video.videoWidth || !video.videoHeight) return null;
      const t = tMs <= last ? last + 1 : tMs; // the task wants strictly rising times
      last = t;
      const found = task.detectForVideo(video, t);
      const lm: any[] | undefined = found.landmarks?.[0];
      return lm ? lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })) : null;
    },
    close() {
      task.close();
    },
  };
}
