declare module "bun:sqlite" {
  export class Database {
    constructor(path: string)
    run(sql: string, ...params: unknown[]): unknown
    prepare(sql: string): Statement
    query(sql: string): Statement
    transaction<T extends (...args: any[]) => any>(fn: T): T
  }

  export interface Statement {
    run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}
