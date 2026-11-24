import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Fenêtre modale rendue à la racine du document : un parent `sticky` ou `overflow` (en-têtes de la
 * liste des issues…) ne peut ni la couper ni passer par-dessus. Échap la ferme, et le focus revient
 * là où il était à l'ouverture.
 */
export function Modal({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }): ReactElement {
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close.current();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            previous?.focus?.({ preventScroll: true });
        };
    }, []);
    return createPortal(
        <div className="modal-backdrop" onClick={onClose}>
            <div className={`modal ${className}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                {children}
            </div>
        </div>,
        document.body,
    );
}
