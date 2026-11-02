import { executeQuery } from '../db/index.js';
import { sqlExecuteSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: sql_execute
 * Execute SQL SELECT queries with parameters
 */
export async function sqlExecute(args: unknown): Promise<ToolResponse> {
  try {
    const { query, params, maxRows } = sqlExecuteSchema.parse(args);

    const result = await executeQuery(query, params, maxRows);

    return formatSuccess({
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields,
      duration: `${result.duration}ms`,
      truncated: result.truncated,
      ...(result.truncated
        ? {
            truncatedBy: result.truncatedBy,
            note:
              result.truncatedBy === 'maxBytes'
                ? 'The response size limit (MAX_RESULT_BYTES) was reached; refine the query or select fewer columns.'
                : 'More rows are available; raise maxRows (up to MAX_ROWS) or refine the query.',
          }
        : {}),
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for sql_execute
 */
export const sqlExecuteDefinition = {
  name: 'sql_execute',
  description:
    'Execute SQL SELECT queries with parameterized inputs. In READONLY mode, only SELECT and WITH (CTE) queries are allowed. Use @paramName syntax for parameters.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'SQL SELECT query with @param placeholders. Only SELECT queries allowed in READONLY mode.',
      },
      params: {
        type: 'object',
        description:
          'Named parameters to bind (without @). Example: { "userId": 123, "status": "active" }',
        additionalProperties: true,
        default: {},
      },
      maxRows: {
        type: 'number',
        description: 'Maximum rows to return (default: 100, max: 5000)',
        default: 100,
        minimum: 1,
        maximum: 5000,
      },
    },
    required: ['query'],
  },
};
