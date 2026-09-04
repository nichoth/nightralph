#!/usr/bin/env node
// Simulates an agent that spawns a child process (a dev server or
// watcher) which inherits the agent's stdout pipe and never exits
// on its own. Neither this process nor its child reads stdin or
// exits voluntarily -- only the orchestrator's timeout should end
// them both. The grandchild's pid is written to ./grandchild.pid
// (relative to this process's cwd, set by the test via spawnAgent's
// `cwd` option) so the test can confirm it was actually killed, not
// just orphaned.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pidFile = join(process.cwd(), 'grandchild.pid')

const grandchild = spawn(process.execPath, [
    '-e',
    'process.stdin.resume(); setInterval(() => {}, 1000)',
], {
    stdio:['ignore', 'inherit', 'inherit'],
})

writeFileSync(pidFile, String(grandchild.pid))

process.stdin.resume()
setInterval(() => {}, 1000)
