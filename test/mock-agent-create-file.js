#!/usr/bin/env node
const cwd = process.cwd()
process.stdout.write('CWD:' + cwd + '\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
