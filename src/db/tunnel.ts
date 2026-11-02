import net from 'node:net';
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import type { Client as SshClient } from 'ssh2';
import { logger } from '../utils/logger.js';

// ssh2 is CommonJS: use the default export, named ESM imports are not all detected
const { Client, utils: sshUtils } = ssh2;
type Client = SshClient;

/**
 * SSH tunnel settings. The destination (dstHost:dstPort) is resolved by the SSH
 * server, so it is the database address as seen from the SSH host.
 */
export interface TunnelOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
  passphrase?: string;
  /** Expected host key fingerprint, as printed by `ssh-keygen -lf` (SHA256:...) */
  hostFingerprint: string;
  dstHost: string;
  dstPort: number;
  readyTimeout?: number;
}

/**
 * Normalize an OpenSSH style fingerprint ("SHA256:abc...=") to bare base64 without padding
 */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
}

/**
 * Compare the hex SHA-256 digest given by ssh2 with the pinned fingerprint(s).
 * `expected` may be a comma separated list, since a server holds one host key per
 * algorithm (ED25519, RSA, ECDSA) and the negotiation picks one of them.
 */
export function fingerprintMatches(hexDigest: string, expected: string): boolean {
  // ssh2 hands over the SHA-256 digest as 64 hex characters; anything else is refused
  if (!/^[0-9a-f]{64}$/i.test(hexDigest)) {
    return false;
  }
  const actual = hexToFingerprint(hexDigest).slice('SHA256:'.length);
  return expected
    .split(',')
    .map((fp) => normalizeFingerprint(fp))
    // a pinned value must be a full SHA-256 in base64 (43 chars without padding)
    .filter((fp) => /^[A-Za-z0-9+/]{43}$/.test(fp))
    .some((fp) => fp === actual);
}

/**
 * OpenSSH style fingerprint ("SHA256:<base64 without padding>") of a hex SHA-256 digest
 */
export function hexToFingerprint(hexDigest: string): string {
  return `SHA256:${Buffer.from(hexDigest, 'hex').toString('base64').replace(/=+$/, '')}`;
}

/**
 * Read and parse an OpenSSH/PEM private key, failing with an actionable message
 * (wrong passphrase, encrypted key without SSH_KEY_PASSPHRASE, unsupported format).
 * Never includes the key or the passphrase in the error.
 */
export function loadPrivateKey(keyPath: string, passphrase?: string): Buffer {
  let key: Buffer;
  try {
    key = readFileSync(keyPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new Error(`SSH_KEY_PATH: cannot read private key "${keyPath}" (${code})`);
  }

  const parsed = sshUtils.parseKey(key, passphrase);
  if (parsed instanceof Error) {
    const hint = /encrypted/i.test(parsed.message) && !passphrase
      ? ' The key is encrypted: set SSH_KEY_PASSPHRASE (or use a dedicated key without passphrase).'
      : '';
    throw new Error(`SSH_KEY_PATH: cannot parse private key "${keyPath}": ${parsed.message}.${hint}`);
  }
  return key;
}

/**
 * In-process equivalent of `ssh -N -L 127.0.0.1:<random>:dstHost:dstPort`.
 *
 * The SSH session is opened on start() (so a bad key/host fails fast) and is
 * transparently re-established if it drops. Each local connection becomes one
 * forwardOut channel, so the MySQL pool can open as many connections as it needs.
 */
export class SshTunnel {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Client whose handshake is in progress (so close() can abort it) */
  private pending: Client | null = null;
  private closed = false;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: TunnelOptions) {}

  /**
   * Open the SSH session and start the local listener.
   * @returns the local port to connect to (bound on 127.0.0.1 only)
   */
  async start(): Promise<number> {
    await this.getClient();

    this.server = net.createServer((socket) => {
      void this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    // Errors after listen() (e.g. EMFILE on accept) must not crash the process
    this.server.on('error', (err) => {
      logger.error('SSH tunnel listener error', { error: err.message });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('SSH tunnel failed to bind a local port');
    }

    logger.info('SSH tunnel ready', {
      sshHost: this.options.host,
      destination: `${this.options.dstHost}:${this.options.dstPort}`,
      localPort: address.port,
    });
    return address.port;
  }

  /**
   * Close the listener, open channels and the SSH session
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pending) {
      // A handshake in progress: abort it, its promise rejects on 'close'
      this.pending.end();
      this.pending = null;
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.connecting = null;
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    try {
      const channel = await this.forward();
      channel.on('error', () => socket.destroy());
      channel.once('close', () => socket.destroy());
      socket.once('close', () => channel.destroy());
      socket.pipe(channel).pipe(socket);
    } catch (error) {
      logger.error('SSH tunnel forward failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      socket.destroy();
    }
  }

  /**
   * Open one forwarded channel, reconnecting once if the SSH session was lost
   */
  private async forward(): Promise<Duplex> {
    try {
      return await this.forwardOut(await this.getClient());
    } catch (error) {
      logger.warn('SSH forward failed, reconnecting', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.client?.end();
      this.client = null;
      return this.forwardOut(await this.getClient());
    }
  }

  private forwardOut(client: Client): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, this.options.dstHost, this.options.dstPort, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
  }

  private getClient(): Promise<Client> {
    if (this.closed) {
      return Promise.reject(new Error('SSH tunnel is closed'));
    }
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private connect(): Promise<Client> {
    const { options } = this;

    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      this.pending = client;

      client.once('ready', () => {
        settled = true;
        if (this.pending === client) this.pending = null;
        if (this.closed) {
          client.end();
          reject(new Error('SSH tunnel closed while connecting'));
          return;
        }
        this.client = client;
        logger.info('SSH session established', {
          sshHost: options.host,
          user: options.username,
        });
        resolve(client);
      });

      client.on('error', (err) => {
        logger.error('SSH session error', { error: err.message });
        if (this.pending === client) this.pending = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      client.once('close', () => {
        if (this.pending === client) this.pending = null;
        if (this.client === client) {
          this.client = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error('SSH connection closed before it was ready'));
        }
      });

      client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
        readyTimeout: options.readyTimeout ?? 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (hashedKey: string) => {
          const ok = fingerprintMatches(hashedKey, options.hostFingerprint);
          if (!ok) {
            // Host key fingerprints are public: showing the received one helps
            // pinning it (after confirming it through another channel).
            logger.error('SSH host key mismatch', {
              expected: options.hostFingerprint,
              received: /^[0-9a-f]{64}$/i.test(hashedKey) ? hexToFingerprint(hashedKey) : 'invalid digest',
            });
          }
          return ok;
        },
      });
    });
  }
}
