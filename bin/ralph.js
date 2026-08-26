#!/usr/bin/env node
/**
 * night-ralph: simple Node orchestrator
 *
 * Basic behavior:
 *  - Find open issues with label `ready-for-agent` in the repo (via `gh`).
 *  - Pick child issues whose body contains "parent" reference to the PRD.
 *  - For each candidate (lowest numbered unblocked), run an agent process once:
 *      spawn `claude` (configurable), pipe the rendered prompt to stdin, wait for exit.
 *  - After agent exits, check the selected issue is closed; if closed, continue.
 *
 * Usage:
 *   night-ralph --prd <num> --repo owner/name [--agent claude] [--model <m>] [--dry-run]
 *
 * Minimal and dependency-free.
 */

const { spawn, execFileSync } = require("child_process");

function usageAndExit(code = 1) {
  console.log(`Usage: night-ralph --prd <number> --repo <owner/name> [--agent claude] [--model <model>] [--dry-run] [--timeout-secs N]`);
  process.exit(code);
}

const argv = process.argv.slice(2);
let PRD = null;
let REPO = null;
let AGENT_CMD = "claude";
let MODEL = null;
let DRY = false;
let TIMEOUT_SECS = 300;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--prd") PRD = Number(argv[++i]);
  else if (a === "--repo") REPO = argv[++i];
  else if (a === "--agent") AGENT_CMD = argv[++i];
  else if (a === "--model") MODEL = argv[++i];
  else if (a === "--dry-run") DRY = true;
  else if (a === "--timeout-secs") TIMEOUT_SECS = Number(argv[++i]);
  else {
    console.error("Unknown arg:", a);
    usageAndExit();
  }
}

if (!PRD || !REPO) {
  console.error("Missing required flags --prd and/or --repo");
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

function extract_parent_prd(body) {
  const arr = extract_section_issue_numbers(body, "parent");
  return arr.length ? arr[0] : null;
}
function extract_blockers(body) {
  return extract_section_issue_numbers(body, "blocked by");
}

// Check blockers: returns true if every blocker is closed
function allBlockersClosed(repo, blockers) {
  for (const num of blockers) {
    try {
      const j = execGhJson(["issue", "view", "-R", repo, String(num), "--json", "state"]);
      const state = j.state; // "OPEN" or "CLOSED"
      if (state.toUpperCase() !== "CLOSED") return false;
    } catch (e) {
      // If we can't fetch an issue, assume not closed (be conservative).
      console.error(`Warning: failed to fetch blocker #${num}: ${e.message}`);
      return false;
    }
  }
  return true;
}

function renderPrompt(prdBody, issue) {
  return [
    "---- PRD CONTEXT ----",
    prdBody,
    "",
    "---- ISSUE ----",
    `#${issue.number} ${issue.title}`,
    issue.body,
    "",
    "---- AGENT INSTRUCTIONS ----",
    "You are an autonomous coding agent. Implement the issue and open a PR.",
    ""
  ].join("\n");
}


// Main loop
(async function main() {
  console.log(`night-ralph: starting for PRD #${PRD} in ${REPO}; agent=${AGENT_CMD}${MODEL ? " model="+MODEL : ""}${DRY ? " [dry-run]" : ""}`);

  // Load PRD body
  let prdBody;
  try {
    const prdJson = execGhJson(["issue", "view", "-R", REPO, String(PRD), "--json", "number,title,body"]);
    prdBody = prdJson.body || "";
  } catch (e) {
    console.error("Failed to fetch PRD:", e.message);
    process.exit(2);
  }

  // Fetch candidate issues labeled ready-for-agent
  let issues;
  try {
    issues = execGhJson(["issue", "list", "-R", REPO, "--json", "number,title,body", "--label", "ready-for-agent", "--state", "open"]);
  } catch (e) {
    console.error("Failed to list issues:", e.message);
    process.exit(3);
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    console.log("No ready-for-agent issues found. Exiting.");
    return;
  }

  // Filter to child issues that declare this PRD as parent
  const children = issues
    .map(i => ({ number: i.number, title: i.title, body: i.body || "" }))
    .filter(i => {
      const parent = extract_parent_prd(i.body);
      return parent === PRD;
    })
    .sort((a, b) => a.number - b.number);

  if (children.length === 0) {
    console.log("No child issues found for this PRD with label ready-for-agent.");
    return;
  }

  console.log(`Found ${children.length} candidate child issues; selecting lowest-numbered unblocked candidate.`);

  // Find first candidate with blockers satisfied
  let selected = null;
  for (const c of children) {
    const blockers = extract_blockers(c.body);
    if (blockers.length === 0 || allBlockersClosed(REPO, blockers)) {
      selected = c;
      break;
    } else {
      console.log(`#${c.number} blocked by ${blockers.join(", ")}; skipping.`);
    }
  }

  if (!selected) {
    console.log("No unblocked candidates found. Exiting.");
    return;
  }

  console.log(`Selected #${selected.number}: ${selected.title}`);

  const prompt = renderPrompt(prdBody, selected);

  if (DRY) {
    console.log("DRY RUN: would invoke agent with the following prompt:\n");
    console.log(prompt);
    return;
  }

  // Spawn agent process. We stream prompt to stdin and wait for exit.
  const spawnArgs = [];
  if (MODEL) {
    spawnArgs.push("--model", MODEL);
  }

  console.log(`Spawning agent: ${AGENT_CMD} ${spawnArgs.join(" ")} (timeout ${TIMEOUT_SECS}s)`);
  const agentProc = spawn(AGENT_CMD, spawnArgs, { stdio: ["pipe", "inherit", "inherit"] });

  // safety: kill after timeout if still running
  const timeout = setTimeout(() => {
    if (!agentProc.killed) {
      console.warn(`Agent did not exit in ${TIMEOUT_SECS}s; killing.`);
      agentProc.kill("SIGKILL");
    }
  }, TIMEOUT_SECS * 1000);

  // write prompt and then close stdin so agent sees EOF
  agentProc.stdin.write(prompt);
  agentProc.stdin.end();

  const exitCode = await new Promise(resolve => {
    agentProc.on("close", code => resolve(code));
    agentProc.on("error", err => {
      console.error("Agent process error:", err.message);
      resolve(1);
    });
  });

  clearTimeout(timeout);

  console.log(`Agent finished with code ${exitCode}`);

  // Verify the issue is closed now
  try {
    const j = execGhJson(["issue", "view", "-R", REPO, String(selected.number), "--json", "state"]);
    const state = j.state;
    if (state.toUpperCase() === "CLOSED") {
      console.log(`Issue #${selected.number} is closed — continuing (if you want automatic loops, rerun).`);
    } else {
      console.log(`Issue #${selected.number} remains open. Stopping as agent may have failed to close or open a PR.`);
    }
  } catch (e) {
    console.error("Failed to verify selected issue state:", e.message);
  }

})();
