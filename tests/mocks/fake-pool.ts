import { EventEmitter } from 'node:events';

/**
 * Minimal stand-ins for mssql's ConnectionPool / Transaction / Request, enough
 * for src/db/execute.ts: a request in stream mode emits 'recordset', 'row',
 * 'error' and 'done' like the real one, driven by a scripted `query` mock
 * (the same `{ recordset, rowsAffected }` results the older mocks returned).
 */
export interface ScriptedRequest {
  input: (...args: unknown[]) => unknown;
  query: (text: string) => Promise<{ recordset?: Record<string, unknown>[]; rowsAffected?: number[] }>;
}

class FakeRequest extends EventEmitter {
  stream = false;
  private canceled = false;

  constructor(private readonly script: ScriptedRequest) {
    super();
  }

  input(name: string, type: unknown, value: unknown): this {
    this.script.input(name, type, value);
    return this;
  }

  cancel(): void {
    this.canceled = true;
  }

  async batch(text: string): Promise<unknown> {
    return this.script.query(text);
  }

  query(text: string): unknown {
    if (!this.stream) return this.script.query(text);
    void (async () => {
      try {
        const result = await this.script.query(text);
        const rows = result?.recordset ?? [];
        const columns: Record<string, { type: { name: string } }> = {};
        for (const key of Object.keys(rows[0] ?? {})) columns[key] = { type: { name: 'Mock' } };
        this.emit('recordset', columns);
        for (const row of rows) {
          if (this.canceled) break;
          this.emit('row', row);
        }
      } catch (error) {
        this.emit('error', error);
      }
      this.emit('done', {});
    })();
    return undefined;
  }
}

export class FakeTransaction {
  static rollbacks = 0;
  constructor(private readonly pool: { request: () => unknown }) {}
  async begin(): Promise<void> {}
  request(): unknown {
    return this.pool.request();
  }
  async rollback(): Promise<void> {
    FakeTransaction.rollbacks++;
  }
}

export function fakePool(script: ScriptedRequest) {
  return { request: () => new FakeRequest(script) };
}
