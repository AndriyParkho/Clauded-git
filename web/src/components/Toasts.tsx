import '../styles/notifications.css';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Notice, NoticeKind } from '../store';
import { Icon } from './Icon';

/** Durée d'affichage d'une réussite ou d'une info, hors survol et fenêtre en arrière-plan. */
const AUTO_DISMISS_MS = 4000;

const KIND_LABEL: Record<NoticeKind, string> = { error: 'Erreur', success: 'Réussi', info: 'Info' };

/** Pictogramme de la sorte de toast (✓, i, !), dessiné ici pour ne pas toucher au jeu d'icônes. */
function KindGlyph({ kind }: { kind: NoticeKind }): ReactElement {
    const path = kind === 'success' ? 'M5 12.5l4.5 4.5L19 7.5' : kind === 'info' ? 'M12 11v6M12 7.5v.01' : 'M12 7v6M12 16.5v.01';
    return (
        <svg className="toast-glyph" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            {kind !== 'success' && <circle cx="12" cy="12" r="9.25" strokeWidth={1.75} />}
            <path d={path} />
        </svg>
    );
}

/** Fenêtre au premier plan : sinon les toasts attendent qu'on revienne pour partir. */
function useWindowActive(): boolean {
    const [active, setActive] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
    useEffect(() => {
        const update = (): void => setActive(document.visibilityState === 'visible' && document.hasFocus());
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);
        document.addEventListener('visibilitychange', update);
        return () => {
            window.removeEventListener('focus', update);
            window.removeEventListener('blur', update);
            document.removeEventListener('visibilitychange', update);
        };
    }, []);
    return active;
}

function Toast({ notice, windowActive }: { notice: Notice; windowActive: boolean }): ReactElement {
    const dismiss = useStore((s) => s.dismissNotice);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const remaining = useRef(AUTO_DISMISS_MS);
    const auto = notice.kind !== 'error';
    const paused = hovered || focused || !windowActive;

    // Compte à rebours suspendu au survol, au focus clavier et quand la fenêtre est en arrière-plan.
    useEffect(() => {
        if (!auto || paused) return;
        const started = Date.now();
        const timer = setTimeout(() => dismiss(notice.id), Math.max(0, remaining.current));
        return () => {
            clearTimeout(timer);
            remaining.current -= Date.now() - started;
        };
    }, [auto, paused, dismiss, notice.id]);

    const close = (): void => dismiss(notice.id);
    const error = notice.kind === 'error';

    return (
        <div
            className={`toast toast-${notice.kind}`}
            role={error ? 'alert' : 'status'}
            aria-live={error ? 'assertive' : 'polite'}
            aria-atomic="true"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
            }}
            onClick={(e) => {
                // Un clic sur le texte ferme le toast, sauf pour en sélectionner une partie (message d'erreur à copier).
                if ((e.target as HTMLElement).closest('button')) return;
                if (window.getSelection()?.toString()) return;
                close();
            }}
        >
            <KindGlyph kind={notice.kind} />
            <span className="toast-sr">{KIND_LABEL[notice.kind]} : </span>
            <div className="toast-body">
                <div className="toast-message">
                    {notice.runId !== undefined ? `#${notice.runId} · ` : ''}
                    {notice.message}
                </div>
                {notice.action && (
                    <button
                        className="toast-action"
                        onClick={() => {
                            notice.action?.run();
                            close();
                        }}
                    >
                        {notice.action.label}
                    </button>
                )}
            </div>
            <button className="toast-close" onClick={close} aria-label="Fermer la notification" title="Fermer">
                <Icon name="x" size={14} />
            </button>
        </div>
    );
}

/** Pile des toasts en bas à droite : erreurs jusqu'au clic, réussites et infos ~4 s. */
export function Toasts(): ReactElement {
    const notices = useStore((s) => s.notices);
    const windowActive = useWindowActive();
    // Conteneur toujours présent : les lecteurs d'écran annoncent mieux ce qui apparaît dans une zone déjà là.
    return (
        <section className="toasts" aria-label="Notifications">
            {notices.map((n) => (
                <Toast key={n.id} notice={n} windowActive={windowActive} />
            ))}
        </section>
    );
}
