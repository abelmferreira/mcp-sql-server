/**
 * Graceful shutdown.
 *
 * The server ends when the MCP client goes away (stdin closes), or on
 * SIGINT / SIGTERM / SIGHUP. Without the stdin trigger a server started with
 * `docker run -i` would stay alive after its client died, keeping the
 * database connections and the SSH tunnel open.
 */

export interface ShutdownLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export interface ShutdownOptions {
  /** Releases the resources (connection pool and SSH tunnel) */
  closePool: () => Promise<void>;
  /** Terminates the process (process.exit outside of tests) */
  exit: (code: number) => void;
  logger: ShutdownLogger;
  /** Exit anyway after this many milliseconds if closePool() hangs (default 5000) */
  timeoutMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Build an idempotent shutdown function: the first call closes the resources
 * and exits (code 0, or 1 when closing failed or timed out); later calls
 * return the same promise and do nothing else.
 */
export function createShutdown(options: ShutdownOptions): (reason: string) => Promise<void> {
  const { closePool, exit, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let running: Promise<void> | null = null;

  return (reason: string): Promise<void> => {
    if (running) {
      return running;
    }

    running = (async () => {
      logger.info('Shutting down...', { reason });

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        // The safety timer alone must not keep the process alive
        timer.unref?.();
      });

      let code = 0;
      try {
        const outcome = await Promise.race([closePool().then(() => 'closed' as const), timedOut]);
        if (outcome === 'timeout') {
          logger.warn('Closing resources timed out; exiting anyway', { timeoutMs });
          code = 1;
        }
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        code = 1;
      } finally {
        clearTimeout(timer);
      }

      exit(code);
    })();

    return running;
  };
}

/** Minimal event source (process, a stream...) */
interface EventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ShutdownTriggers {
  /** Usually process.stdin: `end` / `close` mean the client is gone */
  stdin: EventSource;
  /** Usually process.stdout: a write `error` (EPIPE) also means the client is gone */
  stdout: EventSource;
  /** Usually process: receives SIGINT / SIGTERM / SIGHUP */
  signals: EventSource;
}

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Wire the shutdown function to its triggers. The SDK's StdioServerTransport
 * only listens to `data` and `error` on stdin, so the end of input has to be
 * handled here. These listeners do not keep the event loop alive.
 * Returns a function that removes the listeners.
 */
export function installShutdownTriggers(
  shutdown: (reason: string) => Promise<void>,
  triggers: ShutdownTriggers
): () => void {
  const onStdinEnd = () => void shutdown('stdin closed');
  const onStdoutError = () => void shutdown('stdout error');
  const onSignal = SHUTDOWN_SIGNALS.map((signal) => [signal, () => void shutdown(signal)] as const);

  triggers.stdin.on('end', onStdinEnd);
  triggers.stdin.on('close', onStdinEnd);
  triggers.stdout.on('error', onStdoutError);
  for (const [signal, listener] of onSignal) {
    triggers.signals.on(signal, listener);
  }

  return () => {
    triggers.stdin.off('end', onStdinEnd);
    triggers.stdin.off('close', onStdinEnd);
    triggers.stdout.off('error', onStdoutError);
    for (const [signal, listener] of onSignal) {
      triggers.signals.off(signal, listener);
    }
  };
}
