import { useEffect, useRef, type ReactNode } from 'react';

/* A small confirmation dialog in the page's modal style: what will happen, then Cancel or the action. Escape, a
   click outside and Cancel all close it without acting; the action button has focus, so Enter confirms. */

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const action = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    action.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="as-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="as-dialog as-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="as-confirm-title"
        aria-describedby="as-confirm-body"
      >
        <div className="as-dialog-head">
          <h2 id="as-confirm-title">{title}</h2>
        </div>
        <div id="as-confirm-body" className="as-dialog-intro">
          {children}
        </div>
        <div className="as-confirm-actions">
          <button type="button" className="as-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="as-btn primary" ref={action} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
