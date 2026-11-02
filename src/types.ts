/**
 * Field information from query result
 */
export interface FieldInfo {
  name: string;
  type: string;
}

/**
 * Result of a SQL query execution
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  fields: FieldInfo[];
  duration: number;
  /** More rows were available than returned */
  truncated: boolean;
  /** Which limit cut the result: the row limit or the response size limit */
  truncatedBy?: 'maxRows' | 'maxBytes';
}

/**
 * Options for query execution
 */
export interface QueryOptions {
  params?: Record<string, unknown>;
  maxRows?: number;
  timeout?: number;
}

/**
 * MCP Tool response content
 */
export interface ToolContent {
  type: 'text';
  text: string;
}

/**
 * MCP Tool response
 */
export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Column information from schema
 */
export interface ColumnInfo {
  name: string;
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
}

/**
 * Index information from schema
 */
export interface IndexInfo {
  indexName: string;
  indexType: string;
  isUnique: boolean;
  isPrimaryKey: boolean;
  columns: string;
  includeColumns: string | null;
}

/**
 * Foreign key information from schema
 */
export interface ForeignKeyInfo {
  constraintName: string;
  columnName: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

/**
 * Table information from schema
 */
export interface TableInfo {
  schema: string;
  name: string;
  type: string;
  rowCount: number | null;
}

/**
 * Table description with columns, indexes, and foreign keys
 */
export interface TableDescription {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

/**
 * Active query information from monitoring
 */
export interface ActiveQuery {
  sessionId: number;
  status: string;
  command: string;
  queryText: string;
  durationMs: number;
  cpuTime: number;
  logicalReads: number;
  waitType: string | null;
  waitTime: number;
  blockedBy: number | null;
  database: string;
  user: string;
}

/**
 * Blocking chain information
 */
export interface BlockingInfo {
  sessionId: number;
  blockedBy: number | null;
  waitType: string;
  waitTimeMs: number;
  queryText: string;
  level: number;
}

/**
 * Wait statistics information
 */
export interface WaitStats {
  waitType: string;
  waitingTasksCount: number;
  waitTimeMs: number;
  maxWaitTimeMs: number;
  signalWaitTimeMs: number;
  percentageOfTotal: number;
}

/**
 * Database size information
 */
export interface DatabaseSizeInfo {
  database: string;
  totalSizeMB: number;
  dataUsedMB: number;
  logUsedMB: number;
  freeSpaceMB: number;
}

/**
 * Missing index suggestion
 */
export interface MissingIndex {
  schema: string;
  table: string;
  equalityColumns: string | null;
  inequalityColumns: string | null;
  includeColumns: string | null;
  impact: number;
  userSeeks: number;
  userScans: number;
  avgTotalUserCost: number;
  avgUserImpact: number;
  createStatement: string;
}

/**
 * Unused index information
 */
export interface UnusedIndex {
  schema: string;
  table: string;
  indexName: string;
  indexType: string;
  columns: string;
  sizeMB: number;
  userSeeks: number;
  userScans: number;
  userLookups: number;
  userUpdates: number;
  lastUserSeek: Date | null;
  lastUserScan: Date | null;
  maintenanceCost: 'HIGH' | 'MEDIUM' | 'LOW';
  dropStatement: string;
}

/**
 * Duplicate index information
 */
export interface DuplicateIndex {
  schema: string;
  table: string;
  duplicateType: 'EXACT' | 'SUBSET';
  index1Name: string;
  index2Name: string;
  keyColumns: string;
  index1SizeMB: number;
  index2SizeMB: number;
  index1Reads: number;
  index2Reads: number;
  recommendation: string;
  potentialSavingsMB: number;
}

/**
 * Index fragmentation information
 */
export interface FragmentedIndex {
  schema: string;
  table: string;
  indexName: string;
  indexType: string;
  fragmentationPercent: number;
  pageCount: number;
  avgPageSpaceUsedPercent: number;
  recommendation: 'REBUILD' | 'REORGANIZE' | 'OK';
  rebuildStatement: string;
  reorganizeStatement: string;
}

/**
 * Statistics information
 */
export interface StatisticsInfo {
  schema: string;
  table: string;
  statisticName: string;
  lastUpdated: Date | null;
  rowCount: number;
  rowsModified: number;
  modificationPercent: number;
  updateStatement: string;
}

/**
 * Server information
 */
export interface ServerInfo {
  server: string;
  database: string;
  readonly: boolean;
  version: string;
  connected: boolean;
  poolSize: {
    min: number;
    max: number;
    current: number;
  };
}

/**
 * SQL parameter value types
 */
export type SqlParamValue = string | number | boolean | null | Date;

/**
 * SQL parameters object
 */
export type SqlParams = Record<string, SqlParamValue>;
