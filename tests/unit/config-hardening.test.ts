/**
 * Hardening of the configuration: SSH fingerprint checks, SQL Server specific
 * options, secrets never echoed, server version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fingerprintMatches, hexToFingerprint } from '../../src/db/tunnel.js';
import { invalidFingerprints, parseConfig, ConfigError } from '../../src/config.js';
import { readPackageVersion } from '../../src/server.js';

const hex = '4f2a'.repeat(16);
const b64 = Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
const base = { READONLY: 'true', SQL_SERVER: 'db', SQL_DATABASE: 'd', SQL_USER: 'u', SQL_PASSWORD: 'p' };

describe('fingerprintMatches fails closed', () => {
  it.each(['', ' ', ',', ' , ', 'SHA256:', 'SHA256:=', 'MD5:ab:cd', 'SHA256:AAAA', b64.toLowerCase()])(
    'rejects %j',
    (fp) => {
      expect(fingerprintMatches(hex, fp)).toBe(false);
    }
  );

  it('accepts exact, with/without padding, any case of the prefix, in a list', () => {
    expect(fingerprintMatches(hex, `SHA256:${b64}=`)).toBe(true);
    expect(fingerprintMatches(hex, ` sha256:${b64} `)).toBe(true);
    expect(fingerprintMatches(hex, `SHA256:zzz,${b64}`)).toBe(true);
  });

  it('rejects a malformed digest from ssh2', () => {
    expect(fingerprintMatches('', '')).toBe(false);
    expect(fingerprintMatches('zz', 'SHA256:')).toBe(false);
    expect(fingerprintMatches('', `SHA256:${b64}`)).toBe(false);
  });

  it('formats the received digest for the mismatch log', () => {
    expect(hexToFingerprint(hex)).toBe(`SHA256:${b64}`);
  });
});

describe('SSH_HOST_FINGERPRINT format', () => {
  it('accepts one or more SHA256 fingerprints', () => {
    expect(invalidFingerprints(`SHA256:${b64}`)).toBeNull();
    expect(invalidFingerprints(`SHA256:${b64}=, sha256:${b64}`)).toBeNull();
  });

  it.each(['SHA256:', 'SHA256:AAAA', ' , ', 'MD5:aa:bb', b64])('rejects %j', (value) => {
    expect(invalidFingerprints(value)).not.toBeNull();
  });

  it('is enforced by parseConfig', () => {
    const env = {
      ...base,
      SSH_HOST: 'bastion.example.com',
      SSH_USER: 'tunnel',
      SSH_KEY_PATH: '/nonexistent',
      SSH_HOST_FINGERPRINT: 'SHA256:',
    };
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(/SSH_HOST_FINGERPRINT/);
  });
});

describe('SQL Server configuration', () => {
  it('has MAX_RESULT_BYTES with default and bounds', () => {
    expect(parseConfig(base).MAX_RESULT_BYTES).toBe(10485760);
    expect(parseConfig({ ...base, MAX_RESULT_BYTES: '2048' }).MAX_RESULT_BYTES).toBe(2048);
    expect(() => parseConfig({ ...base, MAX_RESULT_BYTES: '10' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, MAX_RESULT_BYTES: '999999999999' })).toThrow(ConfigError);
  });

  it('keeps encryption on and certificate trust off by default', () => {
    const cfg = parseConfig(base);
    expect(cfg.SQL_ENCRYPT).toBe(true);
    expect(cfg.SQL_TRUST_CERT).toBe(false);
    expect(cfg.SSH).toBeNull();
  });

  it('READONLY is mandatory with a clear message', () => {
    const { READONLY: _omit, ...withoutReadonly } = base;
    void _omit;
    expect(() => parseConfig(withoutReadonly)).toThrow(/READONLY is required/);
    expect(() => parseConfig({ ...base, READONLY: 'maybe' })).toThrow(/READONLY must be/);
  });

  it('refuses a named instance together with the SSH tunnel (SQL Browser uses UDP)', () => {
    const env = {
      ...base,
      SQL_INSTANCE: 'totvs',
      SSH_HOST: 'bastion.example.com',
      SSH_USER: 'tunnel',
      SSH_KEY_PATH: '/nonexistent',
      SSH_HOST_FINGERPRINT: `SHA256:${b64}`,
    };
    expect(() => parseConfig(env)).toThrow(/SQL_INSTANCE.*SSH_HOST/s);
    expect(() =>
      parseConfig({
        ...env,
        SQL_INSTANCE: undefined,
        SQL_CONNECTION_URL: 'sqlserver://u:p@db/app?instanceName=totvs',
      })
    ).toThrow(/cannot be combined with SSH_HOST/);
  });

  it('allows a named instance without SSH', () => {
    expect(parseConfig({ ...base, SQL_INSTANCE: 'totvs' }).SQL_INSTANCE).toBe('totvs');
  });

  it('never echoes passwords from the URL in any error', () => {
    for (const url of ['sqlserver://u:s3cr3t@[bad/app', 'sqlserver://u:s3cr3t@host:99999/app', 'sqlserver://u:s3cr3t@host/']) {
      try {
        parseConfig({ READONLY: 'true', SQL_CONNECTION_URL: url });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain('s3cr3t');
      }
    }
  });

  it('reports bad percent-encoding without echoing it', () => {
    try {
      parseConfig({ READONLY: 'true', SQL_CONNECTION_URL: 'sqlserver://u:s3%ZZcr3t@host/app' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('s3%ZZcr3t');
    }
  });
});

describe('server version', () => {
  it('comes from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(readPackageVersion()).toBe(pkg.version);
    expect(readPackageVersion()).not.toBe('0.0.0');
  });
});
