import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Shell } from './Shell'
import { Stage } from './Stage'
import { emptyCall } from '../lib/call'
import { DEFAULTS } from '../lib/settings'
import { applyReady, emptyWorld, type World } from '../lib/world'
import type { Api } from '../lib/api'
import type { ReadyFrame, User } from '../lib/wire'

/**
 * That the whole thing draws.
 *
 * Every other test here asks one component one question. This asks the app
 * whether it can be rendered at all — which is the failure nothing else
 * catches, because a component that throws on a shape it did not expect
 * typechecks perfectly and takes the entire screen with it at runtime.
 *
 * Deliberately given a world with awkward things in it: somebody with no
 * avatar, a channel of each kind, a server this account does not own, a
 * message from a person the roster has never mentioned.
 */

const user = (id: string, over: Partial<User> = {}): User => ({
  id, username: id, discriminator: '0001', verified: 0, display_name: id,
  bio: '', accent: '', accent_2: '', name_font: 'default',
  name_effect: 'none', avatar_path: null, banner_path: null,
  status_text: '', presence: 'online', created_at: 0, ...over,
})

const frame = (over: Partial<ReadyFrame> = {}): ReadyFrame => ({
  t: 'ready',
  user: user('me', { display_name: 'Me' }),
  members: [user('pat', { display_name: 'Pat' })],
  channels: [
    { id: 'c1', space_id: 's1', name: 'general', kind: 'text', topic: '', position: 0, category_id: null },
    { id: 'c2', space_id: 's1', name: 'Voice', kind: 'voice', topic: '', position: 1, category_id: null },
  ],
  categories: [],
  roles: [{
    id: 'r1', space_id: 's1', name: 'Owner', colour: '#ff0000', position: 9,
    permissions: '[]', kind: 'owner', hoist: 1, created_at: 0,
  }],
  assignments: [],
  online: ['me'],
  voice: [],
  unread: [],
  channelPrefs: [],
  permissionsBySpace: { s1: ['view_channels', 'send_messages'] },
  channelPermissions: {},
  looseOrder: {},
  activities: {},
  ...over,
})

function world(): World {
  const w = emptyWorld(user('me', { display_name: 'Me' }))
  applyReady(w, frame())
  w.spaces = [{
    id: 's1', name: 'Somewhere', description: '', icon_path: null, banner_path: null,
    owner_id: 'somebody-else', position: 0, created_at: 0,
  } as World['spaces'][number]]
  return w
}

const server = {
  get: async () => ({}), post: async () => ({}),
  patch: async () => ({}), delete: async () => ({}),
} as unknown as Api

const noop = () => {}

/*
 * Opened in the server, on purpose.
 *
 * The app opens where you were and Home the first time, so a Shell built
 * fresh in a test has never been anywhere and lands on Home - where there is
 * no channel list to find "general" in. This says where it was, which is what
 * a real launch would have found.
 */
const openedIn = (id: string) => localStorage.setItem('atrium.where',
  JSON.stringify({ where: { kind: 'space', id }, page: null }))

const draw = (w: World = world()) => (openedIn('s1'), renderToStaticMarkup(
  <Shell world={w} server={server} onOut={noop} send={noop} gateway={null}
    settings={DEFAULTS} set={noop} reset={noop} version={0} changed={() => {}}
    stale={false} error="" clearError={noop} />,
))

describe('the app', () => {
  it('draws', () => {
    const out = draw()
    expect(out).toContain('Somewhere')
    expect(out).toContain('general')
  })

  /* A voice room is a place with people in it, not a row with a title — and
     it is drawn from the roster of a call this account is not in. */
  it('and draws a voice room nobody is standing in', () => {
    expect(draw()).toContain('Nobody in here')
  })

  /* Whichever of the four columns are there, an empty world still has to
     produce a screen rather than a crash — this is what somebody sees on the
     very first run, before anything has been fetched. */
  it('and draws with nothing in it at all', () => {
    const bare = emptyWorld(user('me', { display_name: 'Me' }))
    expect(() => draw(bare)).not.toThrow()
  })

  /* The roster is only you, your friends and whoever you share a
     conversation with — so a message from anybody else arrives from a person
     this client has never been told about. */
  it('and survives a server with no roles or permissions in the frame', () => {
    const w = emptyWorld(user('me'))
    applyReady(w, frame({ roles: [], permissionsBySpace: {} }))
    expect(() => draw(w)).not.toThrow()
  })
})

describe('the parts a smoke test would otherwise never reach', () => {
  /*
   * The stage draws from the call, not from the world, so nothing above ever
   * renders it. A component that throws on a shape it did not expect
   * typechecks perfectly and takes the screen with it — and the stage is the
   * least exercised thing in the app, because voice needs a media server.
   */
  it('the stage draws with somebody sharing and no stream yet', () => {
    const w = world()
    const call = {
      ...emptyCall(),
      channel: 'c2',
      members: [
        { id: 'me', identity: 'me', name: 'Me', muted: false, sharing: true, cam: false },
        { id: 'pat', identity: 'pat', name: 'Pat', muted: true, sharing: false, cam: true },
      ],
    }
    const out = renderToStaticMarkup(
      <Stage
        world={w}
        call={call}
        controls={{ call } as never}
        name="Voice"
        master={100}
        onClose={() => {}}
      />,
    )
    /* Your own share has a tile before its picture arrives — waiting for the
       stream is a tile that never appears, because the thing that would draw
       it is the stream. */
    expect(out).toContain('Your screen')
    /* And somebody else's camera asks before it is sent. */
    expect(out).toContain('Watch Pat')
  })

  it('and with nobody in it at all', () => {
    expect(() => renderToStaticMarkup(
      <Stage world={world()} call={emptyCall()} controls={{} as never}
        name="Voice" master={100} onClose={() => {}} />,
    )).not.toThrow()
  })
})

describe('switching to a server the app knows little about', () => {
  /*
   * Everything went blank when changing server, which is a render throwing
   * with nothing to catch it. The newest paths are the ones that assume a
   * roster, a category or a set that has arrived — and on a server just
   * switched to, none of them has.
   */
  it('draws with a server whose roster has not arrived', () => {
    const w = world()
    w.spaces = [...w.spaces, {
      id: 's2', name: 'Other', description: '', icon_path: null, banner_path: null,
      owner_id: 'me', position: 1, created_at: 0,
    } as World['spaces'][number]]
    /* No membersBySpace entry, no roles, no permissions, no channels. */
    expect(() => draw(w)).not.toThrow()
  })

  it('and with a channel in a category nothing knows about', () => {
    const w = emptyWorld(user('me', { display_name: 'Me' }))
    applyReady(w, frame({
      channels: [{
        id: 'c9', space_id: 's1', name: 'orphan', kind: 'text', topic: '',
        position: 0, category_id: 'gone',
      }],
    }))
    expect(() => draw(w)).not.toThrow()
  })

  /* A message from somebody no roster mentions — which is most people, most
     of the time, since the opening frame carries only you and your friends. */
  it('and with a message from somebody it has never heard of', () => {
    const w = world()
    w.messages.set('c1', [{
      id: 'm1', channel_id: 'c1', author_id: 'nobody-here', body: 'hi',
      created_at: 1, edited_at: null, deleted_at: null, kind: 'text',
      reply_to: null, pinned_at: null, reactions: [], attachments: [],
    }])
    expect(() => draw(w)).not.toThrow()
  })
})
