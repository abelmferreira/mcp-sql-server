import { executeQuery } from '../db/index.js';
import { listIndexesSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: schema_list_indexes
 * List indexes in the database
 */
export async function schemaListIndexes(args: unknown): Promise<ToolResponse> {
  try {
    const { table, schema } = listIndexesSchema.parse(args);

    let query = `
      SELECT
        s.name AS [schema],
        t.name AS [table],
        i.name AS [indexName],
        i.type_desc AS [type],
        i.is_unique AS [isUnique],
        i.is_primary_key AS [isPrimaryKey],
        i.is_disabled AS [isDisabled],
        STRING_AGG(
          CASE WHEN ic.is_included_column = 0 THEN c.name END,
          ', '
        ) WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS [columns],
        STRING_AGG(
          CASE WHEN ic.is_included_column = 1 THEN c.name END,
          ', '
        ) WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS [includedColumns],
        ps.row_count AS [rowCount],
        CAST(ROUND(ps.used_page_count * 8.0 / 1024, 2) AS DECIMAL(18,2)) AS [sizeMB],
        ius.user_seeks AS [seeks],
        ius.user_scans AS [scans],
        ius.user_lookups AS [lookups],
        ius.user_updates AS [updates],
        ius.last_user_seek AS [lastSeek],
        ius.last_user_scan AS [lastScan]
      FROM sys.indexes i
      INNER JOIN sys.tables t ON i.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      LEFT JOIN sys.dm_db_partition_stats ps ON i.object_id = ps.object_id AND i.index_id = ps.index_id
      LEFT JOIN sys.dm_db_index_usage_stats ius ON i.object_id = ius.object_id AND i.index_id = ius.index_id AND ius.database_id = DB_ID()
      WHERE i.name IS NOT NULL
    `;

    const params: Record<string, string> = {};

    if (table) {
      query += ` AND t.name = @table`;
      params.table = table;
    }

    if (schema) {
      query += ` AND s.name = @schema`;
      params.schema = schema;
    }

    query += `
      GROUP BY
        s.name, t.name, i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_disabled,
        ps.row_count, ps.used_page_count,
        ius.user_seeks, ius.user_scans, ius.user_lookups, ius.user_updates,
        ius.last_user_seek, ius.last_user_scan
      ORDER BY s.name, t.name, i.name
    `;

    const result = await executeQuery(query, params, 1000);

    return formatSuccess({
      indexes: result.rows,
      count: result.rowCount,
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for schema_list_indexes
 */
export const schemaListIndexesDefinition = {
  name: 'schema_list_indexes',
  description:
    'List indexes in the database with usage statistics, including seeks, scans, lookups, and updates.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter by table name',
      },
      schema: {
        type: 'string',
        description: 'Filter by schema name',
      },
    },
  },
};
