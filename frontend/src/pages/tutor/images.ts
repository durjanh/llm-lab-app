/**
 * Pictures the learner shares: pasted, uploaded, photographed or captured from the screen.
 * Each is scaled down so its longer side is at most 1568 pixels, the size Claude reads best,
 * which also keeps requests small.
 */
export interface SharedImage {
  media_type: 'image/png' | 'image/jpeg';
  data: string; // base64, without the data: prefix
  url: string; // an object URL for showing it on the page
}

const MAX_SIDE = 1568;

export async function prepareImage(blob: Blob): Promise<SharedImage> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Screenshots of text stay sharp as PNG; photos are much smaller as JPEG.
  const type = blob.type === 'image/png' && canvas.width * canvas.height < 1_200_000 ? 'image/png' : 'image/jpeg';
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be read.'))), type, 0.9),
  );
  const data = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(out);
  });
  return { media_type: type, data, url: URL.createObjectURL(out) };
}

/** Lets the learner pick a screen, window or tab, and takes one frame of it. */
export async function captureScreen(): Promise<SharedImage> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the first frame arrive
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The screen could not be captured.'))), 'image/png'),
    );
    return prepareImage(blob);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
