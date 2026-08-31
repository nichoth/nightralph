/**
 * Demo script for the terminal status UI.
 * Run: npx esbuild demo-display.ts --format=esm --bundle --packages=external --outdir=dist && node dist/demo-display.js
 */
import { StatusDisplay } from './src/display.js'

function sleep (ms:number):Promise<void> {
    return new Promise(r => setTimeout(r, ms))
}

const tickets = [
    { num:1, filename:'001-add-login-page.md' },
    { num:2, filename:'002-fix-header-alignment.md' },
    { num:3, filename:'003-refactor-auth-module.md' },
    { num:4, filename:'004-update-dependencies.md' },
    { num:5, filename:'005-add-dark-mode.md' },
    { num:6, filename:'006-improve-error-messages.md' },
    { num:7, filename:'007-add-search-feature.md' },
    { num:8, filename:'008-optimize-queries.md' },
]

async function main () {
    const display = new StatusDisplay()

    // Wave 1: first 4 tickets
    const wave1 = tickets.slice(0, 4)
    display.startWave(1, 3, wave1)
    display.log('Starting wave 1...')

    for (const t of wave1) {
        await sleep(600)
        display.setTicketStatus(t.num, 'in-progress')
        display.log(`Agent working on ${t.filename}`)
        await sleep(1200)
        const status = t.num === 3 ? 'failed' : 'done'
        display.setTicketStatus(t.num, status as any)
        display.log(
            status === 'done' ?
                `Completed ${t.filename}` :
                `Failed ${t.filename}`
        )
    }

    await sleep(1000)

    // Wave 2: next 3 tickets
    const wave2 = tickets.slice(4, 7)
    display.startWave(2, 3, wave2)
    display.log('Starting wave 2...')

    for (const t of wave2) {
        await sleep(600)
        display.setTicketStatus(t.num, 'in-progress')
        display.log(`Agent working on ${t.filename}`)
        await sleep(1000)
        display.setTicketStatus(t.num, 'done')
        display.log(`Completed ${t.filename}`)
    }

    await sleep(1000)

    // Wave 3: last ticket
    const wave3 = tickets.slice(7)
    display.startWave(3, 3, wave3)
    display.log('Starting wave 3...')

    await sleep(600)
    display.setTicketStatus(8, 'in-progress')
    display.log('Agent working on 008-optimize-queries.md')
    await sleep(1500)
    display.setTicketStatus(8, 'done')
    display.log('Completed 008-optimize-queries.md')

    await sleep(800)
    display.cleanup()
    console.log('\nDemo complete.')
}

main()
