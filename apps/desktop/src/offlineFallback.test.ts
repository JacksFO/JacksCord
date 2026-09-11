import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What the app loads when the server will not answer.
 *
 * The client keeps everything it remembers - the sign-in, the theme, the
 * panel arrangement and widths, every toggle - in the browser's storage, and
 * storage belongs to an origin. The app normally loads from the server's
 * address, so that address is the origin. Falling back to the copy inside the
 * installer means falling back to `app://atrium`, which is a different origin
 * with its own empty storage: the app comes up signed out and factory-reset,
 * then undoes itself the next time the server answers. A restart of the
 * server is enough to do it.
 *
 * Read out of the source because the failure is a line of code coming back,
 * not a value being wrong, and because standing an Electron app up with an
 * unreachable server is not something to do on somebody's desktop.
 */

const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

/** The body of `loadClient`, which is the whole of the decision. */
const loadClient = (() => {
  const at = main.indexOf('async function loadClient(')
  expect(at, 'loadClient is still in main.ts').toBeGreaterThan(0)
  const end = main.indexOf('\n}', at)
  return main.slice(at, end)
})()

describe('when the server cannot be reached', () => {
  it('shows a page that stores nothing, not the bundled client', () => {
    expect(loadClient).toContain('offline.html')
  })

  it('and loads the bundled client only when there is no address at all', () => {
    /*
     * That case is the first-run screen: nothing is signed in, nothing is
     * stored, and there is nothing to look reset. It is the one place
     * app://atrium is right.
     */
    const uses = loadClient.split('app://atrium')
    expect(uses.length - 1, 'exactly one fallback to the bundled client').toBe(1)
    const before = uses[0]!
    expect(before, 'guarded by there being no server').toContain('if (!server)')
    expect(before.lastIndexOf('if (!server)'))
      .toBeGreaterThan(before.lastIndexOf('catch'))
  })

  it('keeps trying, and backs off rather than hammering', () => {
    expect(loadClient).toContain('RETRY_WAITS')
    const waits = /const RETRY_WAITS = \[([^\]]+)\]/.exec(main)
    expect(waits, 'the waits are declared').not.toBe(null)
    const ms = waits![1]!.split(',').map((n) => Number(n.trim()))
    expect(ms.length).toBeGreaterThan(1)
    expect(ms[0]).toBeGreaterThanOrEqual(1000)
    for (let i = 1; i < ms.length; i += 1) {
      expect(ms[i], 'each wait is longer than the last').toBeGreaterThan(ms[i - 1]!)
    }
  })

  it('and a successful load stops it trying', () => {
    expect(loadClient).toContain('stopRetrying()')
  })
})

describe('the page it shows', () => {
  const page = readFileSync(join(__dirname, 'offline.html'), 'utf8')

  it('stores nothing itself', () => {
    /* The whole point of it. A page that stores nothing cannot look reset,
       and cannot become a second place preferences live. */
    expect(page).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
  })

  it('and talks to nothing but the main process', () => {
    expect(page).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|<script[^>]+src=/)
  })

  it('offers the window controls, since there is no title bar to close it by', () => {
    for (const id of ['min', 'max', 'close']) expect(page).toContain(`id="${id}"`)
  })

  it('and a way to try again that does not need the server', () => {
    expect(page).toContain('bridge.retry')
  })

  /*
   * And no offer to point the app somewhere else.
   *
   * There used to be a "Use a different server" button here, from when this
   * was a thing somebody ran themselves. There is one hosted Atrium now and
   * its address is built in, so that button led nowhere - and it appeared on
   * the one screen somebody reaches when things are already going wrong,
   * which is the worst place to offer a dead end. Reported exactly that way.
   */
  it('and does not offer to send the app at a different server', () => {
    /* Comments stripped first: the note explaining why that button went says
       its name, and a note about a thing is not an offer of it. */
    const offered = page.replace(/<!--[\s\S]*?-->/g, '')
    expect(offered).not.toMatch(/clearServer|different server/i)
  })
})
