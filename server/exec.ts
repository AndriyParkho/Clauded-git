import { execFile } from 'node:child_process';

export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/** Exécute un programme sans shell et renvoie toujours un résultat (jamais de rejet). */
export function exec(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
        const child = execFile(
            file,
            args,
            {
                ...(options.cwd ? { cwd: options.cwd } : {}),
                env: { ...process.env, ...options.env },
                maxBuffer: 64 * 1024 * 1024,
                timeout: options.timeoutMs ?? 0,
            },
            (error, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
                resolve({ stdout: String(stdout), stderr: String(stderr), code });
            },
        );
        child.on('error', () => undefined);
    });
}

/** Comme `exec`, mais lève une erreur lisible si la commande échoue. */
export async function execOrThrow(file: string, args: string[], options: Parameters<typeof exec>[2] = {}): Promise<string> {
    const result = await exec(file, args, options);
    if (result.code !== 0) {
        throw new Error(`${file} ${args.join(' ')} a échoué (code ${result.code}) : ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
}
