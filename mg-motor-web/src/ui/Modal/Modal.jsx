import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import CloseButton from "../CloseButton/CloseButton";
import "./Modal.css";

// Matches the exit animation in Modal.css (modal-fade-out / modal-pop-out).
const EXIT_MS = 180;

// Lets content inside a Modal close it with the same exit animation as the X.
const ModalCloseContext = createContext(null);

/** A button inside a Modal that closes it with the exit animation. */
export function ModalCloseButton({ children, onClick, ...props }) {
  const requestClose = useContext(ModalCloseContext);
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        requestClose?.();
      }}
    >
      {children}
    </button>
  );
}

/**
 * Modal.jsx
 * -----------------------------------------------------------------------
 * Generic dialog shell. Business content (a form, a detail view) is
 * passed as children; this component only owns backdrop/escape/close
 * behavior, same pattern as Table and Badge.
 *
 * Opens with a short fade + rise and closes the same way: Escape, a backdrop
 * click or the close button play the exit animation first, then call onClose.
 * A parent that ignores the close (e.g. while busy) leaves the dialog open, so
 * it returns to its open state. Closing it from the parent (unmounting) is
 * immediate. Motion is skipped when the user prefers reduced motion.
 */
export default function Modal({ title, onClose, children, width = 480 }) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    window.clearTimeout(timerRef.current);
  }, []);

  const requestClose = useCallback(() => {
    if (timerRef.current) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      onClose();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onClose();
      if (mountedRef.current) setClosing(false);
    }, EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  return (
    <div className={`modal-backdrop${closing ? " modal-backdrop--closing" : ""}`} onClick={requestClose}>
      <div
        className={`modal${closing ? " modal--closing" : ""}`}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <CloseButton onClick={requestClose} />
        </div>
        <ModalCloseContext.Provider value={requestClose}>
          <div className="modal__body">{children}</div>
        </ModalCloseContext.Provider>
      </div>
    </div>
  );
}
