import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Fenêtre modale rendue à la racine du document : un parent `sticky` ou `overflow` (en-têtes de la
 * liste des issues…) ne peut ni la couper ni passer par-dessus.
 */
export function Modal({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }): ReactElement {
    return createPortal(
        <div className="modal-backdrop" onClick={onClose}>
            <div className={`modal ${className}`} onClick={(e) => e.stopPropagation()}>
                {children}
            </div>
        </div>,
        document.body,
    );
}
