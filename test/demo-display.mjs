import { StatusDisplay } from '../dist/display.js'

const d = new StatusDisplay()
d.startWave(1, 2, [
    { num:1, filename:'01-auth-middleware.md' },
    { num:2, filename:'02-api-endpoints.md' },
    { num:3, filename:'03-dashboard-ui.md' },
], { completed:0, total:5 }, [
    { num:4, filename:'04-notifications.md' },
    { num:5, filename:'05-deploy-config.md' },
])

d.setTicketStatus(1, 'in-progress')
let i = 0

const iv = setInterval(() => {
    i++
    d.log(`[01-auth-middleware] Agent output line ${i}`)

    if (i === 8) {
        d.setTicketStatus(1, 'done')
        d.setTicketStatus(2, 'in-progress')
    }
    if (i === 15) {
        d.setTicketStatus(2, 'done')
        d.setTicketStatus(3, 'in-progress')
    }
    if (i === 20) {
        d.setTicketStatus(3, 'failed')
    }
    if (i > 25) {
        clearInterval(iv)
        d.cleanup()
        console.log('\nDemo complete.')
    }
}, 300)
