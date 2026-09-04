#!/usr/bin/env node
// Exits immediately without ever reading stdin, simulating an
// agent CLI that fails fast on a bad flag or missing auth before
// it drains its prompt. A large prompt piped into this process
// should trigger EPIPE on the writer side rather than being read.
process.exit(1)
