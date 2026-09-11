/**
 * The call panel does not eat the channel list.
 *
 * Reported: "when in a call with people it then overlaps the channels in the
 * channel bar". The panel is a block in a flex column with the channels above
 * it, and nothing bounded it - so every person who joined made it taller and
 * took that height off the list. Three or four people and the channels were a
 * couple of rows and a scrollbar.
 *
 * Run in a short window on purpose. The bug needs the sidebar to be short of
 * room, and a 900-tall window has enough for both - so at that size the panel
 * behaves whether it is capped or not, and a test there would prove nothing.
 *
 * What cannot be staged here is a call with six people in it: the panel lists
 * whoever the media server says is connected, and a second account joining
 * over the gateway alone does not appear. So the cap and the scroller are
 * checked as properties of the panel rather than by filling it, and the thing
 * those properties exist to protect - the channels still being usable, the
 * buttons still being pressable - is checked directly.
 */
const { signIn } = require('../lib.cjs')

module.exports = {
  name: 'call-panel-room',
  width: 1200,
  /* Short, so the sidebar has to make a choice. */
  height: 560,

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

    /* How much room the channels had before anybody was in a call, to
       compare against. */
    const before = await js(`(() => {
      const list = document.querySelector('.sidepane .scroll')
      return { channels: Math.round(list.getBoundingClientRect().height) } })()`)

    await js(`(() => {
      const room = [...document.querySelectorAll('.vcard')]
        .find((c) => /lounge/i.test(c.textContent || ''))
      const join = room && [...room.querySelectorAll('button')]
        .find((b) => /join/i.test(b.textContent || ''))
      ;(join || room).click()
      return 1 })()`)
    check('the call panel appears',
      await until('the panel', `!!document.querySelector('.vhud')`, 20000))
    await wait(1500)

    const after = await js(`(() => {
      const pane = document.querySelector('.sidepane')
      const hud = document.querySelector('.vhud')
      const list = document.querySelector('.sidepane .scroll')
      const people = hud.querySelector('.vpeople')
      const seen = people ? getComputedStyle(people) : null
      const box = hud.getBoundingClientRect()
      const paneBox = pane.getBoundingClientRect()
      return {
        channels: Math.round(list.getBoundingClientRect().height),
        panelShare: box.height / paneBox.height,
        /* The parts that must not move when the list does. */
        hasScroller: !!people,
        scrolls: seen ? seen.overflowY : null,
        canShrink: seen ? seen.minHeight : null,
        capped: getComputedStyle(hud).maxHeight,
        /* And nothing hanging out of the panel it lives in. */
        inside: box.bottom <= paneBox.bottom + 1,
      } })()`)
    console.log('      before: ' + JSON.stringify(before) + '  after: ' + JSON.stringify(after))

    /*
     * The structure the cap is made of. Checked rather than inferred from the
     * panel's height, because with one person in the call it is not tall
     * enough to be capped - and a test that passes because nothing was big
     * enough to matter is a test that would pass with the fix removed.
     */
    check('the names are in a scroller of their own', after.hasScroller === true, after)
    check('and that scroller really scrolls',
      after.scrolls === 'auto' || after.scrolls === 'scroll', after.scrolls)
    check('and is allowed to shrink, or it would push instead of scrolling',
      after.canShrink === '0px', after.canShrink)
    check('and the panel is capped rather than growing without limit',
      after.capped !== 'none' && after.capped !== '', after.capped)

    /* And what all of that is for. */
    check('the channels keep room to be used', after.channels > 120, after)
    check('and the panel stays inside the sidebar', after.inside === true, after)

    /*
     * The buttons, hit-tested. A panel that overflows its parent looks
     * completely normal and cannot be pressed, which is the failure this
     * whole change is about.
     */
    const buttons = await js(`(() => {
      const out = []
      for (const b of document.querySelectorAll('.vhud .vctl button')) {
        const r = b.getBoundingClientRect()
        if (r.width === 0) continue
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        out.push({
          what: (b.getAttribute('aria-label') || b.title || '?').trim(),
          reachable: !!hit && (hit === b || b.contains(hit)),
        })
      }
      return out })()`)
    console.log('      controls: ' + JSON.stringify(buttons))
    check('the call buttons are there', buttons.length > 0, buttons)
    check('and every one of them can be pressed',
      buttons.length > 0 && buttons.every((b) => b.reachable),
      buttons.filter((b) => !b.reachable))
  },
}
