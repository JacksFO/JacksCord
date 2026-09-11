/**
 * Somebody with no servers lands somewhere they can do something.
 *
 * Reported with a screenshot from a fresh test account: signing in put them
 * in a server view for a server that does not exist - an empty channel list,
 * a heading reading "Welcome to #", and a composer telling them to pick a
 * channel. There was nothing to pick. The view opened on a server because it
 * always had, and nobody had ever arrived without one before open
 * registration was switched on.
 *
 * Friends is where a new account actually has something to do: add somebody,
 * or make a server.
 */
const { signIn } = require('../lib.cjs')

module.exports = {
  name: 'first-run',
  width: 1400,
  height: 900,

  async run({ js, until, wait, win, check, base }) {
    await win.loadURL(base + '/')
    // Claimed by somebody, so the account below is an ordinary new arrival
    // rather than the first person here.
    const setup = await signIn(js, { owner: 'JacksFO', friends: [] })
    check('the first account can just sign up', setup.ok === true, setup.why)

    // A brand new account, signing up the way anybody would now: no code.
    const fresh = await js(`(async () => {
      const r = await fetch('/api/register', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'Newbie', displayName: 'Newbie', password: 'password123' }) })
      const b = await r.json().catch(() => null)
      if (!b || !b.token) return { ok: false, status: r.status }
      localStorage.setItem('atrium.token', b.token)
      return { ok: true } })()`)
    check('they can sign up with no code', fresh.ok === true, fresh)

    await win.loadURL(base + '/')
    await until('the app', `!!document.querySelector('.shell, .chatpane, .home')`)
    await wait(2500)

    const landed = await js(`(() => {
      const text = document.body.innerText || ''
      return {
        // The rail has the home button and nothing else - no server pips.
        spacePips: document.querySelectorAll('.pane.rail .rl:not([aria-label="Conversations"]):not(.rlread):not(.rlnew)').length,
        /*
         * Something to do, wherever it is offered.
         *
         * The client this replaced sent a new account to a Friends page and
         * this looked for its wording. This one lands them on Home, which
         * carries the same two offers - make or join a server, and add
         * somebody - on the cards it shows when there is nothing else. The
         * screen is what matters, not which of the two it is called: a new
         * account must not arrive somewhere blank.
         */
        friendsScreen: /No friends yet|Nobody around/i.test(text)
          || /Add somebody as a friend/i.test(text)
          || /Make or join a server/i.test(text),
        /* Called "Conversations" here, and it is the heading over them in
           the side panel rather than a line of body text. */
        directMessages: [...document.querySelectorAll('.sidepane .sect')]
          .some((s) => /Conversations/i.test(s.textContent || '')),
        // The tells from the screenshot, none of which should be here.
        welcomeToNothing: /Welcome to #\\s*$|Welcome to #\\n/.test(text) || /Welcome to #(?![a-z0-9-])/i.test(text),
        pickAChannel: !!document.querySelector('[placeholder="Pick a channel"]'),
        emptyChannelGroups: /TEXT\\s*VOICE/i.test(text.replace(/\\s+/g, ' ')),
      } })()`)
    console.log('      what a new account sees: ' + JSON.stringify(landed))
    console.log('      screen: ' + JSON.stringify(await js(`(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400)`)))

    check('they have no servers to be in', landed.spacePips === 0, landed.spacePips)
    check('they land somewhere with something to do',
      landed.friendsScreen === true, landed.friendsScreen)
    check('with their conversations beside it', landed.directMessages === true)

    /*
     * And none of the server view built for a server they are not in.
     */
    check('not a welcome to a channel that does not exist',
      landed.welcomeToNothing === false, landed.welcomeToNothing)
    check('and not a composer telling them to pick one',
      landed.pickAChannel === false, landed.pickAChannel)

    /*
     * The other direction: somebody who DOES have a server is not sent to
     * Friends, which is what that fix must not do.
     *
     * Where they land is no longer "their first server" - the app opens where
     * you were, and Home the first time. This account was last on Home,
     * because the part above was just there under a different token and the
     * place is remembered per machine rather than per account. So the check
     * is that the server is reachable and works, rather than that it is
     * already open: the original worry was Friends, and it still is.
     */
    await js(`(() => { localStorage.setItem('atrium.token', ${JSON.stringify(setup.me?.token ?? '')}); return 1 })()`)
    await win.loadURL(base + '/')
    await until('the app again', `!!document.querySelector('.shell, .chatpane')`)
    await wait(2500)

    const owner = await js(`(() => ({
      spacePips: document.querySelectorAll('.pane.rail .rl:not([aria-label="Conversations"]):not(.rlread):not(.rlnew)').length,
      channels: document.querySelectorAll('.chan').length,
      onFriends: /Nobody yet/i.test(document.body.innerText || ''),
    }))()`)
    console.log('      what the owner sees: ' + JSON.stringify(owner))
    check('somebody with a server has it in the rail', owner.spacePips > 0, owner.spacePips)
    check('and is not sent to Friends instead', owner.onFriends === false)

    /* And the server is one click away and full of its channels - which is
       what "opens on it" was really protecting. */
    await js(`(() => {
      const tile = [...document.querySelectorAll('.pane.rail .rl:not(.rlread):not(.rlnew)')]
        .find((b) => !/^conversations$/i.test(b.getAttribute('title') || ''))
      if (tile) tile.click()
      return 1 })()`)
    const listed = await until('its channels',
      `document.querySelectorAll('.chan').length > 0`, 10000)
    check('and opening it lists its channels', listed === true)
  },
}
