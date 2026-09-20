# 03: Display feature/num prefix

**What to build:** The terminal status UI renders tickets as
`feature/num` (e.g. `auth/01`, `payments/03`) instead of bare
filenames when the ticket carries a feature name. `DisplayTicket`
gains an optional `feature` field. `setTicketStatus` uses compound
identity (feature + num) so that two features with the same ticket
number update the correct row. `startWave` accepts feature on ticket
objects. When `feature` is absent (single-feature run), the display
falls back to the current filename-only rendering.

**Blocked by:** 01: Ticket compound identity and feature-prefixed
branch naming

**Touches:** `src/display.ts` (`DisplayTicket`, `StatusDisplay`,
`PlainDisplay`, `Display` interface), `test/display.test.ts`

**Status:** ready-for-agent

- [x] `DisplayTicket` has an optional `feature?:string` field
- [x] `StatusDisplay` renders each ticket row as `feature/num` when `feature` is present, otherwise falls back to filename
- [x] `PlainDisplay.startWave` includes the `feature/num` format in its output when feature is present
- [x] `setTicketStatus` matches tickets by compound identity (feature + num) when feature is present, by num alone when absent
- [x] Display tests verify `feature/num` rendering with tickets from multiple features
