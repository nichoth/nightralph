import {
    findReadyTickets,
    simulateRun,
    ticketKey,
    type Ticket,
} from './orchestrator.js'
import { ticketLabel } from './display.js'
import type { BlockerRef, BlockerWarning } from './blockers.js'
import type { LoadedSelection } from './resolve.js'

export type TicketId = {
    feature:string;
    num:number;
}

/**
 * One blocker ref of an open ticket, with the ticket it is on. A
 * `run` ref carries the blocking ticket's status in `ref.status`.
 */
export type UpstreamRef = {
    from:TicketId;
    ref:BlockerRef;
}

export type Suggestion = {
    features:string[];      // target first, then upstream, sorted
    edges:UpstreamRef[];    // every needed cross-feature ref
    runnable:number;        // target tickets that run in some wave
    total:number;           // target ready-for-agent tickets
    deadEnds:UpstreamRef[]; // why the rest never run
    cycles:string[];        // labels of needed tickets in a cycle
}

export type FeatureReport = {
    feature:string;
    ready:number;           // ready if run alone, as the picker
    total:number;           // all tickets, as the picker
    // null: no cross-feature edge and no dead ref into another
    // feature
    suggestion:Suggestion|null;
}

export type LoadFn = (names:string[]) => LoadedSelection

function idOf (t:Ticket):TicketId {
    return { feature:t.feature, num:t.num }
}

function byFeatureThenNum (a:UpstreamRef, b:UpstreamRef):number {
    return a.from.feature.localeCompare(b.from.feature) ||
        a.ref.feature.localeCompare(b.ref.feature) ||
        a.from.num - b.from.num ||
        a.ref.num - b.ref.num
}

/**
 * The `pending` refs of ready-for-agent tickets, grouped by the
 * feature they point into. Direct edges only; the picker label
 * uses the keys.
 */
export function upstreamOf (
    tickets:ReadonlyArray<Ticket>
):Map<string, UpstreamRef[]> {
    const groups = new Map<string, UpstreamRef[]>()
    for (const t of tickets) {
        if (t.status !== 'ready-for-agent') continue
        for (const ref of t.blockers) {
            if (ref.where !== 'pending') continue
            const list = groups.get(ref.feature) ?? []
            list.push({ from:idOf(t), ref })
            groups.set(ref.feature, list)
        }
    }
    return groups
}

/**
 * Every unsatisfied ref reached from the target's ready-for-agent
 * tickets, following in-run refs into ready-for-agent tickets only
 * (each ticket once, so cycles end). Done refs and done tickets are
 * skipped; a ticket in any other status is reached but not walked
 * past. `needed` is the keys of the tickets walked, the target's
 * own included.
 */
function walkNeeded (
    tickets:ReadonlyArray<Ticket>,
    target:string
):{ reached:UpstreamRef[]; needed:Set<string> } {
    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    const stack = tickets.filter(t => (
        t.feature === target && t.status === 'ready-for-agent'
    ))
    const needed = new Set(stack.map(t => ticketKey(t.feature, t.num)))
    const reached:UpstreamRef[] = []
    while (stack.length > 0) {
        const t = stack.pop()!
        for (const ref of t.blockers) {
            if (ref.where === 'done') continue
            if (ref.where !== 'run') {
                reached.push({ from:idOf(t), ref })
                continue
            }
            const key = ticketKey(ref.feature, ref.num)
            const blocker = byKey.get(key)
            if (!blocker || blocker.status === 'done') continue
            reached.push({
                from:idOf(t),
                ref:{ ...ref, status:blocker.status },
            })
            if (blocker.status !== 'ready-for-agent') continue
            if (needed.has(key)) continue
            needed.add(key)
            stack.push(blocker)
        }
    }
    return { reached, needed }
}

/**
 * The `pending` refs the target needs, directly or through in-run
 * tickets. A `missing` ref is a dead end and is not returned.
 */
export function neededPending (
    tickets:ReadonlyArray<Ticket>,
    target:string
):UpstreamRef[] {
    return walkNeeded(tickets, target).reached
        .filter(r => r.ref.where === 'pending')
        .sort(byFeatureThenNum)
}

/**
 * The features to run together so the target's tickets can run:
 * start from the target, add the features behind `neededPending`,
 * reload, and repeat until the selection stops growing. Then check
 * the final selection with `simulateRun`.
 */
export function suggestSelection (
    load:LoadFn,
    target:string
):Suggestion {
    let features = [target]
    let { tickets } = load(features)
    while (true) {
        const more = neededPending(tickets, target)
            .map(r => r.ref.feature)
            .filter(f => !features.includes(f))
        if (more.length === 0) break
        // A pending ref always points outside the selection, so
        // each round adds at least one feature and the loop ends.
        features = [...features, ...new Set(more)]
        tickets = load(features).tickets
    }

    const byKey = new Map(
        tickets.map(t => [ticketKey(t.feature, t.num), t])
    )
    const withStatus = (ref:BlockerRef):BlockerRef => {
        const b = ref.where === 'run' ?
            byKey.get(ticketKey(ref.feature, ref.num)) :
            undefined
        return b ? { ...ref, status:b.status } : ref
    }

    const { reached, needed } = walkNeeded(tickets, target)
    const sim = simulateRun(tickets)
    const inWave = new Set(
        sim.waves.flat().map(t => ticketKey(t.feature, t.num))
    )
    const own = tickets
        .filter(t => (
            t.feature === target && t.status === 'ready-for-agent'
        ))
        .sort((a, b) => a.num - b.num)

    return {
        features:[
            target,
            ...features
                .filter(f => f !== target)
                .sort((a, b) => a.localeCompare(b)),
        ],
        edges:reached
            .filter(r => (
                r.ref.where !== 'missing' &&
                r.ref.feature !== r.from.feature
            ))
            .sort(byFeatureThenNum),
        runnable:own.filter(t => (
            inWave.has(ticketKey(t.feature, t.num))
        )).length,
        total:own.length,
        deadEnds:own.flatMap(t => (
            sim.deadRefs.get(ticketKey(t.feature, t.num)) ?? []
        ).map(ref => ({ from:idOf(t), ref:withStatus(ref) }))),
        cycles:sim.neverRun
            .filter(t => {
                const key = ticketKey(t.feature, t.num)
                return needed.has(key) && !sim.deadRefs.has(key)
            })
            .sort((a, b) => (
                a.feature.localeCompare(b.feature) || a.num - b.num
            ))
            .map(t => ticketLabel(t)),
    }
}

// Whether a feature belongs in the report: it waits on another
// feature, or one of its tickets has a dead ref into another
// feature (a ref that matches no ticket there, say).
function crossesFeatures (s:Suggestion):boolean {
    return s.edges.length > 0 || s.deadEnds.some(d => (
        d.ref.feature !== d.from.feature
    ))
}

/**
 * One report per feature, sorted by name: its picker counts and,
 * when it waits on or has a dead ref into another feature, the
 * verified suggestion. Typo warnings come from each feature's own
 * load, so each is listed once. Loads are cached by name list, so
 * no selection is read twice in one call.
 */
export function buildGraph (
    load:LoadFn,
    features:ReadonlyArray<string>
):{ reports:FeatureReport[]; warnings:BlockerWarning[] } {
    const cache = new Map<string, LoadedSelection>()
    const cached:LoadFn = names => {
        const key = names.join('\n')
        const hit = cache.get(key) ?? load(names)
        cache.set(key, hit)
        return hit
    }
    const reports:FeatureReport[] = []
    const warnings:BlockerWarning[] = []
    const sorted = [...new Set(features)]
        .sort((a, b) => a.localeCompare(b))
    for (const feature of sorted) {
        const alone = cached([feature])
        warnings.push(...alone.warnings.filter(w => w.kind === 'typo'))
        const suggestion = suggestSelection(cached, feature)
        reports.push({
            feature,
            ready:findReadyTickets(alone.tickets).length,
            total:alone.tickets.length,
            suggestion:crossesFeatures(suggestion) ? suggestion : null,
        })
    }
    return { reports, warnings }
}
