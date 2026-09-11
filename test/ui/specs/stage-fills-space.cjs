/**
 * The stage uses the window it is given.
 *
 * Reported with a picture: three people in a call, three small faces along
 * the top, a screen share the size of a postage stamp, and more than half the
 * window showing nothing at all. The grid was
 * `repeat(auto-fit, minmax(300px, 1fr))` with the rows packed to the top, so
 * the tiles were as wide as 300 pixels demanded and as tall as 16:9 made
 * them, and whatever height was left over stayed empty.
 *
 * The arithmetic lives in stageGrid.ts and is tested there against sizes it
 * will never see in a browser. What is checked here is the half that cannot
 * be: that the numbers reach the screen, and that nothing they produce lies
 * across the controls.
 *
 * That last one is not hypothetical. A cell keeping its aspect ratio has
 * overflowed this pane before and sat invisibly on top of the buttons - the
 * stage looked perfect and Leave could not be pressed. So the buttons are
 * hit-tested rather than looked for.
 */
const { signIn } = require('../lib.cjs')

module.exports = {
  name: 'stage-fills-space',
  width: 1400,
  height: 900,

  async run({ js, until, wait, win, check, base }) {
    await win.loadURL(base + '/')
    const setup = await signIn(js, { owner: 'JacksFO', friends: ['Baileyyy'] })
    check('the server can be set up', setup.ok === true, setup.why)

    await win.loadURL(base + '/')
    await until('the channel list', `document.querySelectorAll('.chan').length > 0`)
    await wait(1500)

    const made = await js(`(async () => {
      const token = localStorage.getItem('atrium.token')
      const h = { 'content-type': 'application/json', authorization: 'Bearer ' + token }
      const got = await (await fetch('/api/spaces', { headers: h })).json()
      const space = (got.spaces || [])[0]
      if (!space) return { ok: false, why: 'no server' }
      const r = await fetch('/api/channels', { method: 'POST', headers: h,
        body: JSON.stringify({ spaceId: space.id, name: 'Lounge', kind: 'voice' }) })
      return { ok: r.ok } })()`)
    check('a voice room can be made', made.ok === true, made)

    await win.loadURL(base + '/')
    await until('the rooms', `document.querySelectorAll('.vcard').length > 0`, 15000)
    await wait(2000)

    await js(`(() => {
      const room = [...document.querySelectorAll('.vcard')]
        .find((c) => /lounge/i.test(c.textContent || ''))
      const join = room && [...room.querySelectorAll('button')]
        .find((b) => /join/i.test(b.textContent || ''))
      ;(join || room).click()
      return 1 })()`)
    await until('the call panel', `document.querySelectorAll('.vrow').length > 0`, 20000)

    /* Onto the stage itself, which is the thing being measured. The way in
       is the room's name in the call panel - `.wv`, titled "Open the stage". */
    const opened = await js(`(() => {
      const w = document.querySelector('.wv')
      if (w) { w.click(); return { pressed: true } }
      return { pressed: false,
        buttons: [...document.querySelectorAll('button')]
          .map((b) => (b.title || b.getAttribute('aria-label') || b.textContent || '').trim())
          .filter(Boolean).slice(0, 25) } })()`)
    check('there is a way onto the stage', opened.pressed === true, opened)
    const staged = await until('the stage', `!!document.querySelector('.stbody')`, 15000)
    check('the stage opens', staged === true)
    await wait(1200)

    // --- how much of it is used ---------------------------------------------
    const laid = await js(`(() => {
      const body = document.querySelector('.stbody')
      const cells = [...body.querySelectorAll('.scell')]
      const b = body.getBoundingClientRect()
      if (!cells.length) return { cells: 0 }
      const tops = cells.map((c) => c.getBoundingClientRect())
      const top = Math.min(...tops.map((r) => r.top))
      const bottom = Math.max(...tops.map((r) => r.bottom))
      return {
        cells: cells.length,
        pane: { w: Math.round(b.width), h: Math.round(b.height) },
        cell: { w: Math.round(tops[0].width), h: Math.round(tops[0].height) },
        covered: (bottom - top) / b.height,
        /* The sizes worked out from the box, on the element. Without them the
           stylesheet's own grid is in charge, which is the old behaviour. */
        columns: body.style.gridTemplateColumns,
        rowHeight: body.style.gridAutoRows,
        /* Nothing may stick out of the box it is in. */
        insideY: top >= b.top - 1 && bottom <= b.bottom + 1,
        insideX: Math.min(...tops.map((r) => r.left)) >= b.left - 1
          && Math.max(...tops.map((r) => r.right)) <= b.right + 1,
      } })()`)
    console.log('      laid out: ' + JSON.stringify(laid))

    check('there is somebody on the stage', laid.cells > 0, laid)

    /*
     * That the measured sizes reached the element, which is the half of this
     * a browser can prove and a unit test cannot.
     *
     * Not "the faces are big": with one person on the stage the old layout
     * was already full width, so that check passed identically with the fix
     * switched off - measured, not assumed. The sizing itself is proved in
     * stageGrid.test.ts, which can pose the reported case of three people in
     * a thousand-pixel pane without needing three people in a real call.
     */
    check('the stage is laid out from its own measurements',
      /repeat\(\d+,/.test(laid.columns || '') && /px/.test(laid.rowHeight || ''),
      { columns: laid.columns, rowHeight: laid.rowHeight })
    check('and nothing hangs out of the pane', laid.insideY && laid.insideX, laid)

    // --- and the controls are still pressable -------------------------------
    /*
     * The one that has actually gone wrong before. elementFromPoint, because
     * a cell lying on top of a button looks exactly like a button.
     */
    const buttons = await js(`(() => {
      const out = []
      for (const b of document.querySelectorAll('.stfoot button, .stagepane .stctl button')) {
        const r = b.getBoundingClientRect()
        if (r.width === 0) continue
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        out.push({
          what: (b.textContent || b.getAttribute('aria-label') || '?').trim(),
          reachable: !!hit && (hit === b || b.contains(hit)),
          covered: hit ? hit.className : null,
        })
      }
      return out })()`)
    console.log('      controls: ' + JSON.stringify(buttons))

    /* Asserted together, because `every` over an empty list is true - and a
       stage with no controls found would otherwise report them all pressable. */
    check('the controls are on screen at all', buttons.length > 0, buttons)
    check('and every one of them can actually be pressed',
      buttons.length > 0 && buttons.every((b) => b.reachable),
      buttons.filter((b) => !b.reachable))
  },
}
