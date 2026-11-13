/**
 * Records the microphone and returns WAV, the format Azure personal voice accepts: 24 kHz, 16-bit, mono. Browsers
 * record compressed audio (WebM or MP4), so the recording is decoded, mixed to mono, resampled and written as PCM.
 */

const RATE = 24000;

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  started = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();
    this.started = Date.now();
  }

  /** Stops and returns the recording as WAV, with its length in seconds. */
  async stop(): Promise<{ wav: Blob; seconds: number; url: string }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Not recording.');
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    const wav = await toWav(new Blob(this.chunks, { type: recorder.mimeType }));
    return { ...wav, url: URL.createObjectURL(wav.wav) };
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}

/** Any audio the browser can decode, as 24 kHz 16-bit mono WAV. */
export async function toWav(blob: Blob): Promise<{ wav: Blob; seconds: number }> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void context.close();
  }
  const frames = Math.ceil(decoded.duration * RATE);
  const offline = new OfflineAudioContext(1, frames, RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination); // more than one channel is mixed down to mono here
  source.start();
  const mono = (await offline.startRendering()).getChannelData(0);

  const data = new DataView(new ArrayBuffer(44 + mono.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  data.setUint32(4, 36 + mono.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 1, true); // mono
  data.setUint32(24, RATE, true);
  data.setUint32(28, RATE * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return { wav: new Blob([data], { type: 'audio/wav' }), seconds: mono.length / RATE };
}
