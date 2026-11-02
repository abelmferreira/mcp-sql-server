/**
 * Base error class for MCP SQL Server
 */
export class McpError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error thrown when query validation fails
 */
export class QueryValidationError extends McpError {
  public readonly queryType?: string;

  constructor(message: string, queryType?: string) {
    super(message, 'QUERY_VALIDATION_ERROR');
    this.name = 'QueryValidationError';
    this.queryType = queryType;
  }
}

/**
 * Error thrown when READONLY mode is violated
 */
export class ReadOnlyViolationError extends McpError {
  public readonly blockedKeyword: string;

  constructor(blockedKeyword: string) {
    super(
      `Operation blocked in READONLY mode: "${blockedKeyword}" is not allowed. ` +
        'Only SELECT queries are permitted.',
      'READONLY_VIOLATION'
    );
    this.name = 'ReadOnlyViolationError';
    this.blockedKeyword = blockedKeyword;
  }
}

/**
 * Error thrown when database connection fails
 */
export class ConnectionError extends McpError {
  constructor(message: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

/**
 * Error thrown when query times out
 */
export class TimeoutError extends McpError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Query timed out after ${timeoutMs}ms. Consider optimizing your query or increasing the timeout.`,
      'TIMEOUT_ERROR'
    );
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when required parameters are missing
 */
export class MissingParameterError extends McpError {
  public readonly parameterName: string;

  constructor(parameterName: string) {
    super(`Required parameter "${parameterName}" is missing`, 'MISSING_PARAMETER');
    this.name = 'MissingParameterError';
    this.parameterName = parameterName;
  }
}

/**
 * Error thrown for invalid SQL operations
 */
export class InvalidOperationError extends McpError {
  constructor(message: string) {
    super(message, 'INVALID_OPERATION');
    this.name = 'InvalidOperationError';
  }
}

/**
 * Get a user-friendly error message from an error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof McpError) {
    return error.message;
  }

  if (error instanceof Error) {
    // Remove sensitive information from SQL Server errors
    const message = error.message
      .replace(/Login failed for user '[^']*'/, "Login failed for user '***'")
      .replace(/password[^,]*/gi, 'password=***');

    return message;
  }

  return 'An unknown error occurred';
}

/**
 * Is this a query timeout (driver request timeout or this server's own timer)?
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'ETIMEOUT' || (typeof message === 'string' && /timeout/i.test(message));
}
