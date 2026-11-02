import { executeQuery, getEstimatedPlan } from '../db/index.js';
import { analyzeQuerySchema } from '../validators/schemas.js';
import { formatSuccess, formatError } from '../utils/formatters.js';
import type { ToolResponse } from '../types.js';

/**
 * Tool: analyze_query
 * Analyze a query's execution plan and statistics
 */
export async function analyzeQuery(args: unknown): Promise<ToolResponse> {
  try {
    const { query, params, includeExecutionPlan } = analyzeQuerySchema.parse(args);

    const results: {
      estimatedPlan?: unknown;
      statistics?: unknown;
      warnings?: string[];
    } = {};
    const warnings: string[] = [];

    if (includeExecutionPlan) {
      // Estimated plan: the statement is compiled, not executed. Needs the SHOWPLAN permission.
      try {
        const planXml = await getEstimatedPlan(query, params);

        if (planXml) {
          // Parse key information from the XML plan
          results.estimatedPlan = parsePlanXml(planXml);
        }
      } catch (planError) {
        warnings.push(`Could not get execution plan: ${planError instanceof Error ? planError.message : 'Unknown error'}`);
      }
    }

    // Get query statistics from cache if available
    const statsQuery = `
      SELECT TOP 1
        qs.execution_count AS [executionCount],
        qs.total_worker_time / 1000 AS [totalCpuTimeMs],
        qs.total_elapsed_time / 1000 AS [totalElapsedTimeMs],
        qs.total_logical_reads AS [totalLogicalReads],
        qs.total_logical_writes AS [totalLogicalWrites],
        qs.total_physical_reads AS [totalPhysicalReads],
        qs.total_rows AS [totalRows],
        qs.last_execution_time AS [lastExecutionTime],
        CASE WHEN qs.execution_count > 0 THEN qs.total_worker_time / qs.execution_count / 1000 END AS [avgCpuTimeMs],
        CASE WHEN qs.execution_count > 0 THEN qs.total_elapsed_time / qs.execution_count / 1000 END AS [avgElapsedTimeMs],
        CASE WHEN qs.execution_count > 0 THEN qs.total_logical_reads / qs.execution_count END AS [avgLogicalReads],
        CASE WHEN qs.execution_count > 0 THEN qs.total_rows / qs.execution_count END AS [avgRows]
      FROM sys.dm_exec_query_stats qs
      CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
      WHERE st.text LIKE @queryPattern
      ORDER BY qs.last_execution_time DESC
    `;

    // Create a pattern to find similar queries in cache
    const queryPattern = '%' + query.substring(0, Math.min(50, query.length)).replace(/'/g, "''") + '%';

    try {
      const statsResult = await executeQuery(statsQuery, { queryPattern }, 1);
      if (statsResult.rows.length > 0) {
        results.statistics = statsResult.rows[0];
      } else {
        warnings.push('No cached statistics found for this query');
      }
    } catch {
      warnings.push('Could not retrieve query statistics');
    }

    if (warnings.length > 0) {
      results.warnings = warnings;
    }

    return formatSuccess(results);
  } catch (error) {
    return formatError(error);
  }
}

/**
 * Parse execution plan XML to extract key information
 */
function parsePlanXml(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    raw: xml.length > 5000 ? xml.substring(0, 5000) + '... [truncated]' : xml,
  };

  // Extract estimated cost
  const costMatch = xml.match(/StatementEstRows="([^"]+)"/);
  if (costMatch) {
    result.estimatedRows = parseFloat(costMatch[1]);
  }

  const subtreeCostMatch = xml.match(/EstimatedTotalSubtreeCost="([^"]+)"/);
  if (subtreeCostMatch) {
    result.estimatedCost = parseFloat(subtreeCostMatch[1]);
  }

  // Check for missing indexes
  const missingIndexMatch = xml.match(/<MissingIndexGroup[^>]*Impact="([^"]+)"[^>]*>/);
  if (missingIndexMatch) {
    result.missingIndexImpact = parseFloat(missingIndexMatch[1]);
    result.hasMissingIndex = true;
  }

  // Check for warnings
  const warningsMatch = xml.match(/<Warnings>([\s\S]*?)<\/Warnings>/);
  if (warningsMatch) {
    result.planWarnings = warningsMatch[1];
  }

  // Check for table/index scans (potential performance issues)
  const scanCount = (xml.match(/PhysicalOp="(?:Table Scan|Clustered Index Scan|Index Scan)"/g) || []).length;
  if (scanCount > 0) {
    result.scanOperations = scanCount;
    result.potentialIssue = 'Query uses table/index scans instead of seeks';
  }

  // Check for parallelism
  if (xml.includes('Parallelism')) {
    result.usesParallelism = true;
  }

  // Check for sorts
  const sortCount = (xml.match(/PhysicalOp="Sort"/g) || []).length;
  if (sortCount > 0) {
    result.sortOperations = sortCount;
  }

  return result;
}

/**
 * Tool definition for analyze_query
 */
export const analyzeQueryDefinition = {
  name: 'analyze_query',
  description:
    'Analyze a SQL query to get execution plan, statistics, and performance recommendations.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'SQL query to analyze',
      },
      params: {
        type: 'object',
        description: 'Named parameters for the query',
        additionalProperties: true,
        default: {},
      },
      includeExecutionPlan: {
        type: 'boolean',
        default: true,
        description: 'Include execution plan details (default: true)',
      },
    },
    required: ['query'],
  },
};
