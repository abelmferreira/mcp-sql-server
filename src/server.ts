import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { getPool, closePool } from './db/index.js';
import { createShutdown, installShutdownTriggers } from './shutdown.js';

// Import all tool handlers
import { sqlExecute } from './tools/sql-execute.js';
import { schemaListTables } from './tools/schema-list-tables.js';
import { schemaDescribeTable } from './tools/schema-describe-table.js';
import { schemaListColumns } from './tools/schema-list-columns.js';
import { schemaListProcedures } from './tools/schema-list-procedures.js';
import { schemaListIndexes } from './tools/schema-list-indexes.js';
import { monitorActiveQueries } from './tools/monitor-active-queries.js';
import { monitorBlocking } from './tools/monitor-blocking.js';
import { monitorWaitStats } from './tools/monitor-wait-stats.js';
import { monitorDatabaseSize } from './tools/monitor-database-size.js';
import { monitorConnections } from './tools/monitor-connections.js';
import { monitorPerformanceCounters } from './tools/monitor-performance-counters.js';
import { analyzeQuery } from './tools/analyze-query.js';
import { analyzeSuggestIndexes } from './tools/analyze-suggest-indexes.js';
import { analyzeUnusedIndexes } from './tools/analyze-unused-indexes.js';
import { analyzeDuplicateIndexes } from './tools/analyze-duplicate-indexes.js';
import { analyzeFragmentation } from './tools/analyze-fragmentation.js';
import { analyzeStatistics } from './tools/analyze-statistics.js';
import { sqlInsert } from './tools/sql-insert.js';
import { sqlUpdate } from './tools/sql-update.js';
import { sqlDelete } from './tools/sql-delete.js';

/**
 * Version from package.json. It sits one level above this file both in the
 * sources (src/server.ts) and in the published package (build/server.js).
 */
export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Create and configure the MCP server
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-sql-server',
    version: readPackageVersion(),
  });

  logger.info('Registering tools', { readonly: config.READONLY });

  // SQL Execute Tool
  server.tool(
    'sql_execute',
    'Execute SQL SELECT queries with parameterized inputs. In READONLY mode, only SELECT and WITH (CTE) queries are allowed.',
    {
      query: z.string().describe('SQL SELECT query with @param placeholders'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Named parameters (without @)'),
      maxRows: z.number().optional().describe('Maximum rows to return (default: 100, max: 5000)'),
    },
    async (args) => {
      const result = await sqlExecute(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Schema List Tables Tool
  server.tool(
    'schema_list_tables',
    'List all tables and views in the database with optional filtering.',
    {
      schema: z.string().optional().describe('Filter by schema name'),
      type: z.enum(['TABLE', 'VIEW', 'ALL']).optional().describe('Filter by object type'),
      pattern: z.string().optional().describe('LIKE pattern for table name'),
    },
    async (args) => {
      const result = await schemaListTables(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Schema Describe Table Tool
  server.tool(
    'schema_describe_table',
    'Get detailed information about a table including columns, indexes, and foreign keys.',
    {
      table: z.string().describe('Table name to describe'),
      schema: z.string().optional().describe('Schema name (default: dbo)'),
    },
    async (args) => {
      const result = await schemaDescribeTable(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Schema List Columns Tool
  server.tool(
    'schema_list_columns',
    'Search for columns across all tables.',
    {
      pattern: z.string().optional().describe('LIKE pattern for column name'),
      dataType: z.string().optional().describe('Filter by data type'),
      table: z.string().optional().describe('Filter by table name'),
      schema: z.string().optional().describe('Filter by schema name'),
    },
    async (args) => {
      const result = await schemaListColumns(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Schema List Procedures Tool
  server.tool(
    'schema_list_procedures',
    'List stored procedures in the database.',
    {
      schema: z.string().optional().describe('Filter by schema name'),
      pattern: z.string().optional().describe('LIKE pattern for procedure name'),
    },
    async (args) => {
      const result = await schemaListProcedures(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Schema List Indexes Tool
  server.tool(
    'schema_list_indexes',
    'List indexes in the database with usage statistics.',
    {
      table: z.string().optional().describe('Filter by table name'),
      schema: z.string().optional().describe('Filter by schema name'),
    },
    async (args) => {
      const result = await schemaListIndexes(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Active Queries Tool
  server.tool(
    'monitor_active_queries',
    'Monitor currently running queries with execution statistics.',
    {
      minDurationMs: z.number().optional().describe('Filter queries with minimum duration in ms'),
      includeSystemQueries: z.boolean().optional().describe('Include system queries'),
    },
    async (args) => {
      const result = await monitorActiveQueries(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Blocking Tool
  server.tool(
    'monitor_blocking',
    'Monitor blocking sessions and lock chains.',
    {},
    async () => {
      const result = await monitorBlocking();
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Wait Stats Tool
  server.tool(
    'monitor_wait_stats',
    'Monitor wait statistics to identify performance bottlenecks.',
    {
      top: z.number().optional().describe('Number of wait types to return'),
      excludeIdle: z.boolean().optional().describe('Exclude idle/benign waits'),
    },
    async (args) => {
      const result = await monitorWaitStats(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Database Size Tool
  server.tool(
    'monitor_database_size',
    'Monitor database size including file usage and largest tables.',
    {},
    async () => {
      const result = await monitorDatabaseSize();
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Connections Tool
  server.tool(
    'monitor_connections',
    'Monitor active connections to the database.',
    {},
    async () => {
      const result = await monitorConnections();
      return { content: result.content, isError: result.isError };
    }
  );

  // Monitor Performance Counters Tool
  server.tool(
    'monitor_performance_counters',
    'Monitor SQL Server performance counters.',
    {
      category: z.enum(['buffer', 'sql', 'locks', 'memory', 'all']).optional().describe('Counter category'),
    },
    async (args) => {
      const result = await monitorPerformanceCounters(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Query Tool
  server.tool(
    'analyze_query',
    'Analyze a SQL query to get execution plan and statistics.',
    {
      query: z.string().describe('SQL query to analyze'),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Named parameters'),
      includeExecutionPlan: z.boolean().optional().describe('Include execution plan details'),
    },
    async (args) => {
      const result = await analyzeQuery(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Suggest Indexes Tool
  server.tool(
    'analyze_suggest_indexes',
    'Suggest missing indexes based on query analyzer recommendations.',
    {
      table: z.string().optional().describe('Filter for a specific table'),
      minImpact: z.number().optional().describe('Minimum impact percentage'),
      top: z.number().optional().describe('Maximum number of suggestions'),
    },
    async (args) => {
      const result = await analyzeSuggestIndexes(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Unused Indexes Tool
  server.tool(
    'analyze_unused_indexes',
    'Find indexes that are not being used.',
    {
      table: z.string().optional().describe('Filter for a specific table'),
      minSizeMB: z.number().optional().describe('Minimum index size in MB'),
      minAgeDays: z.number().optional().describe('Minimum days since last use'),
    },
    async (args) => {
      const result = await analyzeUnusedIndexes(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Duplicate Indexes Tool
  server.tool(
    'analyze_duplicate_indexes',
    'Find duplicate or overlapping indexes.',
    {
      table: z.string().optional().describe('Filter for a specific table'),
    },
    async (args) => {
      const result = await analyzeDuplicateIndexes(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Fragmentation Tool
  server.tool(
    'analyze_fragmentation',
    'Analyze index fragmentation levels.',
    {
      table: z.string().optional().describe('Filter for a specific table'),
      minFragmentation: z.number().optional().describe('Minimum fragmentation percentage'),
      minPageCount: z.number().optional().describe('Minimum page count'),
    },
    async (args) => {
      const result = await analyzeFragmentation(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Analyze Statistics Tool
  server.tool(
    'analyze_statistics',
    'Analyze table statistics to identify stale statistics.',
    {
      table: z.string().optional().describe('Filter for a specific table'),
      minRowsChanged: z.number().optional().describe('Minimum percentage of rows changed'),
    },
    async (args) => {
      const result = await analyzeStatistics(args);
      return { content: result.content, isError: result.isError };
    }
  );

  // Write Tools (only available when READONLY=false)
  if (!config.READONLY) {
    logger.info('Write tools enabled (READONLY=false)');

    // SQL Insert Tool
    server.tool(
      'sql_insert',
      'Insert a row into a table. Only available when READONLY=false.',
      {
        table: z.string().describe('Table name to insert into'),
        schema: z.string().optional().describe('Schema name (default: dbo)'),
        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Data to insert'),
      },
      async (args) => {
        const result = await sqlInsert(args);
        return { content: result.content, isError: result.isError };
      }
    );

    // SQL Update Tool
    server.tool(
      'sql_update',
      'Update rows in a table. Only available when READONLY=false.',
      {
        table: z.string().describe('Table name to update'),
        schema: z.string().optional().describe('Schema name (default: dbo)'),
        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Fields to update'),
        where: z.string().describe('WHERE clause (required)'),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Parameters for WHERE clause'),
      },
      async (args) => {
        const result = await sqlUpdate(args);
        return { content: result.content, isError: result.isError };
      }
    );

    // SQL Delete Tool
    server.tool(
      'sql_delete',
      'Delete rows from a table. Only available when READONLY=false.',
      {
        table: z.string().describe('Table name to delete from'),
        schema: z.string().optional().describe('Schema name (default: dbo)'),
        where: z.string().describe('WHERE clause (required)'),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Parameters for WHERE clause'),
      },
      async (args) => {
        const result = await sqlDelete(args);
        return { content: result.content, isError: result.isError };
      }
    );
  }

  return server;
}

export interface RunServerOptions {
  /** Defaults to process.stdin */
  stdin?: Readable;
  /** Defaults to process.stdout */
  stdout?: Writable;
  /** Receives SIGINT / SIGTERM / SIGHUP. Defaults to process */
  signals?: EventEmitterLike;
  /** Defaults to process.exit */
  exit?: (code: number) => void;
  /** Exit anyway after this long if closing the pool/tunnel hangs */
  shutdownTimeoutMs?: number;
}

interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Run the MCP server. The options exist for tests; the CLI uses the defaults.
 */
export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  logger.info('Starting MCP SQL Server', {
    version: readPackageVersion(),
    server: config.SQL_SERVER,
    database: config.SQL_DATABASE,
    readonly: config.READONLY,
    logLevel: config.LOG_LEVEL,
  });

  // Test database connection (fail closed: no connection, no server)
  try {
    await getPool();
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Failed to connect to database', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    exit(1);
    return;
  }

  // Create server
  const server = createServer();

  // Create transport
  const transport = new StdioServerTransport(stdin, stdout);

  // Close the pool and the SSH tunnel, then exit, when the client goes away
  // (stdin closed, stdout broken) or on SIGINT / SIGTERM / SIGHUP.
  const shutdown = createShutdown({
    closePool,
    exit,
    logger,
    timeoutMs: options.shutdownTimeoutMs,
  });
  installShutdownTriggers(shutdown, { stdin, stdout, signals });

  // Connect server to transport
  await server.connect(transport);

  logger.info('MCP server running');
}
