import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

/** Dossier de données de l'app (base SQLite, profils). */
export const DATA_DIR = process.env.CLAUDED_GIT_HOME ?? join(homedir(), '.clauded-git');
export const DB_PATH = join(DATA_DIR, 'clauded-git.db');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 4747);
/** Implémentations où Claude travaille en même temps, au plus (les lots attendent une place). */
export const MAX_PARALLEL = Math.max(1, Number(process.env.CLAUDED_GIT_MAX_PARALLEL ?? 3) || 3);

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Effort des sessions dont l'onglet n'en a pas choisi (`CLAUDED_GIT_EFFORT`, `medium` par défaut) :
 * il passe avant le `effortLevel` des réglages Claude Code, souvent `high`.
 */
export const DEFAULT_EFFORT: EffortLevel = EFFORTS.find((e) => e === process.env.CLAUDED_GIT_EFFORT) ?? 'medium';
export const isEffort = (value: unknown): value is EffortLevel => EFFORTS.includes(value as EffortLevel);

mkdirSync(DATA_DIR, { recursive: true });
