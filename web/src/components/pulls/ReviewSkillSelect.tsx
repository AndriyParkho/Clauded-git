import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api, type Profile } from '../../api';
import { useStore } from '../../store';
import type { SkillInfo } from '../../../../shared/protocol';

const SOURCES: Record<SkillInfo['source'], string> = { project: 'dépôt', user: 'perso', plugin: 'plugin' };

/**
 * Choix du skill de review du dépôt (enregistré dans son profil). Propose les skills dont le nom
 * parle de review, lus sur le disque (dépôt, `~/.claude`, plugins), plus `extra` (ceux qu'une
 * session ouverte a chargés).
 */
export function ReviewSkillSelect({ repoId, extra = [] }: { repoId: number; extra?: string[] }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [profile, setProfile] = useState<Profile | undefined>();
    const [skills, setSkills] = useState<SkillInfo[]>([]);

    useEffect(() => {
        let live = true;
        api.profile(repoId)
            .then((r) => live && setProfile(r.profile))
            .catch((e: unknown) => notify(String(e)));
        api.skills(repoId)
            .then((list) => live && setSkills(list.filter((s) => /review/i.test(s.name))))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [repoId, notify]);

    const current = profile?.reviewSkill ?? '';
    const known = new Set(skills.map((s) => s.name));
    const others = [...new Set([...extra, ...(current ? [current] : [])])].filter((name) => !known.has(name));

    const choose = async (name: string): Promise<void> => {
        if (!profile) return;
        try {
            const saved = await api.saveProfile(repoId, { ...profile, reviewSkill: name || null });
            setProfile(saved.profile);
        } catch (error) {
            notify(String(error));
        }
    };

    const chosen = skills.find((s) => s.name === current);
    return (
        <select
            className={`review-skill ${current ? '' : 'generic'}`}
            value={current}
            disabled={!profile}
            onChange={(e) => void choose(e.target.value)}
            title={chosen ? `/${chosen.name} — ${chosen.description}` : current ? `/${current}` : 'Aucun skill : consigne de review générique. Le choix est enregistré dans le profil du dépôt.'}
        >
            <option value="">review générique (sans skill)</option>
            {skills.map((s) => (
                <option key={s.name} value={s.name}>
                    /{s.name} · {SOURCES[s.source]}
                </option>
            ))}
            {others.map((name) => (
                <option key={name} value={name}>
                    /{name}
                </option>
            ))}
        </select>
    );
}
