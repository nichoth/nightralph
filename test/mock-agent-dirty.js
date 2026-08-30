#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.stdin.resume()
process.stdin.on('end', () => {
    writeFileSync(
        join(process.cwd(), 'uncommitted-change.txt'),
        'dirty'
    )
    process.exit(0)
})
