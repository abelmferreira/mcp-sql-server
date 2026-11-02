import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvFileError, expandHome, loadEnvFileFromEnv, resolveUserPath } from '../../src/env-file.js';
import { ConfigError, parseConfig } from '../../src/config.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mcp-sql-server-envfile-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(name: string, content: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe('expandHome / resolveUserPath', () => {
  it('expands a leading ~ only', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/a/.env', '/home/u')).toBe(path.join('/home/u', 'a/.env'));
    expect(expandHome('/abs/~/x', '/home/u')).toBe('/abs/~/x');
    expect(expandHome('~other/x', '/home/u')).toBe('~other/x');
  });

  it('resolves relative paths against the given cwd', () => {
    expect(resolveUserPath('proj/.env', '/work')).toBe(path.resolve('/work', 'proj/.env'));
    expect(resolveUserPath('/abs/.env', '/work')).toBe('/abs/.env');
    expect(resolveUserPath(' ~/k ', '/work', '/home/u')).toBe(path.join('/home/u', 'k'));
  });
});

describe('loadEnvFileFromEnv', () => {
  it('does nothing when ENV_FILE is not set or empty', () => {
    expect(loadEnvFileFromEnv({})).toBeNull();
    expect(loadEnvFileFromEnv({ ENV_FILE: '  ' })).toBeNull();
  });

  it('loads variables from the file', () => {
    const file = writeEnv('basic.env', '# comment\nSQL_SERVER=db.example.com\nSQL_PORT=3307\nQUOTED="a b"\n');
    const env: NodeJS.ProcessEnv = { ENV_FILE: file };
    expect(loadEnvFileFromEnv(env)).toBe(file);
    expect(env.SQL_SERVER).toBe('db.example.com');
    expect(env.SQL_PORT).toBe('3307');
    expect(env.QUOTED).toBe('a b');
  });

  it('variables already in the environment win over the file', () => {
    const file = writeEnv('prec.env', 'READONLY=false\nSQL_USER=from_file\nLOG_LEVEL=debug\n');
    const env: NodeJS.ProcessEnv = { ENV_FILE: file, READONLY: 'true', SQL_USER: 'from_mcp_json' };
    loadEnvFileFromEnv(env);
    expect(env.READONLY).toBe('true');
    expect(env.SQL_USER).toBe('from_mcp_json');
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('an empty string set in the environment still wins (it is defined)', () => {
    const file = writeEnv('empty.env', 'SSH_KEY_PASSPHRASE=from_file\n');
    const env: NodeJS.ProcessEnv = { ENV_FILE: file, SSH_KEY_PASSPHRASE: '' };
    loadEnvFileFromEnv(env);
    expect(env.SSH_KEY_PASSPHRASE).toBe('');
  });

  it('has the same precedence as process.loadEnvFile', () => {
    const file = writeEnv('parity.env', 'MCP_MSSQL_T_A=file\nMCP_MSSQL_T_B=file\n');
    process.env.MCP_MSSQL_T_A = 'process';
    try {
      process.loadEnvFile(file);
      const node = { a: process.env.MCP_MSSQL_T_A, b: process.env.MCP_MSSQL_T_B };

      const env: NodeJS.ProcessEnv = { ENV_FILE: file, MCP_MSSQL_T_A: 'process' };
      loadEnvFileFromEnv(env);
      expect({ a: env.MCP_MSSQL_T_A, b: env.MCP_MSSQL_T_B }).toEqual(node);
      expect(node).toEqual({ a: 'process', b: 'file' });
    } finally {
      delete process.env.MCP_MSSQL_T_A;
      delete process.env.MCP_MSSQL_T_B;
    }
  });

  it('ignores ENV_FILE declared inside the file (no chaining)', () => {
    const file = writeEnv('chain.env', 'ENV_FILE=/elsewhere/.env\nX=1\n');
    const env: NodeJS.ProcessEnv = { ENV_FILE: file };
    loadEnvFileFromEnv(env);
    expect(env.ENV_FILE).toBe(file);
    expect(env.X).toBe('1');
  });

  it('expands ~ and resolves relative paths against cwd', () => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, 'proj'), { recursive: true });
    writeFileSync(path.join(home, 'proj', '.env'), 'FROM_TILDE=yes\n');

    const env1: NodeJS.ProcessEnv = { ENV_FILE: '~/proj/.env' };
    expect(loadEnvFileFromEnv(env1, { home })).toBe(path.join(home, 'proj', '.env'));
    expect(env1.FROM_TILDE).toBe('yes');

    const env2: NodeJS.ProcessEnv = { ENV_FILE: 'proj/.env' };
    expect(loadEnvFileFromEnv(env2, { cwd: home })).toBe(path.join(home, 'proj', '.env'));
    expect(env2.FROM_TILDE).toBe('yes');
  });

  it('throws a clear error, without values, when the file is missing', () => {
    const missing = path.join(dir, 'nope.env');
    expect(() => loadEnvFileFromEnv({ ENV_FILE: missing })).toThrow(EnvFileError);
    expect(() => loadEnvFileFromEnv({ ENV_FILE: missing })).toThrow(/could not be read \(file not found\)/);
  });

  it('throws when ENV_FILE points to a directory', () => {
    expect(() => loadEnvFileFromEnv({ ENV_FILE: dir })).toThrow(/is a directory/);
  });
});

describe('ENV_FILE combined with SSH_* and parseConfig', () => {
  it('builds an SSH config from the file, with env overrides and ~ in SSH_KEY_PATH', () => {
    const home = path.join(dir, 'sshhome');
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh', 'tunnel_key'), 'dummy');

    const file = writeEnv(
      'ssh.env',
      [
        'READONLY=true',
        'SQL_SERVER=192.0.2.10',
        'SQL_DATABASE=app',
        'SQL_USER=reader',
        'SQL_PASSWORD=s3cr3t',
        'SSH_HOST=bastion.example.com',
        'SSH_USER=tunnel',
        `SSH_KEY_PATH=${path.join(home, '.ssh', 'tunnel_key')}`,
        'SSH_HOST_FINGERPRINT=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'SSH_PORT=2222',
      ].join('\n')
    );

    // SSH_PORT from the MCP client env wins over the file
    const env: NodeJS.ProcessEnv = { ENV_FILE: file, SSH_PORT: '22' };
    loadEnvFileFromEnv(env);
    const cfg = parseConfig(env);
    expect(cfg.SQL_SERVER).toBe('192.0.2.10');
    expect(cfg.SSH).toEqual({
      host: 'bastion.example.com',
      port: 22,
      user: 'tunnel',
      keyPath: path.join(home, '.ssh', 'tunnel_key'),
      keyPassphrase: undefined,
      hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });

    // `~` in SSH_KEY_PATH is expanded against the real home directory
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const cfg2 = parseConfig({ ...env, SSH_KEY_PATH: '~/.ssh/tunnel_key' });
      expect(cfg2.SSH?.keyPath).toBe(path.join(home, '.ssh', 'tunnel_key'));
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('reports missing SSH settings and unreadable keys as ConfigError', () => {
    const base = { READONLY: 'true', SQL_CONNECTION_URL: 'sqlserver://u:p@db:1433/app' };
    expect(() => parseConfig({ ...base, SSH_HOST: 'bastion.example.com' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, SSH_HOST: 'bastion.example.com' })).toThrow(/SSH_USER/);
    expect(() =>
      parseConfig({
        ...base,
        SSH_HOST: 'bastion.example.com',
        SSH_USER: 'tunnel',
        SSH_KEY_PATH: path.join(dir, 'no-such-key'),
        SSH_HOST_FINGERPRINT: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      })
    ).toThrow(/SSH_KEY_PATH: private key .* is not readable \(ENOENT\)/);
  });
});

describe('parseConfig', () => {
  it('requires READONLY', () => {
    expect(() => parseConfig({ SQL_CONNECTION_URL: 'sqlserver://u:p@db:1433/app' })).toThrow(ConfigError);
  });

  it('does not echo the connection URL (password) on a malformed URL', () => {
    try {
      parseConfig({ READONLY: 'true', SQL_CONNECTION_URL: 'sqlserver://u:s3cr3t@[bad/app' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('s3cr3t');
    }
  });

  it('parses the connection URL', () => {
    const cfg = parseConfig({ READONLY: 'true', SQL_CONNECTION_URL: 'mssql://u:p%40ss@db.example.com:1434/app?encrypt=true&TrustServerCertificate=true' });
    expect(cfg).toMatchObject({ SQL_SERVER: 'db.example.com', SQL_PORT: 1434, SQL_PASSWORD: 'p@ss', SQL_ENCRYPT: true, SQL_TRUST_CERT: true, SSH: null });
  });
});
