import { executeQuery } from '../db/index.js';
import { statisticsSchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_statistics
 * Analyze table statistics and identify stale statistics
 */
export async function analyzeStatistics(args: unknown): Promise<ToolResponse> {
  try {
    const { table, minRowsChanged } = statisticsSchema.parse(args);

    let query = `
      SELECT
        OBJECT_SCHEMA_NAME(s.object_id) AS [schema],
        OBJECT_NAME(s.object_id) AS [table],
        s.name AS [statisticsName],
        s.auto_created AS [autoCreated],
        s.user_created AS [userCreated],
        s.no_recompute AS [noRecompute],
        s.has_filter AS [hasFilter],
        s.filter_definition AS [filterDefinition],
        sp.last_updated AS [lastUpdated],
        sp.rows AS [totalRows],
        sp.rows_sampled AS [rowsSampled],
        sp.modification_counter AS [modificationCounter],
        CAST(100.0 * sp.modification_counter / NULLIF(sp.rows, 0) AS DECIMAL(5,2)) AS [percentModified],
        sp.steps AS [histogramSteps],
        sp.unfiltered_rows AS [unfilteredRows],
        CASE
          WHEN sp.rows = 0 THEN 'EMPTY TABLE'
          WHEN 100.0 * sp.modification_counter / sp.rows > 20 THEN 'STALE - Update recommended'
          WHEN DATEDIFF(DAY, sp.last_updated, GETDATE()) > 30 THEN 'OLD - Consider update'
          ELSE 'OK'
        END AS [status],
        CASE
          WHEN 100.0 * sp.modification_counter / NULLIF(sp.rows, 0) > 20
            THEN 'UPDATE STATISTICS [' + OBJECT_SCHEMA_NAME(s.object_id) + '].[' + OBJECT_NAME(s.object_id) + '] [' + s.name + '] WITH FULLSCAN'
          ELSE NULL
        END AS [updateDDL],
        COL_NAME(s.object_id, sc.column_id) AS [firstColumn],
        (
          SELECT STRING_AGG(COL_NAME(sc2.object_id, sc2.column_id), ', ') WITHIN GROUP (ORDER BY sc2.stats_column_id)
          FROM sys.stats_columns sc2
          WHERE sc2.object_id = s.object_id AND sc2.stats_id = s.stats_id
        ) AS [allColumns]
      FROM sys.stats s
      CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
      LEFT JOIN sys.stats_columns sc ON s.object_id = sc.object_id AND s.stats_id = sc.stats_id AND sc.stats_column_id = 1
      WHERE OBJECTPROPERTY(s.object_id, 'IsUserTable') = 1
    `;

    const params: Record<string, string | number> = { minRowsChanged };

    if (table) {
      query += ` AND OBJECT_NAME(s.object_id) = @table`;
      params.table = table;
    }

    if (minRowsChanged > 0) {
      query += ` AND (sp.rows = 0 OR 100.0 * sp.modification_counter / sp.rows >= @minRowsChanged)`;
    }

    query += `
      ORDER BY
        CASE
          WHEN sp.rows = 0 THEN 0
          ELSE 100.0 * sp.modification_counter / sp.rows
        END DESC,
        sp.last_updated ASC
    `;

    const result = await executeQuery(query, params, 200);

    // Categorize statistics
    const summary = {
      stale: 0,
      old: 0,
      ok: 0,
      empty: 0,
    };

    result.rows.forEach((row) => {
      const r = row as { status: string };
      if (r.status.startsWith('STALE')) {
        summary.stale++;
      } else if (r.status.startsWith('OLD')) {
        summary.old++;
      } else if (r.status === 'EMPTY TABLE') {
        summary.empty++;
      } else {
        summary.ok++;
      }
    });

    return formatSuccess({
      statistics: result.rows,
      count: result.rowCount,
      summary,
      thresholds: {
        stale: 'More than 20% rows modified',
        old: 'Last updated more than 30 days ago',
      },
      note: 'Stale statistics can cause the query optimizer to choose suboptimal execution plans. Consider updating statistics regularly.',
    });
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Tool definition for analyze_statistics
 */
export const analyzeStatisticsDefinition = {
  name: 'analyze_statistics',
  description:
    'Analyze table statistics to identify stale or outdated statistics that may affect query performance.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'Filter for a specific table',
      },
      minRowsChanged: {
        type: 'number',
        default: 10,
        minimum: 0,
        maximum: 100,
        description: 'Minimum percentage of rows changed (default: 10)',
      },
    },
  },
};
