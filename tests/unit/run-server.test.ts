import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// runServer() with the database layer mocked and in-memory stdio streams.
const db = vi.hoisted(() => ({
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...actual, getPool: db.getPool, closePool: db.closePool };
});

const { runServer } = await import('../../src/server.js');

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => (exited = resolve));
  const exit = vi.fn((code: number) => exited(code));
  return { stdin, stdout, signals, exit, exitCode };
}

/** Next JSON-RPC message written by the server */
function nextMessage(stdout: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        stdout.off('data', onData);
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    };
    stdout.on('data', onData);
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

beforeEach(() => {
  db.getPool.mockReset().mockResolvedValue({});
  db.closePool.mockReset().mockResolvedValue(undefined);
});

describe('runServer shutdown', () => {
  it('answers initialize, then closes the pool and exits 0 when stdin ends', async () => {
    const h = harness();
    await runServer({ stdin: h.stdin, stdout: h.stdout, signals: h.signals, exit: h.exit });

    const reply = nextMessage(h.stdout);
    h.stdin.write(`${JSON.stringify(initialize)}\n`);
    expect(await reply).toMatchObject({ id: 1, result: { serverInfo: { name: expect.any(String) } } });
    expect(db.closePool).not.toHaveBeenCalled();

    h.stdin.end();

    expect(await h.exitCode).toBe(0);
    expect(db.closePool).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('shuts down once on SIGHUP even if stdin closes afterwards', async () => {
    const h = harness();
    await runServer({ stdin: h.stdin, stdout: h.stdout, signals: h.signals, exit: h.exit });

    h.signals.emit('SIGHUP');
    h.stdin.end();
    h.stdin.destroy();

    expect(await h.exitCode).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.closePool).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 after the timeout when closing the pool hangs', async () => {
    db.closePool.mockReturnValue(new Promise(() => undefined));
    const h = harness();
    await runServer({ stdin: h.stdin, stdout: h.stdout, signals: h.signals, exit: h.exit, shutdownTimeoutMs: 50 });

    h.stdin.end();

    expect(await h.exitCode).toBe(1);
  });

  it('exits 1 without listening when the first connection fails', async () => {
    db.getPool.mockRejectedValue(new Error('unreachable'));
    const h = harness();
    await runServer({ stdin: h.stdin, stdout: h.stdout, signals: h.signals, exit: h.exit });

    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.signals.eventNames()).toEqual([]);
    expect(h.stdin.listenerCount('data')).toBe(0);
  });
});
