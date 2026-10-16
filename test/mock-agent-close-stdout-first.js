#!/usr/bin/env node
// Closes stdout, then writes to stderr a moment later, simulating
// an agent (or a grandchild it spawned) whose stdout reaches EOF
// before its stderr does. Both lines must land in the ticket log.
import { closeSync } from 'node:fs'

// Create the stderr stream before fd 1 is freed. On macOS libuv
// opens a probe fd while setting up a stream; created later, that
// fd lands on 1 and libuv aborts on `fd > STDERR_FILENO`.
process.stderr

process.stdout.write('stdout before close\n', () => {
    closeSync(1)
    setTimeout(() => {
        process.stderr.write('stderr after stdout closed\n')
    }, 200)
})
