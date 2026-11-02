import type { EventEmitter } from 'node:events';
import { closePool, getPool, sql } from './connection.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { validateQuery } from '../validators/query-validator.js';
import {
  QueryValidationError,
  ReadOnlyViolationError,
  TimeoutError,
  InvalidOperationError,
  getErrorMessage,
  isTimeoutError,
} from '../utils/errors.js';
import type { QueryResult, SqlParamValue } from '../types.js';

/** Extra time given to the driver's own request timeout before this module gives up */
const CLIENT_TIMEOUT_GRACE_MS = 1000;
/** Upper bound for the ROLLBACK that ends every READONLY query */
const ROLLBACK_TIMEOUT_MS = 5000;
/** Characters of the query text written to the log */
const LOG_QUERY_CHARS = 200;

/** Parameter names end up in the declaration list sent to the server: keep them plain */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * SQL parameter types mapping
 */
function getSqlType(value: SqlParamValue): sql.ISqlTypeFactoryWithNoParams {
  if (value === null) {
    return sql.NVarChar;
  }
  if (typeof value === 'string') {
    return sql.NVarChar;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? sql.BigInt : sql.Float;
  }
  if (typeof value === 'boolean') {
    return sql.Bit;
  }
  return sql.NVarChar;
}

/**
 * Bind named parameters to a request. Values travel to the server as typed
 * RPC arguments: they are never spliced into the SQL text.
 */
function bindParams(request: sql.Request, params: Record<string, SqlParamValue>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM_NAME.test(name)) {
      throw new InvalidOperationError(
        `Invalid parameter name "${name.slice(0, 40)}": use letters, digits and underscore, starting with a letter or underscore`
      );
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new InvalidOperationError(`Parameter "${name}" must be a finite number`);
    }
    request.input(name, getSqlType(value), value);
  }
}

/**
 * T-SQL type used to declare a parameter in an estimated-plan batch
 */
function declaredType(value: SqlParamValue): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'bigint' : 'float';
  if (typeof value === 'boolean') return 'bit';
  return 'nvarchar(max)';
}

/**
 * Quote an identifier with [ ] (a closing bracket is doubled)
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new InvalidOperationError('Invalid identifier: it must be a non-empty string without NUL characters');
  }
  return '[' + name.replace(/]/g, ']]') + ']';
}

/**
 * Query text for the log: the first characters only, never parameter values
 */
function logText(query: string): string {
  return query.substring(0, LOG_QUERY_CHARS);
}

/**
 * Rough size of a row in bytes (used to cap the response size)
 */
function estimateRowBytes(row: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    total += key.length;
    if (value === null || value === undefined) total += 4;
    else if (typeof value === 'string') total += value.length;
    else if (Buffer.isBuffer(value)) total += value.length;
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') total += 8;
    else if (value instanceof Date) total += 24;
    else total += JSON.stringify(value)?.length ?? 8;
  }
  return total;
}

/**
 * Request in stream mode: emits 'recordset' (columns), 'row', 'error', 'done'
 */
interface StreamRequest extends EventEmitter {
  stream: boolean;
  query(command: string): unknown;
  cancel(): void;
}

interface StreamLimits {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
}

interface StreamOutcome {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  truncated: boolean;
  truncatedBy?: 'maxRows' | 'maxBytes';
}

function describeColumns(columns: Record<string, { type?: unknown }>): Array<{ name: string; type: string }> {
  return Object.entries(columns).map(([name, column]) => {
    const type = column?.type as { name?: string; declaration?: string } | undefined;
    return { name, type: type?.declaration ?? type?.name ?? 'unknown' };
  });
}

/**
 * Run a statement and collect its rows one by one. The first row beyond
 * `maxRows` (or beyond the byte budget) cancels the request on the server, so
 * the full result set is never read or buffered. Only the first result set is
 * returned; a second one cancels the request as well.
 *
 * Settles after the driver reports 'done' (the request is over and the
 * connection is usable again), or on the timeout fallback.
 */
function streamQuery(request: StreamRequest, text: string, limits: StreamLimits): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let fields: Array<{ name: string; type: string }> = [];
    let recordsets = 0;
    let bytes = 0;
    let stopped: 'maxRows' | 'maxBytes' | 'extraResultSet' | null = null;
    let failure: Error | null = null;
    let settled = false;

    const settle = (outcome: StreamOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped) return;
      stopped = reason;
      try {
        request.cancel();
      } catch {
        // already finished
      }
    };

    const timer = setTimeout(() => {
      try {
        request.cancel();
      } catch {
        // ignore
      }
      settle(new TimeoutError(limits.timeoutMs));
    }, limits.timeoutMs + CLIENT_TIMEOUT_GRACE_MS);

    request.on('recordset', (columns: Record<string, { type?: unknown }>) => {
      recordsets++;
      if (recordsets === 1) {
        fields = describeColumns(columns);
      } else {
        stop('extraResultSet');
      }
    });

    request.on('row', (row: Record<string, unknown>) => {
      if (stopped || recordsets !== 1) return;
      if (rows.length >= limits.maxRows) {
        stop('maxRows');
        return;
      }
      bytes += estimateRowBytes(row);
      if (bytes > limits.maxBytes) {
        stop('maxBytes');
        return;
      }
      rows.push(row);
    });

    // The cancellation requested above is reported as an error: not a failure
    request.on('error', (err: Error & { code?: string }) => {
      if (stopped && (err.code === 'ECANCEL' || /cancel/i.test(err.message))) return;
      failure ??= err;
    });

    request.on('done', () => {
      if (failure) {
        settle(failure);
        return;
      }
      const truncatedBy = stopped === 'maxRows' || stopped === 'maxBytes' ? stopped : undefined;
      settle({
        rows,
        fields,
        truncated: truncatedBy !== undefined,
        ...(truncatedBy ? { truncatedBy } : {}),
      });
    });

    try {
      request.query(text);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * ROLLBACK without letting a failure hide the real result. A server side
 * abort (XACT_ABORT) already ended the transaction: nothing left to undo.
 */
async function rollbackQuietly(transaction: sql.Transaction): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      transaction.rollback(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ROLLBACK timed out')), ROLLBACK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn('ROLLBACK did not complete cleanly', { error: getErrorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one statement.
 *
 * READONLY: inside BEGIN TRANSACTION, always ended with ROLLBACK (also after
 * errors, timeouts and cancellations), so nothing the statement did can be
 * committed even if it slipped past the validator and the login could write.
 */
async function runStatement(
  text: string,
  params: Record<string, SqlParamValue>,
  maxRows: number,
  readonly: boolean
): Promise<StreamOutcome> {
  const pool = await getPool();
  const limits: StreamLimits = {
    maxRows,
    maxBytes: config.MAX_RESULT_BYTES,
    timeoutMs: config.QUERY_TIMEOUT,
  };

  if (!readonly) {
    const request = pool.request();
    request.stream = true;
    bindParams(request, params);
    return streamQuery(request as unknown as StreamRequest, text, limits);
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const request = transaction.request();
    request.stream = true;
    bindParams(request, params);
    return await streamQuery(request as unknown as StreamRequest, text, limits);
  } finally {
    await rollbackQuietly(transaction);
  }
}

/**
 * Execute a SQL query with parameters
 *
 * @param query SQL query with @param placeholders
 * @param params Named parameters (without @)
 * @param maxRows Maximum rows to return (capped by MAX_ROWS)
 * @returns Query result with rows and metadata
 */
export async function executeQuery(
  query: string,
  params: Record<string, SqlParamValue> = {},
  maxRows: number = 100
): Promise<QueryResult> {
  const startTime = Date.now();
  const limit = Math.max(1, Math.min(Math.floor(maxRows), config.MAX_ROWS));
  const paramCount = Object.keys(params).length;

  // Parameters are bound on the server, never interpolated: the text validated
  // here is exactly the text that reaches the server.
  if (config.READONLY) {
    const validation = validateQuery(query);
    if (!validation.valid) {
      throw new QueryValidationError(validation.reason || 'Query validation failed', validation.queryType);
    }
  }

  try {
    const outcome = await runStatement(query, params, limit, config.READONLY);
    const duration = Date.now() - startTime;

    logger.info('Query executed', {
      duration,
      rows: outcome.rows.length,
      truncated: outcome.truncated,
      paramCount,
      readonly: config.READONLY,
      query: logText(query),
    });

    return {
      rows: outcome.rows,
      rowCount: outcome.rows.length,
      fields: outcome.fields,
      duration,
      truncated: outcome.truncated,
      ...(outcome.truncatedBy ? { truncatedBy: outcome.truncatedBy } : {}),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Query execution failed', {
      error: getErrorMessage(error),
      duration,
      paramCount,
      query: logText(query),
    });

    if (isTimeoutError(error)) {
      throw new TimeoutError(config.QUERY_TIMEOUT);
    }
    throw error;
  }
}

/**
 * Estimated execution plan (SET SHOWPLAN_XML ON): the statement is compiled,
 * not executed. SHOWPLAN is session state, so everything runs on one
 * connection (a transaction pins it) and the setting is always switched off
 * again before the connection goes back to the pool.
 *
 * @returns the plan XML, or null when the server returned none
 */
export async function getEstimatedPlan(
  query: string,
  params: Record<string, SqlParamValue> = {}
): Promise<string | null> {
  if (config.READONLY) {
    const validation = validateQuery(query);
    if (!validation.valid) {
      throw new QueryValidationError(validation.reason || 'Query validation failed', validation.queryType);
    }
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  let showplanOn = false;
  try {
    await transaction.request().batch('SET SHOWPLAN_XML ON');
    showplanOn = true;
    // The plan is only returned for a plain batch (an RPC / sp_executesql call
    // returns nothing under SHOWPLAN_XML), so parameters become DECLAREd
    // variables without a value: the plan is estimated for "unknown" values and
    // no parameter value is ever spliced into the text.
    const declarations = Object.entries(params).map(([name, value]) => {
      if (!PARAM_NAME.test(name)) {
        throw new InvalidOperationError(`Invalid parameter name "${name.slice(0, 40)}"`);
      }
      return `DECLARE @${name} ${declaredType(value)};`;
    });
    const result = await transaction.request().batch([...declarations, query].join('\n'));
    const first = result.recordset?.[0] as Record<string, unknown> | undefined;
    const xml = first ? Object.values(first)[0] : null;
    return typeof xml === 'string' ? xml : null;
  } finally {
    let switchedOff = !showplanOn;
    if (showplanOn) {
      try {
        await transaction.request().batch('SET SHOWPLAN_XML OFF');
        switchedOff = true;
      } catch {
        // A failed statement (e.g. missing SHOWPLAN permission) can abort the
        // transaction and hand the connection back to the pool before this runs
      }
    }
    await rollbackQuietly(transaction);
    if (!switchedOff) {
      // The connection may keep returning plans instead of results: do not
      // leave it in the pool
      logger.warn('Could not switch SHOWPLAN_XML off; resetting the connection pool');
      await closePool();
    }
  }
}

/**
 * Execute a write operation (INSERT, UPDATE, DELETE)
 * Only allowed when READONLY is false
 *
 * @param query SQL query
 * @param params Named parameters
 * @returns Number of affected rows
 */
export async function executeWrite(
  query: string,
  params: Record<string, SqlParamValue> = {}
): Promise<{ affectedRows: number; duration: number }> {
  if (config.READONLY) {
    throw new ReadOnlyViolationError('WRITE');
  }

  const startTime = Date.now();
  const paramCount = Object.keys(params).length;

  try {
    const pool = await getPool();
    const request = pool.request();
    bindParams(request, params);

    const result = await request.query(query);

    const duration = Date.now() - startTime;
    const affectedRows = result.rowsAffected[0] || 0;

    logger.info('Write operation executed', {
      affectedRows,
      duration,
      paramCount,
      query: logText(query),
    });

    return { affectedRows, duration };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Write operation failed', {
      error: getErrorMessage(error),
      duration,
      paramCount,
      query: logText(query),
    });

    throw error;
  }
}

/**
 * Execute a query that returns a single scalar value
 */
export async function executeScalar<T>(
  query: string,
  params: Record<string, SqlParamValue> = {}
): Promise<T | null> {
  const result = await executeQuery(query, params, 1);

  if (result.rows.length === 0) {
    return null;
  }

  const firstRow = result.rows[0] as Record<string, unknown>;
  const keys = Object.keys(firstRow);

  if (keys.length === 0) {
    return null;
  }

  return firstRow[keys[0]] as T;
}

/**
 * Parameter names for the values of a write: the column name when it is a
 * plain parameter name that does not clash (SQL Server parameter names are
 * case-insensitive) with another one, otherwise a neutral name. A column such
 * as "first name" or "id" (also used in the WHERE clause) stays safe.
 */
function valueParamNames(columns: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved.map((name) => name.toLowerCase()));
  return columns.map((col, i) => {
    let name = PARAM_NAME.test(col) && !used.has(col.toLowerCase()) ? col : `v${i}`;
    for (let n = i; used.has(name.toLowerCase()); n++) name = `v${n}_`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Build a parameterized INSERT query
 */
export function buildInsertQuery(
  schema: string,
  table: string,
  data: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  const columns = Object.keys(data);
  if (columns.length === 0) {
    throw new InvalidOperationError('No data to insert');
  }
  const names = valueParamNames(columns);
  const params: Record<string, SqlParamValue> = {};
  const placeholders = columns.map((col, i) => {
    params[names[i]] = data[col];
    return `@${names[i]}`;
  });

  const query = `
    INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')})
    VALUES (${placeholders.join(', ')});
    SELECT SCOPE_IDENTITY() AS insertedId;
  `;

  return { query, params };
}

/**
 * Build a parameterized UPDATE query
 */
export function buildUpdateQuery(
  schema: string,
  table: string,
  data: Record<string, SqlParamValue>,
  whereClause: string,
  whereParams: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  const columns = Object.keys(data);
  if (columns.length === 0) {
    throw new InvalidOperationError('No data to update');
  }
  const names = valueParamNames(columns, Object.keys(whereParams));
  const params: Record<string, SqlParamValue> = {};
  const setClause = columns
    .map((col, i) => {
      params[names[i]] = data[col];
      return `${quoteIdentifier(col)} = @${names[i]}`;
    })
    .join(', ');

  const query = `
    UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
    SET ${setClause}
    WHERE ${whereClause};
    SELECT @@ROWCOUNT AS affectedRows;
  `;

  return { query, params: { ...params, ...whereParams } };
}

/**
 * Build a parameterized DELETE query
 */
export function buildDeleteQuery(
  schema: string,
  table: string,
  whereClause: string,
  whereParams: Record<string, SqlParamValue>
): { query: string; params: Record<string, SqlParamValue> } {
  const query = `
    DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
    WHERE ${whereClause};
    SELECT @@ROWCOUNT AS affectedRows;
  `;

  return { query, params: whereParams };
}
