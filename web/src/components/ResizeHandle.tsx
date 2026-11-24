import type { ReactElement } from 'react';
import { useRef } from 'react';
import { useUi } from '../ui';

const STEP = 16;

/** Largeur mémorisée d'une zone (`key`), bornée ; `undefined` tant qu'on ne l'a pas réglée. */
export function useSize(key: string): number | undefined {
    return useUi((s) => s.sizes[key]);
}

interface Props {
    /** Clé de la largeur mémorisée. */
    sizeKey: string;
    /** Largeur actuelle en px (celle affichée, pour partir de la bonne valeur). */
    current: () => number;
    min: number;
    max: number | (() => number);
    /** 1 : glisser vers la droite agrandit (zone à gauche de la poignée) ; -1 : l'inverse. */
    direction: 1 | -1;
    label: string;
    className?: string;
}

/**
 * Poignée verticale pour régler la largeur d'une zone à la souris ou au clavier (flèches, pas de
 * 16 px ; Maj pour 64 px). Double-clic : largeur par défaut.
 */
export function ResizeHandle({ sizeKey, current, min, max, direction, label, className }: Props): ReactElement {
    const setSize = useUi((s) => s.setSize);
    const resetSize = useUi((s) => s.resetSize);
    const drag = useRef<{ x: number; start: number } | null>(null);
    const limit = (px: number): number => Math.max(min, Math.min(typeof max === 'function' ? max() : max, px));

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: current() };
        document.body.classList.add('resizing');
    };
    const onPointerMove = (e: React.PointerEvent): void => {
        if (!drag.current) return;
        setSize(sizeKey, limit(drag.current.start + direction * (e.clientX - drag.current.x)));
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing');
    };
    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = (e.shiftKey ? 4 : 1) * STEP * (e.key === 'ArrowRight' ? 1 : -1) * direction;
        setSize(sizeKey, limit(current() + step));
    };

    return (
        <div
            className={`resize-handle ${className ?? ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            tabIndex={0}
            title={`${label} : glisser pour redimensionner, double-clic pour la largeur par défaut`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => resetSize(sizeKey)}
            onKeyDown={onKeyDown}
        />
    );
}

/**
 * Zone latérale droite redimensionnable (détail d'une issue, d'une PR) : poignée sur son bord gauche,
 * la liste à sa gauche garde au moins 320 px.
 */
export function ResizablePane({ sizeKey, className, children }: { sizeKey: string; className: string; children: React.ReactNode }): ReactElement {
    const width = useSize(sizeKey);
    const box = useRef<HTMLDivElement>(null);
    return (
        <div ref={box} className={`${className} resizable`} style={width === undefined ? undefined : { width }}>
            <ResizeHandle
                sizeKey={sizeKey}
                current={() => box.current?.offsetWidth ?? 480}
                min={300}
                max={() => (box.current?.parentElement?.offsetWidth ?? 1200) - 320}
                direction={-1}
                label="Largeur du détail"
                className="edge-left"
            />
            {/* La poignée reste hors de la zone qui défile. */}
            <div className="resizable-body">{children}</div>
        </div>
    );
}
