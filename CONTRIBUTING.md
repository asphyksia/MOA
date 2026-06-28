# Contributing to opencore

opencore is built on [opencode](https://opencode.ai) through its plugin and agent extension system. Contributions are welcome — whether new plugins, improved agents, skills, or bug fixes.

---

## Architecture overview

opencore extends opencode in three ways:

1. **Agents** (`.opencode/agents/*.md`) — personality/behavior definitions with permission profiles
2. **Plugins** (`.opencode/plugins/*.ts`) — TypeScript modules that hook into opencode's runtime (tools, event handlers, hooks)
3. **Skills** (`.opencode/skills/*/SKILL.md`) — reusable instruction templates in Markdown (agentskills.io format)

All three are synced globally via the installer (`scripts/install.ps1` / `install.sh`).

---

## Creating a plugin

Plugins use the `@opencode-ai/plugin` SDK. They can:
- Add tools the agent can call
- React to events (messages, session lifecycle, file edits)
- Hook into opencode internals (memory injection, compaction, etc.)

### Plugin anatomy

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ client }) => {
  // Setup: runs once when the plugin loads
  // Access to `client` for logging, storage, etc.

  return {
    // Optional: add custom tools the agent can invoke
    tool: {
      my_tool: {
        description: "What this tool does",
        parameters: z.object({
          query: z.string().describe("A query parameter"),
        }),
        execute: async ({ query }) => {
          // Tool logic here
          return { result: "..." }
        },
      },
    },

    // Optional: react to events
    event: async ({ event }) => {
      if (event?.type === "session.idle") {
        // Do something after the agent responds
      }
      if (event?.type === "file.edited") {
        // React to file changes
      }
    },
  }
}
```

### Example: A simple "last commit" tracker

Let's build a plugin that tracks the last git commit and surfaces it as a tool.

**File: `.opencode/plugins/last-commit.ts`**

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { z } from "zod"

export const LastCommitPlugin: Plugin = async () => {
  return {
    tool: {
      last_commit: {
        description: "Get the last git commit hash and message in the current repo",
        parameters: z.object({}),
        execute: async () => {
          try {
            const hash = execSync("git log -1 --format=%H", { encoding: "utf8" }).trim()
            const message = execSync("git log -1 --format=%s", { encoding: "utf8" }).trim()
            return { hash, message }
          } catch (err) {
            return { error: "Not a git repo or git not available" }
          }
        },
      },
    },
  }
}
```

**Register it in `opencode.json`:**

```json
{
  "plugin": ["last-commit"]
}
```

After running the installer, the agent can call `last_commit` in any session.

---

## Plugin patterns

### Storage (SQLite)

opencore's memory and codebase plugins use SQLite via Bun's built-in `bun:sqlite`. See `lib/memory-store.ts` and `lib/codebase-store.ts` for reusable patterns:

- Full-text search with FTS5
- Hybrid BM25 + embedding search
- Schema migrations
- Per-project vs global storage

### Event hooks

Plugins can react to:
- `message.updated` — new message from agent or user
- `session.idle` — agent finished responding
- `file.edited` — user edited a file
- `experimental.session.compacting` — context is being compressed (inject facts here)

See `plugins/memory.ts` for a complete example.

### Tools with async logic

Tools can be async, call external APIs, read files, etc. Wrap errors gracefully:

```typescript
execute: async ({ query }) => {
  try {
    const result = await fetchSomething(query)
    return { data: result }
  } catch (err) {
    return { error: err.message }
  }
}
```

---

## Creating an agent

Agents are Markdown files with frontmatter + system prompt.

**Minimal example: `.opencode/agents/minimal.md`**

```markdown
---
name: minimal
description: A minimal custom agent
permissions:
  edit: ask
  bash: deny
---

You are a minimal agent. You can read files but not edit or execute code.
```

See `agents/dev.md` and `agents/chat.md` for full examples with memory/RAG instructions.

---

## Creating a skill

Skills are instruction templates loaded on-demand. Format: [agentskills.io](https://agentskills.io).

**Example: `.opencode/skills/changelog/SKILL.md`**

```markdown
---
name: changelog
description: Generate a changelog from recent git commits
---

# Changelog skill

When the user asks for a changelog:

1. Run `git log --oneline -20`
2. Group commits by type (feat, fix, docs, refactor)
3. Format as Markdown with version bump suggestion
4. Return the changelog
```

Skills don't execute code — they're instructions the agent follows. Use them for repeatable workflows.

---

## Testing your changes

1. Make your changes (plugin, agent, or skill)
2. Run the installer to sync: `powershell scripts\install.ps1` or `./scripts/install.sh`
3. Restart the opencode desktop app if it's running
4. Test in a new session: `opencode --agent <your-agent>` or call your tool

---

## Submitting a PR

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-plugin`
3. Add your plugin/agent/skill + update README if adding new features
4. Test locally with the installer
5. Commit with clear messages: `Add last-commit plugin`
6. Push and open a PR with:
   - What the change does
   - Why it's useful
   - How you tested it

---

## Questions?

Open an issue or discussion on GitHub. For opencode plugin API questions, see the [opencode docs](https://opencode.ai/docs).
