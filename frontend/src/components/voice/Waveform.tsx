import { useEffect, useRef, useState } from 'react';

const BARS = 48;
const STEP_MS = 70; // a new bar this often, so the wave scrolls left as you speak

/**
 * A live waveform of the microphone: the loudness of the last few seconds as bars, newest on the right. It opens its
 * own audio stream for the levels only; recognition has its own. Quiet shows as dots.
 */
export function Waveform({ active }: { active: boolean }) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const frame = useRef(0);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let stopped = false;
    let last = 0;
    let peak = 0;

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(s).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = (now: number) => {
          if (stopped) return;
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) sum += v * v;
          peak = Math.max(peak, Math.sqrt(sum / samples.length));
          if (now - last >= STEP_MS) {
            last = now;
            const level = Math.min(1, peak * 6); // speech RMS is small: scale it so normal talking fills the bar
            peak = 0;
            setLevels((ls) => [...ls.slice(1), level]);
          }
          frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
      })
      .catch(() => undefined); // no level meter without the microphone; recognition reports its own errors

    return () => {
      stopped = true;
      cancelAnimationFrame(frame.current);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
      setLevels(Array(BARS).fill(0));
    };
  }, [active]);

  return (
    <div className="vc-wave" aria-hidden="true">
      {levels.map((l, i) => (
        <i key={i} style={{ height: `${Math.max(3, Math.round(l * 26))}px` }} className={l < 0.04 ? 'dot' : ''} />
      ))}
    </div>
  );
}
