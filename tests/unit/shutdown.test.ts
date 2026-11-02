import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createShutdown, installShutdownTriggers, DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../../src/shutdown.js';

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdown', () => {
  it('closes the pool and exits with code 0', async () => {
    const closePool = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({ closePool, exit, logger: silentLogger() });

    await shutdown('SIGTERM');

    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('calls exit only after closePool has finished', async () => {
    const order: string[] = [];
    const closePool = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('closed');
    });
    const exit = vi.fn(() => order.push('exit'));
    await createShutdown({ closePool, exit, logger: silentLogger() })('stdin closed');
    expect(order).toEqual(['closed', 'exit']);
  });

  it('is idempotent: concurrent and later calls run it once', async () => {
    let release!: () => void;
    const closePool = vi.fn(() => new Promise<void>((r) => (release = r)));
    const exit = vi.fn();
    const shutdown = createShutdown({ closePool, exit, logger: silentLogger() });

    const first = shutdown('stdin closed');
    const second = shutdown('SIGINT');
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    await shutdown('SIGHUP');

    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 after the timeout when closePool hangs', async () => {
    vi.useFakeTimers();
    const closePool = vi.fn(() => new Promise<void>(() => undefined)); // never settles
    const exit = vi.fn();
    const logger = silentLogger();
    const done = createShutdown({ closePool, exit, logger, timeoutMs: 5000 })('stdin closed');

    await vi.advanceTimersByTimeAsync(4999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'), { timeoutMs: 5000 });
  });

  it('uses a 5 s default timeout', async () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    const exit = vi.fn();
    const done = createShutdown({ closePool: () => new Promise(() => undefined), exit, logger: silentLogger() })('x');
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('clears the safety timer when closing finishes in time', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    await createShutdown({ closePool: async () => undefined, exit, logger: silentLogger() })('x');
    expect(vi.getTimerCount()).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with code 1 when closePool rejects', async () => {
    const exit = vi.fn();
    const logger = silentLogger();
    await createShutdown({ closePool: () => Promise.reject(new Error('boom')), exit, logger })('x');
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith('Error during shutdown', { error: 'boom' });
  });
});

describe('installShutdownTriggers', () => {
  function setup() {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const signals = new EventEmitter();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const uninstall = installShutdownTriggers(shutdown, { stdin, stdout, signals });
    return { stdin, stdout, signals, shutdown, uninstall };
  }

  it.each([
    ['stdin end', (t: ReturnType<typeof setup>) => t.stdin.emit('end'), 'stdin closed'],
    ['stdin close', (t: ReturnType<typeof setup>) => t.stdin.emit('close'), 'stdin closed'],
    ['stdout error', (t: ReturnType<typeof setup>) => t.stdout.emit('error', new Error('EPIPE')), 'stdout error'],
    ['SIGINT', (t: ReturnType<typeof setup>) => t.signals.emit('SIGINT'), 'SIGINT'],
    ['SIGTERM', (t: ReturnType<typeof setup>) => t.signals.emit('SIGTERM'), 'SIGTERM'],
    ['SIGHUP', (t: ReturnType<typeof setup>) => t.signals.emit('SIGHUP'), 'SIGHUP'],
  ])('%s triggers the shutdown', (_name, fire, reason) => {
    const t = setup();
    fire(t);
    expect(t.shutdown).toHaveBeenCalledWith(reason);
  });

  it('removes every listener on uninstall', () => {
    const t = setup();
    t.uninstall();
    expect(t.stdin.eventNames()).toEqual([]);
    expect(t.stdout.eventNames()).toEqual([]);
    expect(t.signals.eventNames()).toEqual([]);
  });
});
