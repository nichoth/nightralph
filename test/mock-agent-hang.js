#!/usr/bin/env node
// Never exits on its own; only a signal from the
// orchestrator's timeout can end it.
process.stdin.resume()
setInterval(() => {}, 1000)
