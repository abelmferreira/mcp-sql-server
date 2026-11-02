import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('../../../src/db/index.js', () => ({
  executeQuery: vi.fn(),
}));

import { sqlExecute, sqlExecuteDefinition } from '../../../src/tools/sql-execute.js';
import { executeQuery } from '../../../src/db/index.js';

describe('sqlExecute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute a simple SELECT query', async () => {
    const mockResult = {
      rows: [{ id: 1, name: 'Test' }],
      rowCount: 1,
      fields: ['id', 'name'],
      duration: 50,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    const result = await sqlExecute({ query: 'SELECT * FROM users' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const content = JSON.parse(result.content[0].text);
    expect(content.rows).toEqual([{ id: 1, name: 'Test' }]);
    expect(content.rowCount).toBe(1);
    expect(content.duration).toBe('50ms');
  });

  it('should execute query with parameters', async () => {
    const mockResult = {
      rows: [{ id: 1, name: 'John' }],
      rowCount: 1,
      fields: ['id', 'name'],
      duration: 30,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    const result = await sqlExecute({
      query: 'SELECT * FROM users WHERE id = @id',
      params: { id: 1 },
    });

    expect(result.isError).toBeUndefined();
    expect(executeQuery).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE id = @id',
      { id: 1 },
      100
    );
  });

  it('should use custom maxRows', async () => {
    const mockResult = {
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 10,
      fields: ['id'],
      duration: 20,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    const result = await sqlExecute({
      query: 'SELECT id FROM users',
      maxRows: 50,
    });

    expect(result.isError).toBeUndefined();
    expect(executeQuery).toHaveBeenCalledWith('SELECT id FROM users', {}, 50);
  });

  it('should indicate truncated results', async () => {
    const mockResult = {
      rows: Array(100).fill({ id: 1 }),
      rowCount: 100,
      fields: ['id'],
      duration: 100,
      truncated: true,
      truncatedBy: 'maxRows' as const,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    const result = await sqlExecute({
      query: 'SELECT id FROM users',
      maxRows: 100,
    });

    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.truncated).toBe(true);
  });

  it('should not indicate truncated when all rows returned', async () => {
    const mockResult = {
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
      fields: ['id'],
      duration: 10,
      truncated: false,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    const result = await sqlExecute({
      query: 'SELECT id FROM users',
      maxRows: 100,
    });

    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.truncated).toBe(false);
  });

  it('should handle query execution errors', async () => {
    vi.mocked(executeQuery).mockRejectedValue(new Error('Connection failed'));

    const result = await sqlExecute({ query: 'SELECT * FROM users' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection failed');
  });

  it('should handle validation errors for invalid query', async () => {
    const result = await sqlExecute({ query: '' });

    expect(result.isError).toBe(true);
  });

  it('should use default maxRows of 100', async () => {
    const mockResult = {
      rows: [],
      rowCount: 0,
      fields: [],
      duration: 5,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    await sqlExecute({ query: 'SELECT 1' });

    expect(executeQuery).toHaveBeenCalledWith('SELECT 1', {}, 100);
  });

  it('should handle empty params as empty object', async () => {
    const mockResult = {
      rows: [],
      rowCount: 0,
      fields: [],
      duration: 5,
    };
    vi.mocked(executeQuery).mockResolvedValue(mockResult);

    await sqlExecute({ query: 'SELECT 1', params: undefined });

    expect(executeQuery).toHaveBeenCalledWith('SELECT 1', {}, 100);
  });
});

describe('sqlExecuteDefinition', () => {
  it('should have correct name', () => {
    expect(sqlExecuteDefinition.name).toBe('sql_execute');
  });

  it('should have description', () => {
    expect(sqlExecuteDefinition.description).toBeTruthy();
    expect(sqlExecuteDefinition.description).toContain('SELECT');
  });

  it('should have query as required parameter', () => {
    expect(sqlExecuteDefinition.inputSchema.required).toContain('query');
  });

  it('should have params as optional parameter with default', () => {
    expect(sqlExecuteDefinition.inputSchema.properties.params.default).toEqual({});
  });

  it('should have maxRows with constraints', () => {
    expect(sqlExecuteDefinition.inputSchema.properties.maxRows.default).toBe(100);
    expect(sqlExecuteDefinition.inputSchema.properties.maxRows.minimum).toBe(1);
    expect(sqlExecuteDefinition.inputSchema.properties.maxRows.maximum).toBe(5000);
  });
});
