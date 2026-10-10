import { test } from '@substrate-system/tapzero'
import {
    emptyStreamStats,
    nextStreamStats,
    emptyRunStats,
    addRun,
    renderRunStats,
    addStats,
    formatStats,
} from '../src/stats.js'
import type { RunStats } from '../src/stats.js'

function toolUse (name:unknown, id:unknown):unknown {
    return { type:'tool_use', name, id, input:{} }
}

function assistant (
    blocks:unknown,
    parent:unknown = null
):unknown {
    return {
        type:'assistant',
        parent_tool_use_id:parent,
        message:{ content:blocks },
    }
}

function fold (values:unknown[]) {
    return values.reduce(nextStreamStats, emptyStreamStats())
}

// -- AC3.1: a main-loop Agent tool_use counts one subagent --

test('AC3.1: a main-loop Agent tool_use counts one subagent', t => {
    const state = fold([
        assistant([toolUse('Agent', 'toolu_1')]),
    ])
    t.deepEqual(state.stats, { subagents:1 })
})

// -- AC3.2: a main-loop Task tool_use counts; other tools do not --

test('AC3.2: a main-loop Task tool_use counts one subagent', t => {
    const state = fold([
        assistant([toolUse('Task', 'toolu_1')]),
    ])
    t.deepEqual(state.stats, { subagents:1 })
})

test('AC3.2: a non-subagent tool_use counts nothing', t => {
    const state = fold([
        assistant([toolUse('Bash', 'toolu_1')]),
    ])
    t.deepEqual(state.stats, { subagents:0 })
})

// -- AC3.3: messages from inside a subagent are not counted --

test('AC3.3: a message with parent_tool_use_id is not counted', t => {
    const state = emptyStreamStats()
    const next = nextStreamStats(
        state,
        assistant([toolUse('Agent', 'toolu_1')], 'toolu_x'),
    )
    t.equal(next, state)
})

test('AC3.3: a message without parent_tool_use_id is counted', t => {
    const obj = {
        type:'assistant',
        message:{ content:[toolUse('Agent', 'toolu_1')] },
    }
    const next = nextStreamStats(emptyStreamStats(), obj)
    t.deepEqual(next.stats, { subagents:1 })
})

// -- AC3.4: a repeated tool_use id counts once --

test('AC3.4: the same tool_use id in two messages counts once', t => {
    const state = fold([
        assistant([toolUse('Agent', 'toolu_1')]),
        assistant([toolUse('Agent', 'toolu_1')]),
    ])
    t.equal(state.stats.subagents, 1)
})

test('AC3.4: the same tool_use id twice in one message counts once', t => {
    const state = fold([
        assistant([
            toolUse('Agent', 'toolu_1'),
            toolUse('Agent', 'toolu_1'),
        ]),
    ])
    t.equal(state.stats.subagents, 1)
})

// -- AC3.5: result messages set cost and replace the count --

test('AC3.5: a result without subagent_stats keeps the live count', t => {
    const state = fold([
        assistant([toolUse('Agent', 'toolu_1')]),
        assistant([toolUse('Agent', 'toolu_2')]),
        { type:'result', total_cost_usd:0.5 },
    ])
    t.deepEqual(state.stats, { subagents:2, costUsd:0.5 })
})

test('AC3.5: a result with subagent_stats replaces the count', t => {
    const state = fold([
        assistant([toolUse('Agent', 'toolu_1')]),
        {
            type:'result',
            total_cost_usd:0.5,
            subagent_stats:{ spawned:5 },
        },
    ])
    t.deepEqual(state.stats, { subagents:5, costUsd:0.5 })
})

test('AC3.5: a result with only subagent_stats omits the cost key', t => {
    const state = fold([
        { type:'result', subagent_stats:{ spawned:2 } },
    ])
    t.deepEqual(state.stats, { subagents:2 })
    t.ok(!('costUsd' in state.stats), 'costUsd key is absent')
})

test('AC3.5: the last of several results wins and nothing is summed', t => {
    const state = fold([
        {
            type:'result',
            total_cost_usd:0.5,
            subagent_stats:{ spawned:3 },
        },
        {
            type:'result',
            total_cost_usd:0.75,
            subagent_stats:{ spawned:4 },
        },
    ])
    t.deepEqual(state.stats, { subagents:4, costUsd:0.75 })
})

test('AC3.5: a repeated identical result returns the same state', t => {
    const result = {
        type:'result',
        total_cost_usd:0.5,
        subagent_stats:{ spawned:3 },
    }
    const first = nextStreamStats(emptyStreamStats(), result)
    const second = nextStreamStats(first, result)
    t.equal(second, first)
})

// -- AC3.6: malformed input leaves the state unchanged --

test('AC3.6: non-object values return the input state', t => {
    const state = fold([assistant([toolUse('Agent', 'toolu_1')])])
    const inputs:unknown[] = [
        undefined,
        null,
        42,
        'text',
        [],
    ]
    for (const input of inputs) {
        t.equal(nextStreamStats(state, input), state)
    }
})

test('AC3.6: malformed assistant messages return the input state', t => {
    const state = emptyStreamStats()
    const inputs:unknown[] = [
        { type:'assistant' },
        { type:'assistant', message:{ content:'x' } },
        assistant([toolUse(1, 'toolu_1')]),
        assistant([toolUse('Agent', 1)]),
    ]
    for (const input of inputs) {
        t.equal(nextStreamStats(state, input), state)
    }
})

test('AC3.6: malformed result fields return the input state', t => {
    const state = emptyStreamStats()
    const inputs:unknown[] = [
        { type:'result', total_cost_usd:'1' },
        { type:'result', total_cost_usd:NaN },
        { type:'result', subagent_stats:{ spawned:-1 } },
        { type:'result', subagent_stats:{ spawned:1.5 } },
    ]
    for (const input of inputs) {
        t.equal(nextStreamStats(state, input), state)
    }
})

// -- AC6.1: no reported data renders nothing --

test('AC6.1: renderRunStats is null when no run reported anything', t => {
    t.equal(renderRunStats(emptyRunStats()), null)
})

test('AC6.1: a run with no subagents and no cost renders nothing', t => {
    const run = addRun(emptyRunStats(), {})
    t.equal(renderRunStats(run), null)
})

// -- AC6.2: the line has the subagent total, runs and cost --

test('AC6.2: the tally sums subagents and cost across runs', t => {
    const run = addRun(
        addRun(emptyRunStats(), { subagents:2, costUsd:0.5 }),
        { subagents:1, costUsd:0.25 },
    )
    t.deepEqual(run, {
        agentRuns:2,
        withCost:2,
        subagents:3,
        costUsd:0.75,
    })
})

test('AC6.2: the line names the subagents, runs and cost', t => {
    const run = addRun(
        addRun(emptyRunStats(), { subagents:2, costUsd:0.5 }),
        { subagents:1, costUsd:0.25 },
    )
    const line = renderRunStats(run)
    t.ok(line !== null, 'line is rendered')
    t.ok(line?.includes('3'), 'includes the subagent total')
    t.ok(line?.includes(' 2 '), 'includes the agent-run count')
    t.ok(line?.includes('0.75'), 'includes the cost')
})

// -- AC6.3: the partial-cost marker appears only when some runs
//    reported no cost --

test('AC6.3: partial-cost marker only when some runs lack cost', t => {
    const full:RunStats = {
        agentRuns:2,
        withCost:2,
        subagents:3,
        costUsd:0.5,
    }
    const partial:RunStats = { ...full, withCost:1 }
    const fullLine = renderRunStats(full)
    const partialLine = renderRunStats(partial)
    t.ok(fullLine !== null, 'full line is rendered')
    t.ok(partialLine !== null, 'partial line is rendered')
    t.ok(
        partialLine?.startsWith(fullLine ?? ''),
        'partial line starts with the full line',
    )
    t.ok(
        (partialLine?.length ?? 0) > (fullLine?.length ?? 0),
        'partial line is longer',
    )
})

// -- AC5.2: a ticket's running total across attempts --

test('AC5.2: addStats sums subagents and cost', t => {
    t.deepEqual(
        addStats({ subagents:1, costUsd:0.25 }, { subagents:2, costUsd:0.5 }),
        { subagents:3, costUsd:0.75 },
    )
})

test('AC5.2: addStats keeps no cost when neither side has one', t => {
    const total = addStats({ subagents:1 }, { subagents:1 })
    t.deepEqual(total, { subagents:2 })
    t.ok(!('costUsd' in total), 'no costUsd key')
})

test('AC5.2: addStats keeps a cost reported by either side', t => {
    t.deepEqual(
        addStats({ subagents:1, costUsd:0.25 }, {}),
        { subagents:1, costUsd:0.25 },
    )
    t.deepEqual(
        addStats({ subagents:0 }, { subagents:2, costUsd:0.5 }),
        { subagents:2, costUsd:0.5 },
    )
})

// -- AC5.1: the display row suffix --

test('AC5.1: formatStats is null when there is nothing to show', t => {
    t.equal(formatStats(undefined), null)
    t.equal(formatStats({ subagents:0 }), null)
})

test('AC5.1: formatStats renders a count or a cost', t => {
    t.ok(formatStats({ subagents:0, costUsd:0.1 }) !== null, 'cost only')
    t.ok(formatStats({ subagents:2 }) !== null, 'count only')
    const both = formatStats({ subagents:2, costUsd:0.42 })
    t.ok(both?.includes('2'), 'includes the count')
    t.ok(both?.includes('0.42'), 'includes the cost')
})
