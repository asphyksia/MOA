import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { createHash } from "node:crypto"

/**
 * Per-project SQLite + FTS5 store for codebase RAG.
 *
 * Unlike long-term memory (one global store), the codebase index is scoped to
 * each project: the DB file is named by a hash of the project's absolute path,
 * under ~/.moa/codebase/<hash>.db. This keeps projects isolated.
 *
 * Files are split into line-range chunks; an FTS5 table indexes chunk content
 * for BM25 full-text search. Re-indexing a file replaces all its chunks.
 *
 * Runs on Bun's built-in `bun:sqlite` (opencode plugin runtime) — no native
 * build step, no external dependency.
 */

export type Chunk = {
  path: string
  startLine: number
  endLine: number
  content: string
}

export type SearchHit = {
  path: string
  startLine: number
  endLine: number
  content: string
}

const baseDir = join(homedir(), ".moa", "codebase")

const dbCache = new Map<string, any>()

function dbFileFor(projectDir: string): string {
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16)
  return join(baseDir, `${hash}.db`)
}

async function openDb(projectDir: string): Promise<any> {
  const cached = dbCache.get(projectDir)
  if (cached) return cached

  mkdirSync(baseDir, { recursive: true })
  const { Database } = (await import("bun:sqlite")) as any
  const db = new Database(dbFileFor(projectDir))
  db.run("PRAGMA journal_mode = WAL")

  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      path      TEXT NOT NULL,
      startLine INTEGER NOT NULL,
      endLine   INTEGER NOT NULL,
      content   TEXT NOT NULL
    )
  `)
  db.run("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)")

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
    USING fts5(content, path UNINDEXED, content='chunks', content_rowid='id')
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, path) VALUES (new.id, new.content, new.path);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, path) VALUES ('delete', old.id, old.content, old.path);
    END
  `)

  // Meta table for bookkeeping (last index time, counts).
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")

  dbCache.set(projectDir, db)
  return db
}

/** Replace all chunks for a file with a fresh set. */
export async function indexFile(
  projectDir: string,
  path: string,
  chunks: Chunk[],
): Promise<void> {
  const db = await openDb(projectDir)
  const del = db.prepare("DELETE FROM chunks WHERE path = ?")
  const ins = db.prepare(
    "INSERT INTO chunks (path, startLine, endLine, content) VALUES (?, ?, ?, ?)",
  )
  const tx = db.transaction(() => {
    del.run(path)
    for (const c of chunks) ins.run(c.path, c.startLine, c.endLine, c.content)
  })
  tx()
}

/** Remove a file's chunks entirely (e.g. on delete). */
export async function removeFile(projectDir: string, path: string): Promise<void> {
  const db = await openDb(projectDir)
  db.prepare("DELETE FROM chunks WHERE path = ?").run(path)
}

/** Clear the entire index for a project. */
export async function clearIndex(projectDir: string): Promise<void> {
  const db = await openDb(projectDir)
  db.run("DELETE FROM chunks")
}

function toMatchExpr(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  return terms.join(" OR ")
}

export async function search(
  projectDir: string,
  query: string,
  limit = 8,
): Promise<SearchHit[]> {
  const db = await openDb(projectDir)
  const expr = toMatchExpr(query)
  if (!expr) return []
  const rows = db
    .query(
      `
      SELECT c.path, c.startLine, c.endLine, c.content
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY bm25(chunks_fts) ASC
      LIMIT ?
      `,
    )
    .all(expr, limit)
  return rows as SearchHit[]
}

export async function setMeta(projectDir: string, key: string, value: string): Promise<void> {
  const db = await openDb(projectDir)
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
}

export async function getMeta(projectDir: string, key: string): Promise<string | null> {
  const db = await openDb(projectDir)
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export async function stats(projectDir: string): Promise<{ files: number; chunks: number }> {
  const db = await openDb(projectDir)
  const chunks = (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n
  const files = (
    db.query("SELECT COUNT(DISTINCT path) AS n FROM chunks").get() as { n: number }
  ).n
  return { files, chunks }
}
