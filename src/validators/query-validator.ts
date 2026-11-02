import { lex, significant, type Token } from './sql-lexer.js';

/**
 * Result of query validation
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  queryType?: string;
}

/**
 * READONLY query validator.
 *
 * This is a safety net, NOT the security boundary: the boundary is a database
 * login that can only read (db_datareader) plus the transaction that every
 * READONLY query runs in and always rolls back (see db/execute.ts).
 *
 * T-SQL makes statement boundaries hard to see: the `;` is optional, so
 * `SELECT 1 DELETE FROM t` is two statements. Instead of trying to split
 * statements, the validator works on real tokens (comments, string literals
 * and quoted identifiers are skipped by the lexer) and
 *   1. requires the query to start with SELECT / WITH / "(";
 *   2. accepts `;` only as a trailing terminator;
 *   3. refuses every keyword that can start another (or a dangerous) statement,
 *      wherever it appears as a bare word. Reserved words cannot be column
 *      names without brackets anyway; quote with [ ] when a name collides.
 *
 * What is validated is the SQL text exactly as it is sent to the server:
 * parameters are bound on the server (RPC arguments, never interpolated), so
 * the text the caller wrote is the text that runs.
 */

/** Bare words refused anywhere in a READONLY query */
const BLOCKED_KEYWORDS = new Set([
  // Writes and DDL
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'INTO', // SELECT ... INTO creates a table; also OUTPUT INTO, COPY INTO
  'BULK', 'READTEXT', 'WRITETEXT', 'UPDATETEXT',
  // Dynamic and external execution
  'EXEC', 'EXECUTE', 'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY',
  // Permissions, server and database administration
  'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE', 'DBCC', 'SHUTDOWN', 'KILL',
  'RECONFIGURE', 'CHECKPOINT', 'USE', 'SETUSER', 'REVERT',
  // Session state, variables, flow control and transactions (statements that
  // can follow a SELECT without a ";")
  'SET', 'DECLARE', 'WAITFOR', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'PRINT',
  'RAISERROR', 'GOTO', 'IF', 'WHILE', 'RETURN', 'BREAK', 'CONTINUE',
  'OPEN', 'CLOSE', 'DEALLOCATE',
  // Service Broker: RECEIVE removes messages from a queue
  'RECEIVE',
  // Lock hints that take update/exclusive or serializable locks: even rolled
  // back at the end, they can block other sessions while the query runs
  'UPDLOCK', 'XLOCK', 'TABLOCKX', 'HOLDLOCK', 'SERIALIZABLE',
]);

/**
 * Words that start a dangerous statement only when followed by a specific
 * word. They are not reserved, so a bare column called SEND or ENABLE stays valid.
 */
const BLOCKED_PAIRS: Array<[string, string]> = [
  ['NEXT', 'VALUE'], // NEXT VALUE FOR seq advances a sequence and survives ROLLBACK
  ['SEND', 'ON'],
  ['MOVE', 'CONVERSATION'],
  ['GET', 'CONVERSATION'],
  ['END', 'CONVERSATION'],
  ['ENABLE', 'TRIGGER'],
  ['DISABLE', 'TRIGGER'],
  ['ADD', 'SIGNATURE'],
];

/** System procedure / extended procedure name prefixes (sp_executesql, xp_cmdshell, ...) */
const BLOCKED_PREFIXES = ['SP_', 'XP_'];

/** Words that may start a READONLY query */
const ALLOWED_START = new Set(['SELECT', 'WITH']);

function ok(queryType: string): ValidationResult {
  return { valid: true, queryType };
}

function refuse(reason: string, queryType: string): ValidationResult {
  return { valid: false, reason, queryType };
}

/**
 * "GO" alone on its line: the batch separator of sqlcmd/SSMS. It is not T-SQL,
 * this server sends one batch, and some tools split on it: refuse it.
 */
function isBatchSeparator(query: string, token: Token): boolean {
  const lineStart = Math.max(query.lastIndexOf('\n', token.start - 1), query.lastIndexOf('\r', token.start - 1)) + 1;
  if (query.slice(lineStart, token.start).trim() !== '') return false;
  const rest = query.slice(token.end).split(/[\r\n]/, 1)[0];
  // GO may be followed by a repeat count and a comment
  return /^[ \t]*(\d+)?[ \t]*(--.*)?$/.test(rest);
}

/**
 * Validate a query for READONLY mode
 *
 * @param query The SQL text exactly as it will be sent to the server
 * @returns Validation result with valid flag and optional reason
 */
export function validateQuery(query: string): ValidationResult {
  const { tokens, error } = lex(query);
  if (error) {
    return refuse(error, 'INVALID');
  }

  const invalid = tokens.find((t) => t.type === 'invalid');
  if (invalid) {
    const code = invalid.text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    return refuse(
      `Character U+${code} is not allowed outside string literals and quoted identifiers`,
      'INVALID'
    );
  }

  const sig = significant(tokens);
  if (sig.length === 0) {
    return refuse('Query is empty', 'EMPTY');
  }

  // A leading ";" (";WITH cte AS ...") is an empty statement
  let first = 0;
  while (first < sig.length && sig[first].text === ';') first++;
  if (first >= sig.length) {
    return refuse('Query is empty', 'EMPTY');
  }

  const start = sig[first];
  const startWord = start.type === 'word' ? start.text.toUpperCase() : start.text;
  if (!ALLOWED_START.has(startWord) && start.text !== '(') {
    return refuse(`Query must start with SELECT or WITH (CTE). Found: ${startWord}`, startWord);
  }

  for (let i = first; i < sig.length; i++) {
    const token = sig[i];

    // ";" may only be followed by more ";" (a trailing terminator)
    if (token.type === 'punct' && token.text === ';') {
      const following = sig.slice(i + 1).find((t) => t.text !== ';');
      if (following) {
        return refuse('Multiple statements are not allowed (found a statement after ";")', 'MULTIPLE_STATEMENTS');
      }
      continue;
    }

    if (token.type !== 'word') continue;
    const word = token.text.toUpperCase();

    if (BLOCKED_KEYWORDS.has(word)) {
      return refuse(`Keyword "${word}" is not allowed in READONLY mode`, word);
    }

    if (BLOCKED_PREFIXES.some((prefix) => word.startsWith(prefix))) {
      return refuse(
        `System and extended procedures ("${token.text}") are not allowed in READONLY mode`,
        'SYSTEM_PROCEDURE'
      );
    }

    if (word === 'GO' && isBatchSeparator(query, token)) {
      return refuse('GO (batch separator) is not allowed: send a single batch', 'BATCH_SEPARATOR');
    }

    const nextToken = sig[i + 1];
    if (nextToken && nextToken.type === 'word') {
      const nextWord = nextToken.text.toUpperCase();
      const pair = BLOCKED_PAIRS.find(([a, b]) => a === word && b === nextWord);
      if (pair) {
        return refuse(`"${pair[0]} ${pair[1]}" is not allowed in READONLY mode`, `${pair[0]} ${pair[1]}`);
      }
    }
  }

  return ok(startWord === 'WITH' ? 'CTE' : 'SELECT');
}

/**
 * Check if a query is a write operation
 */
export function isWriteOperation(query: string): boolean {
  const sig = significant(lex(query).tokens);
  const first = sig.find((t) => t.text !== ';');
  if (!first || first.type !== 'word') return false;
  return ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(first.text.toUpperCase());
}

/**
 * Get the type of SQL operation from a query
 */
export function getQueryType(query: string): string {
  const sig = significant(lex(query).tokens);
  const first = sig.find((t) => t.text !== ';');
  if (!first) return '';
  const word = first.type === 'word' ? first.text.toUpperCase() : first.text;
  return word === 'WITH' ? 'CTE' : word;
}
