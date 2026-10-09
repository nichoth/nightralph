// Blocker references in a ticket's **Blocked by:** field. Pure:
// no file or process access and no imports, so orchestrator.ts
// and resolve.ts can both depend on it.

export type RawRef = {
    feature?:string;  // absent -> the ticket's own feature
    num:number;
}

export type BlockerParse = {
    refs:RawRef[];
    typos:string[];   // feature-shaped words that name no feature
}

const FIELD_RE = /\*\*Blocked by:\*\*/i
const NEXT_FIELD_RE = /^\s*(?:[-*]\s+)?\*\*[^*\n]+:\*\*/
const HEADING_RE = /^\s*#{1,6}\s/
const CHECKLIST_RE = /^\s*[-*+]\s+\[[ xX]\]/
const TOKEN_RE = /[A-Za-z0-9_-]+/g

function endsField (line:string):boolean {
    return line.trim() === '' ||
        NEXT_FIELD_RE.test(line) ||
        HEADING_RE.test(line) ||
        CHECKLIST_RE.test(line)
}

/**
 * The text of the **Blocked by:** field: the rest of its line
 * plus continuation lines, up to a blank line, the next
 * `**Field:**` line, a heading or a checklist item. `null` when
 * the body has no such field.
 */
function fieldText (body:string):string|null {
    const lines = body.split(/\r?\n/)
    const start = lines.findIndex(l => FIELD_RE.test(l))
    if (start === -1) return null
    const first = lines[start]
    const m = FIELD_RE.exec(first)!
    const parts = [first.slice(m.index + m[0].length)]
    for (const line of lines.slice(start + 1)) {
        if (endsField(line)) break
        parts.push(line)
    }
    return parts.join('\n')
}

/**
 * Blanks out backtick spans and `(...)` spans (nested, across
 * lines). Only paired delimiters count; an unpaired `(` or
 * backtick stays as text. Each blanked character becomes a space,
 * so the words on either side never merge.
 */
function stripNotes (text:string):string {
    const chars = [...text]
    const drop = new Array<boolean>(chars.length).fill(false)
    const ticks:number[] = []
    chars.forEach((ch, i) => {
        if (ch === '`') ticks.push(i)
    })
    for (let i = 0; i + 1 < ticks.length; i += 2) {
        for (let j = ticks[i]; j <= ticks[i + 1]; j++) {
            drop[j] = true
        }
    }
    const open:number[] = []
    chars.forEach((ch, i) => {
        if (drop[i]) return
        if (ch === '(') {
            open.push(i)
        } else if (ch === ')' && open.length > 0) {
            const from = open.pop()!
            for (let j = from; j <= i; j++) drop[j] = true
        }
    })
    return chars.map((ch, i) => (drop[i] ? ' ' : ch)).join('')
}

/**
 * A word shaped like a feature dir name: lowercase letters and
 * digits joined by hyphens, with at least one letter. Doc IDs such
 * as `FDR-018` are not.
 */
function looksLikeFeature (word:string):boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(word) && /[a-z]/.test(word)
}

/**
 * Reads the **Blocked by:** field of a ticket body. A number
 * belongs to the feature named by the word directly before it
 * when that word is in `knownFeatures` (the names of
 * `.scratch/<name>/issues` dirs); otherwise to the ticket's own
 * feature. Feature-shaped words that name no feature are returned
 * as `typos`.
 */
export function parseBlockerField (
    body:string,
    knownFeatures:ReadonlySet<string>
):BlockerParse {
    const text = fieldText(body)
    if (text === null) return { refs:[], typos:[] }
    const clean = stripNotes(text)
    if (/^\s*none\b/i.test(clean)) return { refs:[], typos:[] }

    const refs:RawRef[] = []
    const typos:string[] = []
    const seen = new Set<string>()
    const add = (num:number, feature?:string) => {
        const id = `${feature ?? ''}:${num}`
        if (seen.has(id)) return
        seen.add(id)
        refs.push(feature === undefined ? { num } : { feature, num })
    }
    let prev:{ word:string; end:number }|null = null
    for (const m of clean.matchAll(TOKEN_RE)) {
        const word = m[0]
        const start = m.index ?? 0
        if (/^\d+(?:-\d+)*$/.test(word)) {
            const before = prev !== null &&
                /^\s+$/.test(clean.slice(prev.end, start)) ?
                prev.word :
                null
            let feature:string|undefined
            if (before !== null && knownFeatures.has(before)) {
                feature = before
            } else if (
                before !== null &&
                looksLikeFeature(before) &&
                !typos.includes(before)
            ) {
                typos.push(before)
            }
            // both ends of a range belong to the same feature
            for (const n of word.split('-').map(Number)) add(n, feature)
        }
        prev = { word, end:start + word.length }
    }
    return { refs, typos }
}

export type BlockerWhere = 'run'|'done'|'pending'|'missing'

export type BlockerRef = {
    feature:string;
    num:number;
    // 'run'     -> a ticket in this run; its live status decides
    // 'done'    -> outside the run, done when loaded
    // 'pending' -> outside the run, not done (dead this session)
    // 'missing' -> no ticket matches (dead, reported)
    where:BlockerWhere;
    status?:string;   // the outside ticket's status, for messages
}

// Same text as ticketKey in orchestrator.ts, which this module
// must not import.
function refId (feature:string, num:number):string {
    return `${feature}:${num}`
}

/**
 * Classifies raw refs. `selected` maps each feature in the run to
 * its ticket numbers; `lookup` returns the status of a ticket in a
 * feature outside the run, or undefined when there is none.
 * De-duplicates by (feature, num) after the own feature is filled
 * in.
 */
export function resolveBlockers (
    raw:ReadonlyArray<RawRef>,
    ownFeature:string,
    selected:ReadonlyMap<string, ReadonlySet<number>>,
    lookup:(feature:string, num:number) => string|undefined
):BlockerRef[] {
    const out:BlockerRef[] = []
    const seen = new Set<string>()
    for (const r of raw) {
        const feature = r.feature ?? ownFeature
        const id = refId(feature, r.num)
        if (seen.has(id)) continue
        seen.add(id)
        const nums = selected.get(feature)
        if (nums) {
            out.push({
                feature,
                num:r.num,
                where:nums.has(r.num) ? 'run' : 'missing',
            })
            continue
        }
        const status = lookup(feature, r.num)
        if (status === undefined) {
            out.push({ feature, num:r.num, where:'missing' })
        } else {
            out.push({
                feature,
                num:r.num,
                where:status === 'done' ? 'done' : 'pending',
                status,
            })
        }
    }
    return out
}

/**
 * Refs for a bare scan, before the run is known: every ref is
 * `run`, so one that matches no ticket in the list is never
 * satisfied.
 */
export function provisionalRefs (
    raw:ReadonlyArray<RawRef>,
    ownFeature:string
):BlockerRef[] {
    const out:BlockerRef[] = []
    const seen = new Set<string>()
    for (const r of raw) {
        const feature = r.feature ?? ownFeature
        const id = refId(feature, r.num)
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ feature, num:r.num, where:'run' })
    }
    return out
}
