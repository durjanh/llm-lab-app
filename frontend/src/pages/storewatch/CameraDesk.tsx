import { useEffect, useRef, useState } from 'react';
import { findFaces, loadFaceModel, type Face } from '@/lib/faceModel';
import { storeWatchService as desk, type DeskState } from '@/services/storewatchService';

const WIDTH = 480;
const WATCH_MS = 3 * 60 * 1000; // a limit, so a forgotten tab doesn't keep paying for the behaviour model
const FRAME_EVERY_MS = 1500;
const FRAMES = 3;
const COOL_DOWN_MS = 30_000;
const DOOR_EVERY_MS = 1200;

/** One frame for the behaviour model, with every face blurred first, so that model never sees one. */
function blurredFrame(video: HTMLVideoElement, faces: Face[]): string {
  const canvas = document.createElement('canvas');
  const scale = WIDTH / video.videoWidth;
  canvas.width = WIDTH;
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  for (const { box } of faces) {
    const pad = box.width * 0.25 * scale;
    const [x, y, w, h] = [
      box.x * scale - pad,
      box.y * scale - pad,
      box.width * scale + 2 * pad,
      box.height * scale + 2 * pad,
    ];
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = 'blur(26px)';
    ctx.drawImage(canvas, 0, 0);
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }
  return canvas.toDataURL('image/jpeg', 0.6);
}

/** A small picture of one face, so that staff can compare a possible match with a person. */
function thumbnail(video: HTMLVideoElement, face: Face): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const { x, y, width, height } = face.box;
  canvas.getContext('2d')!.drawImage(video, x, y, width, height, 0, 0, 96, 96);
  return canvas.toDataURL('image/jpeg', 0.7);
}

interface Props {
  state: DeskState;
  name: string;
  threshold: number;
  onState: (s: DeskState) => void;
  onError: (message: string) => void;
}

/** Test mode: a webcam, a real behaviour model and real face templates, for people who have agreed. */
export function CameraDesk({ state, name, threshold, onState, onError }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const watchTimer = useRef(0);
  const doorTimer = useRef(0);
  const busy = useRef({ watch: false, door: false });
  const live = useRef({ threshold, onState, onError });
  live.current = { threshold, onState, onError };
  const [agreed, setAgreed] = useState(false);
  const [status, setStatus] = useState<'off' | 'loading' | 'on'>('off');
  const [watching, setWatching] = useState(false);
  const [door, setDoor] = useState(false);
  const [note, setNote] = useState('');
  const [faces, setFaces] = useState(0);
  const [layout, setLayout] = useState(state.default_layout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const stopWatch = () => {
    clearInterval(watchTimer.current);
    setWatching(false);
  };
  const stopDoor = () => {
    clearInterval(doorTimer.current);
    setDoor(false);
  };
  const stopCamera = () => {
    stopWatch();
    stopDoor();
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setStatus('off');
  };

  useEffect(
    () => () => {
      clearInterval(watchTimer.current);
      clearInterval(doorTimer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const startCamera = async () => {
    setStatus('loading');
    setNote('Loading the face model, about 7 MB the first time…');
    try {
      await loadFaceModel();
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      video.current!.srcObject = stream.current;
      await video.current!.play();
      setStatus('on');
      setNote('Camera on.');
    } catch (err) {
      setStatus('off');
      setNote('');
      live.current.onError(`The camera could not start: ${(err as Error).message}`);
    }
  };

  const startWatch = () => {
    const frames: string[] = [];
    const started = Date.now();
    let quietUntil = 0;
    let last: Face | undefined;
    let lastThumb: string | undefined;
    setWatching(true);
    setNote('Watching. Every few seconds, blurred frames go to the behaviour model.');
    watchTimer.current = window.setInterval(async () => {
      const v = video.current;
      if (!v || busy.current.watch) return;
      if (Date.now() - started > WATCH_MS) {
        stopWatch();
        setNote('Stopped after three minutes, to limit the cost.');
        return;
      }
      if (Date.now() < quietUntil) return;
      busy.current.watch = true;
      try {
        const found = await findFaces(v);
        setFaces(found.length);
        if (found[0]) {
          last = found[0];
          lastThumb = thumbnail(v, found[0]);
        }
        frames.push(blurredFrame(v, found));
        if (frames.length < FRAMES) return;
        const batch = frames.splice(0, FRAMES);
        const result = await desk.cameraAnalyse(
          batch,
          last?.descriptor ?? null,
          last ? lastThumb! : null,
          layoutRef.current,
        );
        live.current.onState(result);
        setNote(
          `Score ${result.last_camera.score}${result.last_camera.left_unpaid ? ', left without paying' : result.last_camera.carrying ? ', carrying something unpaid' : ''}. ${result.last_camera.what}`,
        );
        if (result.last_camera.alerted) quietUntil = Date.now() + COOL_DOWN_MS;
      } catch (err) {
        stopWatch();
        live.current.onError((err as Error).message);
      } finally {
        busy.current.watch = false;
      }
    }, FRAME_EVERY_MS);
  };

  const startDoor = () => {
    setDoor(true);
    doorTimer.current = window.setInterval(async () => {
      const v = video.current;
      if (!v || busy.current.door) return;
      busy.current.door = true;
      try {
        const found = await findFaces(v);
        setFaces(found.length);
        for (const face of found.slice(0, 3)) {
          live.current.onState(await desk.cameraDoor(face.descriptor, live.current.threshold));
        }
      } catch (err) {
        stopDoor();
        live.current.onError((err as Error).message);
      } finally {
        busy.current.door = false;
      }
    }, DOOR_EVERY_MS);
  };

  const ready = !!state.compliance && !!state.camera_consent;
  return (
    <section className="card sw-step" id="camera">
      <h2>2. Your camera (test mode)</h2>
      <p className="muted">
        A real webcam, a real behaviour model and real face templates.{' '}
        <b>Use this only on yourself and adults who have agreed.</b> It does not connect to shop CCTV, and shoppers must
        not be enrolled until the DPIA and legal advice are done.
      </p>
      {!state.camera_available && <p className="sw-error">The behaviour model needs Azure OpenAI settings in .env.</p>}
      {!state.compliance && <p className="muted">Complete step 1 first.</p>}
      {state.compliance && !state.camera_consent && (
        <div className="sw-row">
          <label className="sw-check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> Everyone in view is
            an adult who has agreed to take part
          </label>
          <button
            className="btn primary"
            disabled={!agreed}
            onClick={() =>
              desk
                .cameraConsent(name)
                .then(onState)
                .catch((e: Error) => onError(e.message))
            }
          >
            Confirm
          </button>
        </div>
      )}
      {ready && (
        <>
          <div className="sw-row">
            {status === 'on' ? (
              <button className="btn" onClick={stopCamera}>
                Stop camera
              </button>
            ) : (
              <button className="btn primary" disabled={status === 'loading'} onClick={() => void startCamera()}>
                Start camera
              </button>
            )}
            <button className="btn" disabled={status !== 'on'} onClick={watching ? stopWatch : startWatch}>
              {watching ? 'Stop watching' : 'Watch for hiding an item'}
            </button>
            <button className="btn" disabled={status !== 'on'} onClick={door ? stopDoor : startDoor}>
              {door ? 'Stop door check' : 'Start door check'}
            </button>
            {status === 'on' && <span className="small muted">Faces in view: {faces}</span>}
          </div>
          <video ref={video} className={`sw-video ${status === 'on' ? 'on' : ''}`} muted playsInline />
          <input
            className="sw-layout"
            aria-label="Camera layout"
            value={layout}
            maxLength={300}
            onChange={(e) => setLayout(e.target.value)}
          />
          {note && <p className="small">{note}</p>}
          {state.camera_visit && state.camera_visit.log.length > 0 && (
            <ol className="sw-visit">
              {state.camera_visit.log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          )}
          <p className="small muted">
            Every face the detector finds is blurred in your browser before frames go to Azure OpenAI; a face it misses
            is not. The face template is made in your browser and sent only to this lab&apos;s backend. Try hiding an
            object in a pocket or bag, then use the steps below.
          </p>
        </>
      )}
    </section>
  );
}
