import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Dossier de données de l'app (base SQLite, profils). */
export const DATA_DIR = process.env.CLAUDED_GIT_HOME ?? join(homedir(), '.clauded-git');
export const DB_PATH = join(DATA_DIR, 'clauded-git.db');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT ?? 4747);

mkdirSync(DATA_DIR, { recursive: true });
