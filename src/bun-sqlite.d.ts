declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; strict?: boolean; });
    exec(sql: string): void;
    query(sql: string): {
      run(params?: unknown): { changes: number; lastInsertRowid: number | bigint; };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
