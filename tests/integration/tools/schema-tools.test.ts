import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mssql: the pool hands out streaming requests driven by one scripted `query` mock
vi.mock('mssql', async () => {
  const { fakePool, FakeTransaction } = await import('../../mocks/fake-pool.js');
  const script = {
    input: vi.fn(),
    query: vi.fn(),
  };
  const mockPool = {
    connected: true,
    ...fakePool(script),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    _script: script,
  };
  const types = {
    NVarChar: Symbol('NVarChar'),
    BigInt: Symbol('BigInt'),
    Float: Symbol('Float'),
    Bit: Symbol('Bit'),
    Transaction: FakeTransaction,
  };
  return {
    default: { connect: vi.fn().mockResolvedValue(mockPool), ...types },
    connect: vi.fn().mockResolvedValue(mockPool),
    ...types,
  };
});

import sql from 'mssql';
import { schemaListTables } from '../../../src/tools/schema-list-tables.js';
import { schemaDescribeTable } from '../../../src/tools/schema-describe-table.js';
import { schemaListColumns } from '../../../src/tools/schema-list-columns.js';

// Helper to get mock request from the pool
async function getMockRequest() {
  const pool = (await sql.connect({} as never)) as unknown as { _script: { query: unknown } };
  return pool._script as { query: unknown };
}

describe('schemaListTables', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockReset();
  });

  it('should return list of tables', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { schema_name: 'dbo', table_name: 'users', type: 'TABLE', row_count: 100 },
        { schema_name: 'dbo', table_name: 'orders', type: 'TABLE', row_count: 500 },
      ],
      rowsAffected: [2],
    });

    const result = await schemaListTables({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBeUndefined();
  });

  it('should filter by schema', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { schema_name: 'sales', table_name: 'customers', type: 'TABLE', row_count: 50 },
      ],
      rowsAffected: [1],
    });

    const result = await schemaListTables({ schema: 'sales' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should filter by type TABLE', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { schema_name: 'dbo', table_name: 'users', type: 'TABLE', row_count: 100 },
      ],
      rowsAffected: [1],
    });

    const result = await schemaListTables({ type: 'TABLE' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should filter by type VIEW', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { schema_name: 'dbo', table_name: 'active_users', type: 'VIEW', row_count: 0 },
      ],
      rowsAffected: [1],
    });

    const result = await schemaListTables({ type: 'VIEW' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should handle empty results', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [],
      rowsAffected: [0],
    });

    const result = await schemaListTables({ schema: 'nonexistent' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should handle pattern filter', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { schema_name: 'dbo', table_name: 'user_profiles', type: 'TABLE', row_count: 50 },
        { schema_name: 'dbo', table_name: 'user_settings', type: 'TABLE', row_count: 30 },
      ],
      rowsAffected: [2],
    });

    const result = await schemaListTables({ pattern: '%user%' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });
});

describe('schemaDescribeTable', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockReset();
  });

  it('should describe table with columns', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { column_name: 'id', data_type: 'int', is_nullable: 'NO', is_primary_key: 1 },
        { column_name: 'name', data_type: 'nvarchar', is_nullable: 'YES', is_primary_key: 0 },
      ],
      rowsAffected: [2],
    });

    const result = await schemaDescribeTable({ table: 'users' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should use default schema dbo', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { column_name: 'id', data_type: 'int', is_nullable: 'NO' },
      ],
      rowsAffected: [1],
    });

    const result = await schemaDescribeTable({ table: 'users' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should accept custom schema', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { column_name: 'id', data_type: 'int', is_nullable: 'NO' },
      ],
      rowsAffected: [1],
    });

    const result = await schemaDescribeTable({ table: 'orders', schema: 'sales' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should handle validation error for empty table name', async () => {
    const result = await schemaDescribeTable({ table: '' });

    expect(result.isError).toBe(true);
  });
});

describe('schemaListColumns', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockReset();
  });

  it('should return list of columns', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { table_schema: 'dbo', table_name: 'users', column_name: 'id', data_type: 'int' },
        { table_schema: 'dbo', table_name: 'users', column_name: 'name', data_type: 'nvarchar' },
      ],
      rowsAffected: [2],
    });

    const result = await schemaListColumns({});

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should filter by pattern', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { table_schema: 'dbo', table_name: 'users', column_name: 'user_id', data_type: 'int' },
        { table_schema: 'dbo', table_name: 'orders', column_name: 'user_id', data_type: 'int' },
      ],
      rowsAffected: [2],
    });

    const result = await schemaListColumns({ pattern: '%user_id%' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should filter by data type', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { table_schema: 'dbo', table_name: 'users', column_name: 'created_at', data_type: 'datetime' },
      ],
      rowsAffected: [1],
    });

    const result = await schemaListColumns({ dataType: 'datetime' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });

  it('should filter by table name', async () => {
    const mockRequest = await getMockRequest();
    (mockRequest.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordset: [
        { table_schema: 'dbo', table_name: 'users', column_name: 'id', data_type: 'int' },
      ],
      rowsAffected: [1],
    });

    const result = await schemaListColumns({ table: 'users' });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
  });
});
