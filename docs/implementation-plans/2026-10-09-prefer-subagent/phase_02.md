# Prefer Subagent Implementation Plan

**Goal:** `spawnAgent` sets `CLAUDE_CODE_SUBAGENT_MODEL` for claude
when asked, reports live subagent stats, and returns final stats in
`AgentResult`.

**Architecture:** The claude branch of the stdout loop parses each
line once; the parsed value feeds `nextStreamStats` (Phase 1) and a
new internal `formatStreamObject`, which `formatStreamLine` now
wraps. `formatStreamObject` drops subagent messages (non-null
`parent_tool_use_id`), so subagent text can never yield `[x]` items.

**Tech Stack:** TypeScript, Node `child_process.spawn`, tapzero

**Scope:** Phase 2 of 6 from
`docs/design-plans/2026-10-09-prefer-subagent.md`

**Codebase verified:** 2026-10-09

---

## Acceptance Criteria Coverage

This phase implements and tests:

### prefer-subagent.AC1: Flag and env
- **prefer-subagent.AC1.4 Success:** a claude spawn with the option
  has `CLAUDE_CODE_SUBAGENT_MODEL=X` in its env, overriding a value
  exported in the parent shell
- **prefer-subagent.AC1.5 Success:** a claude spawn without the
  option leaves the env untouched: a shell value is inherited, none
  is added

### prefer-subagent.AC3: Stats capture
- **prefer-subagent.AC3.6 Failure:** non-JSON lines, non-objects and
  wrong-typed fields leave the state unchanged and never throw
  (stdout half; the pure half is Phase 1)
- **prefer-subagent.AC3.7 Success:** `spawnAgent` returns the final
  stats in `AgentResult`, and `onStats` fires on each change, in
  order
- **prefer-subagent.AC3.8 Edge:** a timed-out agent reports the live
  count and no cost

### prefer-subagent.AC7: Cross-cutting
- **prefer-subagent.AC7.1 Failure:** `[x]` text from a subagent
  message never checks off ticket items

---

## Codebase notes for the executor

- `src/orchestrator.ts:730-777` `formatStreamLine(line)` (exported):
  parses JSON itself, returns the raw line on parse failure, returns
  the first `text` block of an `assistant` message, formats `result`
  as `<subtype> ($x.xx)`, formats `system/api_retry`, else `null`.
  It does not look at `parent_tool_use_id` today.
- `src/orchestrator.ts:886-892` `AgentResult` type.
- `src/orchestrator.ts:937-1210` `spawnAgent`. Provider is
  `basename(opts.agentCmd)` (`isClaude`, `isPi` at :955-957). The
  `spawn(...)` call is at ~:1014 with `{ stdio, cwd, detached:true }`
  and no `env`. The stdout `rl.on('line', ...)` handler is at
  ~:1052; its claude branch calls `formatStreamLine(line)` then
  `collectCompleted(formatted)`. `finish(exitCode)` at ~:1136
  resolves `{ exitCode, completedItems, timedOut }`. The `'error'`
  handler (~:1178) resolves without going through `finish`; leave it
  unchanged (a spawn error reports no stats).
- `src/stats.ts` (Phase 1) exports `emptyStreamStats`,
  `nextStreamStats`, `SubagentStats`.
- Test fakes: `test/mock-agent-*.js` are plain executables passed as
  `agentCmd`. None is named `claude` and none emits stream-json. The
  claude branch is chosen only when `basename(agentCmd) === 'claude'`,
  so the new fake must live in a file literally named `claude`.
- `package.json` has `"type": "module"`. An extensionless file's
  module type is version-dependent in Node, so the `claude` file is a
  two-line `sh` wrapper that `exec`s the ESM body,
  `test/mock-agent-claude.js` (`exec` keeps the pid, so
  process-group kills still work).
- `eslint.config.js` ignores `test/*.js` (the existing mocks), and
  its no-space `key-spacing` override applies to `**/*.ts` only. So
  the ESM body lives at `test/mock-agent-claude.js` (lint-ignored,
  same style as the other mocks), and only the extensionless wrapper
  lives in `test/fake-claude/`. Do not change eslint settings.
- Tests that set `process.env.*` for a mock restore the original in a
  `finally` (see `MOCK_INVOCATION_LOG` around
  `test/orchestrator.test.ts:2461-2496`).
- spawnAgent test example: `test/orchestrator.test.ts:1982-2011`
  (`MOCK_CHECKLIST`, `spawnAgent({ prompt:'test', agentCmd, model:null,
  timeout:10, logPath })`).
- Code style: see Phase 1 notes (no semicolons, 4 spaces, `a:T`,
  80 columns, no em dashes or arrow characters in comments).

---

<!-- START_TASK_1 -->
### Task 1: Fake `claude` executable

**Verifies:** None (test fixture)

**Files:**
- Create: `test/fake-claude/claude` (sh wrapper, executable)
- Create: `test/mock-agent-claude.js` (ESM, executable)

**Step 1: Create the wrapper `test/fake-claude/claude`**

```sh
#!/bin/sh
exec node "$(dirname "$0")/../mock-agent-claude.js" "$@"
```

**Step 2: Create `test/mock-agent-claude.js`**

Behaviour is driven by environment variables so tests can script it.
It drains stdin first (spawnAgent writes the prompt there), then:

1. `FAKE_CLAUDE_ENV_LOG` (path): append one line,
   `JSON.stringify(process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null)`.
2. `FAKE_CLAUDE_STREAM` (path): write that file's lines to stdout
   verbatim, each followed by `\n`. Lines may be non-JSON on
   purpose.
3. `FAKE_CLAUDE_HANG=1`: stay alive (e.g. `setInterval(() => {},
   1000)`) instead of exiting, so the orchestrator's timeout kills
   it. Otherwise exit 0.

```js
#!/usr/bin/env node
// A stand-in for the claude CLI. Tests run it through
// test/fake-claude/claude, whose basename makes spawnAgent take
// the claude branch.
import { appendFileSync, readFileSync } from 'node:fs'

process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
    const envLog = process.env.FAKE_CLAUDE_ENV_LOG
    if (envLog) {
        const value = process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null
        appendFileSync(envLog, JSON.stringify(value) + '\n')
    }
    const stream = process.env.FAKE_CLAUDE_STREAM
    if (stream) {
        const lines = readFileSync(stream, 'utf8')
            .split('\n')
            .filter(line => line !== '')
        for (const line of lines) process.stdout.write(line + '\n')
    }
    if (process.env.FAKE_CLAUDE_HANG === '1') {
        setInterval(() => {}, 1000)
        return
    }
    process.exitCode = 0
})
```

Use `process.exitCode = 0` (not `process.exit(0)`) so buffered
stdout is flushed before exit.

**Step 3: Make both executable**

```bash
chmod +x test/fake-claude/claude test/mock-agent-claude.js
```

**Step 4: Verify operationally**

```bash
printf 'x' | FAKE_CLAUDE_STREAM=<(printf '{"type":"result"}\n') \
    test/fake-claude/claude --print; echo "exit $?"
```
Expected: prints `{"type":"result"}` then `exit 0`.

Run: `npm run lint`
Expected: no errors (the new `.js` file is under the existing
`test/*.js` ignore).

**Step 5: Commit**

```bash
git add test/fake-claude test/mock-agent-claude.js
git commit -m "test: add scriptable fake claude executable"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Stats capture, env and subagent filtering in `spawnAgent`

**Verifies:** prefer-subagent.AC1.4, AC1.5, AC3.6, AC3.7, AC3.8,
AC7.1 (tested in Task 3)

**Files:**
- Modify: `src/orchestrator.ts:730-777` (`formatStreamLine`)
- Modify: `src/orchestrator.ts:886-892` (`AgentResult`)
- Modify: `src/orchestrator.ts:937-1160` (`spawnAgent`)
- Modify: imports at the top of `src/orchestrator.ts`

**Implementation:**

1. Import from `./stats.js`:
   `emptyStreamStats`, `nextStreamStats`, `type SubagentStats`.

2. Split `formatStreamLine`:

```ts
export function formatStreamLine (
    line:string
):string|null {
    let obj:unknown
    try {
        obj = JSON.parse(line)
    } catch {
        return line
    }
    return formatStreamObject(obj)
}

function formatStreamObject (value:unknown):string|null {
    if (typeof value !== 'object' || value === null) return null
    const obj = value as Record<string, unknown>

    if (obj.type === 'assistant') {
        // A subagent's messages carry the id of the tool_use that
        // started it. Only the main agent's text is shown, so a
        // subagent can never report `[x]` items.
        if (obj.parent_tool_use_id != null) return null
        const msg = obj.message as
            Record<string, unknown>|undefined
        const content = msg?.content
        if (!Array.isArray(content)) return null
        for (const block of content) {
            if (typeof block !== 'object' || block === null) continue
            const b = block as Record<string, unknown>
            if (b.type === 'text') return String(b.text)
        }
        return null
    }

    if (obj.type === 'result') {
        const sub = typeof obj.subtype === 'string' ?
            obj.subtype :
            'done'
        const cost = obj.total_cost_usd
        const costStr = typeof cost === 'number' ?
            ` ($${cost.toFixed(2)})` :
            ''
        return `${sub}${costStr}`
    }

    // ... existing system/api_retry branch unchanged ...
    return null
}
```

   Behaviour changes: subagent `assistant` messages return `null`;
   a JSON value that is not an object (e.g. the line `null`, which
   crashed before) returns `null`; wrong-typed fields (a string
   `total_cost_usd`, a non-array `content`, a `null` block), which
   threw inside the readline handler before and killed the
   orchestrator, are now skipped. `msg?.content` on a non-object
   `message` (e.g. a number) yields `undefined`, which the
   `Array.isArray` check rejects; if `message` could be a string,
   `msg?.content` is still `undefined`, so no extra guard is
   needed.

3. `AgentResult` gains two optional fields with a comment:

```ts
    // claude only: subagents the main loop started, and the cost
    // from the last `result` message. Absent = not reported
    // (always so for codex and pi).
    subagents?:number
    costUsd?:number
```

4. `spawnAgent` opts gain:

```ts
    // claude only: sets CLAUDE_CODE_SUBAGENT_MODEL for the agent
    preferSubagent?:string
    // claude only: called whenever the subagent stats change
    onStats?:(stats:SubagentStats) => void
```

5. Build the env right before `spawn` and pass it only when set, so
   an unset option leaves the inherited environment untouched:

```ts
    const env = isClaude && opts.preferSubagent ?
        {
            ...process.env,
            CLAUDE_CODE_SUBAGENT_MODEL:opts.preferSubagent,
        } :
        undefined
    const proc = spawn(opts.agentCmd, args, {
        stdio:['pipe', 'pipe', 'pipe'],
        cwd:opts.cwd,
        detached:true,
        ...(env ? { env } : {}),
    })
```

   Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.

6. Next to `collectCompleted`, add the per-spawn stats state and a
   claude line handler that parses once:

```ts
    let streamStats = emptyStreamStats()

    // Each claude line is parsed once: the value feeds the
    // subagent stats and the formatter.
    function formatClaudeLine (line:string):string|null {
        let obj:unknown
        try {
            obj = JSON.parse(line)
        } catch {
            return line
        }
        const next = nextStreamStats(streamStats, obj)
        if (next !== streamStats) {
            streamStats = next
            opts.onStats?.(next.stats)
        }
        return formatStreamObject(obj)
    }
```

   In `rl.on('line', ...)`, the claude branch calls
   `formatClaudeLine(line)` instead of `formatStreamLine(line)`; the
   rest of that branch is unchanged.

7. In `finish`, resolve with the stats for claude only:

```ts
            resolve({
                exitCode,
                completedItems,
                timedOut,
                ...(isClaude ? streamStats.stats : {}),
            })
```

   A killed or timed-out agent never emits a `result`, so it reports
   the live count and no `costUsd`. The `'error'` handler stays as
   is.

**Verification:**

Run: `npm run build`
Expected: succeeds (tsc reports no type errors).

**Commit:** `feat: capture subagent stats and set subagent model env`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: spawnAgent and formatStreamLine tests

**Verifies:** prefer-subagent.AC1.4, AC1.5, AC3.6, AC3.7, AC3.8,
AC7.1

**Files:**
- Modify: `test/orchestrator.test.ts` (unit/integration with a real
  child process), in the existing spawnAgent and formatStreamLine
  sections

**Testing:**

Define once:
`const FAKE_CLAUDE = join(process.cwd(), 'test', 'fake-claude', 'claude')`
and
`const FAKE_CLAUDE_JS = join(process.cwd(), 'test', 'mock-agent-claude.js')`.
Write stream files and env logs into a `mkdtempSync(join(tmpdir(), ...))`
directory. Save and restore `FAKE_CLAUDE_STREAM`, `FAKE_CLAUDE_ENV_LOG`,
`FAKE_CLAUDE_HANG` and `CLAUDE_CODE_SUBAGENT_MODEL` in `finally`
(delete the key when the original was `undefined`).

Tests must verify each AC:
- AC1.4: set `process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'shell-model'`,
  spawn `FAKE_CLAUDE` with `preferSubagent:'haiku'`; the env log's
  only line parses to `'haiku'`.
- AC1.5: with `CLAUDE_CODE_SUBAGENT_MODEL='shell-model'` and no
  `preferSubagent`, the log reads `'shell-model'`; with the variable
  deleted and no option, the log reads `null`. Also: spawn
  `FAKE_CLAUDE_JS` directly (its basename is not `claude`, so it is
  not the claude provider) with `preferSubagent:'haiku'` and the
  variable deleted; the log reads `null`.
- AC3.6 (stdout half): a stream with a non-JSON line, the line
  `null`, the line `42`, the wrong-typed lines
  `{"type":"result","total_cost_usd":"1"}`,
  `{"type":"assistant","message":{"content":5}}` and
  `{"type":"assistant","message":{"content":[null]}}`, then a valid
  `result` with `total_cost_usd:0.1` -> the spawn resolves with
  `exitCode` 0 and `costUsd` 0.1, and nothing throws. Also pure
  `formatStreamLine` checks: each wrong-typed line returns without
  throwing.
- AC3.7: a stream with two main-loop assistant lines, each with one
  `Agent` tool_use (distinct ids), then a `result` with
  `total_cost_usd:0.5` and `subagent_stats:{ spawned:3 }`. Collect
  `onStats` calls into an array; `t.deepEqual` it with
  `[{ subagents:1 }, { subagents:2 }, { subagents:3, costUsd:0.5 }]`.
  The result has `subagents` 3 and `costUsd` 0.5.
- AC3.8: a stream with one `Agent` tool_use and no `result`,
  `FAKE_CLAUDE_HANG=1`, `timeout:1`; the result has `timedOut`
  true, `subagents` 1, and `'costUsd' in result` is false.
- AC7.1: a stream with an assistant line that has
  `parent_tool_use_id:'toolu_1'` and a text block `[x] first item`,
  then a main-loop text block `[x] second item`; `completedItems`
  deep-equals `['second item']`. Also a pure test:
  `formatStreamLine` of a subagent assistant line returns `null`,
  and of the same line with `parent_tool_use_id:null` returns its
  text.
- Regression: an existing non-claude spawn (e.g. `MOCK_CHECKLIST`)
  result has no `subagents` key (`'subagents' in result` is false).

Follow project testing patterns. The executor writes the test code.

**Verification:**

Run: `npm run build && npm test`
Expected: all suites pass.

Run: `npm run lint`
Expected: no errors.

**Commit:** `test: cover spawnAgent subagent stats and env`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
