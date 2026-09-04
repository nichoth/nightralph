#!/usr/bin/env node
// Simulates an agent that spawns a long-lived grandchild sharing
// stdout, writes the grandchild's pid to ./grandchild.pid, then
// exits 0. The grandchild holds the stdout pipe open indefinitely.
// The grace timer should kill the process group so the grandchild
// does not survive.
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

// Read stdin to completion so the parent doesn't get EPIPE
process.stdin.resume()
process.stdin.on('end', () => {})

// Exit 0 immediately -- the grandchild keeps stdout open
process.exit(0)
