import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Error raised while loading the file pointed to by ENV_FILE.
 * The message never contains values read from the file.
 */
export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

/**
 * Expand a leading `~` (or `~/...`) to the user's home directory.
 * `~user/...` is not supported and is returned unchanged.
 */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Resolve a user supplied path: expands `~` and makes relative paths absolute
 * against `cwd` (the working directory of the process, i.e. where the MCP
 * client launched the server).
 */
export function resolveUserPath(p: string, cwd: string = process.cwd(), home: string = homedir()): string {
  return path.resolve(cwd, expandHome(p.trim(), home));
}

export interface LoadEnvFileOptions {
  cwd?: string;
  home?: string;
}

/**
 * When `env.ENV_FILE` is set, read that dotenv file and copy its variables into
 * `env`. Variables already present in `env` (e.g. set in the `env` block of the
 * MCP client configuration) WIN over the ones in the file, the same precedence
 * as `node --env-file` / `process.loadEnvFile`.
 *
 * Must run before the configuration is validated.
 *
 * @returns the absolute path that was loaded, or null when ENV_FILE is not set
 * @throws EnvFileError when the file cannot be read
 */
export function loadEnvFileFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadEnvFileOptions = {}
): string | null {
  const raw = env.ENV_FILE;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const file = resolveUserPath(raw, options.cwd, options.home);

  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    const reason =
      code === 'ENOENT' ? 'file not found'
        : code === 'EACCES' ? 'permission denied'
          : code === 'EISDIR' ? 'is a directory'
            : code;
    throw new EnvFileError(`ENV_FILE "${file}" could not be read (${reason})`);
  }

  const parsed = parseEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'ENV_FILE') continue; // no chaining
    if (env[key] === undefined) {
      env[key] = value;
    }
  }

  return file;
}
