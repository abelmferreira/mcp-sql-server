/**
 * Minimal T-SQL lexer used by the READONLY query validator.
 *
 * It only has to find the boundaries of the things that hide text from the
 * keyword checks: comments, string literals and quoted identifiers. Its rule
 * is "when in doubt, expose the text": whenever the server could read a
 * construct differently from this lexer, the lexer must end up looking at MORE
 * code than the server executes, never less.
 *
 *  - `-- ...` ends at the first CR, LF or other line-break character (the
 *    server may end it at "\n" only; ending earlier exposes more code, never less).
 *  - `/* ... *\/` comments NEST in T-SQL, so they are tracked with a depth
 *    counter (an unterminated comment is an error, not "the rest is a comment").
 *  - '...' strings: only a doubled quote escapes (no backslash escapes).
 *  - [bracketed identifiers]: only `]]` escapes. "double quoted" identifiers:
 *    only `""` escapes. With QUOTED_IDENTIFIER OFF the server reads "..." as a
 *    string, with the same boundaries, so both readings agree.
 *  - Anything the lexer cannot classify with certainty (control characters,
 *    non-ASCII characters that are not letters/digits, NUL) is reported as an
 *    'invalid' token so that the validator can refuse it.
 */

export type TokenType =
  | 'word' // keyword or identifier: letters, digits, _ # $ @ (not first), non-ASCII letters
  | 'bracket' // [quoted identifier]
  | 'dquote' // "quoted identifier" (or string when QUOTED_IDENTIFIER is OFF)
  | 'string' // 'string literal'
  | 'variable' // @name
  | 'sysvar' // @@name
  | 'punct' // any other single ASCII character
  | 'ws' // whitespace run (space, tab, CR, LF)
  | 'comment' // -- ... or /* ... */ (nested comments included)
  | 'invalid'; // a character that is not allowed outside literals

export interface Token {
  type: TokenType;
  /** Raw text of the token */
  text: string;
  start: number;
  end: number;
  /** variable: the name without the leading @ */
  name?: string;
}

export interface LexResult {
  tokens: Token[];
  error?: string;
}

/** Where a `--` comment ends for us: every character a server might treat as a line break */
const LINE_END = /^[\n\r\v\f\u0085\u2028\u2029]$/;
const ASCII_WORD_START = /^[A-Za-z_#]$/;
const ASCII_WORD_PART = /^[A-Za-z0-9_#$@]$/;
const UNICODE_LETTER = /^[\p{L}\p{M}\p{N}]$/u;

function isWordStart(ch: string): boolean {
  return ASCII_WORD_START.test(ch) || (ch > '\x7f' && UNICODE_LETTER.test(ch)) || /^[0-9]$/.test(ch);
}

function isWordPart(ch: string): boolean {
  return ASCII_WORD_PART.test(ch) || (ch > '\x7f' && UNICODE_LETTER.test(ch));
}

/**
 * Split a query into tokens. Never throws; problems are reported in `error`
 * (the tokens collected so far are still returned).
 */
export function lex(query: string): LexResult {
  const tokens: Token[] = [];
  const n = query.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, extra: Partial<Token> = {}) => {
    tokens.push({ type, text: query.slice(start, end), start, end, ...extra });
  };

  if (query.includes('\u0000')) {
    return { tokens, error: 'NUL characters are not allowed in the query' };
  }

  while (i < n) {
    const ch = query[i];
    const next = query[i + 1];

    // Line comment: up to (not including) the first CR or LF
    if (ch === '-' && next === '-') {
      let j = i + 2;
      while (j < n && !LINE_END.test(query[j])) j++;
      push('comment', i, j);
      i = j;
      continue;
    }

    // Block comment, nested
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (query[j] === '/' && query[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (query[j] === '*' && query[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        return { tokens, error: 'Unterminated block comment' };
      }
      push('comment', i, j);
      i = j;
      continue;
    }

    if (ch === "'") {
      const end = scanQuoted(query, i, "'");
      if (end === -1) return { tokens, error: 'Unterminated string literal' };
      push('string', i, end);
      i = end;
      continue;
    }

    if (ch === '"') {
      const end = scanQuoted(query, i, '"');
      if (end === -1) return { tokens, error: 'Unterminated quoted identifier' };
      push('dquote', i, end);
      i = end;
      continue;
    }

    if (ch === '[') {
      const end = scanQuoted(query, i, ']');
      if (end === -1) return { tokens, error: 'Unterminated bracketed identifier' };
      push('bracket', i, end);
      i = end;
      continue;
    }

    if (ch === '@') {
      if (next === '@') {
        let j = i + 2;
        while (j < n && isWordPart(query[j])) j++;
        if (j === i + 2) return { tokens, error: 'Malformed system variable reference' };
        push('sysvar', i, j);
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && isWordPart(query[j])) j++;
      if (j === i + 1) return { tokens, error: 'Malformed variable reference' };
      push('variable', i, j, { name: query.slice(i + 1, j) });
      i = j;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      let j = i + 1;
      while (j < n && (query[j] === ' ' || query[j] === '\t' || query[j] === '\n' || query[j] === '\r')) j++;
      push('ws', i, j);
      i = j;
      continue;
    }

    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordPart(query[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }

    // Other control characters, DEL, and non-ASCII characters that are not
    // letters/digits (NBSP, U+2028, zero-width characters, ...): the server's
    // idea of whitespace/identifier characters is not ours, so do not guess.
    const code = ch.charCodeAt(0);
    if (code > 0x7e || code < 0x20) {
      push('invalid', i, i + 1);
      i++;
      continue;
    }

    push('punct', i, i + 1);
    i++;
  }

  return { tokens };
}

/**
 * Scan a quoted literal starting at `start` (the opening delimiter). `close`
 * is the closing delimiter: the same as the opening one, except for
 * `[ ... ]`. A doubled closing delimiter is an escaped delimiter.
 * Returns the index just after the closing delimiter, or -1 when unterminated.
 */
function scanQuoted(query: string, start: number, close: string): number {
  const n = query.length;
  let j = start + 1;
  while (j < n) {
    if (query[j] === close) {
      if (query[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * Tokens that carry SQL meaning (no whitespace, no comments)
 */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'ws' && t.type !== 'comment');
}
