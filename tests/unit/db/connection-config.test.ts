import { describe, it, expect, vi, beforeEach } from 'vitest';

// buildSqlConfig() reads the global config: load it with controlled values.
async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import('../../../src/db/connection.js');
  } finally {
    process.env = saved;
  }
}

describe('buildSqlConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('connects directly to SQL_SERVER:SQL_PORT without serverName', async () => {
    const { buildSqlConfig } = await load({ SQL_SERVER: 'db.example.com', SQL_PORT: '1444', SQL_ENCRYPT: 'true', SQL_TRUST_CERT: 'false' });
    const cfg = buildSqlConfig();
    expect(cfg.server).toBe('db.example.com');
    expect(cfg.port).toBe(1444);
    expect(cfg.options?.serverName).toBeUndefined();
    expect(cfg.options?.encrypt).toBe(true);
    expect(cfg.options?.trustServerCertificate).toBe(false);
  });

  it('through the tunnel connects to the local end but validates the certificate against SQL_SERVER', async () => {
    const { buildSqlConfig } = await load({ SQL_SERVER: 'db.internal', SQL_PORT: '1433', SQL_ENCRYPT: 'true', SQL_TRUST_CERT: 'false' });
    const cfg = buildSqlConfig({ host: '127.0.0.1', port: 41234 });
    expect(cfg.server).toBe('127.0.0.1');
    expect(cfg.port).toBe(41234);
    expect(cfg.options?.serverName).toBe('db.internal');
    expect(cfg.options?.trustServerCertificate).toBe(false);
  });

  it('through the tunnel with an IP as SQL_SERVER keeps the IP as certificate identity', async () => {
    const { buildSqlConfig } = await load({ SQL_SERVER: '10.1.2.3', SQL_ENCRYPT: 'true', SQL_TRUST_CERT: 'false' });
    expect(buildSqlConfig({ host: '127.0.0.1', port: 5 }).options?.serverName).toBe('10.1.2.3');
  });

  it('does not set serverName when encryption is off', async () => {
    const { buildSqlConfig } = await load({ SQL_SERVER: 'db.internal', SQL_ENCRYPT: 'false' });
    expect(buildSqlConfig({ host: '127.0.0.1', port: 5 }).options?.serverName).toBeUndefined();
  });

  it('uses the instance name instead of the port', async () => {
    const { buildSqlConfig } = await load({ SQL_SERVER: 'db', SQL_INSTANCE: 'totvs' });
    const cfg = buildSqlConfig();
    expect(cfg.port).toBeUndefined();
    expect(cfg.options?.instanceName).toBe('totvs');
  });
});
