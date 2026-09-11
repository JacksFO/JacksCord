import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { resized, watchers } from '../test-setup'
import { Shell } from './Shell'
import { DEFAULTS } from '../lib/settings'
import { applyReady, emptyWorld, type World } from '../lib/world'
import type { Api } from '../lib/api'
import type { ReadyFrame, User } from '../lib/wire'

/**
 * Staying at the bottom while the page is still growing.
 *
 * Opening a channel scrolls to the end on the next frame — which is before a
 * link card has been fetched and long before a picture has loaded. Both
 * arrive later and make the list taller underneath somebody who was told they
 * were at the bottom, so a channel whose last message carried a preview
 * always stopped short of the end by exactly the height of the thing that had
 * not loaded yet.
 */

const user = (id: string): User => ({
  id, username: id, discriminator: '0001', verified: 0, display_name: id,
  bio: '', accent: '', accent_2: '', name_font: 'default',
  name_effect: 'none', avatar_path: null, banner_path: null,
  status_text: '', presence: 'online', created_at: 0,
})

function world(): World {
  const w = emptyWorld(user('me'))
  applyReady(w, {
    t: 'ready', user: user('me'), members: [user('pat')],
    channels: [{
      id: 'c1', space_id: 's1', name: 'general', kind: 'text', topic: '',
      position: 0, category_id: null,
    }],
    categories: [], roles: [], assignments: [], online: ['me'], voice: [],
    unread: [], channelPrefs: [],
    permissionsBySpace: { s1: ['view_channels', 'send_messages', 'read_history'] },
    channelPermissions: {}, looseOrder: {}, activities: {},
  } as ReadyFrame)
  w.spaces = [{
    id: 's1', name: 'Somewhere', description: '', icon_path: null, banner_path: null,
    owner_id: 'me', position: 0, created_at: 0,
  } as World['spaces'][number]]
  w.membersBySpace.set('s1', new Set(['me', 'pat']))
  w.messages.set('c1', [{
    id: 'm1', channel_id: 'c1', author_id: 'pat',
    body: 'look https://example.com/a-thing',
    created_at: 1, edited_at: null, deleted_at: null, kind: 'text',
    reply_to: null, pinned_at: null, reactions: [], attachments: [],
  }])
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

/** The scrolling list, given a height so there is a bottom to be at. */
function open() {
  /*
   * Opened in the server, on purpose.
   *
   * The app opens where you were and Home the first time, so a Shell built
   * fresh in a test has never been anywhere and lands on Home - where there
   * is no conversation to scroll and nothing to measure. This says where it
   * was, which is what a real launch would have found.
   */
  localStorage.setItem('atrium.where',
    JSON.stringify({ where: { kind: 'space', id: 's1' }, page: null }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <Shell world={world()} server={server} onOut={noop} send={noop} gateway={null}
        settings={DEFAULTS} set={noop} reset={noop} version={0} changed={() => {}}
        stale={false} error="" clearError={noop} />,
    )
  })
  const el = host.querySelector('.stream') as HTMLElement
  /* jsdom lays nothing out, so the measurements are given. */
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true, writable: true })
  return el
}

describe('the conversation, while its pictures are still loading', () => {
  it('watches the rows it is showing', () => {
    const el = open()
    const row = el.children[0]
    expect(row, 'there is something in the list to watch').toBeTruthy()
    expect(watchers(row as Element)).toBeGreaterThan(0)
  })

  /* The bug, exactly: something below grows after the scroll. */
  it('follows a row that grows after it was drawn', () => {
    const el = open()
    el.scrollTop = 0
    Object.defineProperty(el, 'scrollHeight', { value: 1200, configurable: true })
    act(() => { resized(el.children[0] as Element) })
    expect(el.scrollTop).toBe(1200)
  })

  /* But somebody reading back through a week is left where they are. */
  it('and leaves somebody alone who has scrolled up', () => {
    const el = open()
    /* Far from the bottom, and said so through the app's own handler. */
    Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true })
    el.scrollTop = 100
    act(() => { el.dispatchEvent(new Event('scroll', { bubbles: true })) })
    act(() => { resized(el.children[0] as Element) })
    expect(el.scrollTop).toBe(100)
  })
})

/**
 * A picture finishing, which is not a resize of anything React drew.
 *
 * A link card arrives with no height and gets one when its picture loads,
 * and that load fires on the <img> itself. `load` does not bubble, so it has
 * to be caught on the way down — without it, opening a channel whose last
 * message carries a preview stops short by exactly the height of the
 * picture, which is the thing that kept being reported.
 */
describe('a picture arriving after the scroll', () => {
  it('brings the conversation the rest of the way down', () => {
    const el = open()
    el.scrollTop = 0
    Object.defineProperty(el, 'scrollHeight', { value: 1800, configurable: true })

    /* Fired on an <img> inside a row, exactly as a browser fires it. */
    const img = document.createElement('img')
    ;(el.children[0] as Element).appendChild(img)
    act(() => { img.dispatchEvent(new Event('load')) })

    expect(el.scrollTop).toBe(1800)
  })

  /* And still leaves somebody alone who has scrolled up to read. */
  it('but not for somebody who has scrolled up', () => {
    const el = open()
    Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true })
    el.scrollTop = 100
    act(() => { el.dispatchEvent(new Event('scroll', { bubbles: true })) })

    const img = document.createElement('img')
    ;(el.children[0] as Element).appendChild(img)
    act(() => { img.dispatchEvent(new Event('load')) })

    expect(el.scrollTop).toBe(100)
  })
})
