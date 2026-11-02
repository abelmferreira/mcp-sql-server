/**
 * The DATABASE is the barrier, not the validator: here the validator is mocked
 * to accept everything and the statements must still not change anything.
 *  - reader login (db_datareader): the server refuses the writes;
 *  - writer login (db_owner): the writes run but the READONLY transaction is
 *    always rolled back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mssqlEnabled, createFixture, useLogin, SEED_ROWS, type Fixture } from './mssql-fixture.js';

type ExecuteModule = typeof import('../../../src/db/execute.js');
type ConnectionModule = typeof import('../../../src/db/connection.js');

async function load(): Promise<{ execute: ExecuteModule; connection: ConnectionModule }> {
  vi.resetModules();
  vi.doMock('../../../src/validators/query-validator.js', () => ({
    validateQuery: () => ({ valid: true, queryType: 'SELECT' }),
  }));
  const connection = await import('../../../src/db/connection.js');
  const execute = await import('../../../src/db/execute.js');
  return { execute, connection };
}

const WRITES = [
  "INSERT INTO dbo.items (id, name) VALUES (1000, 'x')",
  "UPDATE dbo.items SET name = 'changed'",
  'DELETE FROM dbo.items',
  'TRUNCATE TABLE dbo.items',
  'SELECT * INTO dbo.leak FROM dbo.items',
  'CREATE TABLE dbo.created (id int)',
  'DROP TABLE dbo.items',
];

describe.skipIf(!mssqlEnabled)('the database refuses writes even with the validator off', () => {
  let fixture: Fixture;
  let execute: ExecuteModule;
  let connection: ConnectionModule;

  beforeAll(async () => {
    fixture = await createFixture();
    useLogin(fixture, 'reader', { QUERY_TIMEOUT: '3000' });
    ({ execute, connection } = await load());
  }, 120000);

  afterAll(async () => {
    await connection?.closePool();
    await fixture?.teardown();
  }, 60000);

  for (const statement of WRITES) {
    it(`db_datareader: ${statement}`, async () => {
      await expect(execute.executeQuery(statement, {}, 10)).rejects.toThrow(/denied|permission/i);
      expect(await fixture.count()).toBe(SEED_ROWS);
    });
  }

  it('db_datareader: xp_cmdshell is refused', async () => {
    await expect(execute.executeQuery("EXEC xp_cmdshell 'whoami'", {}, 10)).rejects.toThrow();
  });
});

describe.skipIf(!mssqlEnabled)('READONLY transaction is always rolled back (login WITH write permission)', () => {
  let fixture: Fixture;
  let execute: ExecuteModule;
  let connection: ConnectionModule;

  beforeAll(async () => {
    fixture = await createFixture();
    useLogin(fixture, 'writer', { QUERY_TIMEOUT: '3000' });
    ({ execute, connection } = await load());
  }, 120000);

  afterAll(async () => {
    await connection?.closePool();
    await fixture?.teardown();
  }, 60000);

  async function tableExists(name: string): Promise<boolean> {
    const result = await fixture.admin.request().query(`SELECT OBJECT_ID('dbo.${name}') AS id`);
    return result.recordset[0].id !== null;
  }

  it('INSERT / UPDATE / DELETE are undone', async () => {
    await execute.executeQuery("INSERT INTO dbo.items (id, name) VALUES (1000, 'x')", {}, 10);
    await execute.executeQuery("UPDATE dbo.items SET name = 'changed'", {}, 10);
    await execute.executeQuery('DELETE FROM dbo.items WHERE id < 10', {}, 10);
    expect(await fixture.count()).toBe(SEED_ROWS);
    const names = await fixture.admin.request().query("SELECT COUNT(*) AS n FROM dbo.items WHERE name = 'changed'");
    expect(names.recordset[0].n).toBe(0);
  });

  it('SELECT INTO and DDL are undone', async () => {
    await execute.executeQuery('SELECT * INTO dbo.leak FROM dbo.items', {}, 10);
    await execute.executeQuery('CREATE TABLE dbo.created (id int)', {}, 10);
    expect(await tableExists('leak')).toBe(false);
    expect(await tableExists('created')).toBe(false);
  });

  it('a statement that fails halfway leaves nothing behind', async () => {
    await expect(
      execute.executeQuery("INSERT INTO dbo.items (id, name) VALUES (2000, 'x'); SELECT 1/0", {}, 10)
    ).rejects.toThrow();
    expect(await fixture.count()).toBe(SEED_ROWS);
  });

  it('a timed out statement is cancelled, rolled back, and the connection works again', async () => {
    const started = Date.now();
    await expect(
      execute.executeQuery("INSERT INTO dbo.items (id, name) VALUES (3000, 'x'); WAITFOR DELAY '00:00:20'", {}, 10)
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await fixture.count()).toBe(SEED_ROWS);
    const next = await execute.executeQuery('SELECT 1 AS ok', {}, 1);
    expect(next.rows[0].ok).toBe(1);
  });

  it('LIMIT: with the validator off, a COMMIT in the statement ends the READONLY transaction', async () => {
    // This is why the validator refuses COMMIT/ROLLBACK/BEGIN and why the
    // login must not be able to write: the transaction is a second line of
    // defence, not the first.
    await execute.executeQuery("COMMIT; INSERT INTO dbo.items (id, name) VALUES (4000, 'x')", {}, 10).catch(() => undefined);
    expect(await fixture.count()).toBe(SEED_ROWS + 1);
  });
});
