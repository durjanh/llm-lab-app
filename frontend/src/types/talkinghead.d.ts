/** The parts of TalkingHead (https://github.com/met4citizen/TalkingHead) the tutor uses. It ships no types. */
declare module '@met4citizen/talkinghead' {
  export interface SpeakAudio {
    audio: AudioBuffer;
    words?: string[];
    wtimes?: number[];
    wdurations?: number[];
    visemes?: string[];
    vtimes?: number[];
    vdurations?: number[];
  }

  export class TalkingHead {
    constructor(node: HTMLElement, options?: Record<string, unknown>);
    audioCtx: AudioContext;
    /** The loaded avatar: its meshes, for changing materials. */
    armature?: { traverse(fn: (object: { isMesh?: boolean; material?: unknown }) => void): void };
    isSpeaking: boolean;
    showAvatar(avatar: Record<string, unknown>, onprogress?: ((e: ProgressEvent) => void) | null): Promise<void>;
    speakAudio(r: SpeakAudio, opt?: Record<string, unknown> | null, onsubtitles?: ((node: unknown) => void) | null): void;
    speakMarker(onmarker: () => void): void;
    stopSpeaking(): void;
    setMood(mood: 'neutral' | 'happy' | 'angry' | 'sad' | 'fear' | 'disgust' | 'love' | 'sleep'): void;
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    lookAtCamera(t: number): void;
    makeEyeContact(t: number): void;
    setView(view: 'full' | 'mid' | 'upper' | 'head', opt?: Record<string, unknown>): void;
    start(): void;
    stop(): void;
    dispose(): void;
  }
}
