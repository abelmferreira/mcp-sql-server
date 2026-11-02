import { describe, it, expect } from 'vitest';
import { validateQuery } from '../../../src/validators/query-validator.js';
import { lex } from '../../../src/validators/sql-lexer.js';

/**
 * Adversarial cases for the READONLY validator. In T-SQL the ";" is optional,
 * so statements can follow each other with nothing in between, and
 * comments/strings/quoted identifiers are what attackers hide behind.
 */

const refused = (query: string) => expect(validateQuery(query).valid, query).toBe(false);
const accepted = (query: string) => expect(validateQuery(query).valid, query).toBe(true);

describe('stacked statements', () => {
  it('refuses a second statement without a semicolon', () => {
    refused('SELECT 1 DELETE FROM t');
    refused('SELECT 1\nDELETE FROM t');
    refused('SELECT * FROM t WHERE a = 1 UPDATE t SET a = 2');
    refused('SELECT 1 INSERT t VALUES (1)');
    refused('SELECT 1 DROP TABLE t');
    refused('WITH c AS (SELECT 1 AS a) DELETE FROM c');
    refused('WITH c AS (SELECT 1 AS a) UPDATE c SET a = 2');
  });

  it('refuses anything after a semicolon', () => {
    refused('SELECT 1; SELECT 2');
    refused('SELECT 1;DELETE FROM t');
    refused('SELECT 1 ; -- c\n DELETE FROM t');
    refused('SELECT 1;;DROP TABLE t');
  });

  it('accepts trailing and leading semicolons', () => {
    accepted('SELECT 1;');
    accepted('SELECT 1;  ;  ');
    accepted('SELECT 1; -- done');
    accepted(';WITH c AS (SELECT 1 AS a) SELECT a FROM c');
  });

  it('refuses statements that follow without a keyword the old regex knew', () => {
    refused('SELECT 1 WAITFOR DELAY \'00:00:30\'');
    refused('SELECT 1 DECLARE @x int');
    refused('SELECT 1 SET NOCOUNT ON');
    refused('SELECT 1 USE master');
    refused('SELECT 1 BEGIN TRAN');
    refused('SELECT 1 COMMIT');
    refused('SELECT 1 ROLLBACK');
    refused('SELECT 1 PRINT 1');
    refused('SELECT 1 RAISERROR (\'x\', 16, 1)');
    refused('SELECT 1 IF 1 = 1 SELECT 2');
    refused('SELECT 1 WHILE 1 = 1 SELECT 2');
    refused('SELECT 1 GOTO a');
    refused('SELECT 1 CHECKPOINT');
    refused('SELECT 1 RECONFIGURE');
    refused('SELECT 1 SHUTDOWN');
    refused('SELECT 1 KILL 55');
    refused('SELECT 1 DBCC FREEPROCCACHE');
    refused('SELECT 1 BACKUP DATABASE x TO DISK = \'y\'');
    refused('SELECT 1 RESTORE DATABASE x FROM DISK = \'y\'');
    refused('SELECT 1 GRANT SELECT ON t TO u');
    refused('SELECT 1 REVOKE SELECT ON t FROM u');
    refused('SELECT 1 DENY SELECT ON t TO u');
    refused('SELECT 1 TRUNCATE TABLE t');
    refused('SELECT 1 MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE;');
    refused('SELECT 1 CREATE TABLE t (a int)');
    refused('SELECT 1 ALTER TABLE t ADD b int');
    refused('SELECT 1 OPEN c');
    refused('SELECT 1 REVERT');
    refused('SELECT 1 SETUSER \'x\'');
  });

  it('refuses Service Broker and trigger statements that are not reserved words', () => {
    refused('SELECT 1 RECEIVE * FROM q');
    refused('SELECT 1 SEND ON CONVERSATION @h MESSAGE TYPE m');
    refused('SELECT 1 MOVE CONVERSATION @h TO @g');
    refused('SELECT 1 GET CONVERSATION GROUP @g FROM q');
    refused('SELECT 1 END CONVERSATION @h');
    refused('SELECT 1 ENABLE TRIGGER t ON db');
    refused('SELECT 1 DISABLE TRIGGER t ON db');
  });

  it('keeps those non-reserved words usable as column names', () => {
    accepted('SELECT send, receive_x, enable, [disable], move FROM t');
    accepted('SELECT t.enable FROM t');
  });
});

describe('what comments, strings and quoted identifiers hide', () => {
  it('does not take a string for a comment (the real PostgreSQL bypass)', () => {
    refused("SELECT '--'; DELETE FROM t");
    refused("SELECT '--' DELETE FROM t");
    refused("SELECT '/*' DELETE FROM t");
    refused("SELECT '''--' DELETE FROM t");
  });

  it('does not take a quoted identifier for a comment', () => {
    refused('SELECT [--] DELETE FROM t');
    refused('SELECT "--" DELETE FROM t');
    refused('SELECT [a]]--] DELETE FROM t');
  });

  it('sees code after a line comment that ends in CR or LF', () => {
    refused('SELECT 1 -- x\nDELETE FROM t');
    refused('SELECT 1 -- x\rDELETE FROM t');
    refused('SELECT 1 -- x\r\nDELETE FROM t');
  });

  it('follows nested block comments', () => {
    refused('SELECT 1 /* a /* b */ */ DELETE FROM t');
    // the DELETE is inside the (nested) comment: not code
    accepted('SELECT 1 /* a /* b */ DELETE FROM t */');
    refused('SELECT 1 /* unterminated DELETE FROM t');
    refused('SELECT 1 /* a /* b */ DELETE FROM t');
  });

  it('does not let a keyword hide in a comment-looking operator sequence', () => {
    refused('SELECT 1 /**/ DELETE FROM t');
    refused('SELECT 1/**/DELETE FROM t');
    refused('SELECT 5--3\nDELETE FROM t');
  });

  it('accepts keywords inside strings, comments and quoted identifiers', () => {
    accepted("SELECT 'DELETE FROM t; DROP TABLE t' AS s");
    accepted("SELECT N'EXEC xp_cmdshell' AS s");
    accepted('SELECT 1 -- DELETE FROM t');
    accepted('SELECT 1 /* DROP TABLE t */');
    accepted('SELECT [delete], [update], "drop" FROM [exec]');
    accepted('SELECT [a]]b] FROM t');
    accepted("SELECT 'it''s; DELETE' AS s");
  });

  it('refuses unterminated literals', () => {
    refused("SELECT 'abc");
    refused('SELECT [abc');
    refused('SELECT "abc');
  });
});

describe('characters the server may read differently', () => {
  it('refuses NUL and control characters', () => {
    refused('SELECT 1\u0000 DELETE FROM t');
    refused('SELECT\u00011 DELETE FROM t');
    refused('SELECT 1\u000b DELETE FROM t');
    refused('SELECT 1\u000c DELETE FROM t');
    refused('SELECT 1\u007f DELETE FROM t');
  });

  it('refuses unicode spaces and separators outside literals', () => {
    refused('SELECT 1\u00a0DELETE FROM t');
    refused('SELECT 1\u2028DELETE FROM t');
    refused('SELECT 1\u200bDELETE FROM t');
    refused('SELECT 1\ufeffDELETE FROM t');
    refused('SELECT 1 --\u2028DELETE FROM t');
  });

  it('accepts non-ASCII letters in identifiers and any text in literals', () => {
    accepted('SELECT descrição, ação FROM tabela');
    accepted("SELECT 'a\u00a0b\u2028c' AS s");
    accepted('SELECT [a\u00a0b] FROM t');
  });
});

describe('execution and external access', () => {
  it('refuses EXEC and friends in every form', () => {
    refused("EXEC xp_cmdshell 'dir'");
    refused("exec('DELETE FROM t')");
    refused('EXECUTE sp_who');
    refused("SELECT 1 EXEC('DELETE FROM t')");
    refused("SELECT 1 eXeC sp_executesql N'x'");
  });

  it('refuses system and extended procedure names', () => {
    refused('SELECT sp_who FROM t');
    refused('SELECT xp_cmdshell FROM t');
    refused('SELECT * FROM sp_helpdb');
    accepted('SELECT [sp_name] FROM t');
  });

  it('refuses ad hoc and external data sources', () => {
    refused("SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;Trusted_Connection=yes;', 'SELECT 1')");
    refused("SELECT * FROM OPENROWSET(BULK 'C:\\f.txt', SINGLE_CLOB) AS x");
    refused("SELECT * FROM OPENQUERY(srv, 'SELECT 1')");
    refused("SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=x').db.dbo.t");
    refused("SELECT 1 BULK INSERT t FROM 'f'");
  });

  it('refuses INTO in all its forms', () => {
    refused('SELECT * INTO #t FROM u');
    refused('SELECT * INTO dbo.t FROM u');
    refused('SELECT * INTO ##t FROM u');
    refused('SELECT * INTO @tv FROM u');
    refused('SELECT 1 AS a INTO t');
    refused('select\n*\ninto\nt\nfrom u');
    refused("COPY INTO t FROM 'x'");
  });

  it('refuses side effects that survive ROLLBACK', () => {
    refused('SELECT NEXT VALUE FOR dbo.seq');
    refused('SELECT next   value for dbo.seq');
    accepted('SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY');
  });

  it('refuses lock hints that take update/exclusive locks', () => {
    refused('SELECT * FROM t WITH (UPDLOCK)');
    refused('SELECT * FROM t WITH (XLOCK, ROWLOCK)');
    refused('SELECT * FROM t WITH (TABLOCKX)');
    refused('SELECT * FROM t WITH (HOLDLOCK)');
    accepted('SELECT * FROM t WITH (NOLOCK)');
  });
});

describe('GO and statement start', () => {
  it('refuses GO alone on a line', () => {
    refused('SELECT 1\nGO\nSELECT 2');
    refused('SELECT 1\nGO 5');
    refused('SELECT 1\n  go  \n');
  });

  it('accepts go as an alias', () => {
    accepted('SELECT 1 AS go');
    accepted('SELECT 1 go');
  });

  it('only SELECT, WITH or an opening parenthesis can start a query', () => {
    refused('EXEC sp_who');
    refused('INSERT INTO t VALUES (1)');
    refused('DECLARE @a int = 1 SELECT @a');
    refused('SET NOCOUNT ON');
    refused('/* x */ DELETE FROM t');
    refused('-- x\nDELETE FROM t');
    refused('');
    refused('   ');
    refused('-- only a comment');
    accepted('/* x */ SELECT 1');
    accepted('-- x\nSELECT 1');
    accepted('(SELECT 1) UNION (SELECT 2)');
  });
});

describe('legitimate queries keep working', () => {
  const queries = [
    'SELECT TOP 10 * FROM dbo.Orders o WITH (NOLOCK) WHERE o.Total > @min ORDER BY o.Id DESC',
    'SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1 OPTION (RECOMPILE)',
    'WITH c AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM c WHERE n < 10) SELECT n FROM c OPTION (MAXRECURSION 0)',
    'SELECT * FROM a CROSS APPLY sys.dm_exec_sql_text(a.sql_handle) st',
    "SELECT CAST('2024-01-01' AS date), DATEADD(day, 1, GETDATE()), IIF(1 = 1, 'a', 'b')",
    'SELECT * FROM t FOR JSON PATH',
    'SELECT * FROM t FOR XML RAW',
    'SELECT @@VERSION, @@SERVERNAME, @@TRANCOUNT',
    'SELECT * FROM #temp',
    "SELECT * FROM t WHERE name LIKE N'%x%' AND d >= '20240101'",
    'SELECT * FROM (VALUES (1), (2)) AS v(n)',
    'SELECT * FROM t PIVOT (SUM(x) FOR y IN ([a], [b])) AS p',
    'SELECT CASE WHEN a = 1 THEN 1 ELSE 0 END FROM t',
    'SELECT * FROM t1 UNION ALL SELECT * FROM t2 EXCEPT SELECT * FROM t3',
    'SELECT updated_at, created_by, deleted FROM t',
  ];
  for (const query of queries) {
    it(query.slice(0, 70), () => accepted(query));
  }
});

describe('lexer', () => {
  it('tokenizes nested comments, brackets and doubled quotes as single tokens', () => {
    const { tokens, error } = lex("SELECT [a]]b], 'it''s', \"q\"\"x\" /* a /* b */ c */ -- tail");
    expect(error).toBeUndefined();
    expect(tokens.map((t) => t.type).filter((t) => t !== 'ws')).toEqual([
      'word', 'bracket', 'punct', 'string', 'punct', 'dquote', 'comment', 'comment',
    ]);
  });

  it('reports unterminated constructs', () => {
    expect(lex('SELECT /* a').error).toMatch(/block comment/);
    expect(lex("SELECT 'a").error).toMatch(/string/);
    expect(lex('SELECT [a').error).toMatch(/bracketed/);
  });
});
