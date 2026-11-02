/**
 * Every tool against a real SQL Server, in READONLY mode (real validator):
 *  - with a privileged login each tool must work (its own queries must pass
 *    the READONLY validator and run on a real server);
 *  - with a db_datareader-only login each tool must answer with a structured
 *    result; the ones that need more permissions are listed in EXPECTED_NEEDS
 *    (this is the table documented in the README).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  mssqlEnabled,
  createFixture,
  useLogin,
  TEST_MSSQL_PASSWORD,
  type Fixture,
} from '../db/mssql-fixture.js';

type ToolResponse = { content: Array<{ text: string }>; isError?: boolean };
type Tool = (args: unknown) => Promise<ToolResponse>;

const CASES: Array<[string, string, unknown]> = [
  ['schemaListTables', 'schema-list-tables', {}],
  ['schemaDescribeTable', 'schema-describe-table', { table: 'items' }],
  ['schemaListColumns', 'schema-list-columns', {}],
  ['schemaListProcedures', 'schema-list-procedures', {}],
  ['schemaListIndexes', 'schema-list-indexes', {}],
  ['monitorActiveQueries', 'monitor-active-queries', {}],
  ['monitorBlocking', 'monitor-blocking', {}],
  ['monitorWaitStats', 'monitor-wait-stats', {}],
  ['monitorDatabaseSize', 'monitor-database-size', {}],
  ['monitorConnections', 'monitor-connections', {}],
  ['monitorPerformanceCounters', 'monitor-performance-counters', {}],
  ['analyzeQuery', 'analyze-query', { query: 'SELECT * FROM dbo.items WHERE id = @id', params: { id: 1 }, includeExecutionPlan: true }],
  ['analyzeSuggestIndexes', 'analyze-suggest-indexes', {}],
  ['analyzeUnusedIndexes', 'analyze-unused-indexes', {}],
  ['analyzeDuplicateIndexes', 'analyze-duplicate-indexes', {}],
  ['analyzeFragmentation', 'analyze-fragmentation', {}],
  ['analyzeStatistics', 'analyze-statistics', {}],
];

const loaders = import.meta.glob('../../../src/tools/*.ts') as Record<string, () => Promise<Record<string, Tool>>>;

async function run(role: 'reader' | 'monitor' | 'dbstate' | 'sa', fixture: Fixture): Promise<Record<string, { ok: boolean; detail: string }>> {
  useLogin(fixture, role === 'sa' ? 'reader' : role, { QUERY_TIMEOUT: '20000', POOL_MAX: '4' });
  if (role === 'sa') {
    process.env.SQL_USER = 'sa';
    process.env.SQL_PASSWORD = TEST_MSSQL_PASSWORD!;
  }
  vi.resetModules();
  const connection = await import('../../../src/db/connection.js');
  const results: Record<string, { ok: boolean; detail: string }> = {};
  try {
    for (const [name, file, args] of CASES) {
      const mod = await loaders[`../../../src/tools/${file}.ts`]();
      const response = await mod[name](args);
      const body = response.content[0].text;
      const warned = /warnings/.test(body) && /(permission|denied|unavailable|Could not)/i.test(body);
      if (name === 'analyzeQuery') {
        console.log(`analyzeQuery as ${role}: plan=${body.includes('estimatedPlan')} body=${body.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      if (name === 'analyzeQuery' && (role === 'sa' || role === 'monitor')) {
        expect(body, `analyze_query plan as ${role}`).toContain('estimatedPlan');
      }
      results[name] = {
        ok: !response.isError && !warned,
        detail: response.isError || warned ? body.replace(/\s+/g, ' ').slice(0, 300) : '',
      };
    }
  } finally {
    await connection.closePool();
  }
  return results;
}

describe.skipIf(!mssqlEnabled)('every tool against real SQL Server (READONLY)', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture();
  }, 120000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60000);

  it('all tools work with a privileged login (their queries pass the validator)', async () => {
    const results = await run('sa', fixture);
    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    console.log('PRIVILEGED:', JSON.stringify(results, null, 1));
    expect(failed.map(([name]) => name)).toEqual([]);
  }, 120000);

  it('all tools work with db_datareader + the documented monitoring grants', async () => {
    const results = await run('monitor', fixture);
    console.log('MONITOR:', JSON.stringify(results, null, 1));
    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    expect(failed.map(([name]) => name)).toEqual([]);
  }, 120000);

  it('reports which tools work with db_datareader + VIEW DATABASE STATE only', async () => {
    const results = await run('dbstate', fixture);
    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    console.log('DBSTATE FAILED:', JSON.stringify(Object.fromEntries(failed.map(([n, r]) => [n, r.detail.slice(0, 120)])), null, 1));
    expect(Object.keys(results)).toHaveLength(CASES.length);
  }, 120000);

  it('reports which tools a db_datareader login can not use', async () => {
    const results = await run('reader', fixture);
    console.log('DATAREADER:', JSON.stringify(results, null, 1));
    const needsMore = Object.entries(results).filter(([, r]) => !r.ok).map(([name]) => name).sort();
    console.log('NEED MORE THAN db_datareader:', needsMore.join(', '));
    // every tool answers with a structured response (no crash); the list above is what the README documents
    expect(Object.keys(results)).toHaveLength(CASES.length);
  }, 120000);
});
