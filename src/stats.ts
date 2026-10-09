// Subagent counts and cost read from claude's stream-json output,
// and the run-wide total. Pure: imports nothing, so the
// orchestrator, display and tests can all use it.

export type SubagentStats = {
    subagents:number
    // absent until a `result` message reports it
    costUsd?:number
}

export type StreamStatsState = {
    readonly stats:SubagentStats
    // tool_use ids already counted, so a repeated id counts once
    readonly seenToolIds:ReadonlySet<string>
}

export type RunStats = {
    // spawnAgent results tallied
    readonly agentRuns:number
    // of those, how many reported a cost
    readonly withCost:number
    readonly subagents:number
    readonly costUsd:number
}

// Starting a subagent is a tool_use named `Agent`; Claude Code
// named it `Task` before 2.1.63.
const SUBAGENT_TOOLS:ReadonlySet<string> = new Set(['Agent', 'Task'])

export function isRecord (value:unknown):value is Record<string, unknown> {
    return typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
}

export function emptyStreamStats ():StreamStatsState {
    return { stats:{ subagents:0 }, seenToolIds:new Set() }
}

/**
 * Fold one parsed stream-json value into the state. Returns the
 * same `state` object when nothing changed, so callers can detect
 * a change by identity. Never throws.
 */
export function nextStreamStats (
    state:StreamStatsState,
    obj:unknown
):StreamStatsState {
    if (!isRecord(obj)) return state
    if (obj.type === 'assistant') return countSubagents(state, obj)
    if (obj.type === 'result') return applyResult(state, obj)
    return state
}

function countSubagents (
    state:StreamStatsState,
    obj:Record<string, unknown>
):StreamStatsState {
    // A message from inside a subagent carries the id of the
    // tool_use that started it; only the main loop is counted.
    if (obj.parent_tool_use_id != null) return state
    const message = obj.message
    if (!isRecord(message) || !Array.isArray(message.content)) {
        return state
    }
    const ids:string[] = []
    for (const block of message.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue
        if (
            typeof block.name !== 'string' ||
            !SUBAGENT_TOOLS.has(block.name)
        ) continue
        if (typeof block.id !== 'string') continue
        if (state.seenToolIds.has(block.id)) continue
        if (ids.includes(block.id)) continue
        ids.push(block.id)
    }
    if (ids.length === 0) return state
    return {
        stats:{
            ...state.stats,
            subagents:state.stats.subagents + ids.length,
        },
        seenToolIds:new Set([...state.seenToolIds, ...ids]),
    }
}

// `total_cost_usd` is cumulative and a process can emit several
// `result` messages, so the latest one replaces earlier values.
function applyResult (
    state:StreamStatsState,
    obj:Record<string, unknown>
):StreamStatsState {
    const cost = obj.total_cost_usd
    const hasCost = typeof cost === 'number' && Number.isFinite(cost)
    const subagentStats = obj.subagent_stats
    const spawned = isRecord(subagentStats) ?
        subagentStats.spawned :
        undefined
    const hasSpawned = typeof spawned === 'number' &&
        Number.isInteger(spawned) &&
        spawned >= 0
    if (!hasCost && !hasSpawned) return state

    const subagents = hasSpawned ?
        spawned :
        state.stats.subagents
    const costUsd = hasCost ?
        cost :
        state.stats.costUsd
    // A repeated result with the same values is not a change
    if (
        subagents === state.stats.subagents &&
        costUsd === state.stats.costUsd
    ) return state
    return {
        stats:costUsd === undefined ?
            { subagents } :
            { subagents, costUsd },
        seenToolIds:state.seenToolIds,
    }
}

// The running total of a ticket's attempts. A cost is kept as
// soon as either side reports one.
export function addStats (
    total:SubagentStats,
    run:{ subagents?:number; costUsd?:number }
):SubagentStats {
    const subagents = total.subagents + (run.subagents ?? 0)
    if (total.costUsd === undefined && run.costUsd === undefined) {
        return { subagents }
    }
    return {
        subagents,
        costUsd:(total.costUsd ?? 0) + (run.costUsd ?? 0),
    }
}

/**
 * The display row suffix, e.g. `2 subagents, $0.42`, or `null`
 * when there is nothing to show.
 */
export function formatStats (stats?:SubagentStats):string|null {
    if (!stats) return null
    if (stats.subagents === 0 && stats.costUsd === undefined) {
        return null
    }
    const count = `${stats.subagents} ` +
        (stats.subagents === 1 ? 'subagent' : 'subagents')
    return stats.costUsd === undefined ?
        count :
        `${count}, $${stats.costUsd.toFixed(2)}`
}

export function emptyRunStats ():RunStats {
    return { agentRuns:0, withCost:0, subagents:0, costUsd:0 }
}

export function addRun (
    run:RunStats,
    result:{ subagents?:number; costUsd?:number }
):RunStats {
    return {
        agentRuns:run.agentRuns + 1,
        withCost:run.withCost + (result.costUsd === undefined ? 0 : 1),
        subagents:run.subagents + (result.subagents ?? 0),
        costUsd:run.costUsd + (result.costUsd ?? 0),
    }
}

/**
 * The one-line total logged after the finish summary, or `null`
 * when no run reported a subagent or a cost (codex and pi never
 * do).
 */
export function renderRunStats (run:RunStats):string|null {
    if (run.agentRuns === 0) return null
    if (run.withCost === 0 && run.subagents === 0) return null
    const runs = `${run.agentRuns} agent ` +
        (run.agentRuns === 1 ? 'run' : 'runs')
    const partial = run.withCost < run.agentRuns ?
        ` (cost from ${run.withCost} of ${run.agentRuns} runs)` :
        ''
    return `Subagents: ${run.subagents} started across ${runs}, ` +
        `cost $${run.costUsd.toFixed(2)}${partial}`
}
