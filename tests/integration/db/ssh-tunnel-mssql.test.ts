/**
 * End-to-end test of the built-in SSH tunnel against a real sshd + SQL Server.
 *
 * Skipped unless these variables point to DISPOSABLE servers (never production):
 *   TEST_SSH_HOST, TEST_SSH_PORT (default 22), TEST_SSH_USER, TEST_SSH_KEY_PATH,
 *   TEST_SSH_KEY_PASSPHRASE (optional), TEST_SSH_HOST_FINGERPRINT,
 *   TEST_MSSQL_HOST      SQL Server host name AS SEEN FROM THE SSH HOST (must be in its certificate)
 *   TEST_MSSQL_PORT      (default 1433), TEST_MSSQL_USER, TEST_MSSQL_PASSWORD, TEST_MSSQL_DATABASE
 *   TEST_MSSQL_ALIAS     another name of the same server that is NOT in its certificate
 *   TEST_MSSQL_CA=true   the CA of the server certificate is trusted by this process
 *                        (NODE_EXTRA_CA_CERTS); otherwise the certificate is untrusted
 *
 * scripts/e2e-ssh-tunnel.sh brings up throwaway sshd + SQL Server containers on
 * internal docker networks and runs this file twice (without and with the CA).
 *
 * Covers: queries through the tunnel, TLS certificate validation against the
 * ORIGINAL server name (and refusal on an untrusted certificate / wrong name),
 * wrong SSH fingerprint is refused, and the real process (src/index.ts) with
 * ENV_FILE precedence, missing ENV_FILE => exit 1, clean shutdown on SIGTERM and
 * when stdin closes, and no secret in the logs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const E = process.env;
const enabled = Boolean(E.TEST_SSH_HOST && E.TEST_MSSQL_HOST && E.TEST_MSSQL_PASSWORD);
const caTrusted = E.TEST_MSSQL_CA === 'true';

type ConnectionModule = typeof import('../../../src/db/connection.js');

const ROOT = path.resolve(__dirname, '../../..');
const VITE_NODE = path.join(ROOT, 'node_modules', '.bin', 'vite-node');

function sshEnv(fingerprint = E.TEST_SSH_HOST_FINGERPRINT ?? ''): Record<string, string> {
  return {
    SSH_HOST: E.TEST_SSH_HOST ?? '',
    SSH_PORT: E.TEST_SSH_PORT ?? '22',
    SSH_USER: E.TEST_SSH_USER ?? '',
    SSH_KEY_PATH: E.TEST_SSH_KEY_PATH ?? '',
    ...(E.TEST_SSH_KEY_PASSPHRASE ? { SSH_KEY_PASSPHRASE: E.TEST_SSH_KEY_PASSPHRASE } : {}),
    SSH_HOST_FINGERPRINT: fingerprint,
  };
}

function sqlEnv(host = E.TEST_MSSQL_HOST ?? '', trustCert = true): Record<string, string> {
  return {
    SQL_SERVER: host,
    SQL_PORT: E.TEST_MSSQL_PORT ?? '1433',
    SQL_DATABASE: E.TEST_MSSQL_DATABASE ?? 'master',
    SQL_USER: E.TEST_MSSQL_USER ?? 'sa',
    SQL_PASSWORD: E.TEST_MSSQL_PASSWORD ?? '',
    SQL_ENCRYPT: 'true',
    SQL_TRUST_CERT: trustCert ? 'true' : 'false',
  };
}

/** Values that must never show up in logs or error messages */
function secrets(): string[] {
  const list = [E.TEST_MSSQL_PASSWORD ?? ''];
  if (E.TEST_SSH_KEY_PASSPHRASE) list.push(E.TEST_SSH_KEY_PASSPHRASE);
  // a line from the middle of the private key body
  const keyLines = readFileSync(E.TEST_SSH_KEY_PATH ?? '', 'utf8').split('\n').filter((l) => l.length > 40);
  if (keyLines.length > 1) list.push(keyLines[1]);
  return list.filter((s) => s.length >= 6);
}

function expectNoSecrets(text: string): void {
  for (const secret of secrets()) {
    expect(text.includes(secret), 'a secret leaked into the output').toBe(false);
  }
}

async function loadConnection(extra: Record<string, string>): Promise<ConnectionModule> {
  vi.resetModules();
  for (const [k, v] of Object.entries({
    READONLY: 'true',
    POOL_MIN: '0',
    POOL_MAX: '2',
    QUERY_TIMEOUT: '20000',
    ...extra,
  })) {
    process.env[k] = v;
  }
  return import('../../../src/db/connection.js');
}

/**
 * Run the real server entry point with a clean environment (nothing from the
 * test setup leaks in). Resolves when `until` shows up on stderr (then sends
 * SIGTERM, or closes stdin when `closeStdin`) or when the process exits on its own.
 */
function runServer(
  env: Record<string, string>,
  until?: RegExp,
  closeStdin = false
): Promise<{ code: number | null; stdout: string; stderr: string; reached: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_NODE, ['src/index.ts'], {
      cwd: ROOT,
      env: { PATH: E.PATH ?? '', HOME: E.HOME ?? '/tmp', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let reached = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 40000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (until && !reached && until.test(stderr)) {
        reached = true;
        if (closeStdin) child.stdin.end();
        else child.kill('SIGTERM');
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, reached });
    });
  });
}

async function queryEncrypted(connection: ConnectionModule): Promise<{ encrypted: string; auth: string }> {
  const pool = await connection.getPool();
  const res = await pool
    .request()
    .query(
      'SELECT encrypt_option AS encrypted, auth_scheme AS auth FROM sys.dm_exec_connections WHERE session_id = @@SPID'
    );
  return res.recordset[0] as { encrypted: string; auth: string };
}

describe.skipIf(!enabled)('SSH tunnel against real sshd + SQL Server', () => {
  let dir: string;
  let connection: ConnectionModule | null = null;
  const saved = { ...process.env };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-mssql-e2e-'));
  });

  afterAll(async () => {
    await connection?.closePool();
    rmSync(dir, { recursive: true, force: true });
    process.env = saved;
  });

  describe('tunnel', () => {
    it('runs queries through the tunnel (certificate trusted explicitly), several connections at once', async () => {
      connection = await loadConnection({ ...sshEnv(), ...sqlEnv() });
      const pool = await connection.getPool();
      const one = await pool.request().query('SELECT 1 AS n');
      expect(one.recordset[0].n).toBe(1);
      const many = await Promise.all(
        [1, 2, 3].map((i) => pool.request().input('n', i).query('SELECT @n AS n'))
      );
      expect(many.map((r) => r.recordset[0].n)).toEqual([1, 2, 3]);
      expect((await queryEncrypted(connection)).encrypted).toBe('TRUE');
      await connection.closePool();
      connection = null;
    });

    it('refuses a host key that does not match SSH_HOST_FINGERPRINT, without leaking secrets', async () => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        errors.push(args.join(' '));
      });
      try {
        connection = await loadConnection({
          ...sshEnv('SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
          ...sqlEnv(),
        });
        let message = '';
        await connection.getPool().catch((err: Error) => (message = err.message));
        expect(message).toMatch(/Failed to connect to SQL Server: .*verification failed/i);
        expectNoSecrets(message);
        expectNoSecrets(errors.join('\n'));
      } finally {
        spy.mockRestore();
        connection = null;
      }
    });
  });

  describe('TLS verification through the tunnel', () => {
    it.skipIf(caTrusted)('refuses an untrusted (self-signed) certificate when SQL_TRUST_CERT=false', async () => {
      connection = await loadConnection({ ...sshEnv(), ...sqlEnv(E.TEST_MSSQL_HOST, false) });
      let message = '';
      await connection.getPool().catch((err: Error) => (message = err.message));
      expect(message).toMatch(/Failed to connect to SQL Server/);
      expect(message).toMatch(/self[- ]signed|unable to verify|certificate/i);
      expectNoSecrets(message);
      await connection.closePool();
      connection = null;
    });

    it.skipIf(!caTrusted)(
      'accepts a trusted certificate whose name is the ORIGINAL SQL_SERVER, even though the driver dials 127.0.0.1',
      async () => {
        connection = await loadConnection({ ...sshEnv(), ...sqlEnv(E.TEST_MSSQL_HOST, false) });
        const status = await queryEncrypted(connection);
        expect(status.encrypted).toBe('TRUE');
        await connection.closePool();
        connection = null;
      }
    );

    it.skipIf(!caTrusted || !E.TEST_MSSQL_ALIAS)(
      'refuses a trusted certificate that does not cover the SQL_SERVER name (identity is checked)',
      async () => {
        connection = await loadConnection({ ...sshEnv(), ...sqlEnv(E.TEST_MSSQL_ALIAS, false) });
        let message = '';
        await connection.getPool().catch((err: Error) => (message = err.message));
        expect(message).toMatch(/Failed to connect to SQL Server/);
        expect(message).toMatch(/Hostname\/IP does not match|altnames|does not match certificate/i);
        await connection.closePool();
        connection = null;
      }
    );
  });

  describe('server process', () => {
    it('missing ENV_FILE exits with 1 and prints no values', async () => {
      const r = await runServer({ ENV_FILE: path.join(dir, 'does-not-exist.env'), READONLY: 'true' });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/ENV_FILE ".*does-not-exist\.env" could not be read \(file not found\)/);
      expect(r.stdout).toBe('');
    }, 60000);

    it('SSH_HOST without the fingerprint fails early with a clear message', async () => {
      const env = { ...sshEnv(), ...sqlEnv(), READONLY: 'true' };
      delete (env as Record<string, string>).SSH_HOST_FINGERPRINT;
      const r = await runServer(env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('SSH_HOST is set but these are missing:');
      expect(r.stderr).toContain('- SSH_HOST_FINGERPRINT');
      expectNoSecrets(r.stderr);
    }, 60000);

    it('ENV_FILE + env block precedence, tunnel up, clean SIGTERM, no secret in logs', async () => {
      const envFile = path.join(dir, 'project.env');
      const sql = sqlEnv();
      writeFileSync(
        envFile,
        [
          '# project .env',
          `SQL_SERVER=${sql.SQL_SERVER}`,
          `SQL_PORT=${sql.SQL_PORT}`,
          'SQL_DATABASE=wrong_database_from_file',
          `SQL_USER=${sql.SQL_USER}`,
          `SQL_PASSWORD="${sql.SQL_PASSWORD}"`,
          `SQL_TRUST_CERT=${sql.SQL_TRUST_CERT}`,
          'READONLY=false',
          'LOG_LEVEL=info',
          ...Object.entries(sshEnv()).map(([k, v]) => `${k}=${v}`),
        ].join('\n')
      );

      // the "env" block of .mcp.json wins: right database and READONLY=true
      const r = await runServer(
        { ENV_FILE: envFile, SQL_DATABASE: sql.SQL_DATABASE, READONLY: 'true' },
        /MCP server running/
      );

      expect(r.reached).toBe(true);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('SSH tunnel ready');
      expect(r.stderr).toContain('"readonly":true');
      expect(r.stderr).toContain('"viaSshTunnel":true');
      expect(r.stderr).not.toContain('wrong_database_from_file');
      expect(r.stderr).toContain('Connection pool closed');
      expectNoSecrets(r.stderr + r.stdout);
    }, 60000);

    it('exits 0 and drops pool and tunnel when the client closes stdin', async () => {
      const r = await runServer(
        { ...sshEnv(), ...sqlEnv(), READONLY: 'true', LOG_LEVEL: 'info' },
        /MCP server running/,
        true
      );
      expect(r.reached).toBe(true);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('stdin closed');
      expect(r.stderr).toContain('Connection pool closed');
      expectNoSecrets(r.stderr + r.stdout);
    }, 60000);
  });
});
