import type { ReactElement, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

interface Props {
    /** Texte du bouton ; avec `icon` seul, mettre `title` pour l'accessibilité. */
    label?: ReactNode;
    icon?: IconName;
    title?: string;
    children: ReactNode;
    /** Ouvre le menu vers la gauche (bouton en bord droit). */
    align?: 'left' | 'right';
    /** Ferme le menu au clic sur un bouton du menu (listes d'actions). Désactivé pour les panneaux avec formulaires. */
    closeOnClick?: boolean;
    /** Garde le contenu monté quand le menu est fermé (boutons qui suivent un job, saisies en cours). */
    keepMounted?: boolean;
    className?: string;
    small?: boolean;
    /** Pastille sur le bouton (commande en cours, échec). */
    badge?: ReactNode;
    disabled?: boolean;
}

/** Premier ancêtre qui rogne son contenu (volet, panneau qui défile), sinon la fenêtre. */
function clipBox(el: HTMLElement): { left: number; right: number } {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
            const box = node.getBoundingClientRect();
            return { left: Math.max(0, box.left), right: Math.min(window.innerWidth, box.right) };
        }
    }
    return { left: 0, right: window.innerWidth };
}

/**
 * Menu déroulant : ferme au clic extérieur et sur Échap, flèches haut/bas entre les éléments,
 * focus rendu au bouton à la fermeture.
 */
export function Menu({ label, icon, title, children, align = 'left', closeOnClick = true, keepMounted = false, className, small, badge, disabled }: Props): ReactElement {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const outside = (e: MouseEvent): void => {
            if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', outside);
        // Premier élément focalisé à l'ouverture, pour enchaîner au clavier.
        list.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], select, input')?.focus({ preventScroll: true });
        return () => document.removeEventListener('mousedown', outside);
    }, [open]);

    // Gardé dans la zone visible : un menu ouvert vers la gauche depuis un bouton en bord de volet
    // passerait sous le rail (ou serait rogné par le volet).
    useLayoutEffect(() => {
        const el = list.current;
        if (!open || !el) return;
        el.style.marginLeft = '';
        const box = el.getBoundingClientRect();
        const bounds = clipBox(el);
        const margin = 8;
        let shift = 0;
        if (box.left < bounds.left + margin) shift = bounds.left + margin - box.left;
        else if (box.right > bounds.right - margin) shift = Math.max(bounds.left + margin - box.left, bounds.right - margin - box.right);
        if (shift !== 0) el.style.marginLeft = `${Math.round(shift)}px`;
    }, [open]);

    const close = (): void => {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
    };

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const target = e.target as HTMLElement;
        if (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        const items = [...(list.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? [])];
        if (items.length === 0) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next]?.focus();
    };

    const onClick = (e: React.MouseEvent): void => {
        if (!closeOnClick) return;
        const button = (e.target as HTMLElement).closest<HTMLElement>('button, a[href]');
        if (button && !button.dataset['keepOpen']) setOpen(false);
    };

    return (
        <span className={`menu ${className ?? ''}`} ref={root} onKeyDown={onKeyDown}>
            <button ref={trigger} className={`menu-trigger ${small ? 'small' : ''} ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled}>
                {icon && <Icon name={icon} size={15} />}
                {label !== undefined && <span>{label}</span>}
                {badge}
                {label !== undefined && <Icon name="chevronDown" size={13} className="menu-chevron" />}
            </button>
            {(open || keepMounted) && (
                <div ref={list} role="menu" className={`menu-items ${align === 'right' ? 'align-right' : ''}`} hidden={!open} onClick={onClick}>
                    {children}
                </div>
            )}
        </span>
    );
}

/** Titre de section dans un menu. */
export function MenuLabel({ children }: { children: ReactNode }): ReactElement {
    return <div className="menu-label">{children}</div>;
}

export function MenuSeparator(): ReactElement {
    return <div className="menu-separator" role="separator" />;
}
