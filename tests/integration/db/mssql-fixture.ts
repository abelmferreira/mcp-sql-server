/**
 * Fixture for the tests against a real SQL Server (see scripts/test-mssql.sh).
 *
 * The tests are skipped unless TEST_MSSQL_SERVER / TEST_MSSQL_PASSWORD point to
 * a DISPOSABLE instance (the "sa" login is used to create a database, a
 * read-only login (db_datareader) and a read-write login (db_owner)).
 */
import { randomBytes } from 'node:crypto';
import mssql from 'mssql';

export const TEST_MSSQL_SERVER = process.env.TEST_MSSQL_SERVER;
export const TEST_MSSQL_PORT = Number(process.env.TEST_MSSQL_PORT ?? '1433');
export const TEST_MSSQL_PASSWORD = process.env.TEST_MSSQL_PASSWORD;
export const mssqlEnabled = Boolean(TEST_MSSQL_SERVER && TEST_MSSQL_PASSWORD);

export const SEED_ROWS = 50;

export interface Fixture {
  database: string;
  readerUser: string;
  readerPassword: string;
  writerUser: string;
  writerPassword: string;
  monitorUser: string;
  monitorPassword: string;
  dbStateUser: string;
  dbStatePassword: string;
  admin: mssql.ConnectionPool;
  /** Rows of dbo.items as seen by the admin connection */
  count(): Promise<number>;
  teardown(): Promise<void>;
}

function password(): string {
  return `Aa1!${randomBytes(12).toString('hex')}`;
}

export function connect(user: string, pass: string, database?: string): Promise<mssql.ConnectionPool> {
  return new mssql.ConnectionPool({
    server: TEST_MSSQL_SERVER!,
    port: TEST_MSSQL_PORT,
    user,
    password: pass,
    ...(database ? { database } : {}),
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
}

export async function createFixture(): Promise<Fixture> {
  const suffix = randomBytes(4).toString('hex');
  const database = `mcp_test_${suffix}`;
  const readerUser = `mcp_reader_${suffix}`;
  const writerUser = `mcp_writer_${suffix}`;
  const readerPassword = password();
  const writerPassword = password();
  const monitorUser = `mcp_monitor_${suffix}`;
  const monitorPassword = password();
  const dbStateUser = `mcp_dbstate_${suffix}`;
  const dbStatePassword = password();

  const master = await connect('sa', TEST_MSSQL_PASSWORD!);
  await master.request().batch(`CREATE DATABASE [${database}]`);
  await master.request().batch(`CREATE LOGIN [${readerUser}] WITH PASSWORD = '${readerPassword}', CHECK_POLICY = OFF`);
  await master.request().batch(`CREATE LOGIN [${writerUser}] WITH PASSWORD = '${writerPassword}', CHECK_POLICY = OFF`);

  await master.request().batch(`CREATE LOGIN [${monitorUser}] WITH PASSWORD = '${monitorPassword}', CHECK_POLICY = OFF`);
  await master.request().batch(`CREATE LOGIN [${dbStateUser}] WITH PASSWORD = '${dbStatePassword}', CHECK_POLICY = OFF`);
  // The permissions the README recommends for the monitoring/analysis tools
  await master.request().batch(`GRANT VIEW SERVER STATE TO [${monitorUser}]`);

  const admin = await connect('sa', TEST_MSSQL_PASSWORD!, database);
  await admin.request().batch(`
    CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(50) NOT NULL, note nvarchar(max) NULL);
    CREATE USER [${readerUser}] FOR LOGIN [${readerUser}];
    ALTER ROLE db_datareader ADD MEMBER [${readerUser}];
    CREATE USER [${writerUser}] FOR LOGIN [${writerUser}];
    ALTER ROLE db_owner ADD MEMBER [${writerUser}];
    CREATE USER [${monitorUser}] FOR LOGIN [${monitorUser}];
    ALTER ROLE db_datareader ADD MEMBER [${monitorUser}];
    GRANT VIEW DATABASE STATE TO [${monitorUser}];
    GRANT VIEW DEFINITION TO [${monitorUser}];
    GRANT SHOWPLAN TO [${monitorUser}];
    CREATE USER [${dbStateUser}] FOR LOGIN [${dbStateUser}];
    ALTER ROLE db_datareader ADD MEMBER [${dbStateUser}];
    GRANT VIEW DATABASE STATE TO [${dbStateUser}];
  `);
  await admin.request().batch(`
    WITH n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < ${SEED_ROWS})
    INSERT INTO dbo.items (id, name, note) SELECT i, 'row ' + CAST(i AS nvarchar(10)), REPLICATE(N'x', 400) FROM n
  `);

  return {
    database,
    readerUser,
    readerPassword,
    writerUser,
    writerPassword,
    monitorUser,
    monitorPassword,
    dbStateUser,
    dbStatePassword,
    admin,
    async count() {
      const result = await admin.request().query('SELECT COUNT(*) AS n FROM dbo.items');
      return result.recordset[0].n as number;
    },
    async teardown() {
      await admin.close().catch(() => undefined);
      await master.request().batch(`ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`).catch(() => undefined);
      await master.request().batch(`DROP DATABASE [${database}]`).catch(() => undefined);
      await master.request().batch(`DROP LOGIN [${readerUser}]`).catch(() => undefined);
      await master.request().batch(`DROP LOGIN [${writerUser}]`).catch(() => undefined);
      await master.request().batch(`DROP LOGIN [${monitorUser}]`).catch(() => undefined);
      await master.request().batch(`DROP LOGIN [${dbStateUser}]`).catch(() => undefined);
      await master.close().catch(() => undefined);
    },
  };
}

/** Point the server configuration (read by src/config.ts) at the fixture */
export function useLogin(fixture: Fixture, role: 'reader' | 'writer' | 'monitor' | 'dbstate', extra: Record<string, string> = {}): void {
  process.env.SQL_SERVER = TEST_MSSQL_SERVER!;
  process.env.SQL_PORT = String(TEST_MSSQL_PORT);
  process.env.SQL_DATABASE = fixture.database;
  const logins = {
    reader: [fixture.readerUser, fixture.readerPassword],
    writer: [fixture.writerUser, fixture.writerPassword],
    monitor: [fixture.monitorUser, fixture.monitorPassword],
    dbstate: [fixture.dbStateUser, fixture.dbStatePassword],
  } as const;
  [process.env.SQL_USER, process.env.SQL_PASSWORD] = logins[role];
  process.env.SQL_ENCRYPT = 'true';
  process.env.SQL_TRUST_CERT = 'true';
  process.env.READONLY = 'true';
  process.env.POOL_MIN = '0';
  process.env.POOL_MAX = '1'; // same connection every time: proves no state leaks between queries
  process.env.LOG_LEVEL = 'error';
  Object.assign(process.env, extra);
}
