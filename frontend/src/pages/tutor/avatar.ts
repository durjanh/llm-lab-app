import type { TalkingHead } from '@met4citizen/talkinghead';
import type { Spoken } from './speech';

/**
 * The 3D tutor, drawn by TalkingHead with three.js. TalkingHead blinks, moves the eyes and head,
 * breathes and changes expression by itself; this wrapper hands it each sentence's audio with the
 * timing of every word and mouth shape, so the lips match the voice.
 *
 * Each voice has its own person. The model files come from TalkingHead's repository and are too
 * large for git: see README.md. Settings for each follow TalkingHead's own siteconfig.js.
 */
export const AVATARS = {
  // Made with Blender and MPFB. CC0: free for any use.
  sonia: { url: '/avatars/mpfb.glb', body: 'F', avatarMood: 'happy', baseline: { eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 } },
  // Made with Avaturn. Licensed for non-commercial use only.
  ava: {
    url: '/avatars/avaturn.glb',
    body: 'F',
    avatarMood: 'happy',
    retarget: {
      Hips: { y: 0.03 },
      Spine: { y: 0.02 },
      Spine1: { y: 0.02, z: 0.01 },
      Spine2: { y: 0.02, z: 0.01 },
      Neck: { z: 0.02, y: 0.01 },
      Head: { z: 0.02 },
      LeftShoulder: { rx: -0.5 },
      RightShoulder: { rx: -0.5 },
      scaleToHipsLevel: 1.0,
    },
    baseline: { headRotateX: -0.05, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
  },
  // Made with Avatar SDK. Licensed for non-commercial use only.
  ryan: {
    url: '/avatars/avatarsdk.glb',
    body: 'M',
    avatarMood: 'happy',
    retarget: {
      Neck: { z: -0.01, rx: -0.15 },
      Neck1: { z: -0.01, rx: -0.15 },
      Neck2: { z: -0.01, rx: -0.15 },
      LeftShoulder: { rz: -0.3 },
      RightShoulder: { rz: 0.3 },
      scaleToEyesLevel: 1.0,
      origin: { y: -0.1 },
    },
    baseline: { headRotateX: -0.04, eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
  },
} as const;
// Office clothes: each model's own clothing recoloured, without its printed pattern. Keys are material names.
const OUTFITS: Record<AvatarId, Record<string, string>> = {
  sonia: { 'Human.female_casualsuit01': '#1f2b45' }, // the logo T-shirt becomes a plain navy top
  ava: {}, // already in a blazer
  ryan: { outfit_top: '#2e323b', outfit_bottom: '#1c1f26' }, // a charcoal top and dark trousers
};

// Where the camera sits for each person, so all the faces are framed alike.
const VIEWS: Record<AvatarId, { cameraY: number; cameraDistance: number }> = {
  sonia: { cameraY: 0, cameraDistance: 0 },
  ava: { cameraY: -0.02, cameraDistance: 0.35 },
  ryan: { cameraY: -0.08, cameraDistance: 0.1 },
};
export type AvatarId = keyof typeof AVATARS;

export class Avatar {
  private current: AvatarId | null = null;

  private constructor(private readonly head: TalkingHead) {}

  /** Loads TalkingHead and the avatar into `node`. onProgress gets 0 to 1 while the model downloads. */
  static async create(node: HTMLElement, who: AvatarId, onProgress: (share: number) => void): Promise<Avatar> {
    const { TalkingHead } = await import('@met4citizen/talkinghead');
    const head = new TalkingHead(node, {
      lipsyncModules: [], // Azure sends the mouth shapes, so TalkingHead's own lip-sync rules are not needed
      lipsyncLang: 'en',
      cameraView: 'head', // close enough to see the lips, eyes, brows and cheeks move
      cameraRotateEnable: false,
      avatarMood: 'happy',
      avatarIdleEyeContact: 0.4,
      avatarSpeakingEyeContact: 0.7,
      avatarSpeakingHeadMove: 0.6,
      modelFPS: 30,
    });
    const avatar = new Avatar(head);
    await avatar.show(who, onProgress);
    return avatar;
  }

  /** Shows another person, for another voice. The scene stays; only the model is replaced. */
  async show(who: AvatarId, onProgress: (share: number) => void = () => undefined): Promise<void> {
    if (who === this.current) return;
    this.head.stopSpeaking();
    await this.head.showAvatar({ ...structuredClone(AVATARS[who]), lipsyncLang: 'en' }, (e) => e.lengthComputable && onProgress(e.loaded / e.total));
    this.head.setView('head', VIEWS[who]);
    this.dress(OUTFITS[who]);
    this.current = who;
  }

  /** Recolours clothing materials by name. The fabric's folds (its normal map) are kept. */
  private dress(outfit: Record<string, string>): void {
    this.head.armature?.traverse((object) => {
      const material = object.material as { name?: string; map?: unknown; color?: { set(c: string): void }; needsUpdate?: boolean } | undefined;
      const colour = object.isMesh && material?.name ? outfit[material.name] : undefined;
      if (!colour || !material?.color) return;
      material.map = null;
      material.color.set(colour);
      material.needsUpdate = true;
    });
  }

  get who(): AvatarId | null {
    return this.current;
  }

  /**
   * Browsers start audio only after a click; call this from one. It never waits more than a moment:
   * without a real click, resume() stays pending, and the lesson must not hang on it.
   */
  async unlockAudio(): Promise<void> {
    if (this.head.audioCtx.state === 'running') return;
    await Promise.race([this.head.audioCtx.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
  }

  get speaking(): boolean {
    return this.head.isSpeaking;
  }

  /** Queues one sentence; onStart runs as it begins, for the subtitle. Sentences play in the order queued. */
  async say(spoken: Spoken, onStart?: () => void): Promise<void> {
    const audio = await this.head.audioCtx.decodeAudioData(spoken.audio.slice(0));
    if (onStart) this.head.speakMarker(onStart);
    this.head.speakAudio({
      audio,
      words: spoken.words,
      wtimes: spoken.wtimes,
      wdurations: spoken.wdurations,
      visemes: spoken.visemes,
      vtimes: spoken.vtimes,
      vdurations: spoken.vdurations,
    });
  }

  /** Resolves when everything queued so far has been said. */
  finished(): Promise<void> {
    return new Promise((resolve) => this.head.speakMarker(resolve));
  }

  stop(): void {
    this.head.stopSpeaking();
  }

  mood(mood: 'neutral' | 'happy' | 'sad'): void {
    this.head.setMood(mood);
  }

  /** A short gesture: thumbup for praise, handup to say hello, index to point something out. */
  gesture(name: 'thumbup' | 'handup' | 'index' | 'ok' | 'shrug'): void {
    this.head.playGesture(name, 2.5);
  }

  /** Looks at the learner, as when listening. */
  attend(ms = 3000): void {
    this.head.makeEyeContact(ms);
  }

  dispose(): void {
    this.head.stop();
    this.head.dispose();
  }
}
