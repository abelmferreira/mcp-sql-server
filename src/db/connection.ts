import sql from 'mssql';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConnectionError, getErrorMessage } from '../utils/errors.js';
import { SshTunnel, loadPrivateKey } from './tunnel.js';

/**
 * Singleton connection pool (and the SSH tunnel it goes through, when enabled)
 */
let pool: sql.ConnectionPool | null = null;
let poolPromise: Promise<sql.ConnectionPool> | null = null;
let tunnel: SshTunnel | null = null;

/**
 * Build the mssql/tedious configuration for a given host/port (the local
 * tunnel end when SSH is enabled).
 *
 * TLS and the SSH tunnel
 * ----------------------
 * SQL Server presents a certificate issued for its own name. Through the
 * tunnel the driver connects to 127.0.0.1, so by default tedious would check
 * the certificate against "127.0.0.1" and always fail. Instead, when going
 * through the tunnel we set `options.serverName` to the ORIGINAL SQL_SERVER:
 * tedious passes it to `tls.connect({ servername })`, which Node uses both for
 * SNI and for the certificate identity check. So:
 *
 *  - SQL_ENCRYPT=true, SQL_TRUST_CERT=false: the chain AND the name of the
 *    certificate are verified against SQL_SERVER, exactly like a direct
 *    connection. If SQL_SERVER is an IP address the certificate needs a
 *    matching IP SAN (Node sends no SNI for an IP and prints a one-time
 *    DEP0123 warning on stderr, which is harmless).
 *  - SQL_TRUST_CERT=true: the certificate is NOT verified at all (a typical
 *    self-signed SQL Server certificate needs this). The SSH tunnel still
 *    protects the path, but a warning is logged.
 *  - SQL_ENCRYPT=false: no TLS; the traffic is only protected by the SSH tunnel.
 *
 * Named instances (SQL_INSTANCE) are resolved by SQL Browser over UDP and are
 * refused together with SSH_HOST in the configuration.
 */
export function buildSqlConfig(endpoint?: { host: string; port: number }): sql.config {
  const viaTunnel = endpoint !== undefined;

  if (config.SQL_ENCRYPT && config.SQL_TRUST_CERT) {
    logger.warn(
      'SQL_TRUST_CERT=true: the database certificate is NOT verified; the connection is open to man-in-the-middle attacks'
    );
  }

  return {
    user: config.SQL_USER,
    password: config.SQL_PASSWORD,
    server: endpoint ? endpoint.host : config.SQL_SERVER,
    database: config.SQL_DATABASE,
    // port and instanceName are mutually exclusive in tedious.
    // When a named instance is provided, the port is resolved by SQL Browser (UDP 1434).
    ...(config.SQL_INSTANCE ? {} : { port: endpoint ? endpoint.port : config.SQL_PORT }),
    options: {
      encrypt: config.SQL_ENCRYPT,
      trustServerCertificate: config.SQL_TRUST_CERT,
      enableArithAbort: true,
      ...(config.SQL_INSTANCE ? { instanceName: config.SQL_INSTANCE } : {}),
      // Certificate name / SNI = the original server name, not the tunnel's 127.0.0.1
      ...(viaTunnel && config.SQL_ENCRYPT ? { serverName: config.SQL_SERVER } : {}),
    },
    pool: {
      min: config.POOL_MIN,
      max: config.POOL_MAX,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: config.QUERY_TIMEOUT,
  };
}

/**
 * Open the SSH tunnel when configured. Returns the host/port the pool must connect to,
 * or undefined for a direct connection.
 */
async function openTunnel(): Promise<{ host: string; port: number } | undefined> {
  if (!config.SSH) {
    return undefined;
  }

  tunnel = new SshTunnel({
    host: config.SSH.host,
    port: config.SSH.port,
    username: config.SSH.user,
    privateKey: loadPrivateKey(config.SSH.keyPath, config.SSH.keyPassphrase),
    passphrase: config.SSH.keyPassphrase,
    hostFingerprint: config.SSH.hostFingerprint,
    dstHost: config.SQL_SERVER,
    dstPort: config.SQL_PORT,
  });

  const localPort = await tunnel.start();
  return { host: '127.0.0.1', port: localPort };
}

async function closeTunnel(): Promise<void> {
  if (tunnel) {
    const current = tunnel;
    tunnel = null;
    await current.close().catch(() => undefined);
  }
}

async function createPool(): Promise<sql.ConnectionPool> {
  try {
    logger.info('Connecting to SQL Server', {
      server: config.SQL_SERVER,
      database: config.SQL_DATABASE,
      ...(config.SQL_INSTANCE ? { instanceName: config.SQL_INSTANCE } : { port: config.SQL_PORT }),
      viaSshTunnel: config.SSH !== null,
    });

    const endpoint = await openTunnel();
    const created = await sql.connect(buildSqlConfig(endpoint));

    logger.info('Connected to SQL Server successfully');

    // Handle pool errors
    created.on('error', (err) => {
      logger.error('Connection pool error', { error: err.message });
    });

    pool = created;
    return created;
  } catch (error) {
    // Do not leave a half-open tunnel behind; the next call starts from scratch
    await closeTunnel();
    const message = getErrorMessage(error);
    logger.error('Failed to connect to SQL Server', { error: message });
    throw new ConnectionError(`Failed to connect to SQL Server: ${message}`);
  }
}

/**
 * Get the connection pool (creates if not exists)
 */
export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) {
    return pool;
  }
  if (!poolPromise) {
    // A stale (disconnected) pool and its tunnel are replaced
    poolPromise = (async () => {
      if (pool) {
        await closePool();
      }
      return createPool();
    })().finally(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}

/**
 * Close the connection pool and the SSH tunnel
 */
export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    try {
      await current.close();
      logger.info('Connection pool closed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error closing connection pool', { error: message });
    }
  }

  await closeTunnel();
}

/**
 * Check if the pool is connected
 */
export function isConnected(): boolean {
  return pool?.connected ?? false;
}

/**
 * Get pool statistics
 */
export function getPoolStats(): { min: number; max: number; connected: boolean } {
  return {
    min: config.POOL_MIN,
    max: config.POOL_MAX,
    connected: pool?.connected ?? false,
  };
}

// Re-export sql for type usage
export { sql };
