/**
 * The shared parts of a browser test.
 *
 * These checks exist because the unit tests cannot see a screen. Every bug
 * they were written for was of one shape: the code was correct and the
 * result was unusable - a button 350px wide squeezing its own label to
 * nothing, a drawer that reported itself open while it sat off screen, a
 * menu that closed in the same click that was meant to open a box in it.
 * Only a real browser laying out real elements can catch that.
 *
 * Everything here is a lesson from getting one of those wrong.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Wrap a window in the handful of things every spec needs.
 *
 * `js` swallows its own errors and hands them back as { __err }, because an
 * exception in the page kills executeJavaScript with a message that names
 * nothing - and a spec that dies at step one tells you far less than one
 * that reports which step went wrong.
 */
function pageOf(win) {
  const js = (code) =>
    win.webContents
      .executeJavaScript(code)
      .catch((e) => ({ __err: String(e).slice(0, 300) }))

  /*
   * What the page is doing, so a wait can end when it stops doing it.
   *
   * Put in the page rather than guessed at from outside: only the page knows
   * whether a fetch is still out or something is still moving. Re-injected
   * whenever it is missing, because a reload takes it with it.
   */
  const WATCH = `(() => {
    if (window.__uiwatch) return true
    const w = { fetches: 0, touched: Date.now() }
    window.__uiwatch = w
    const real = window.fetch
    window.fetch = function (...args) {
      w.fetches++
      w.touched = Date.now()
      return real.apply(this, args).finally(() => {
        w.fetches--
        w.touched = Date.now()
      })
    }
    new MutationObserver(() => { w.touched = Date.now() }).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    })
    return true
  })()`

  /**
   * Is the app finished reacting to whatever just happened?
   *
   * Four things have to be true, and each is here because leaving it out
   * ends the wait too early:
   *
   *   - the document has loaded at all
   *   - nothing is still being fetched, or the answer has not arrived yet
   *   - nothing is animating, or a drawer is measured mid-slide
   *   - and the DOM has been still for a moment, because React renders in
   *     more than one go and the gap between them is not "finished"
   */
  const QUIET = 150
  const IDLE = `(() => {
    const w = window.__uiwatch
    if (!w) return false
    if (document.readyState !== 'complete') return false
    if (w.fetches > 0) return false
    if (document.getAnimations && document.getAnimations().length > 0) return false
    return Date.now() - w.touched >= ${QUIET}
  })()`

  /**
   * Wait for the app to settle, and no longer than asked.
   *
   * Every one of these used to be a flat sleep: 360 of them across the specs,
   * six and a half minutes of the suite spent sleeping through work that had
   * already finished. The number stays as the limit rather than the duration,
   * so nothing waits longer than it used to and a spec that really does need
   * the full time still gets it.
   *
   * It cannot end instantly: a click is followed by a render, and asking
   * before that has started would find a page that is still and call it
   * finished.
   */
  async function wait(ms) {
    const end = Date.now() + ms
    const floor = Date.now() + Math.min(ms, 120)
    await js(WATCH)
    await sleep(Math.min(ms, 60))
    while (Date.now() < end) {
      if (Date.now() >= floor && (await js(IDLE)) === true) return
      await sleep(50)
    }
  }

  /** Poll until an expression is true. Returns false rather than throwing. */
  async function until(what, expr, ms = 25000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const ok = await js(`(() => { try { return !!(${expr}) } catch { return false } })()`)
      if (ok === true) return true
      await sleep(200)
    }
    console.log(`      (gave up waiting for ${what})`)
    return false
  }

  /**
   * Wait for an element to stop moving.
   *
   * The drawers slide for 220ms, and a spec that sleeps a fixed 700ms and
   * then measures is a race, not a test - it passed for a week and then
   * reported a drawer sitting at its closed position because that run
   * happened to read it mid-transition. Asking the element whether it is
   * still animating is the only honest version.
   */
  async function settled(selector, ms = 5000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const done = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        if (!el.getAnimations) return true
        return el.getAnimations().length === 0 })()`)
      if (done === true) return true
      await sleep(60)
    }
    console.log(`      (${selector} never stopped moving)`)
    return false
  }

  return { js, until, wait, settled }
}

/** Collects results so a spec can report every failure, not just the first. */
function results() {
  const failures = []
  let passed = 0

  /**
   * @param what human-readable, in the present tense: what should be true.
   * @param ok   the assertion.
   * @param got  what was actually measured - printed on failure, and on
   *             success too when it is a number worth seeing move.
   */
  const check = (what, ok, got) => {
    const detail = got === undefined ? '' : '  ' + JSON.stringify(got)
    if (ok) {
      passed++
      console.log(`      ok   ${what}${detail}`)
    } else {
      failures.push(what + detail)
      console.log(`      FAIL ${what}${detail}`)
    }
  }

  return { check, failures, count: () => passed }
}

/**
 * Sign in as the owner, with friends, in the page.
 *
 * Registration and friending go over HTTP, which is fine and fast. Sending a
 * message does not: there is no POST for that, it goes over the gateway, and
 * posting to /api/channels/:id/messages quietly does nothing at all. That
 * cost an afternoon once.
 */
async function signIn(js, { owner = 'Owner', friends = [] }) {
  return await js(`(async () => {
    const post = async (p, body, token) => {
      const h = { 'content-type': 'application/json' }
      if (token) h.authorization = 'Bearer ' + token
      const r = await fetch(p, { method: 'POST', headers: h, body: JSON.stringify(body) })
      return await r.json().catch(() => null)
    }
    const reg = (u, invite) => post('/api/register',
      { username: u, password: 'password123', displayName: u, invite })

    const me = await reg(${JSON.stringify(owner)})
    if (!me || !me.token) return { ok: false, why: 'the first account could not sign up', got: me }

    const H = { headers: { authorization: 'Bearer ' + me.token } }
    /*
     * The server is made here, because an account does not come with one.
     *
     * The app used to seed a server and hand it to whoever signed up first,
     * so this read spaces[0] and found it. That is not the model any more -
     * nobody is given a server, everybody makes their own - so spaces[0] was
     * undefined and every spec that calls this died on the line after it,
     * before touching anything it meant to test.
     */
    let spaces = await (await fetch('/api/spaces', H)).json()
    let first = (spaces.spaces ?? [])[0]
    if (!first) {
      const made = await post('/api/spaces', { name: 'Test Server' }, me.token)
      if (!made || !made.space) {
        return { ok: false, why: 'the owner could not make a server', got: made }
      }
      spaces = await (await fetch('/api/spaces', H)).json()
      first = (spaces.spaces ?? []).find((s) => s.id === made.space.id) ?? made.space
      /*
       * With more than one channel in it.
       *
       * A new server is seeded with a single text channel. The seeded server
       * this replaced had five, and the specs were written against that -
       * so reordering had nothing to reorder, and "leave for another
       * channel" had nowhere to go. Two more, named for what they are used
       * for rather than prettily.
       */
      for (const name of ['second', 'third']) {
        await post('/api/channels',
          { spaceId: made.space.id, name, kind: 'text' }, me.token)
      }
    }
    const invite = await post('/api/spaces/' + first.id + '/invites', {}, me.token)

    const made = {}
    for (const name of ${JSON.stringify(friends)}) {
      const them = await reg(name, invite.code)
      made[name] = { id: them.user.id, token: them.token }
      // Friends both ways: a request, then their acceptance.
      await post('/api/friends/request', { name }, me.token)
      await post('/api/friends/accept', { userId: me.user.id }, them.token)
    }

    /* The client keeps its token here. A token under the wrong name is a
       sign-in that silently never happens, which is exactly how this looked
       when the suite was pointed at the client people actually use. */
    localStorage.setItem('atrium.token', me.token)
    /*
     * And open in the server this just made.
     *
     * The app opens where you were, and Home the first time - so without
     * this every spec would start on Home and have to walk into a server
     * before touching its own subject. Said here, once, rather than in each
     * of the eighty-nine.
     *
     * A spec about Home itself clears it; see intoServer for the ones that
     * go the other way.
     */
    localStorage.setItem('atrium.where',
      JSON.stringify({ where: { kind: 'space', id: first.id }, page: null }))
    /* The name as well as the id: a spec that wants to say "it names the
       server" should not have to know what this called it. */
    return { ok: true, me: { id: me.user.id, token: me.token },
      spaceId: first.id, spaceName: first.name, invite: invite.code,
      friends: made } })()`)
}

/**
 * Say something as somebody else.
 *
 * Over the gateway, because that is the only way a message can be sent, and
 * the channel comes out of the socket's own ready payload - there is no
 * /api/channels to ask.
 */
async function sayAs(js, token, body, kind = 'text') {
  return await js(`(async () => {
    return await new Promise((resolve) => {
      const s = new WebSocket('ws://' + location.host + '/gateway')
      s.onopen = () => s.send(JSON.stringify({ t: 'hello', token: ${JSON.stringify(token)} }))
      s.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.t === 'ping') return s.send(JSON.stringify({ t: 'pong' }))
        if (m.t === 'ready') {
          const ch = (m.channels || []).find((c) => c.kind === ${JSON.stringify(kind)})
          if (!ch) { s.close(); return resolve({ ok: false, why: 'no channel of that kind' }) }
          s.send(JSON.stringify({ t: 'send', channelId: ch.id,
            body: ${JSON.stringify(body)}, nonce: 'ui-' + Math.random().toString(36).slice(2) }))
          setTimeout(() => { s.close(); resolve({ ok: true, channelId: ch.id }) }, 900)
        }
      }
      setTimeout(() => resolve({ ok: false, why: 'the socket never became ready' }), 9000)
    }) })()`)
}

/**
 * Find the message box, whatever it is made of.
 *
 * It was an <input>, and the first `.composer input` is the hidden file
 * picker for attachments - setting a value on that throws, because a browser
 * will not let a page put a filename in a file input, and picking the wrong
 * one took the whole app down with "Atrium could not start". That is how
 * that was found, and why this asks for the message box by name.
 *
 * It is a <textarea> now, so it can wrap. Both are looked for, since a spec
 * should not need rewriting the next time it changes.
 */
const MESSAGE_BOX = `(() => {
  /* .cmp in this client, .composer in the one before it. Kept as a pair so a
     spec run against either finds the box - and because this helper pointing
     at the old name is why every "send a message" step in every ported spec
     did nothing at all. */
  const box = document.querySelector('.cmp textarea, .composer textarea')
    || [...document.querySelectorAll('.cmp input, .composer input')]
      .find((i) => i.type !== 'file')
  return box || null
})()`

/**
 * Put text in it, the way React will notice.
 *
 * React tracks the value on the DOM node, so assigning `.value` directly is
 * ignored on the next render. The native setter is what makes React notice -
 * and it lives on a different prototype for a textarea than for an input.
 */
const SET_VALUE = `(box, text) => {
  const proto = box instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}`

/** Type into the message box and send it. */
async function typeAndSend(js, text) {
  return await js(`(() => {
    const box = ${MESSAGE_BOX}
    if (!box) return { ok: false, why: 'no message box' }
    ;(${SET_VALUE})(box, ${JSON.stringify(text)})
    box.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    return { ok: true } })()`)
}

/**
 * Whether a finger would actually land on this element.
 *
 * Dispatching a click on a node proves nothing: it skips hit testing
 * entirely, so a button buried under an overlay still "works". Asking what
 * is at the middle of its box is the question a person's finger asks.
 */
function hitTestFor(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { exists: true,
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), right: Math.round(r.right),
      vw: window.innerWidth,
      onScreen: r.left >= -1 && r.right <= window.innerWidth + 1,
      hittable: !!(at && (at === el || el.contains(at))),
      // What is really at that point, so a failure names the thing in the
      // way instead of leaving it to be guessed at.
      hitWhat: at ? (typeof at.className === 'string' && at.className
        ? at.className : at.tagName) : null } })()`
}

/** The box of an element, with the properties layout bugs hide in. */
function boxOf(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return { exists: true,
      x: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
      display: s.display, position: s.position,
      // A width of 0 with x and right also 0 is display: none wearing a
      // disguise - getBoundingClientRect reports zeroes for a hidden box.
      hidden: s.display === 'none',
      overflows: el.scrollWidth > el.clientWidth + 1 } })()`
}

module.exports = {
  /* `sleep` is the flat pause it always was. The `wait` a spec is handed is a
     different thing now - it settles - and it comes from pageOf, not here. */
  sleep, pageOf, results, signIn, sayAs, typeAndSend, hitTestFor, boxOf,
  /* For specs that drive the message box themselves rather than sending. */
  MESSAGE_BOX, SET_VALUE,
}
