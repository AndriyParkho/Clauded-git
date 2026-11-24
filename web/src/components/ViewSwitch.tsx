import type { ReactElement, ReactNode } from 'react';

export interface ViewOption<T extends string> {
    value: T;
    label: ReactNode;
    title?: string;
    /** Clé unique quand plusieurs options partagent la même valeur (issues liées d'une PR). */
    key?: string;
    active?: boolean;
    /** Remplace `onChange` pour cette option. */
    onSelect?: () => void;
}

/**
 * Sélecteur des panneaux latéraux d'un onglet (Issue, Diff, Logs, PR…) : un seul ouvert à la fois,
 * recliquer sur l'actif le ferme.
 */
export function ViewSwitch<T extends string>({ options, value, onChange, label = 'Panneau' }: { options: Array<ViewOption<T>>; value: T | null; onChange: (value: T) => void; label?: string }): ReactElement {
    return (
        <div className="view-switch" role="group" aria-label={label}>
            {options.map((option) => {
                const active = option.active ?? option.value === value;
                return (
                    <button key={option.key ?? option.value} className={active ? 'active' : ''} aria-pressed={active} onClick={() => (option.onSelect ? option.onSelect() : onChange(option.value))} title={option.title}>
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
