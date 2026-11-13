/* The live desk's eyes: MediaPipe's pose landmarker (up to five people, 33 body points each) and its object detector
   (EfficientDet-Lite0, trained on everyday objects), both run in the browser from jsDelivr and Google's model store.
   Nothing is sent anywhere by this file: every frame is processed here. Coordinates are fractions of the frame. */

const VERSION = '0.10.21';
const LIBRARY = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const OBJECT_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

/** The items a shop cares about: things that can be taken, and things they can be hidden in. */
export const ITEMS = [
  'bottle',
  'cup',
  'cell phone',
  'book',
  'wine glass',
  'remote',
  'scissors',
  'banana',
  'apple',
  'orange',
  'sports ball',
  'teddy bear',
  'toothbrush',
  'mouse',
  'keyboard',
  'laptop',
  'vase',
  'clock',
];
export const BAGS = ['handbag', 'backpack', 'suitcase'];

export interface Point {
  x: number;
  y: number;
  v: number; // visibility, 0 to 1
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detected {
  people: Point[][]; // 33 landmarks per person
  items: { box: Box; label: string; score: number }[];
}

export interface Vision {
  detect(video: HTMLVideoElement | HTMLCanvasElement, tMs: number, withItems: boolean): Detected;
  close(): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function make(vision: any, files: any, delegate: 'GPU' | 'CPU') {
  const pose = await vision.PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 5,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  const objects = await vision.ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: OBJECT_MODEL, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: 0.35,
    maxResults: 12,
    categoryAllowlist: [...ITEMS, ...BAGS],
  });
  return { pose, objects };
}

/** Loads the library, its WebAssembly and both models (about 12 MB together), on the graphics card if it can. */
export async function createVision(): Promise<Vision> {
  const vision: any = await import(/* @vite-ignore */ `${LIBRARY}/vision_bundle.mjs`);
  const files = await vision.FilesetResolver.forVisionTasks(`${LIBRARY}/wasm`);
  let tasks: { pose: any; objects: any };
  try {
    tasks = await make(vision, files, 'GPU');
  } catch {
    tasks = await make(vision, files, 'CPU');
  }
  let lastPose = -1;
  let lastItems = -1;
  let items: Detected['items'] = [];
  return {
    detect(source, tMs, withItems) {
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return { people: [], items: [] };
      const tp = tMs <= lastPose ? lastPose + 1 : tMs; // each task wants strictly rising times
      lastPose = tp;
      const pose = tasks.pose.detectForVideo(source, tp);
      const people: Point[][] = (pose.landmarks ?? []).map((lm: any[]) =>
        lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })),
      );
      if (withItems) {
        const ti = tMs <= lastItems ? lastItems + 1 : tMs;
        lastItems = ti;
        const found = tasks.objects.detectForVideo(source, ti);
        items = (found.detections ?? []).map((d: any) => ({
          box: {
            x: d.boundingBox.originX / width,
            y: d.boundingBox.originY / height,
            w: d.boundingBox.width / width,
            h: d.boundingBox.height / height,
          },
          label: d.categories?.[0]?.categoryName ?? 'item',
          score: d.categories?.[0]?.score ?? 0,
        }));
      }
      return { people, items };
    },
    close() {
      tasks.pose.close();
      tasks.objects.close();
    },
  };
}
