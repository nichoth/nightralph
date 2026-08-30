#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.stdin.resume()
process.stdin.on('end', () => {
    const marker = join(process.cwd(), '.mock-agent-called')
    if (existsSync(marker)) {
        process.exit(1)
    }
    writeFileSync(marker, '1')
    process.exit(0)
})
