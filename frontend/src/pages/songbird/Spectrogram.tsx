import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * A scrolling spectrogram, 0 to 8 kHz, drawn like ink on paper: time runs left to right, pitch upwards, and darker
 * means louder. draw() adds one column from the synth's analyser.
 */

export interface SpectrogramHandle {
  draw: (analyser: AnalyserNode, active: boolean) => void;
  clear: () => void;
}

const TOP_HZ = 8000;
const WIDTH = 900;
const HEIGHT = 150;
const STEP = 2; // pixels per frame

export const Spectrogram = forwardRef<SpectrogramHandle>(function Spectrogram(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bins = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const clear = () => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#f6f1e7';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  };
  useEffect(clear, []);

  useImperativeHandle(ref, () => ({
    clear,
    draw(analyser, active) {
      const ctx = canvas.current?.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(ctx.canvas, -STEP, 0);
      ctx.fillStyle = '#f6f1e7';
      ctx.fillRect(WIDTH - STEP, 0, STEP, HEIGHT);
      if (!active) return;
      if (!bins.current || bins.current.length !== analyser.frequencyBinCount)
        bins.current = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins.current);
      const nyquist = analyser.context.sampleRate / 2;
      const top = Math.floor((TOP_HZ / nyquist) * bins.current.length);
      for (let y = 0; y < HEIGHT; y++) {
        const bin = Math.floor(((HEIGHT - 1 - y) / HEIGHT) * top);
        const v = bins.current[bin] / 255;
        if (v < 0.35) continue;
        const ink = Math.round(70 - (v - 0.35) * 100);
        ctx.fillStyle = `rgba(${ink}, ${ink - 8}, ${ink - 16}, ${Math.min(1, (v - 0.35) * 2.2)})`;
        ctx.fillRect(WIDTH - STEP, y, STEP, 1);
      }
    },
  }));

  return (
    <div className="sb-spectro">
      <div className="sb-spectro-axis">
        {[8, 6, 4, 2].map((k) => (
          <span key={k} style={{ top: `${(1 - k / 8) * 100}%` }}>
            {k} kHz
          </span>
        ))}
      </div>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-label="Spectrogram of the song" />
    </div>
  );
});
