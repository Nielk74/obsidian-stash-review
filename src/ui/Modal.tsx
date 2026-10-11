import React, {useEffect, useRef} from 'react';
import {X} from 'lucide-react';

export function Modal({title, children, onClose, busy = false, wide = false}: {
  title: string; children: React.ReactNode; onClose: () => void; busy?: boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = React.useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = ref.current;
    const first = modal?.querySelector<HTMLElement>('[autofocus]')
      ?? modal?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      ?? modal?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {event.preventDefault(); onClose();}
      if (event.key !== 'Tab') return;
      const elements = Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []);
      if (!elements.length) {event.preventDefault(); return;}
      const firstElement = elements[0]; const lastElement = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {event.preventDefault(); lastElement?.focus();}
      if (!event.shiftKey && document.activeElement === lastElement) {event.preventDefault(); firstElement?.focus();}
    };
    document.addEventListener('keydown', onKey);
    return () => {document.removeEventListener('keydown', onKey); previous?.focus();};
  }, [onClose]);
  return <div className="sr-modal-backdrop" onMouseDown={event => {if (event.target === event.currentTarget && !busy) onClose();}}>
    <div className={`sr-modal ${wide ? 'sr-modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={id}>
      <div className="sr-modal-heading"><h2 id={id}>{title}</h2><button type="button" className="sr-icon-button" aria-label={`Close ${title}`} onClick={onClose} disabled={busy}><X size={18}/></button></div>
      {children}
    </div>
  </div>;
}
