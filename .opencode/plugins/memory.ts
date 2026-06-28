import { type Plugin, tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs"

/**
 * MOA two-level memory plugin.
 *
 * Working memory = opencode's native session context (not handled here).
 * Long-term memory = persistent facts stored locally as JSONL, survive across
 * sessions, and are injected back into context on compaction.
 *
 * V1 storage is JSONL (dependency-free, cross-platform, no native build step).
 * V2 will migrate to SQLite + FTS5 for scalable full-text search; the public
 * surface (remember / recall / search) is designed to stay stable across that
 * migration.
 *
 * Provides:
 *   - tool `memory_remember`  : store a fact
 *   - tool `memory_search`    : retrieve relevant facts (keyword scored)
 *   - hook `session.idle`     : log a reminder to capture durable facts
 *   - hook `experimental.session.compacting` : inject top facts into context
 */

const dir = join(homedir(), ".moa", "memory")
const store = join(dir, "long-term.jsonl")

type Fact = {
  id: string
  text: string
  type: string // identity | preference | goal | project | decision | note ...
  importance: number // 0..1
  createdAt: string
  source?: string
}

function ensureDir() {
  mkdirSync(dir, { recursive: true })
}

function append(fact: Fact) {
  ensureDir()
  appendFileSync(store, JSON.stringify(fact) + "\n", "utf8")
}

function readAll(): Fact[] {
  if (!existsSync(store)) return []
  const out: Fact[] = []
  for (const line of readFileSync(store, "utf8").split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // skip corrupt lines
    }
  }
  return out
}

/** Naive keyword overlap score. Replaced by FTS5 ranking in V2. */
function score(query: string, fact: Fact): number {
  const q = query.toLowerCase().split(/\W+/).filter(Boolean)
  if (q.length === 0) return fact.importance
  const hay = fact.text.toLowerCase()
  let hits = 0
  for (const term of q) if (hay.includes(term)) hits++
  return hits / q.length + fact.importance * 0.25
}

function topFacts(query: string, limit: number): Fact[] {
  return readAll()
    .map((f) => ({ f, s: score(query, f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f)
}

export const MemoryPlugin: Plugin = async ({ client }) => {
  async function log(message: string) {
    try {
      await client.app.log({ body: { service: "moa-memory", level: "info", message } })
    } catch {
      /* best-effort */
    }
  }

  return {
    tool: {
      memory_remember: tool({
        description:
          "Store a durable fact about the user or project in long-term memory " +
          "(preferences, goals, decisions, identity, project facts). Use for " +
          "information that should persist across sessions.",
        args: {
          text: tool.schema.string().describe("The fact to remember, phrased standalone."),
          type: tool.schema
            .string()
            .describe("Category: identity | preference | goal | project | decision | note"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .describe("How important this fact is, 0..1.")
            .optional(),
        },
        async execute(args) {
          const fact: Fact = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: args.text,
            type: args.type || "note",
            importance: typeof args.importance === "number" ? args.importance : 0.5,
            createdAt: new Date().toISOString(),
          }
          append(fact)
          return `Remembered (${fact.type}): ${fact.text}`
        },
      }),

      memory_search: tool({
        description:
          "Search long-term memory for facts relevant to a query. Returns the " +
          "most relevant stored facts about the user or project.",
        args: {
          query: tool.schema.string().describe("What to look for."),
          limit: tool.schema.number().min(1).max(20).optional().describe("Max results (default 5)."),
        },
        async execute(args) {
          const limit = args.limit ?? 5
          const facts = topFacts(args.query, limit)
          if (facts.length === 0) return "No relevant memories found."
          return facts.map((f) => `- [${f.type}] ${f.text}`).join("\n")
        },
      }),
    },

    event: async ({ event }: { event: any }) => {
      // After the agent goes idle, nudge fact capture. In V2 this becomes an
      // automatic extraction pass over the last turn.
      if (event?.type === "session.idle") {
        await log("session idle — consider capturing durable facts via memory_remember")
      }
    },

    // Inject the most relevant long-term facts into the compaction prompt so
    // they survive context summarization.
    "experimental.session.compacting": async (_input: any, output: any) => {
      const facts = readAll()
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 5)
      if (facts.length === 0) return
      const block =
        "## Long-term memory (MOA)\n" +
        "Persisted facts about the user/project to keep in mind:\n" +
        facts.map((f) => `- [${f.type}] ${f.text}`).join("\n")
      if (Array.isArray(output?.context)) output.context.push(block)
    },
  }
}
