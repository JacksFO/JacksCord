import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Shell } from './Shell'
import { DEFAULTS } from '../lib/settings'
import { applyReady, emptyWorld, type World } from '../lib/world'
import type { Api } from '../lib/api'
import type { ReadyFrame, User } from '../lib/wire'

/**
 * Changing server, for real.
 *
 * Every other test of the shell renders it once, to static markup. A render
 * that throws only on the SECOND pass cannot be seen that way — and "rendered
 * fewer hooks than expected" is exactly that failure: it is a comparison
 * against the render before it, so the first one always succeeds. Everything
 * went blank when changing server and the whole suite stayed green.
 *
 * So this one mounts the app properly and clicks from one server to another.
 */

const user = (id: string, over: Partial<User> = {}): User => ({
  id, username: id, discriminator: '0001', verified: 0, display_name: id,
  bio: '', accent: '', accent_2: '', name_font: 'default',
  name_effect: 'none', avatar_path: null, banner_path: null,
  status_text: '', presence: 'online', created_at: 0, ...over,
})

const space = (id: string, name: string, position: number) => ({
  id, name, description: '', icon_path: null, banner_path: null,
  owner_id: 'me', position, created_at: 0,
}) as World['spaces'][number]

/** Two servers, deliberately unalike — different channels, roles and people. */
function twoServers(): World {
  const w = emptyWorld(user('me', { display_name: 'Me' }))
  const f: ReadyFrame = {
    t: 'ready',
    user: user('me', { display_name: 'Me' }),
    members: [user('pat'), user('sam')],
    channels: [
      { id: 'c1', space_id: 's1', name: 'general', kind: 'text', topic: 'hi', position: 0, category_id: null },
      { id: 'c2', space_id: 's1', name: 'Voice', kind: 'voice', topic: '', position: 1, category_id: null },
      { id: 'c3', space_id: 's2', name: 'lobby', kind: 'text', topic: '', position: 0, category_id: 'k1' },
    ],
    categories: [{ id: 'k1', space_id: 's2', name: 'Rooms', position: 0 }],
    roles: [{
      id: 'r1', space_id: 's1', name: 'Owner', colour: '#f00', position: 9,
      permissions: '[]', kind: 'owner', hoist: 1, created_at: 0,
    }],
    assignments: [],
    online: ['me', 'pat'],
    voice: [],
    unread: [],
    channelPrefs: [],
    /* The second server grants less than the first, so switching to it takes
       away whatever the first one's permissions were drawing. */
    permissionsBySpace: { s1: ['view_channels', 'send_messages', 'manage_channels'], s2: ['view_channels'] },
    channelPermissions: {},
    looseOrder: {},
    activities: {},
  }
  applyReady(w, f)
  w.spaces = [space('s1', 'Somewhere', 0), space('s2', 'Attic', 1)]
  w.membersBySpace.set('s1', new Set(['me', 'pat']))
  w.membersBySpace.set('s2', new Set(['me']))
  return w
}

const server = {
  get: async () => ({}), post: async () => ({}),
  patch: async () => ({}), delete: async () => ({}),
} as unknown as Api
const noop = () => {}

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

function mount(w: World) {
  /*
   * Opened in the server, on purpose.
   *
   * The app opens where you were and Home the first time, so a Shell built
   * fresh in a test has never been anywhere and lands on Home. This says
   * where it was, which is what a real launch would have found.
   */
  localStorage.setItem('atrium.where',
    JSON.stringify({ where: { kind: 'space', id: 's1' }, page: null }))

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <Shell world={w} server={server} onOut={noop} send={noop} gateway={null}
        settings={DEFAULTS} set={noop} reset={noop} version={0} changed={() => {}}
        stale={false} error="" clearError={noop} />,
    )
  })
  return host
}

/** The rail tile for a server, found by what it says. */
function tile(el: HTMLElement, name: string): HTMLElement {
  const found = [...el.querySelectorAll('.rail button, .rail .rl')]
    .find((n) => (n.getAttribute('title') ?? n.textContent ?? '').includes(name))
  if (!found) throw new Error(`no rail tile for ${name}`)
  return found as HTMLElement
}

describe('changing server', () => {
  it('has a tile for each server to begin with', () => {
    const el = mount(twoServers())
    /* Proves the click below lands on something real, rather than passing
       because neither tile was ever drawn. */
    expect(tile(el, 'Somewhere')).toBeTruthy()
    expect(tile(el, 'Attic')).toBeTruthy()
  })

  it('draws the other one without throwing', () => {
    const el = mount(twoServers())
    expect(el.textContent).toContain('general')
    act(() => { tile(el, 'Attic').click() })
    expect(el.textContent).toContain('lobby')
    expect(el.textContent).not.toContain('general')
  })

  it('and back again', () => {
    const el = mount(twoServers())
    act(() => { tile(el, 'Attic').click() })
    act(() => { tile(el, 'Somewhere').click() })
    expect(el.textContent).toContain('general')
  })
})

/**
 * The blank screen, as a test.
 *
 * A channel with messages, then the same component asked to draw one without
 * any. That is one render followed by another taking a different path through
 * the body, which is the only way a hook order fault can show itself — and it
 * is what changing server does, because the new server's messages have not
 * arrived when its channel is first drawn.
 */
describe('a channel whose messages have not arrived', () => {
  it('draws after one that had them, without throwing', () => {
    const w = twoServers()
    w.messages.set('c1', [{
      id: 'm1', channel_id: 'c1', author_id: 'pat', body: 'hello',
      created_at: 1, edited_at: null, deleted_at: null, kind: 'text',
      reply_to: null, pinned_at: null, reactions: [], attachments: [],
    }])
    /* c3 is deliberately left with nothing. */
    const el = mount(w)
    expect(el.textContent).toContain('hello')

    act(() => { tile(el, 'Attic').click() })
    expect(el.textContent).not.toContain('hello')
    /* And it is really the empty one that got drawn, not a stale pane. */
    expect(el.textContent).toContain('lobby')
  })
})

/**
 * Opening something to read, while watching a screen.
 *
 * The stage replaces the conversation rather than floating over it, so
 * picking a channel while watching left the channel set underneath a stage
 * that stayed exactly where it was — a click that appeared to do nothing.
 * Every way in goes through one door now, and a test fails if a new one is
 * added that does not.
 */
describe('leaving the stage', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/ui/Shell.tsx'), 'utf8')

  it('happens wherever a conversation is opened', () => {
    const at = src.indexOf('const openToRead')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 400)
    expect(body).toContain('setOnStage(false)')
    expect(body).toContain('setChannelId(id)')
  })

  /* And nothing sets a channel behind the stage's back. */
  it('and nothing opens one any other way', () => {
    const others = [...src.matchAll(/setChannelId\(([^)]*)\)/g)]
      .map((m) => m[1])
      .filter((arg) => arg !== 'null' && arg !== 'id')
    expect(others, `setChannelId called with: ${others.join(', ')}`).toEqual([])
  })

  /*
   * And leaving the call takes it down too.
   *
   * The stage needs both the flag and a call to be drawn, so leaving hid it
   * by removing the call while the flag stayed on. Rejoining put the call
   * back, both were true again, and the stage opened by itself — which is the
   * one thing joining a room is not supposed to do. It only happened to
   * somebody who had opened the stage earlier, which is why it was reported
   * as "sometimes".
   */
  it('and the call ending clears the flag, so rejoining does not reopen it', () => {
    const at = src.indexOf('if (!call.call.channel) setOnStage(false)')
    expect(at).toBeGreaterThan(0)
    /* On the call itself rather than one way out of it: there are four, and
       three of them are not a button somebody pressed. */
    const dep = src.slice(at, src.indexOf('}, [', at) + 30)
    expect(dep).toContain('[call.call.channel]')
  })

  /* Pressing a room you are already in is asking to look at it; walking into
     one is not. Both live in the same handler, so a change to either can
     quietly become a change to both. */
  it('but joining a room still does not open it', () => {
    const at = src.indexOf("if (c?.kind === 'voice')")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('openToRead(id)', at))
    /* Already in it: open. Otherwise: join, and stay where you were. */
    expect(body).toContain('if (call.call.channel === id) { setOnStage(true); return }')
    expect(body).toContain('void call.join(id)')
    /* Exactly one setOnStage(true) in there — a second would be the auto-open
       coming back by another door. */
    expect(body.match(/setOnStage\(true\)/g)).toHaveLength(1)
  })
})
