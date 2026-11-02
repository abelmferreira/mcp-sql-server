import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SshTunnel, fingerprintMatches, loadPrivateKey, normalizeFingerprint } from '../../../src/db/tunnel.js';

// Throwaway ed25519 host key and client key, generated per run (never touches disk).
const hostKey = utils.generateKeyPairSync('ed25519').private;
const clientPem = utils.generateKeyPairSync('ed25519').private;
const clientPub = utils.parseKey(clientPem);
if (clientPub instanceof Error) throw clientPub;

function fingerprintOf(pem: string): string {
  const key = utils.parseKey(pem);
  if (key instanceof Error) throw key;
  const digest = createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** Echo server standing in for the database */
function startEcho(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d.toString()}`)));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

/** Minimal SSH server: key auth + direct-tcpip forwarding only */
function startSshServer(): Promise<{
  server: Server;
  port: number;
  sessions: () => number;
  connected: () => number;
  dropAll: () => void;
}> {
  let sessions = 0;
  const clients = new Set<import('ssh2').Connection>();
  return new Promise((resolve) => {
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      sessions++;
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => {
        const allowed = clientPub.getPublicSSH();
        if (ctx.method === 'publickey' && ctx.key.data.equals(allowed)) return ctx.accept();
        return ctx.reject();
      });
      client.on('ready', () => {
        client.on('tcpip', (accept, _reject, info) => {
          const channel = accept();
          const target = net.connect(info.destPort, info.destIP);
          channel.pipe(target).pipe(channel);
          target.on('error', () => channel.close());
        });
      });
      client.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: (server.address() as net.AddressInfo).port,
        sessions: () => sessions,
        connected: () => clients.size,
        dropAll: () => clients.forEach((c) => c.end()),
      })
    );
  });
}

/** Send one message through a local port and read the reply */
function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(message));
    socket.once('data', (d) => {
      socket.destroy();
      resolve(d.toString());
    });
    socket.once('error', reject);
    socket.setTimeout(5000, () => reject(new Error('timeout')));
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('fingerprint helpers', () => {
  it('normalizes OpenSSH fingerprints', () => {
    expect(normalizeFingerprint(' SHA256:abc= ')).toBe('abc');
  });
  it('matches the hex digest from ssh2 against a SHA256:base64 fingerprint', () => {
    const hex = createHash('sha256').update('x').digest('hex');
    const b64 = createHash('sha256').update('x').digest('base64');
    expect(fingerprintMatches(hex, `SHA256:${b64}`)).toBe(true);
    expect(fingerprintMatches(hex, 'SHA256:AAAA')).toBe(false);
    // list of pinned fingerprints (one per host key algorithm)
    expect(fingerprintMatches(hex, `SHA256:AAAA, SHA256:${b64}`)).toBe(true);
    expect(fingerprintMatches(hex, '')).toBe(false);
  });
});

describe('SshTunnel', () => {
  it('rejects a host key that does not match the pinned fingerprint', async () => {
    const ssh = await startSshServer();
    cleanups.push(() => new Promise((r) => ssh.server.close(() => r())));

    const tunnel = new SshTunnel({
      host: '127.0.0.1', port: ssh.port, username: 'u', privateKey: clientPem,
      hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      dstHost: '127.0.0.1', dstPort: 1,
    });
    cleanups.push(() => tunnel.close());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(tunnel.start()).rejects.toThrow();
      // the fingerprint actually received is logged (stderr) to help pinning it
      const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('SSH host key mismatch');
      expect(logged).toContain(fingerprintOf(hostKey));
    } finally {
      spy.mockRestore();
    }
  });

  it('close() while the SSH handshake is in progress does not leak the session', async () => {
    const ssh = await startSshServer();
    cleanups.push(() => new Promise((r) => ssh.server.close(() => r())));

    const tunnel = new SshTunnel({
      host: '127.0.0.1', port: ssh.port, username: 'u', privateKey: clientPem,
      hostFingerprint: fingerprintOf(hostKey),
      dstHost: '127.0.0.1', dstPort: 1,
    });
    const starting = tunnel.start();
    await tunnel.close();
    await expect(starting).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(ssh.connected()).toBe(0);
  });

  it('forwards traffic to the destination when the host key matches', async () => {
    const echo = await startEcho();
    cleanups.push(() => new Promise((r) => echo.server.close(() => r())));
    const ssh = await startSshServer();
    cleanups.push(() => new Promise((r) => ssh.server.close(() => r())));

    const tunnel = new SshTunnel({
      host: '127.0.0.1', port: ssh.port, username: 'u', privateKey: clientPem,
      hostFingerprint: fingerprintOf(hostKey),
      dstHost: '127.0.0.1', dstPort: echo.port,
    });
    cleanups.push(() => tunnel.close());

    const localPort = await tunnel.start();
    expect(await roundTrip(localPort, 'ping')).toBe('echo:ping');
    // several connections at once, like a pool would open
    const replies = await Promise.all([1, 2, 3].map((i) => roundTrip(localPort, `m${i}`)));
    expect(replies).toEqual(['echo:m1', 'echo:m2', 'echo:m3']);
    expect(ssh.sessions()).toBe(1);
  });

  it('re-establishes the SSH session after it drops', async () => {
    const echo = await startEcho();
    cleanups.push(() => new Promise((r) => echo.server.close(() => r())));
    const ssh = await startSshServer();
    cleanups.push(() => new Promise((r) => ssh.server.close(() => r())));

    const tunnel = new SshTunnel({
      host: '127.0.0.1', port: ssh.port, username: 'u', privateKey: clientPem,
      hostFingerprint: fingerprintOf(hostKey),
      dstHost: '127.0.0.1', dstPort: echo.port,
    });
    cleanups.push(() => tunnel.close());

    const localPort = await tunnel.start();
    expect(await roundTrip(localPort, 'a')).toBe('echo:a');

    ssh.dropAll();
    await new Promise((r) => setTimeout(r, 200));

    expect(await roundTrip(localPort, 'b')).toBe('echo:b');
    expect(ssh.sessions()).toBe(2);
  });
});

describe('loadPrivateKey', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-sql-server-key-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const plain = path.join(dir, 'plain');
  const encrypted = path.join(dir, 'encrypted');
  writeFileSync(plain, clientPem);
  writeFileSync(encrypted, utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 2 }).private);

  it('reads an unencrypted key', () => {
    expect(loadPrivateKey(plain).toString()).toBe(clientPem);
  });

  it('reads an encrypted key with the right passphrase', () => {
    expect(() => loadPrivateKey(encrypted, 'pw')).not.toThrow();
  });

  it('explains that SSH_KEY_PASSPHRASE is needed for an encrypted key', () => {
    expect(() => loadPrivateKey(encrypted)).toThrow(/encrypted: set SSH_KEY_PASSPHRASE/);
  });

  it('fails clearly on a wrong passphrase or a missing file, without leaking the passphrase', () => {
    expect(() => loadPrivateKey(encrypted, 'wrong-pw-xyz')).toThrow(/cannot parse private key/);
    expect(() => loadPrivateKey(encrypted, 'wrong-pw-xyz')).not.toThrow(/wrong-pw-xyz/);
    expect(() => loadPrivateKey(path.join(dir, 'missing'))).toThrow(/cannot read private key .*ENOENT/);
  });
});
