/**
 * The people in a call, in the panel beside the channels.
 *
 * The one list in the app that shows who is actually talking to you was the
 * one place a person could not be clicked. Making somebody quieter, or
 * looking at what they were sharing, meant opening the stage to find a tile
 * of them - and the little monitor beside a sharer's name said somebody was
 * sharing while giving nobody anything to press.
 *
 * The menu itself was already built and already knew how to silence, deafen
 * and remove somebody from a call, each gated on what you may actually do.
 * None of it was reachable from here.
 *
 * Reported: "being able to right click or click people here and manage them
 * too like their volume for me etc and other stuff idk".
 */
const { signIn } = require('../lib.cjs')

module.exports = {
  name: 'voice-row-menu',
  width: 1400,
  height: 900,

  async run({ js, until, wait, win, check, base }) {
    await win.loadURL(base + '/')
    const setup = await signIn(js, { owner: 'JacksFO', friends: ['Baileyyy'] })
    check('the server can be set up', setup.ok === true, setup.why)

    await win.loadURL(base + '/')
    await until('the channel list', `document.querySelectorAll('.chan').length > 0`)
    await wait(1500)

    /* A voice room to stand in. signIn makes text channels only, and the
       panel this is about only exists once somebody is in a call. */
    const made = await js(`(async () => {
      const token = localStorage.getItem('atrium.token')
      const h = { 'content-type': 'application/json', authorization: 'Bearer ' + token }
      const got = await (await fetch('/api/spaces', { headers: h })).json()
      const space = (got.spaces || [])[0]
      if (!space) return { ok: false, why: 'no server' }
      const r = await fetch('/api/channels', { method: 'POST', headers: h,
        body: JSON.stringify({ spaceId: space.id, name: 'Lounge', kind: 'voice' }) })
      return { ok: r.ok, status: r.status } })()`)
    check('a voice room can be made', made.ok === true, made)

    await win.loadURL(base + '/')
    await until('the channel list again', `document.querySelectorAll('.chan').length > 0`, 15000)
    await wait(2000)

    /* A voice room is a `.vcard`, not a `.chan` - it is a place with people
       in it rather than a row with a title, which is why it draws itself. */
    const joined = await js(`(() => {
      /* Case-insensitive: a channel name is lowercased on the way in, so the
         Lounge that was asked for comes back as lounge. */
      const room = [...document.querySelectorAll('.vcard')]
        .find((c) => /lounge/i.test(c.textContent || ''))
      if (!room) return { took: null,
        rooms: [...document.querySelectorAll('.vcard')].map((c) => c.textContent.trim()) }
      /* The card carries a Join of its own; pressing the card is not the same
         thing as walking in. */
      const join = [...room.querySelectorAll('button')]
        .find((b) => /join/i.test(b.textContent || ''))
      ;(join || room).click()
      return { took: room ? room.textContent.trim() : null,
        rooms: [...document.querySelectorAll('.vcard')].map((c) => c.textContent.trim()) } })()`)
    check('and it can be joined', joined.took !== null, joined)

    const panel = await until('the call panel, with me in it',
      `document.querySelectorAll('.vrow').length > 0`, 20000)
    check('and joining it lists who is in it', panel === true)

    // --- the card, on an ordinary click --------------------------------------
    await js(`(() => { const r = document.querySelector('.vrow'); if (r) r.click(); return 1 })()`)
    const card = await until('their card', `!!document.querySelector('.pcard')`, 8000)
    check('clicking somebody opens their card', card === true)
    await js(`(() => { document.querySelector('.scrim') && document.querySelector('.scrim').click(); return 1 })()`)
    await wait(400)

    // --- and the menu, on a right-click --------------------------------------
    await js(`(() => {
      const row = document.querySelector('.vrow')
      const r = row.getBoundingClientRect()
      const x = r.left + 40, y = r.top + r.height / 2
      /* Through elementFromPoint, so this is what a real right-click lands on. */
      document.elementFromPoint(x, y).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
      return 1 })()`)
    const menu = await until('the menu', `!!document.querySelector('.ctx')`, 8000)
    check('right-clicking somebody opens their menu', menu === true)

    const inside = await js(`(() => {
      const m = document.querySelector('.ctx')
      return {
        items: [...m.querySelectorAll('.mitem')].map((b) => b.textContent.trim()),
        sliders: m.querySelectorAll('.mrange input[type=range]').length,
        labels: [...m.querySelectorAll('.mrange .mrl')].map((n) => n.textContent.trim()),
      } })()`)
    console.log('      the menu holds: ' + JSON.stringify(inside))

    check('it offers their profile', inside.items.some((t) => /^Profile$/i.test(t)), inside.items)

    /*
     * And no volume slider, because the only person in this call is me.
     *
     * A slider for how loud you are to yourself is a control for nothing -
     * your own voice is not played back - so it is absent rather than dead,
     * which is the rule the rest of this app keeps.
     *
     * The slider itself is covered in Menu.test.tsx. Proving it here would
     * mean a second person in a real call: the panel lists whoever the media
     * server says is connected, so a second account joining over the gateway
     * alone does not appear in it, and standing up a second media client for
     * one assertion costs more than it is worth. Said plainly rather than
     * left as a gap somebody finds later.
     */
    check('and no slider for your own voice, which plays to nobody',
      inside.sliders === 0, inside)
  },
}
