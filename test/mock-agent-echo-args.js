#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv) + '\n')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
