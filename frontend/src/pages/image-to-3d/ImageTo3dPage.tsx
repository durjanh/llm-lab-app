import { useEffect, useRef, useState } from 'react';
import {
  imageTo3dService,
  type ImageTo3dEvent,
  type ImageTo3dInfo,
  type ImageTo3dResult,
  type ImageTo3dSettings,
} from '@/services/imageTo3dService';
import SplatViewer from './SplatViewer';
import './image-to-3d.css';

interface Shown {
  result: ImageTo3dResult;
  ply: ArrayBuffer;
  input: string; // object URL of the image Idol saw
}

const fmtTime = (s: number | undefined) =>
  s === undefined ? '' : s < 90 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
const fmtMb = (b: number | undefined) => (b === undefined ? '' : `${(b / 2 ** 20).toFixed(1)} MB`);

/** Image to 3D: Idol turns one photo into an object made of Gaussian splats, on this machine, and the page shows it. */
export default function ImageTo3dPage() {
  const [info, setInfo] = useState<ImageTo3dInfo | null>(null);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [settings, setSettings] = useState<ImageTo3dSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<{ step: string; at: number }[]>([]);
  const [device, setDevice] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [flip, setFlip] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(0); // the newest Show click; an older one that answers later is dropped

  const load = () =>
    imageTo3dService
      .info()
      .then((i) => {
        setInfo(i);
        setSettings((s) => s ?? i.defaults);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
    return () => {
      abort.current?.abort(); // leaving the page stops the run
      latest.current = -1; // and drops any Show still loading
    };
  }, []);

  useEffect(() => {
    if (!file) return setPreview('');
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(
    () => () => {
      if (shown) URL.revokeObjectURL(shown.input);
    },
    [shown],
  );

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const show = async (result: ImageTo3dResult) => {
    const mine = ++latest.current;
    setError('');
    try {
      const [ply, input] = await Promise.all([
        imageTo3dService.file(result.id, 'object.ply').then((b) => b.arrayBuffer()),
        imageTo3dService.file(result.id, 'input.png'),
      ]);
      if (mine !== latest.current) return; // another object was asked for since, or the page has gone
      setShown({ result, ply, input: URL.createObjectURL(input) });
    } catch (e) {
      if (mine === latest.current) setError((e as Error).message);
    }
  };

  const make = async () => {
    if (!file || !settings) return;
    setError('');
    setSteps([]);
    setDevice('');
    setElapsed(0);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    let made: ImageTo3dResult | null = null;
    const onEvent = (e: ImageTo3dEvent) => {
      if (e.type === 'progress') setSteps((s) => [...s, { step: e.step, at: e.elapsed_s ?? 0 }]);
      else if (e.type === 'setup') setDevice(e.device);
      else if (e.type === 'done') made = e.result;
      else if (e.type === 'error') setError(e.message);
    };
    try {
      await imageTo3dService.generate(file, settings, onEvent, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
    if (made) await show(made);
    load();
  };

  const cancel = () => {
    imageTo3dService
      .cancel()
      .then(() => load())
      .catch(() => undefined);
  };

  const remove = async (id: string) => {
    await imageTo3dService.remove(id).catch((e: Error) => setError(e.message));
    if (shown?.result.id === id) setShown(null);
    load();
  };

  const tooBig = !!file && !!info && file.size > info.limits.image_bytes;

  return (
    <main className="page-image-to-3d">
      <div className="kicker">Open models · Image to 3D</div>
      <h1>One photo in, a 3D object out</h1>
      <p className="lede">
        Idol, an open model from Speridlabs (Apache 2.0), looks at a single photo of an object and builds it in 3D as
        Gaussian splats: tens of thousands to a million small, coloured, see-through blobs that together look solid from
        any side. It runs here, on this machine, so it costs nothing and the photo never leaves it.
      </p>

      {error && <p className="i3-error">{error}</p>}

      {info && !info.ready && (
        <section className="card i3-setup">
          <h2>Set it up once</h2>
          <ol>
            <li>
              Install Idol in its own environment (it needs PyTorch, which the lab's own environment does not have).
              From the repo root: <code>{info.setup}</code>
            </li>
            <li>
              Idol uses two image encoders that are gated on Hugging Face. Open each page while signed in and accept its
              terms:{' '}
              {info.gated.map((g, i) => (
                <span key={g.repo}>
                  {i > 0 && ' and '}
                  <a href={`https://huggingface.co/${g.repo}`} target="_blank" rel="noreferrer">
                    {g.repo}
                  </a>{' '}
                  ({g.what})
                </span>
              ))}
              . Their terms are their own, separate from Idol's Apache 2.0 licence, so read them.
            </li>
            <li>
              Sign that environment in to Hugging Face: <code>examples/image-to-3d/.venv/bin/hf auth login</code>
            </li>
          </ol>
          <p className="small muted">
            The first run downloads about 3 GB of Idol's weights and then the two encoders. Reload this page when the
            install has finished.
          </p>
        </section>
      )}

      <section className="card">
        <h2>Make an object</h2>
        <p className="small muted">
          Works best on one object on a plain background. Idol removes the background itself. Running on:{' '}
          {info?.machine ?? '…'}.
        </p>
        <div className="i3-make">
          <div>
            <label className="i3-drop">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={running}
              />
              {preview ? (
                <img src={preview} alt="The photo you chose" />
              ) : (
                <span>Choose a photo (PNG, JPEG or WebP)</span>
              )}
            </label>
            {tooBig && <p className="i3-error small">That photo is over the 15 MB limit.</p>}
          </div>
          {settings && info && (
            <div className="i3-settings">
              <label>
                The image is
                <select
                  value={settings.mode}
                  onChange={(e) => setSettings({ ...settings, mode: e.target.value as ImageTo3dSettings['mode'] })}
                  disabled={running}
                >
                  <option value="real">a photograph</option>
                  <option value="synthetic">computer generated</option>
                </select>
              </label>
              <label>
                Sampling steps <span className="mono">{settings.steps}</span>
                <input
                  type="range"
                  min={info.limits.steps[0]}
                  max={info.limits.steps[1]}
                  step={5}
                  value={settings.steps}
                  onChange={(e) => setSettings({ ...settings, steps: Number(e.target.value) })}
                  disabled={running}
                />
              </label>
              <label>
                Gaussians
                <select
                  value={settings.num_gaussians}
                  onChange={(e) => setSettings({ ...settings, num_gaussians: Number(e.target.value) })}
                  disabled={running}
                >
                  {info.limits.gaussians.map((g) => (
                    <option key={g} value={g}>
                      {g.toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Seed
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={settings.seed}
                  onChange={(e) =>
                    setSettings({ ...settings, seed: Math.max(0, Math.min(100000, Number(e.target.value) || 0)) })
                  }
                  disabled={running}
                />
              </label>
              <p className="small muted">
                More steps give a cleaner shape, more Gaussians finer detail; both take longer. The same seed and
                settings make the same object.
              </p>
              <div className="i3-buttons">
                <button
                  className="btn primary"
                  onClick={make}
                  disabled={!info.ready || !file || tooBig || running || info.busy}
                >
                  Make the 3D object
                </button>
                {(running || info.busy) && ( // a run from another tab, or from before a reload, can be stopped too
                  <button className="btn" onClick={cancel}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {(running || steps.length > 0) && (
          <div className="i3-progress">
            <p className="small">
              <b>{running ? `Working: ${fmtTime(elapsed)}` : 'Finished'}</b>
              {device && ` on ${device.toUpperCase()}`}
            </p>
            <ol className="small">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="mono muted">{fmtTime(s.at)}</span> {s.step}
                </li>
              ))}
            </ol>
          </div>
        )}
        {info && (
          <details className="i3-timings">
            <summary className="small">How long it takes (Speridlabs' published times)</summary>
            <table className="t small">
              <thead>
                <tr>
                  <th>Machine</th>
                  <th>Setting</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {info.timings.map((t, i) => (
                  <tr key={i}>
                    <td>{t.where}</td>
                    <td>{t.setting}</td>
                    <td>{t.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              The fast path (compiled sampling) is CUDA only, so a Mac runs it more slowly. Loading the weights adds
              time on every run, because each run starts the model afresh.
            </p>
          </details>
        )}
      </section>

      {shown && (
        <section className="card">
          <h2>The object</h2>
          <div className="i3-result">
            <SplatViewer bytes={shown.ply} flip={flip} label="The 3D object Idol made from the photo, made of splats" />
            <div className="i3-side">
              <img src={shown.input} alt="The image Idol saw: the photo with its background removed, cropped" />
              <p className="small muted">What Idol saw: your photo with the background removed and cropped.</p>
              <label className="small">
                <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Turn it the right
                way up (splat files are usually stored upside down)
              </label>
              <p className="small">
                {shown.result.settings.steps} steps, {shown.result.settings.num_gaussians.toLocaleString()} Gaussians,
                seed {shown.result.settings.seed}
                {shown.result.device && `, on ${shown.result.device.toUpperCase()}`}.
                {shown.result.generate_s !== undefined &&
                  ` Making it took ${fmtTime(shown.result.generate_s)}, after ${fmtTime(shown.result.load_s)} loading.`}
              </p>
              <button
                className="btn"
                onClick={() => imageTo3dService.save(shown.result.id, 'object.ply', `idol-${shown.result.id}.ply`)}
              >
                Save the .ply ({fmtMb(shown.result.ply_bytes)})
              </button>
              <p className="small muted">A standard 3DGS file: it opens in any Gaussian splat viewer.</p>
            </div>
          </div>
        </section>
      )}

      {info && info.results.length > 0 && (
        <section className="card">
          <h2>Objects made here</h2>
          <ul className="i3-list">
            {info.results.map((r) => (
              <li key={r.id} className={shown?.result.id === r.id ? 'on' : ''}>
                <span className="small">
                  {new Date(r.created * 1000).toLocaleString()} · {r.settings.steps} steps ·{' '}
                  {r.settings.num_gaussians.toLocaleString()} Gaussians · {fmtTime(r.total_s)}
                </span>
                <span className="i3-buttons">
                  <button className="btn" onClick={() => show(r)}>
                    Show
                  </button>
                  <button className="btn ghost" onClick={() => remove(r.id)}>
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>How it works</h2>
        <ol className="i3-how">
          <li>
            <b>Clean the photo.</b> BiRefNet cuts the object out and Idol crops it to 1024 × 1024.
          </li>
          <li>
            <b>Read the image.</b> Two encoders turn it into numbers the model can use: DINOv3 for what the object is
            and its shape, FLUX.2's autoencoder for fine colour and texture.
          </li>
          <li>
            <b>Sample a shape.</b> A 370-million-parameter diffusion transformer starts from random noise and, step by
            step, turns it into a compact description of the object (a latent). Each step is one pass of the model, so
            steps are the main cost.
          </li>
          <li>
            <b>Decode into splats.</b> Two decoders turn that latent into Gaussians: each has a position, size,
            rotation, colour and opacity. More Gaussians means finer detail and a bigger file.
          </li>
        </ol>
        <p className="small">
          Splats are not a mesh. There are no faces to edit or 3D-print, but they show soft edges, fur and shine well,
          and they draw fast in a browser. All of Idol is about 1.8 billion parameters; it needs about 7 GB of GPU
          memory at its defaults, or about 24 GB on a Mac.
        </p>
      </section>
    </main>
  );
}
