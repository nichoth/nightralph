#!/usr/bin/env node
/**
 * night-ralph: simple Node orchestrator (local .md mode + gh mode)
 *
 * Features added:
 *  - --local-dir <dir> mode: read local Markdown tickets instead of calling `gh`.
 *  - PRD is read from --prd-file or from <local-dir>/PRD.md (case-insensitive search).
 *  - Matches child tickets created by Matt Pocock's to-tickets: expects "## Parent" and "## Blocked by" sections.
 *  - Selects lowest-lexical filename candidate with no unresolved blockers.
 *  - Saves prompt to prompts/<ticket-filename>.txt and agent stdout/stderr to logs/<ticket-filename>.log.
 *  - On success (agent exit code 0) moves processed ticket to <local-dir>/done/.
 *
 * Usage (local):
 *   night-ralph --local-dir ./tickets --prd-file ./tickets/PRD.md --agent claude --model claude-sonnet-4-6
 *
 * Usage (github):
 *   night-ralph --prd 12 --repo owner/name --agent claude
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function usageAndExit(code = 1) {
  console.log(`Usage:
  # GitHub mode (original):
  night-ralph --prd <number> --repo owner/name [--agent claude] [--model <model>] [--dry-run]

  # Local mode (read .md tickets):
  night-ralph --local-dir <dir> [--prd-file <file>] [--agent claude] [--model <model>] [--dry-run]
`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let PRD = null; // numeric PRD for GH mode
let REPO = null;
let AGENT_CMD = "claude";
let MODEL = null;
let DRY = false;
let TIMEOUT_SECS = 300;
let LOCAL_DIR = null;
let PRD_FILE = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--prd") PRD = Number(argv[++i]);
  else if (a === "--repo") REPO = argv[++i];
  else if (a === "--agent") AGENT_CMD = argv[++i];
  else if (a === "--model") MODEL = argv[++i];
  else if (a === "--dry-run") DRY = true;
  else if (a === "--timeout-secs") TIMEOUT_SECS = Number(argv[++i]);
  else if (a === "--local-dir") LOCAL_DIR = argv[++i];
  else if (a === "--prd-file") PRD_FILE = argv[++i];
  else {
    console.error("Unknown arg:", a);
    usageAndExit();
  }
}

if (!LOCAL_DIR && (!PRD || !REPO)) {
  console.error("Missing required flags: either --local-dir (for local mode) or --prd and --repo (for GitHub mode).");
  usageAndExit();
}

function execGhJson(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8" });
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`gh CLI failed: ${e.message}`);
  }
}

// Parser ported from nightshift/parser.rs behavior
function extract_section_issue_numbers(body, sectionName) {
  const numbers = [];
  const reNum = /#([0-9]+)/g;
  const reHeader = /^#{1,6}\s/;
  const lowerSection = sectionName.toLowerCase();

  const lines = body.split(/\r?\n/);
  let capturing = false;
  for (const line of lines) {
    if (line.toLowerCase().includes(lowerSection)) {
      capturing = true;
      let m;
      while ((m = reNum.exec(line))) numbers.push(Number(m[1]));
      continue;
    }
    if (capturing && reHeader.test(line)) {
      capturing = false;
    }
    if (capturing) {
      let m;
      while ((m = reNum.exec(line))) numbers.push(Number(m[1]));
    }
  }
  return numbers;
}

function extract_parent_prd_from_body(body) {
  const arr = extract_section_issue_numbers(body, "parent");
  return arr.length ? arr[0] : null;
}
function extract_blockers_from_body(body) {
  return extract_section_issue_numbers(body, "blocked by");
}

// Local helpers
function find_prd_file_in_dir(dir) {
  const candidates = fs.readdirSync(dir).filter(f => /^prd\.md$/i.test(f));
  if (candidates.length) return path.join(dir, candidates[0]);
  // fallback: look for any file named README.md or PRD*.md
  const fallback = fs.readdirSync(dir).find(f => /prd/i.test(f) && f.toLowerCase().endsWith('.md'));
  return fallback ? path.join(dir, fallback) : null;
}

function readFileTrimmed(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function prdTitleFromBody(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    // strip leading markdown headings
    return t.replace(/^#+\s*/, '').trim();
  }
  return '';
}

function listMarkdownFiles(dir) {
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md'));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Local mode: find candidates, select one, run agent, mark done
async function runLocalMode() {
  const dir = LOCAL_DIR;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Local dir not found: ${dir}`);
    process.exit(2);
  }

  let prdPath = PRD_FILE ? PRD_FILE : find_prd_file_in_dir(dir);
  if (!prdPath) {
    console.error('PRD file not provided and none found in local dir. Please pass --prd-file or create PRD.md in the directory.');
    process.exit(2);
  }
  if (!path.isAbsolute(prdPath)) prdPath = path.join(dir, prdPath);
  if (!fs.existsSync(prdPath)) {
    console.error(`PRD file does not exist: ${prdPath}`);
    process.exit(2);
  }
  const prdBody = readFileTrimmed(prdPath);
  const prdTitle = prdTitleFromBody(prdBody);
  const prdBasename = path.basename(prdPath);

  const allMd = listMarkdownFiles(dir).filter(f => path.join(dir, f) !== prdPath);
  // exclude done/ directory files
  const doneDir = path.join(dir, 'done');
  const doneFiles = fs.existsSync(doneDir) ? fs.readdirSync(doneDir) : [];

  if (allMd.length === 0) {
    console.log('No markdown ticket files found in local dir. Exiting.');
    return;
  }

  // Build ticket objects
  const tickets = allMd.map(fname => {
    const full = path.join(dir, fname);
    const body = readFileTrimmed(full);
    return { fname, full, body };
  }).filter(t => t.full !== prdPath);

  // Filter to child issues that declare this PRD as parent (matching by PRD filename or title or explicit parent number if present)
  const children = tickets.filter(t => {
    const parentNum = extract_parent_prd_from_body(t.body);
    if (parentNum && PRD) {
      if (parentNum === PRD) return true;
    }
    // if parent section contains prd filename or prd title substring
    const lower = t.body.toLowerCase();
    if (prdBasename && lower.includes(prdBasename.toLowerCase())) return true;
    if (prdTitle && prdTitle.length > 0 && lower.includes(prdTitle.toLowerCase())) return true;
    return false;
  }).sort((a,b) => a.fname.localeCompare(b.fname, undefined, {numeric:true, sensitivity:'base'}));

  if (children.length === 0) {
    console.log('No child tickets found for this PRD in local dir. Exiting.');
    return;
  }

  console.log(`Found ${children.length} candidate child tickets; selecting lowest lexical filename unblocked candidate.`);

  // Determine blockers: numeric blockers (like #10) and filename blockers (simple token match to filenames)
  function resolveBlockers(ticket) {
    const numeric = extract_blockers_from_body(ticket.body);
    // parse filename-like tokens on the Blocked by section lines
    const lb = ticket.body.split(/\r?\n/);
    let capturing = false;
    const fileLike = [];
    for (const line of lb) {
      if (line.toLowerCase().includes('blocked by')) {
        capturing = true; continue;
      }
      if (capturing && /^#{1,6}\s/.test(line)) break;
      if (capturing) {
        // look for tokens that look like filenames (end in .md) or simple words that match other ticket basenames
        const matches = Array.from(line.matchAll(/([\w\-\.]+\.md)/gi)).map(m=>m[1]);
        for (const m of matches) fileLike.push(m);
        // also attempt to find bare basenames like "add-login" that might match add-login.md
        const tokens = line.split(/[^\w\-]+/).filter(Boolean);
        for (const t of tokens) {
          const candidate = t + '.md';
          if (fs.existsSync(path.join(dir, candidate))) fileLike.push(candidate);
        }
      }
    }
    return { numeric, fileLike };
  }

  let selected = null;
  for (const c of children) {
    const { numeric, fileLike } = resolveBlockers(c);
    let unresolved = false;
    // numeric blockers are considered unresolved in pure-local workflow (no mapping to numbers)
    if (numeric.length > 0) {
      unresolved = true;
      console.log(`${c.fname} has numeric blockers ${numeric.join(', ')} which cannot be resolved in local mode; treating as blocked.`);
    }
    // fileLike blockers: unresolved if the file exists and not in done/
    for (const f of fileLike) {
      if (!doneFiles.includes(f)) {
        unresolved = true;
        console.log(`${c.fname} blocked by local ticket ${f} (not in done/)`);
      }
    }
    if (!unresolved) { selected = c; break; }
  }

  if (!selected) { console.log('No unblocked candidates found. Exiting.'); return; }

  console.log(`Selected ${selected.fname}`);

  const prompt = [
    '---- PRD CONTEXT ----',
    prdBody,
    '',
    '---- TICKET ----',
    `${selected.fname}`,
    selected.body,
    '',
    '---- AGENT INSTRUCTIONS ----',
    'You are an autonomous coding agent. Implement the ticket and create a patch or PR as appropriate.',
    ''
  ].join('\n');

  if (DRY) { console.log('DRY RUN: would invoke agent with prompt:\n'); console.log(prompt); return; }

  // prepare dirs for prompts/logs/done
  const promptsDir = path.join(dir, 'prompts');
  const logsDir = path.join(dir, 'logs');
  ensureDir(promptsDir); ensureDir(logsDir); ensureDir(doneDir);

  const promptPath = path.join(promptsDir, selected.fname + '.txt');
  fs.writeFileSync(promptPath, prompt);

  // Spawn agent with stdout/stderr captured to logs
  const logPath = path.join(logsDir, selected.fname + '.log');
  const outStream = fs.createWriteStream(logPath, { flags: 'a' });

  const spawnArgs = [];
  if (MODEL) spawnArgs.push('--model', MODEL);

  console.log(`Spawning agent: ${AGENT_CMD} ${spawnArgs.join(' ')} (timeout ${TIMEOUT_SECS}s). Logs: ${logPath}`);
  const agentProc = spawn(AGENT_CMD, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  const timeout = setTimeout(() => {
    if (!agentProc.killed) {
      console.warn(`Agent did not exit in ${TIMEOUT_SECS}s; killing.`);
      agentProc.kill('SIGKILL');
    }
  }, TIMEOUT_SECS * 1000);

  agentProc.stdout.pipe(outStream);
  agentProc.stderr.pipe(outStream);
  agentProc.stdin.write(prompt);
  agentProc.stdin.end();

  const exitCode = await new Promise(resolve => {
    agentProc.on('close', code => resolve(code));
    agentProc.on('error', err => { console.error('Agent process error:', err.message); resolve(1); });
  });

  clearTimeout(timeout);
  outStream.end();

  console.log(`Agent finished with code ${exitCode}. Log saved to ${logPath}`);

  // On success (exit code 0) move ticket to done/
  if (exitCode === 0) {
    const dest = path.join(doneDir, selected.fname);
    fs.renameSync(selected.full, dest);
    console.log(`Moved ${selected.fname} -> done/`);
  } else {
    console.log(`${selected.fname} remains in place for further inspection.`);
  }
}

// GitHub mode (original behavior)
async function runGitHubMode() {
  console.log(`GitHub mode: PRD=${PRD}, REPO=${REPO}`);

  // load PRD body
  let prdBody;
  try {
    const prdJson = execGhJson(['issue','view','-R', REPO, String(PRD), '--json', 'number,title,body']);
    prdBody = prdJson.body || '';
  } catch (e) { console.error('Failed to fetch PRD:', e.message); process.exit(2); }

  let issues;
  try { issues = execGhJson(['issue','list','-R', REPO, '--json', 'number,title,body', '--label', 'ready-for-agent', '--state','open']); }
  catch (e) { console.error('Failed to list issues:', e.message); process.exit(3); }

  if (!Array.isArray(issues) || issues.length === 0) { console.log('No ready-for-agent issues found. Exiting.'); return; }

  const children = issues.map(i => ({ number: i.number, title: i.title, body: i.body || '' }))
    .filter(i => extract_parent_prd_from_body(i.body) === PRD)
    .sort((a,b) => a.number - b.number);

  if (children.length === 0) { console.log('No child issues found for this PRD with label ready-for-agent.'); return; }

  console.log(`Found ${children.length} candidate child issues; selecting lowest-numbered unblocked candidate.`);

  function allBlockersClosed(repo, blockers) {
    for (const num of blockers) {
      try {
        const j = execGhJson(['issue','view','-R', repo, String(num), '--json', 'state']);
        const state = j.state;
        if (state.toUpperCase() !== 'CLOSED') return false;
      } catch (e) { console.error(`Warning: failed to fetch blocker #${num}: ${e.message}`); return false; }
    }
    return true;
  }

  let selected = null;
  for (const c of children) {
    const blockers = extract_blockers_from_body(c.body);
    if (blockers.length === 0 || allBlockersClosed(REPO, blockers)) { selected = c; break; }
    else console.log(`#${c.number} blocked by ${blockers.join(', ')}; skipping.`);
  }

  if (!selected) { console.log('No unblocked candidates found. Exiting.'); return; }

  console.log(`Selected #${selected.number}: ${selected.title}`);

  const prompt = ['---- PRD CONTEXT ----', prdBody, '', '---- ISSUE ----', `#${selected.number} ${selected.title}`, selected.body, '', '---- AGENT INSTRUCTIONS ----', 'You are an autonomous coding agent. Implement the issue and open a PR.', ''].join('\n');

  if (DRY) { console.log('DRY RUN: would invoke agent with the following prompt:\n'); console.log(prompt); return; }

  const spawnArgs = [];
  if (MODEL) spawnArgs.push('--model', MODEL);

  // capture agent output to prompts/ and logs/ directories in cwd
  ensureDir('prompts'); ensureDir('logs');
  const promptPath = path.join('prompts', `issue-${selected.number}.txt`);
  fs.writeFileSync(promptPath, prompt);
  const logPath = path.join('logs', `issue-${selected.number}.log`);
  const outStream = fs.createWriteStream(logPath, { flags: 'a' });

  console.log(`Spawning agent: ${AGENT_CMD} ${spawnArgs.join(' ')} (timeout ${TIMEOUT_SECS}s). Logs: ${logPath}`);
  const agentProc = spawn(AGENT_CMD, spawnArgs, { stdio: ['pipe','pipe','pipe'] });

  const timeout = setTimeout(() => { if (!agentProc.killed) { console.warn(`Agent did not exit in ${TIMEOUT_SECS}s; killing.`); agentProc.kill('SIGKILL'); } }, TIMEOUT_SECS*1000);

  agentProc.stdout.pipe(outStream); agentProc.stderr.pipe(outStream);
  agentProc.stdin.write(prompt); agentProc.stdin.end();

  const exitCode = await new Promise(resolve => { agentProc.on('close', code => resolve(code)); agentProc.on('error', err => { console.error('Agent process error:', err.message); resolve(1); }); });
  clearTimeout(timeout); outStream.end();

  console.log(`Agent finished with code ${exitCode}. Log saved to ${logPath}`);

  // For GH mode, verify issue closed (original behavior)
  try {
    const j = execGhJson(['issue','view','-R', REPO, String(selected.number), '--json', 'state']);
    const state = j.state;
    if (state.toUpperCase() === 'CLOSED') console.log(`Issue #${selected.number} is closed — continuing (if you want automatic loops, rerun).`);
    else console.log(`Issue #${selected.number} remains open. Stopping as agent may have failed to close or open a PR.`);
  } catch (e) { console.error('Failed to verify selected issue state:', e.message); }
}

// Entrypoint
(async function main() {
  try {
    if (LOCAL_DIR) await runLocalMode(); else await runGitHubMode();
  } catch (e) { console.error('Unhandled error:', e); process.exit(1); }
})();
