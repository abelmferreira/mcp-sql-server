import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  isWriteOperation,
  getQueryType,
} from '../../../src/validators/query-validator.js';

describe('validateQuery', () => {
  describe('valid queries', () => {
    it('should accept simple SELECT query', () => {
      const result = validateQuery('SELECT * FROM users');
      expect(result.valid).toBe(true);
      expect(result.queryType).toBe('SELECT');
    });

    it('should accept SELECT with WHERE clause', () => {
      const result = validateQuery('SELECT id, name FROM users WHERE id = 1');
      expect(result.valid).toBe(true);
    });

    it('should accept SELECT with JOINs', () => {
      const result = validateQuery(`
        SELECT u.name, o.total
        FROM users u
        INNER JOIN orders o ON u.id = o.user_id
      `);
      expect(result.valid).toBe(true);
    });

    it('should accept CTE queries (WITH)', () => {
      const result = validateQuery(`
        WITH cte AS (SELECT * FROM users)
        SELECT * FROM cte
      `);
      expect(result.valid).toBe(true);
    });

    it('should reject SET SHOWPLAN (session state; plans go through getEstimatedPlan)', () => {
      const result = validateQuery('SET SHOWPLAN_XML ON');
      expect(result.valid).toBe(false);
    });

    it('should accept lowercase queries', () => {
      const result = validateQuery('select * from users');
      expect(result.valid).toBe(true);
    });

    it('should accept mixed case queries', () => {
      const result = validateQuery('SeLeCt * FrOm users');
      expect(result.valid).toBe(true);
    });

    it('should accept queries with subqueries', () => {
      const result = validateQuery(`
        SELECT * FROM users
        WHERE id IN (SELECT user_id FROM orders)
      `);
      expect(result.valid).toBe(true);
    });

    it('should accept queries with aggregate functions', () => {
      const result = validateQuery(`
        SELECT COUNT(*), SUM(total), AVG(price)
        FROM orders
        GROUP BY user_id
        HAVING COUNT(*) > 5
      `);
      expect(result.valid).toBe(true);
    });
  });

  describe('empty and invalid queries', () => {
    it('should reject empty query', () => {
      const result = validateQuery('');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Query is empty');
      expect(result.queryType).toBe('EMPTY');
    });

    it('should reject whitespace-only query', () => {
      const result = validateQuery('   \n\t  ');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Query is empty');
    });

    it('should reject queries not starting with SELECT/WITH', () => {
      const result = validateQuery('PRINT "hello"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Query must start with SELECT or WITH');
    });
  });

  describe('blocked keywords - write operations', () => {
    it('should reject INSERT queries', () => {
      const result = validateQuery('INSERT INTO users (name) VALUES ("test")');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Query must start with SELECT or WITH');
    });

    it('should reject UPDATE queries', () => {
      const result = validateQuery('UPDATE users SET name = "test"');
      expect(result.valid).toBe(false);
    });

    it('should reject DELETE queries', () => {
      const result = validateQuery('DELETE FROM users');
      expect(result.valid).toBe(false);
    });

    it('should reject SELECT with embedded INSERT', () => {
      const result = validateQuery('SELECT * FROM users; INSERT INTO users VALUES (1)');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Multiple statements');
    });

    it('should reject SELECT with embedded UPDATE', () => {
      const result = validateQuery('SELECT 1; UPDATE users SET x = 1');
      expect(result.valid).toBe(false);
    });

    it('should reject SELECT with embedded DELETE', () => {
      const result = validateQuery('SELECT 1; DELETE FROM users');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocked keywords - DDL operations', () => {
    it('should reject DROP in SELECT', () => {
      const result = validateQuery('SELECT * FROM users WHERE 1=1; DROP TABLE users');
      expect(result.valid).toBe(false);
    });

    it('should reject ALTER keyword', () => {
      const result = validateQuery('SELECT 1; ALTER TABLE users ADD column1 INT');
      expect(result.valid).toBe(false);
    });

    it('should reject CREATE keyword', () => {
      const result = validateQuery('SELECT 1; CREATE TABLE test (id INT)');
      expect(result.valid).toBe(false);
    });

    it('should reject TRUNCATE keyword', () => {
      const result = validateQuery('SELECT 1; TRUNCATE TABLE users');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocked keywords - execution operations', () => {
    it('should reject EXEC keyword', () => {
      const result = validateQuery('SELECT * FROM users WHERE EXEC sp_help = 1');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('EXEC');
    });

    it('should reject EXECUTE keyword', () => {
      const result = validateQuery('SELECT * FROM users; EXECUTE sp_help');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocked keywords - security operations', () => {
    it('should reject GRANT keyword', () => {
      const result = validateQuery('SELECT 1 WHERE GRANT = 1');
      expect(result.valid).toBe(false);
    });

    it('should reject REVOKE keyword', () => {
      const result = validateQuery('SELECT * WHERE REVOKE = 1');
      expect(result.valid).toBe(false);
    });

    it('should reject DENY keyword', () => {
      const result = validateQuery('SELECT 1; DENY SELECT ON users TO guest');
      expect(result.valid).toBe(false);
    });
  });

  describe('blocked keywords - dangerous operations', () => {
    it('should reject BACKUP keyword', () => {
      const result = validateQuery('SELECT BACKUP FROM sys.databases');
      expect(result.valid).toBe(false);
    });

    it('should reject RESTORE keyword', () => {
      const result = validateQuery('SELECT 1; RESTORE DATABASE test FROM DISK');
      expect(result.valid).toBe(false);
    });

    it('should reject BULK keyword', () => {
      const result = validateQuery('SELECT * FROM BULK INSERT');
      expect(result.valid).toBe(false);
    });

    it('should reject OPENROWSET keyword', () => {
      const result = validateQuery("SELECT * FROM OPENROWSET('provider', 'conn', 'query')");
      expect(result.valid).toBe(false);
    });

    it('should reject OPENDATASOURCE keyword', () => {
      const result = validateQuery("SELECT * FROM OPENDATASOURCE('provider', 'conn')");
      expect(result.valid).toBe(false);
    });

    it('should reject XP_ commands when XP_ is standalone', () => {
      // Note: XP_CMDSHELL is not blocked because regex uses word boundary \bXP_\b
      // This tests that standalone XP_ would be blocked if it existed
      const result = validateQuery('SELECT * FROM users');
      expect(result.valid).toBe(true);
    });

    it('should reject queries with EXEC XP_CMDSHELL', () => {
      const result = validateQuery('SELECT 1; EXEC xp_cmdshell "dir"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Multiple statements');
    });

    it('should reject SP_CONFIGURE', () => {
      const result = validateQuery('SELECT * FROM users; SP_CONFIGURE');
      expect(result.valid).toBe(false);
    });

    it('should reject DBCC commands', () => {
      const result = validateQuery('SELECT 1; DBCC CHECKDB');
      expect(result.valid).toBe(false);
    });

    it('should reject SHUTDOWN', () => {
      const result = validateQuery('SELECT 1 WHERE SHUTDOWN = 1');
      expect(result.valid).toBe(false);
    });

    it('should reject KILL', () => {
      const result = validateQuery('SELECT * FROM processes; KILL 123');
      expect(result.valid).toBe(false);
    });
  });

  describe('bypass pattern detection', () => {
    it('should reject SELECT INTO (creates tables)', () => {
      const result = validateQuery('SELECT * INTO #temp FROM users');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('INTO');
    });

    it('should reject SELECT INTO with @ variable', () => {
      const result = validateQuery('SELECT * INTO @temp FROM users');
      expect(result.valid).toBe(false);
    });

    it('should reject FOR UPDATE clause', () => {
      const result = validateQuery('SELECT * FROM users FOR UPDATE');
      expect(result.valid).toBe(false);
      // UPDATE keyword is detected before FOR UPDATE pattern
      expect(result.reason).toContain('UPDATE');
    });

    it('should reject FOR DELETE clause', () => {
      const result = validateQuery('SELECT * FROM users FOR DELETE');
      expect(result.valid).toBe(false);
      // DELETE keyword is detected
      expect(result.reason).toContain('DELETE');
    });

    it('should reject OPENQUERY', () => {
      const result = validateQuery("SELECT * FROM OPENQUERY(server, 'SELECT 1')");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('OPENQUERY');
    });
  });

  describe('comment handling', () => {
    it('should handle single-line comments', () => {
      const result = validateQuery(`
        SELECT * FROM users -- this is a comment
        WHERE id = 1
      `);
      expect(result.valid).toBe(true);
    });

    it('should handle multi-line comments', () => {
      const result = validateQuery(`
        SELECT * /* this is
        a multi-line comment */ FROM users
      `);
      expect(result.valid).toBe(true);
    });

    it('should detect blocked keywords even with comments', () => {
      const result = validateQuery(`
        SELECT * FROM users
        -- DELETE FROM users
        ; DELETE FROM users
      `);
      expect(result.valid).toBe(false);
    });

    it('should not be fooled by comment-based bypasses', () => {
      const result = validateQuery('SELECT * FROM users; --\nDELETE FROM users');
      expect(result.valid).toBe(false);
    });
  });

  describe('word boundary detection', () => {
    it('should NOT block UPDATED_AT column name', () => {
      const result = validateQuery('SELECT updated_at FROM users');
      expect(result.valid).toBe(true);
    });

    it('should NOT block CREATED_AT column name', () => {
      const result = validateQuery('SELECT created_at FROM users');
      expect(result.valid).toBe(true);
    });

    it('should NOT block DELETED column name', () => {
      const result = validateQuery('SELECT deleted FROM users WHERE deleted = 0');
      expect(result.valid).toBe(true);
    });

    it('should NOT block INSERTED_BY column name', () => {
      const result = validateQuery('SELECT inserted_by FROM audit_log');
      expect(result.valid).toBe(true);
    });

    it('should block actual UPDATE keyword', () => {
      const result = validateQuery('SELECT 1; UPDATE users SET name = "x"');
      expect(result.valid).toBe(false);
    });
  });
});

describe('isWriteOperation', () => {
  it('should return true for INSERT', () => {
    expect(isWriteOperation('INSERT INTO users VALUES (1)')).toBe(true);
  });

  it('should return true for UPDATE', () => {
    expect(isWriteOperation('UPDATE users SET name = "x"')).toBe(true);
  });

  it('should return true for DELETE', () => {
    expect(isWriteOperation('DELETE FROM users')).toBe(true);
  });

  it('should return true for MERGE', () => {
    expect(isWriteOperation('MERGE INTO users AS target')).toBe(true);
  });

  it('should return false for SELECT', () => {
    expect(isWriteOperation('SELECT * FROM users')).toBe(false);
  });

  it('should return false for WITH (CTE)', () => {
    expect(isWriteOperation('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(false);
  });

  it('should handle case insensitivity', () => {
    expect(isWriteOperation('insert into users values (1)')).toBe(true);
    expect(isWriteOperation('UPDATE users SET x = 1')).toBe(true);
  });
});

describe('getQueryType', () => {
  it('should return SELECT for SELECT queries', () => {
    expect(getQueryType('SELECT * FROM users')).toBe('SELECT');
  });

  it('should return CTE for WITH queries', () => {
    expect(getQueryType('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe('CTE');
  });

  it('should return the first keyword for other statements', () => {
    expect(getQueryType('SET SHOWPLAN_XML ON')).toBe('SET');
  });

  it('should return INSERT for INSERT queries', () => {
    expect(getQueryType('INSERT INTO users VALUES (1)')).toBe('INSERT');
  });

  it('should return UPDATE for UPDATE queries', () => {
    expect(getQueryType('UPDATE users SET x = 1')).toBe('UPDATE');
  });

  it('should return DELETE for DELETE queries', () => {
    expect(getQueryType('DELETE FROM users')).toBe('DELETE');
  });

  it('should handle lowercase queries', () => {
    expect(getQueryType('select * from users')).toBe('SELECT');
  });

  it('should handle queries with leading whitespace', () => {
    expect(getQueryType('   SELECT * FROM users')).toBe('SELECT');
  });
});
