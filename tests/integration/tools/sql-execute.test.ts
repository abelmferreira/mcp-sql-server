import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the connection module directly
vi.mock('../../../src/db/connection.js', async () => {
  const { FakeTransaction } = await import('../../mocks/fake-pool.js');
  const NVarChar = Symbol('NVarChar');
  const BigInt = Symbol('BigInt');
  const Float = Symbol('Float');
  const Bit = Symbol('Bit');

  return {
    getPool: vi.fn(),
    sql: { NVarChar, BigInt, Float, Bit, Transaction: FakeTransaction },
  };
});

import { executeQuery, executeScalar } from '../../../src/db/execute.js';
import { getPool } from '../../../src/db/connection.js';
import { fakePool, FakeTransaction } from '../../mocks/fake-pool.js';

// Helper to create mock request
function createMockRequest(queryResult: { recordset: unknown[]; rowsAffected: number[] }) {
  return {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue(queryResult),
  };
}

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute a simple SELECT query', async () => {
    const mockRequest = createMockRequest({
      recordset: [{ id: 1, name: 'Test' }],
      rowsAffected: [1],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeQuery('SELECT * FROM users');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ id: 1, name: 'Test' });
    expect(result.rowCount).toBe(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should execute query with parameters', async () => {
    const mockRequest = createMockRequest({
      recordset: [{ id: 1, name: 'John' }],
      rowsAffected: [1],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeQuery(
      'SELECT * FROM users WHERE id = @id',
      { id: 1 }
    );

    expect(mockRequest.input).toHaveBeenCalledWith('id', expect.anything(), 1);
    expect(result.rows).toHaveLength(1);
  });

  it('should respect maxRows limit', async () => {
    const mockRequest = createMockRequest({
      recordset: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      rowsAffected: [5],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeQuery('SELECT * FROM users', {}, 3);

    expect(result.rows).toHaveLength(3);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('maxRows');
  });

  it('should handle empty results', async () => {
    const mockRequest = createMockRequest({
      recordset: [],
      rowsAffected: [0],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeQuery('SELECT * FROM users WHERE 1=0');

    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
  });

  it('should bind string parameters correctly', async () => {
    const mockRequest = createMockRequest({ recordset: [], rowsAffected: [0] });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    await executeQuery('SELECT * FROM users WHERE name = @name', { name: 'John' });

    expect(mockRequest.input).toHaveBeenCalledWith('name', expect.anything(), 'John');
  });

  it('should bind multiple parameters', async () => {
    const mockRequest = createMockRequest({ recordset: [], rowsAffected: [0] });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    await executeQuery(
      'SELECT * FROM users WHERE id = @id AND score = @score',
      { id: 42, score: 98.5 }
    );

    expect(mockRequest.input).toHaveBeenCalledWith('id', expect.anything(), 42);
    expect(mockRequest.input).toHaveBeenCalledWith('score', expect.anything(), 98.5);
  });

  it('should bind boolean parameters', async () => {
    const mockRequest = createMockRequest({ recordset: [], rowsAffected: [0] });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    await executeQuery('SELECT * FROM users WHERE active = @active', { active: true });

    expect(mockRequest.input).toHaveBeenCalledWith('active', expect.anything(), true);
  });

  it('should bind null parameters', async () => {
    const mockRequest = createMockRequest({ recordset: [], rowsAffected: [0] });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    await executeQuery('SELECT * FROM users WHERE email = @email', { email: null });

    expect(mockRequest.input).toHaveBeenCalledWith('email', expect.anything(), null);
  });

  it('should reject INSERT queries in READONLY mode', async () => {
    await expect(
      executeQuery('INSERT INTO users (name) VALUES (@name)', { name: 'Test' })
    ).rejects.toThrow();
  });

  it('should reject DELETE queries in READONLY mode', async () => {
    await expect(
      executeQuery('DELETE FROM users WHERE id = @id', { id: 1 })
    ).rejects.toThrow();
  });

  it('should reject UPDATE queries in READONLY mode', async () => {
    await expect(
      executeQuery('UPDATE users SET name = @name', { name: 'Test' })
    ).rejects.toThrow();
  });

  it('should handle query timeout errors', async () => {
    const mockRequest = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn().mockRejectedValue(new Error('Request timeout')),
    };
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    await expect(executeQuery('SELECT * FROM large_table')).rejects.toThrow(/timed out/);
  });

  it('should always roll back the READONLY transaction, also after an error', async () => {
    const before = FakeTransaction.rollbacks;
    const ok = createMockRequest({ recordset: [{ id: 1 }], rowsAffected: [1] });
    vi.mocked(getPool).mockResolvedValue(fakePool(ok as never) as never);
    await executeQuery('SELECT 1 AS id');
    const failing = { input: vi.fn(), query: vi.fn().mockRejectedValue(new Error('boom')) };
    vi.mocked(getPool).mockResolvedValue(fakePool(failing as never) as never);
    await expect(executeQuery('SELECT 1 AS id')).rejects.toThrow('boom');
    expect(FakeTransaction.rollbacks - before).toBe(2);
  });

  it('should refuse parameter names that are not plain identifiers', async () => {
    const mockRequest = createMockRequest({ recordset: [], rowsAffected: [0] });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);
    await expect(
      executeQuery('SELECT 1', { 'a int) DROP TABLE t; --': 1 })
    ).rejects.toThrow(/Invalid parameter name/);
    expect(mockRequest.input).not.toHaveBeenCalled();
  });
});

describe('executeScalar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return single value', async () => {
    const mockRequest = createMockRequest({
      recordset: [{ count: 42 }],
      rowsAffected: [1],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeScalar<number>('SELECT COUNT(*) as count FROM users');

    expect(result).toBe(42);
  });

  it('should return null for empty result', async () => {
    const mockRequest = createMockRequest({
      recordset: [],
      rowsAffected: [0],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeScalar<number>('SELECT 1 WHERE 1=0');

    expect(result).toBeNull();
  });

  it('should return first column of first row', async () => {
    const mockRequest = createMockRequest({
      recordset: [{ a: 'first', b: 'second' }],
      rowsAffected: [1],
    });
    vi.mocked(getPool).mockResolvedValue(fakePool(mockRequest as never) as never);

    const result = await executeScalar<string>('SELECT a, b FROM table1');

    expect(result).toBe('first');
  });
});
