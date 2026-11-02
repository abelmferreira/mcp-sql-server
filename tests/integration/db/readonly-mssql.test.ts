/**
 * READONLY mode against a real SQL Server, with the real validator and a
 * login that only has db_datareader (see scripts/test-mssql.sh).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mssqlEnabled, createFixture, useLogin, SEED_ROWS, type Fixture } from './mssql-fixture.js';

type ExecuteModule = typeof import('../../../src/db/execute.js');
type ConnectionModule = typeof import('../../../src/db/connection.js');

describe.skipIf(!mssqlEnabled)('READONLY mode against real SQL Server', () => {
  let fixture: Fixture;
  let execute: ExecuteModule;
  let connection: ConnectionModule;

  beforeAll(async () => {
    fixture = await createFixture();
    useLogin(fixture, 'reader', { QUERY_TIMEOUT: '5000', MAX_RESULT_BYTES: '20000' });
    vi.resetModules();
    connection = await import('../../../src/db/connection.js');
    execute = await import('../../../src/db/execute.js');
  }, 120000);

  afterAll(async () => {
    await connection?.closePool();
    await fixture?.teardown();
  }, 60000);

  it('runs a SELECT with bound parameters', async () => {
    const result = await execute.executeQuery('SELECT id, name FROM dbo.items WHERE id = @id', { id: 7 }, 10);
    expect(result.rows).toEqual([{ id: 7, name: 'row 7' }]);
    expect(result.truncated).toBe(false);
    expect(result.fields.map((f) => f.name)).toEqual(['id', 'name']);
  });

  it('keeps a quote in a parameter value as data', async () => {
    const result = await execute.executeQuery('SELECT @v AS v', { v: "x'; DELETE FROM dbo.items; --" }, 10);
    expect(result.rows[0].v).toBe("x'; DELETE FROM dbo.items; --");
    expect(await fixture.count()).toBe(SEED_ROWS);
  });

  it('applies maxRows on the server side and reports truncation', async () => {
    const result = await execute.executeQuery('SELECT id FROM dbo.items ORDER BY id', {}, 10);
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('maxRows');
  });

  it('does not read an unbounded result set (cancels after maxRows+1)', async () => {
    const started = Date.now();
    const result = await execute.executeQuery(
      'WITH n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 2000000000) SELECT i FROM n OPTION (MAXRECURSION 0)',
      {},
      5
    );
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    // the single pooled connection is usable again afterwards
    const next = await execute.executeQuery('SELECT 1 AS ok', {}, 1);
    expect(next.rows[0].ok).toBe(1);
  });

  it('cuts the response at MAX_RESULT_BYTES', async () => {
    const result = await execute.executeQuery('SELECT id, note FROM dbo.items ORDER BY id', {}, 1000);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('maxBytes');
    expect(result.rows.length).toBeLessThan(SEED_ROWS);
  });

  it('returns only the first result set', async () => {
    const result = await execute.executeQuery('SELECT 1 AS a SELECT 2 AS b', {}, 10);
    expect(result.rows).toEqual([{ a: 1 }]);
  });

  describe('the validator refuses before anything reaches the server', () => {
    const attacks: Array<[string, string]> = [
      ['stacked with ;', 'SELECT 1; DELETE FROM dbo.items'],
      ['stacked without ;', 'SELECT 1 DELETE FROM dbo.items'],
      ['string that looks like a comment', "SELECT '--'; DELETE FROM dbo.items"],
      ['comment inside a comment', 'SELECT 1 /* a /* b */ DELETE FROM dbo.items */ ; DELETE FROM dbo.items'],
      ['SELECT INTO', 'SELECT * INTO dbo.leak FROM dbo.items'],
      ['EXEC', "EXEC xp_cmdshell 'whoami'"],
      ['sp_executesql', "SELECT 1 EXEC sp_executesql N'DELETE FROM dbo.items'"],
      ['OPENROWSET', "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')"],
      ['WAITFOR', "SELECT 1 WAITFOR DELAY '00:00:05'"],
      ['USE', 'SELECT 1 USE master'],
      ['sequence', 'SELECT NEXT VALUE FOR dbo.seq'],
    ];
    for (const [label, query] of attacks) {
      it(label, async () => {
        await expect(execute.executeQuery(query, {}, 10)).rejects.toThrow();
        expect(await fixture.count()).toBe(SEED_ROWS);
      });
    }
  });

  it('a failed estimated plan (no SHOWPLAN permission) does not leave SHOWPLAN on for later queries', async () => {
    await expect(execute.getEstimatedPlan('SELECT * FROM dbo.items WHERE id = @id', { id: 1 })).rejects.toThrow(/SHOWPLAN/);
    const after = await execute.executeQuery('SELECT id FROM dbo.items WHERE id = @id', { id: 3 }, 10);
    expect(after.rows).toEqual([{ id: 3 }]);
  });

  it('keeps a clean session between queries (no state carried over)', async () => {
    const a = await execute.executeQuery('SELECT @@TRANCOUNT AS t, @@DATEFIRST AS d', {}, 1);
    expect(a.rows[0].t).toBe(1); // exactly the READONLY transaction
    const b = await execute.executeQuery('SELECT @@TRANCOUNT AS t', {}, 1);
    expect(b.rows[0].t).toBe(1);
  });
});
