import { useEffect } from 'react';
import { Waveform } from './Waveform';
import { useDictation } from './useDictation';
import './voice.css';

const Icon = {
  mic: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" className="fill" />
    </svg>
  ),
};

/**
 * A chat page's message box, in the style of Claude's and ChatGPT's: one rounded bar with a microphone and a send
 * button. While listening it becomes a strip with a live waveform and what has been heard: ✕ throws it away, ✓ keeps
 * the words in the box to check, and the arrow sends them straight away. With onStop, a stop button replaces send
 * while the page is busy.
 */
export function VoiceComposer({
  value,
  onChange,
  onSend,
  onError,
  busy = false,
  disabled = false,
  onStop,
  placeholder = 'Type or speak your message',
  label = 'Your message',
  maxLength,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  onError: (message: string) => void;
  busy?: boolean;
  disabled?: boolean;
  onStop?: () => void;
  placeholder?: string;
  label?: string;
  maxLength?: number;
}) {
  const dictation = useDictation(onChange, onSend, onError);

  // Shortly after the page opens, load the speech SDK and a token, so the first press of the microphone is quick.
  useEffect(() => {
    const timer = window.setTimeout(dictation.prepare, 1200);
    return () => window.clearTimeout(timer);
  }, []);
  const blocked = busy || disabled;

  if (dictation.listening) {
    return (
      <div className="vc-bar listening" role="group" aria-label="Listening">
        <span className="vc-heard" aria-live="polite">
          {dictation.heard ? (
            dictation.heard.slice(-90)
          ) : (
            <i>{dictation.connecting ? 'Connecting the microphone…' : 'Listening: speak now'}</i>
          )}
        </span>
        <Waveform active />
        <button
          type="button"
          className="vc-round"
          onClick={() => dictation.finish('cancel')}
          title="Cancel"
          aria-label="Cancel"
        >
          {Icon.close}
        </button>
        <button
          type="button"
          className="vc-round"
          onClick={() => dictation.finish('keep')}
          title="Done: check the words, then send"
          aria-label="Done"
        >
          {Icon.check}
        </button>
        <button
          type="button"
          className="vc-round send"
          onClick={() => dictation.finish('send')}
          title="Send now"
          aria-label="Send now"
        >
          {Icon.send}
        </button>
      </div>
    );
  }

  return (
    <form
      className="vc-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && value.trim()) onSend(value);
      }}
    >
      <textarea
        value={value}
        rows={1}
        placeholder={placeholder}
        aria-label={label}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!blocked && value.trim()) onSend(value);
          }
        }}
      />
      <button
        type="button"
        className="vc-icon"
        disabled={blocked}
        onPointerEnter={dictation.prepare}
        onFocus={dictation.prepare}
        onClick={() => void dictation.start(value)}
        title="Speak"
        aria-label="Speak"
      >
        {Icon.mic}
      </button>
      {busy && onStop ? (
        <button type="button" className="vc-round" onClick={onStop} title="Stop" aria-label="Stop">
          {Icon.stop}
        </button>
      ) : (
        <button
          type="submit"
          className="vc-round send"
          disabled={blocked || !value.trim()}
          title="Send"
          aria-label="Send"
        >
          {Icon.send}
        </button>
      )}
    </form>
  );
}
