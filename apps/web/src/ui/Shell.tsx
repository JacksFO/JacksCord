import { reloadApp } from '../lib/reload'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Still } from './Still'
import { conversations, type Conversation } from '../lib/dms'
import { loadSpaces, channelsOf, loadCategories, loadChannels, loadDms, loadFriends, loadSpace, replacingSpace } from '../lib/load'
import { moved, sectionId, sectionsOf } from '../lib/tree'
import { memberGroups, nameColourFrom, rolesOf } from '../lib/roles'
import { voiceModerationFor } from '../lib/voiceModeration'
import { nameLook } from '../lib/nameStyle'
import { nameIn, nicknameIn, spaceOfChannel } from '../lib/names'
import { canCopyPictures, copyPicture } from '../lib/copyPicture'
import { NewSince } from './NewSince'
import { JumpDown } from './JumpDown'
import { badgeLabel } from '../lib/shell'
import { LEVEL_LABEL, quietIn } from '../lib/notifyLevel'
import { isNamed } from '../lib/named'
import { Switcher } from './Switcher'
import { Shortcuts } from './Shortcuts'
import { moved as wrapped, targetsOf, type Target } from '../lib/switcher'
import { toast } from '../lib/toast'
import { memberModerationFor } from '../lib/memberModeration'
import type { Api } from '../lib/api'
import { remember, type World } from '../lib/world'
import type { PermissionId } from '../lib/permissions'
import type {
  ChannelKind, Activity, Channel, ChannelPref, Id, Message, Space, SpacePref, User,
} from '../lib/wire'
import { Avatar, AvatarWithStatus, seedOf } from './Avatar'
import { Composer, type Mention } from './Composer'
import { PollMaker } from './PollMaker'
import { primaryActivity } from '../lib/activity'
import { ActivityLine, InVoiceLine } from './Activity'
import { Icon } from './Icon'
import { readFrame, deleteFrame, editFrame, editIsDelete, reactFrame, watchingFrame } from '../lib/actions'
import { Menu, type MenuItem } from './Menu'
import { waitingHere } from '../lib/readall'
import { SHARE_PRESETS, qualityLabel } from '../lib/sharequality'
import { EmojiPicker } from './EmojiPicker'
import { Messages } from './Messages'
import { Profile } from './Profile'
import type { PaneId } from './Settings'
import { SettingsWindow } from './SettingsWindow'
import { NewServer } from './NewServer'
import { InvitePeople } from './InvitePeople'
import { NewGroup } from './NewGroup'
import { importGif } from '../lib/gifs'
import { Typing } from './Typing'
import { useTyping } from './useTyping'
import { useUpload } from './useUpload'
import { Scene } from './Scene'
import { CallSounds } from './CallSounds'
import { Stage } from './Stage'
import { Pip } from './Pip'
import { Friends, type FriendTab } from './Friends'
import { afterRequest, type RequestAnswer } from '../lib/friendRequest'
import { nextExpiry, statusOf } from '../lib/status'
import { Toasts } from './Toasts'
import { forgetSpot, lastSpot, rememberSpot } from '../lib/lastdm'
import { useMutual } from './useMutual'
import { Home } from './Home'
import { Modal } from './Modal'
import { NAME_COLOURS } from '../lib/nameStyle'
import { Pins } from './Pins'
import { ChannelPerms, type PermTarget } from './ChannelPerms'
import { serverPanesFor, type ServerPaneId } from './ServerSettings'
import { Search } from './Search'
import { useCall } from './useCall'
import type { CallControls } from './useCall'
import { useMessages } from './useMessages'
import { anchorOf, type Anchor } from './useAnchored'
import { usePanelWidths } from './usePanelWidths'
import { usePanelOrder } from './usePanelOrder'
import { Arrange } from './Arrange'
import { foldSide, PANELS, type Panel } from '../lib/panelOrder'
import { facesShown, occupantsByRoom, type Face } from '../lib/voiceRoom'
import { FIRST, STEP, grown, moreToShow, visible } from '../lib/messageWindow'
import { quickRow, remember as rememberEmoji } from '../lib/recentEmoji'
import { useSwipe } from './useSwipe'
import { TopBar } from './TopBar'
import { Intro } from './Intro'
import { voiceLabel } from '../lib/voiceLabel'
import { useWatching } from './useWatching'
import { useVoiceGate } from './useVoiceGate'
import { useNotify } from './useNotify'
import { usePushToTalk } from './usePushToTalk'
import { useLongPress } from './useLongPress'
import { UpdateBanner } from './UpdateBanner'
import { usePresence } from './usePresence'
import { useMarkRead } from './useMarkRead'
import { useVoiceState } from './useVoiceState'
import { useFileDrop } from './useFileDrop'
import { WhatsNew } from './WhatsNew'
import { GetDesktopBanner } from './GetDesktop'
import { useDragOrder } from './useDragOrder'
import { playAnswered, playHangup, startRinging, stopRinging } from '../lib/sound'
import { forgetVoice, intendToResume, voiceToResume } from '../lib/resume'
import { useCallSounds } from './useCallSounds'

/**
 * The app, arranged.
 *
 * Four columns on a desktop, fewer as the window narrows, and on a phone the
 * two side ones slide over the conversation. Which of those is happening is
 * decided from the width in one place — the old client wrote the columns as
 * an inline style, and an inline style beats every media query there is, so
 * the phone layout it shipped was overruled the moment the app drew itself
 * and the conversation ended up in the third column of four, past the right
 * edge of the screen.
 */

/**
 * A handle to drag a panel by, or null where there is nothing to drag.
 *
 * The last panel is grabbed on its left and everything else on its right —
 * otherwise the member list's handle sits past the right edge of the window,
 * where nobody can reach it.
 */
type Grip = ((e: React.PointerEvent) => void) | null

function PanelGrip({ on, atLeft = false }: { on: Grip; atLeft?: boolean }) {
  if (!on) return null
  return (
    <div
      className={atLeft ? 'pgrip at-left' : 'pgrip'}
      onPointerDown={on}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize this panel"
    />
  )
}

/**
 * What the app has to say, over the top of it.
 *
 * One strip rather than a place per kind: a refusal from the socket, a call
 * that would not start and a newer build being served are all the same thing
 * from where somebody is sitting — a sentence the app owes them — and three
 * separate corners for it is three places to not look.
 */
function Notices({ stale, error, onClear, share }: {
  stale: boolean
  error: string
  onClear: () => void
  /** A screen that was being shared before a reload, and what to do about it. */
  share?: { onResume: () => void; onDismiss: () => void } | null
}) {
  return (
    <div className="notices">
      {/* An update waiting to install, and the offer of the desktop build.
          Each decides for itself whether there is anything to say, so this
          strip is empty rather than absent when there is not. */}
      <UpdateBanner />
      <GetDesktopBanner />
      {/* And what the update that just installed was for, once, over
          everything. It decides for itself whether there is anything to say,
          and in a browser there never is. */}
      <WhatsNew />
      {share && (
        <div className="ubar">
          <span>You were sharing your screen.</span>
          <span className="gw" />
          <button className="btn p" onClick={share.onResume}>Share it again</button>
          <button className="btn" onClick={share.onDismiss}>Not now</button>
        </div>
      )}
      {error && (
        <div className="ubar bad">
          <span>{error}</span>
          <span className="gw" />
          <button className="btn" onClick={onClear}>Dismiss</button>
        </div>
      )}
      {stale && (
        /* Offered rather than forced: reloading in the middle of a sentence
           is worse than being a version behind for another minute. */
        <div className="ubar">
          <span>There is a newer version of this app.</span>
          <span className="gw" />
          <button className="btn p" onClick={reloadApp}>Reload</button>
        </div>
      )}
    </div>
  )
}

/** When somebody arrived, in the words a person would use. */
const since = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric',
  }) : 'a while ago'

/** How much is waiting anywhere in one server, for the tile in the rail. */
function waitingIn(world: World, spaceId: Id): number {
  let n = 0
  const now = Date.now()
  for (const c of world.channels) {
    if (c.space_id !== spaceId) continue
    /* Asked of the channel and the server together: a muted channel must not
       be counted, or a server carries a number no channel inside it will
       admit to - and a muted server must not be counted either, which is what
       asking a set of muted channel ids could never answer. */
    if (quietIn(c.id, spaceId, world.prefs, world.spacePrefs, now, isNamed(world, c.id, c.space_id))) continue
    n += world.unread.get(c.id) ?? 0
  }
  return n
}

/**
 * How much is waiting in conversations.
 *
 * The rail put a number on every server and nothing on the Conversations
 * button, so a message from somebody you are not in a server with rang, lit
 * the taskbar, and left the rail looking exactly as it had a moment before.
 * The one place in the app that says "there is something for you somewhere"
 * had nothing to say about the half of it that is not a server.
 *
 * Counted from the conversations themselves rather than from every channel
 * that is not in a server: a channel the client has heard of but is no longer
 * in would otherwise be counted here for ever.
 */
/**
 * What is waiting behind the home button: messages and friend requests.
 *
 * Two different things, deliberately one number. The tile answers "is there
 * something in here", and a person who has added you is exactly that.
 */
export function homeWaiting(world: World): number {
  const asking = world.friends.filter((f) => f.state === 'incoming').length
  return waitingInDms(world) + asking
}

/**
 * And what the number is, in words, for the tooltip.
 *
 * A bare "1" cannot say whether somebody messaged or somebody asked to be
 * friends, and the two are answered in different places - one in a
 * conversation, one on the Friends page. Reading the tile told you there was
 * something without telling you where to go, so the hover says which.
 *
 * The plain name when nothing is waiting: a tooltip that always lists
 * nothing is noise.
 */
export function homeTooltip(world: World): string {
  const asking = world.friends.filter((f) => f.state === 'incoming').length
  const msgs = waitingInDms(world)
  const parts: string[] = []
  if (msgs > 0) parts.push(`${msgs} message${msgs === 1 ? '' : 's'}`)
  if (asking > 0) parts.push(`${asking} friend request${asking === 1 ? '' : 's'}`)
  return parts.length ? `Conversations — ${parts.join(', ')}` : 'Conversations'
}

/**
 * The slow modes worth offering.
 *
 * Round numbers rather than a box asking for seconds - the useful settings
 * are a handful, and "how many seconds" is a question nobody wants to be
 * asked. The same ladder every app with this offers, so the numbers are
 * already familiar.
 */
/**
 * How long to stop somebody talking for.
 *
 * Round numbers, and short ones first: the commonest reason to reach for this
 * is a conversation getting heated, which wants minutes rather than days. A
 * week is the outside because a timeout nobody remembers setting is a ban
 * that nobody decided to make.
 */
const TIMEOUTS: ReadonlyArray<readonly [number, string]> = [
  [5, 'For 5 minutes'],
  [10, 'For 10 minutes'],
  [60, 'For an hour'],
  [24 * 60, 'For a day'],
  [7 * 24 * 60, 'For a week'],
]

const SLOWMODES: ReadonlyArray<readonly [number, string]> = [
  [0, 'Off'],
  [5, '5 seconds'],
  [10, '10 seconds'],
  [30, '30 seconds'],
  [60, '1 minute'],
  [300, '5 minutes'],
  [900, '15 minutes'],
  [3600, '1 hour'],
  [21600, '6 hours'],
]

function waitingInDms(world: World): number {
  let n = 0
  for (const d of world.dms) {
    if (world.muted.has(d.id)) continue
    n += world.unread.get(d.id) ?? 0
  }
  return n
}

/**
 * The permissions that put anything in a server's settings.
 *
 * If none of them are held there is nothing in there to open, and the way in
 * is absent rather than opening an empty screen. Listed rather than asked one
 * at a time so that adding a pane means adding it here too, in the one place
 * that decides whether the door exists.
 */
const MANAGES: readonly PermissionId[] =
  ['manage_space', 'manage_channels', 'manage_roles', 'create_invite']

/**
 * And what it takes to rearrange the place, which is not the same question.
 *
 * `create_invite` belongs in the list above - an invite is a pane in that
 * screen, so holding it means there is something in there for you - and every
 * member holds it by default. Using that same list to decide who may make a
 * channel, drag one, or right-click the empty space handed all of it to
 * everybody: an ordinary member saw the plus on every heading, could drag the
 * list into a new order, and was offered a settings door that is mostly not
 * theirs. The server refused all of it, which is the only reason this was a
 * mess on screen rather than a hole.
 */
const REARRANGES: readonly PermissionId[] = ['manage_channels']

const PHONE = 820
const TABLET = 1250

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

export function Shell({
  world, server, onOut, send, gateway, settings, set, reset, version, changed,
  stale, error, clearError,
}: {
  world: World
  server: Api
  onOut: () => void
  send: (payload: unknown) => void
  /**
   * A number that goes up every time the world changes.
   *
   * The world is one mutable object, changed in place, and its identity never
   * moves - which is deliberate, because copying it on every presence tick is
   * the cost this app cannot afford. The consequence is that anything derived
   * from it with useMemo and `[world]` as the dependency is computed once and
   * then frozen for the session. That is exactly what happened to the list of
   * conversations: it was sorted newest-first correctly and never sorted
   * again, so a DM somebody had just been talking in stayed wherever it was.
   */
  version: number
  /** Say the world was changed in place, so what reads it draws again. */
  changed: () => void
  gateway: import('../lib/gateway').Gateway | null
  settings: import('../lib/settings').Settings
  set: <K extends keyof import('../lib/settings').Settings>(
    k: K, v: import('../lib/settings').Settings[K]) => void
  reset: () => void
  /** A newer build is being served than the one in this tab. */
  stale: boolean
  /** Whatever the server last refused, and a way to stop reading it. */
  error: string
  clearError: () => void
}) {
  const width = useWidth()
  /* The widths somebody dragged the panels to, put on the document. On a
     phone the panels stack and the columns come from a media query, so the
     grips are not drawn — the values stay saved and are there again the
     moment the window is wide enough for them. */
  const { drag } = usePanelWidths(settings, set)

  /*
   * Where the columns are, and whether somebody is moving them.
   *
   * The order is applied always; arranging is only the moment of changing it.
   * Kept here rather than in the settings screen because the thing being
   * arranged is the app, and the settings screen closes to get out of its
   * way.
   */
  /* Folded away means no column at all, not a column of nothing - see
     columnsFor. Everything to the right of it moves up one. */
  usePanelOrder(settings.panelOrder, settings.sideShut ? ['channels'] : [])

  /* Which way the channel list folds away, and what it folds against - both
     out of the arrangement, because the list is only on the left until
     somebody drags it somewhere else. */
  const fold = foldSide(settings.panelOrder, 'channels')
  const [arranging, setArranging] = useState(false)


  /*
   * The call, held here rather than inside whatever is drawing it.
   *
   * A call outlives the stage — closing the stage goes back to reading the
   * conversation while still being in the room — so the state cannot belong
   * to the stage, and the sounds cannot be drawn by it either.
   */
  const call = useCall(server, {
    ...(settings.mic ? { deviceId: settings.mic } : {}),
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  })
  /* Whether the call is filling the middle of the window. Being in one and
     looking at it are different questions: you can be in a call and reading
     somewhere else entirely. */
  /*
   * Back into the call this page was reloaded out of.
   *
   * Shipping an update to this app means reloading the page, and reloading
   * the page drops you out of voice — which is a rotten way to update
   * somebody who is mid-conversation.
   *
   * Once, and only into a room that still exists and is one you can be in: a
   * note pointing at a channel that has been deleted, or at a text channel,
   * would otherwise be a join the server refuses and an error nobody caused.
   * The note itself refuses to travel between tabs and expires in two
   * minutes, so this cannot follow anybody around.
   */
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || world.channels.length === 0) return
    resumed.current = true
    const back = voiceToResume()
    if (!back) return
    /* A voice room, or a conversation — which is not in `channels` at all,
       so it is looked for where conversations live. */
    const room = world.channels.find((c) => c.id === back.channelId)
    const chat = world.dms.find((d) => d.id === back.channelId)
    if (!chat && room?.kind !== 'voice') {
      forgetVoice()
      return
    }
    void call.join(back.channelId).then(() => {
      /* Muted comes back muted. Arriving unmuted into a room you did not
         knowingly rejoin is the one mistake this must not make. */
      if (back.deafened) call.setDeaf(true)
      else if (back.muted) call.setMuted(true)
      /*
       * And the screen, offered rather than resumed.
       *
       * A capture does not survive the page that owns it, and starting one
       * needs somebody to press something - deliberately, because a page
       * that could re-capture your screen after a reload could do it after a
       * reload it caused. The microphone comes back on its own because
       * permission for it is remembered for the whole origin; there is no
       * such thing for a screen, and there should not be.
       */
      if (back.share !== undefined) setOfferShare({ source: back.share })
    })
  /* The length, not the list: this runs once, the first time channels
     arrive, and the ref above makes sure of it. Depending on the arrays
     themselves would re-run it on every message that changes one. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.channels.length, call])

  /*
   * Redraw when the next status on screen runs out.
   *
   * One timer, set for the exact moment, rather than asking every half minute
   * whether anything has lapsed - and no timer at all while nobody has one
   * set, which is nearly always. Nothing is fetched and nothing is pushed:
   * every client already holds the moment and works it out for itself.
   */
  useEffect(() => {
    const soonest = nextExpiry(world.people.values())
    if (soonest === null) return
    /* Capped, because a timeout beyond about 24 days overflows and fires at
       once - which would be a redraw loop rather than a wait. */
    const wait = Math.min(soonest - Date.now() + 1000, 6 * 60 * 60_000)
    if (wait <= 0) { changed(); return }
    const timer = setTimeout(changed, wait)
    return () => clearTimeout(timer)
  }, [world, version, changed])

  /* A share that was running before a reload, waiting to be put back. */
  const [offerShare, setOfferShare] = useState<{ source: string | null } | null>(null)
  const [onStage, setOnStage] = useState(false)

  /*
   * Held to talk, where the shell can hear a key the window did not get.
   *
   * Muting is the same mute the button uses, so the two cannot disagree —
   * releasing the key and pressing Unmute are one state, not two.
   */
  usePushToTalk(settings.pushToTalk, !!call.call.channel,
    useCallback((down: boolean) => call.setMuted(!down), [call]))

  /*
   * And when there is no key, only send while somebody is talking.
   *
   * Not while a key is set: two things deciding when the microphone opens is
   * one too many, and somebody who set a key has already answered this. Not
   * while muted either - mute is a decision, and a gate reopening a
   * microphone somebody shut would be the worst bug in the app.
   */
  useVoiceGate({
    active: !!call.call.channel && !settings.pushToTalk && !call.call.muted,
    auto: settings.gateAuto,
    line: settings.gate,
    /*
     * A copy of the track being sent, rather than a second capture of the
     * device. Two captures meant two independent chains of gain and noise
     * suppression, so what was measured drifted from what was published.
     */
    micStream: call.micStream,
    gate: call.gate,
  })

  /*
   * How tall the notices are, told to the stylesheet.
   *
   * They are drawn over the app so that a sentence about the app does not
   * move the app - but over the app also means over whatever is under them,
   * and the offer of the desktop build sat squarely on the Accept button of
   * a friend request. So the panels stay exactly where they are and reserve
   * that much inside themselves: the frames do not move, and nothing ends up
   * permanently unreachable.
   *
   * Measured rather than assumed: two notices are twice as tall as one, and
   * a hard-coded number is wrong the moment a second one appears.
   */
  const bars = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bars.current
    if (!el) return
    /*
     * How tall the notices are, told to the stylesheet.
     *
     * Its content and not its box: the strip is deliberately nothing tall so
     * that it costs no row, and what overflows it is the thing to make room
     * for. Asking the box gives nought however many notices are in it.
     *
     * The stylesheet decides *which* panel reserves it, because a panel is
     * replaced when somebody walks to another page - the friends list builds
     * its own - and anything set from here lands on whichever panel happened
     * to exist at the time. A rule finds the new one for nothing.
     */
    const say = () => {
      const h = Math.round(el.scrollHeight)
      document.documentElement.style.setProperty('--bars', h > 0 ? `${h}px` : '0px')
    }
    say()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(say)
    ro.observe(el)
    for (const child of el.children) ro.observe(child)
    /* And when a notice comes or goes, which is a change of children rather
       than a change of size - the box stays nought tall either way. */
    const mo = new MutationObserver(() => {
      say()
      for (const child of el.children) ro.observe(child)
    })
    mo.observe(el, { childList: true })
    /* And when the window changes shape, because which panel sits under a
       notice is a fact about where the panels are. */
    window.addEventListener('resize', say)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', say)
    }
  }, [])

  /* The panel down the right, if any. Held here rather than in the
     conversation because a search result can be in a different channel, and
     following one has to be able to change which conversation is open. */
  const [panel, setPanel] = useState<'pins' | 'search' | null>(null)
  /* The two things the keyboard can put on screen from anywhere. */
  const [switching, setSwitching] = useState(false)
  const [showingKeys, setShowingKeys] = useState(false)
  /*
   * Where you have been, newest first.
   *
   * The switcher opens on this rather than on everything there is, because
   * the commonest reason to open one is going back to the thing you were just
   * looking at. Kept here rather than on the world: it is this session's
   * path through the app, and it should not outlive the tab.
   */
  const visited = useRef<Id[]>([])
  /*
   * Which of the three pages outside a server is showing.
   *
   * Home and Friends are not conversations, so they are not a channel id with
   * a special value — a null channel already means "nothing open", and using
   * it for two more things is how "nothing open" starts needing a comment.
   */
  /*
   * Home, when there is no server to open on.
   *
   * This began as null for everybody, which is right for an account with a
   * server - it opens on the server. For a brand new one it meant landing on
   * "Nothing open. Pick a conversation." with no conversations to pick and
   * no servers in the rail: a blank screen, on the one visit where somebody
   * has the least idea what to do next. Home is the page that carries both
   * of the offers for exactly that account - make or join a server, and add
   * somebody - so that is where they land.
   */
  const [page, setPage] = useState<'home' | 'friends' | null>(
    () => (world.spaces[0] ? null : 'home'),
  )
  /* Which server is being walked out of, while the question is being asked. */
  const [leaving, setLeaving] = useState<Space | null>(null)
  const [leaveSaid, setLeaveSaid] = useState('')
  /* Which channel's own rules are being looked at, if any. */
  /* Whose rules are open: a channel or a heading, which are the same panel
     asked of a different row. */
  const [permsFor, setPermsFor] = useState<PermTarget | null>(null)
  /* Which voice room is having its colour chosen, if any. */
  const [colouring, setColouring] = useState<{ id: Id; name: string; was: string } | null>(null)
  /* A channel's own menu, which is more than one thing now. */
  const [chanMenu, setChanMenu] = useState<
    { items: MenuItem[]; x: number; y: number } | null
  >(null)

  /**
   * A person's own menu, from wherever they are named.
   *
   * Right-clicking somebody opened nothing at all — the only way to reach
   * anything about a person was the card, and the card is what you get for a
   * left-click. Everything here is also on the card; this is the shorter way
   * to the two things anybody actually wants.
   */
  const whoMenu = (id: Id, x: number, y: number) => {
    const person = world.people.get(id)
    if (!person) return
    const items: MenuItem[] = [
      {
        kind: 'item', label: 'Profile', icon: 'user',
        /* Placed where the pointer is, since there is no row to hang it off
           by the time this runs. */
        onPick: () => setCard({ id, anchor: { x, y, w: 0, h: 0 } }),
      },
    ]
    if (id !== world.me.id) {
      items.push({
        kind: 'item', label: 'Message', icon: 'chat',
        /* Through the one door. Reached from a server's member list, this is
           the only caller that has to leave a server on the way. */
        onPick: () => {
          void openConversationWith(id).catch(() => { /* refused or offline */ })
        },
      })
    }
    /*
     * Adding somebody, or letting them go.
     *
     * Reachable from the member list, which is where you see somebody you
     * have been talking to and think "who is that". It was only on the
     * Friends page, which you have to already know they exist to visit.
     */
    if (id !== world.me.id) {
      const friend = world.friends.find((f) => f.id === id)
      items.push({ kind: 'rule' })
      if (!friend) {
        items.push({
          kind: 'item', label: 'Add friend', icon: 'people',
          onPick: () => {
            void server.post('/api/friends/request', { name: person.username })
              .then(() => friendAction('refresh', id))
              .catch(() => { /* refused, or already asked */ })
          },
        })
      } else if (friend.state === 'incoming') {
        items.push({
          kind: 'item', label: 'Accept friend request', icon: 'people',
          onPick: () => { void friendAction('accept', id) },
        })
      } else {
        items.push({
          kind: 'item',
          label: friend.state === 'outgoing' ? 'Take back the request' : 'Remove friend',
          icon: 'out', danger: true,
          onPick: () => { void friendAction('remove', id) },
        })
      }
    }

    /*
     * What they are called in this server.
     *
     * The route has been there all along and nothing ever called it, so a
     * nickname could be held in the database and never set by anybody. Only
     * for somebody who may hand them out: absent rather than refused.
     */
    if (space && here.includes('manage_nicknames')) {
      items.push({
        kind: 'item', label: 'Nickname', icon: 'pencil',
        onPick: () => {
          /* What is set here, not what is shown: the box is empty when
             they have no nickname in this server, so saving nothing is
             clearing it rather than pinning their own name as one. */
          setNewName(nicknameIn(world, space?.id ?? null, id))
          setNaming({ kind: 'nickname', id, was: person.display_name || person.username })
        },
      })
    }

    /*
     * Moderating a voice room.
     *
     * The server has done all of this since voice was written - a mute is
     * held per server and per person, written to the audit log, and put into
     * the LiveKit token so it holds even against a patched client. Nothing
     * in the app ever sent the frame, so from the inside it read as a feature
     * nobody had built.
     *
     * Every condition below mirrors one the server checks, so an item that
     * would be refused is absent instead: they have to be in a voice room
     * this account can see, it must be a server's room rather than somebody's
     * private call, and you have to hold the permission there and outrank
     * them. The server checks all four again - this decides what to draw, not
     * what is allowed.
     */
    const mod = voiceModerationFor(world, id)
    if (mod) {
      items.push({ kind: 'rule' })
      if (mod.maySilence) {
        items.push({
          kind: 'item',
          label: mod.serverMuted ? 'Let them speak' : 'Silence in voice',
          icon: mod.serverMuted ? 'mic' : 'micoff',
          onPick: () => send({ t: 'voice-moderate', userId: id, serverMuted: !mod.serverMuted }),
        })
        items.push({
          kind: 'item',
          label: mod.serverDeafened ? 'Let them hear' : 'Deafen in voice',
          icon: mod.serverDeafened ? 'head' : 'headoff',
          onPick: () => send({
            t: 'voice-moderate', userId: id, serverDeafened: !mod.serverDeafened,
          }),
        })
      }
      /* Out of the call, not out of the server. Named for what it does, so
         nobody reads it as removing them from the place. */
      if (mod.mayRemove) {
        items.push({
          kind: 'item', label: 'Remove from the call', icon: 'phoneoff', danger: true,
          onPick: () => send({ t: 'voice-disconnect-member', userId: id }),
        })
      }
    }

    /*
     * Removing somebody, and barring them.
     *
     * Both already existed, several clicks into a server's settings - which
     * is not where anybody reaches for them. This is: you are looking at the
     * person. Every condition is the server's own, worked out in
     * memberModerationFor, so an item that would be refused is absent.
     *
     * Barring asks first. Removing somebody is undone by them clicking the
     * invite again; barring them is undone by nobody but a moderator, and a
     * menu item one row from "Message" is exactly where a misclick lands.
     */
    const mod2 = memberModerationFor(world, space, id)
    if (mod2) {
      items.push({ kind: 'rule' })
      /*
       * Timing out first, because it is the smallest of the three and the one
       * that should be reached for before the others. Ordered the other way
       * round, the biggest tool is the nearest to hand.
       *
       * A submenu of lengths rather than a dialog: the decision is how long,
       * there are five answers worth offering, and none of them needs
       * explaining the way barring somebody does.
       */
      if (mod2.mayTimeOut) {
        items.push({
          kind: 'item', label: 'Time out…', icon: 'clock',
          onPick: () => setTimingOut({
            id, spaceId: mod2.spaceId, name: nameIn(world, space!.id, person),
          }),
        })
      }
      if (mod2.mayKick) {
        items.push({
          kind: 'item', label: `Remove from ${space!.name}`, icon: 'out', danger: true,
          onPick: () => { void moderateMember('remove', id, mod2.spaceId) },
        })
      }
      if (mod2.mayBan) {
        items.push({
          kind: 'item', label: `Ban from ${space!.name}`, icon: 'ban', danger: true,
          onPick: () => setBanning({
            id, spaceId: mod2.spaceId,
            name: nameIn(world, space!.id, person),
            where: space!.name,
          }),
        })
      }
    }

    /*
     * Blocking, and lifting it.
     *
     * Last, and on its own, because it is the only thing in this menu that
     * is about wanting somebody to stop. Everything above is a moderator
     * acting inside a server; this is one person's decision about their own
     * attention, and it needs no permission and works everywhere.
     *
     * Never on yourself. The server refuses it, and an item that is going to
     * be refused should not be drawn.
     */
    if (id !== world.me.id) {
      const blocked = world.blocked.has(id)
      items.push({ kind: 'rule' })
      items.push({
        kind: 'item',
        label: blocked ? 'Unblock' : 'Block',
        icon: blocked ? 'people' : 'ban',
        danger: !blocked,
        onPick: () => { void blockAction(id, !blocked) },
      })
    }

    items.push({ kind: 'rule' })
    items.push({
      kind: 'item', label: 'Copy name', icon: 'copy',
      onPick: () => {
        void navigator.clipboard?.writeText(person.display_name || person.username)
      },
    })
    setChanMenu({ items, x, y })
  }

  /**
   * Muting a channel, or letting it speak again.
   *
   * `muteFor` is a length of time and not a flag — zero is indefinitely,
   * null is not muted. Sent as `{ muted: true }` the route reads neither
   * field it looks for, stores nothing, and the channel stays exactly as it
   * was; which is what the other client did, in both directions at once.
   */
  const setMuted = (id: Id, on: boolean) => {
    /* Set here as well as asked for. The server does not announce a
       preference back — it is nobody's business but this account's — so
       waiting for an event would be waiting for one that never comes. */
    if (on) world.muted.add(id)
    else world.muted.delete(id)
    changed()
    void server.put(`/api/channels/${encodeURIComponent(id)}/prefs`,
      { muteFor: on ? 0 : null })
      .catch(() => {
        /* Refused or offline: put it back rather than showing a state the
           server does not agree with. */
        if (on) world.muted.delete(id)
        else world.muted.add(id)
        changed()
      })
  }
  const [addingFriend, setAddingFriend] = useState<string | null>(null)
  /* Which friends list is showing. Out here so that sending a request can
     land you on the one the request just went into. */
  const [friendTab, setFriendTab] = useState<FriendTab>('online')
  const [friendSaid, setFriendSaid] = useState('')

  /**
   * Accepting, ignoring, taking back and unfriending.
   *
   * The server takes the same body for all of them and answers the same way,
   * so they are one call with a different word in the path — and the list is
   * refetched rather than adjusted here, because what a request becomes is
   * the server's answer and not this client's guess.
   */
  /* `refresh` asks for nothing and only reloads the list, for after a
     request has been sent by another route. */
  const friendAction = async (what: 'accept' | 'remove' | 'refresh', userId: Id) => {
    try {
      if (what !== 'refresh') await server.post(`/api/friends/${what}`, { userId })
      world.friends = await loadFriends(server)
      /* And say so, or the list beside it is the one worked out before. */
      changed()
    } catch {
      /* Refused, or offline. The list stays as it was rather than showing a
         change the server did not make. */
    }
  }
  /**
   * Blocking somebody, and lifting it.
   *
   * The list is not adjusted here and then confirmed. The server answers
   * with the whole list on `blocks-changed`, which is what the world holds -
   * so a refusal leaves the screen showing what is actually in force rather
   * than what was attempted. Blocking also ends a friendship, and guessing
   * at half of that here is how the two get out of step.
   *
   * The friends list is reloaded because of that side effect: without it
   * somebody stays on the Friends page, un-messageable, which reads as a bug
   * rather than as a decision.
   */
  const blockAction = async (userId: Id, on: boolean) => {
    try {
      if (on) await server.post('/api/blocks', { userId })
      else await server.delete(`/api/blocks/${encodeURIComponent(userId)}`)
      world.friends = await loadFriends(server)
      changed()
    } catch {
      /* Refused, or offline. Nothing has been changed here to put back. */
    }
  }
  /**
   * Removing somebody from a server, or barring them.
   *
   * The roster is asked for again rather than adjusted here: what happened is
   * the server's answer, and the member list is drawn from that roster. The
   * gateway also announces it to everybody else, so this is only about the
   * window that asked.
   */
  const moderateMember = async (what: 'remove' | 'ban', userId: Id, spaceId: Id) => {
    const where = `spaceId=${encodeURIComponent(spaceId)}`
    try {
      if (what === 'ban') {
        await server.post(`/api/admin/members/${encodeURIComponent(userId)}/ban?${where}`, {})
      } else {
        await server.delete(`/api/admin/members/${encodeURIComponent(userId)}?${where}`)
      }
      world.loaded.delete(spaceId)
      await loadSpace(server, world, spaceId).catch(() => {})
      changed()
    } catch {
      /* Refused or offline. Nothing was changed here to put back. */
    }
  }
  /**
   * Stop somebody talking for a while, and put the roster right afterwards.
   *
   * Read back rather than adjusted here, the same as removing and barring:
   * what happened is the server's answer.
   */
  const timeOutMember = async (userId: Id, spaceId: Id, minutes: number) => {
    const where = `spaceId=${encodeURIComponent(spaceId)}`
    try {
      await server.post(
        `/api/admin/members/${encodeURIComponent(userId)}/timeout?${where}`,
        { minutes },
      )
      world.loaded.delete(spaceId)
      await loadSpace(server, world, spaceId).catch(() => {})
      changed()
    } catch {
      /* Refused or offline. Nothing was changed here to put back. */
    }
  }
  /* Somebody about to be stopped from talking, and for how long. */
  const [timingOut, setTimingOut] = useState<
    { id: Id; spaceId: Id; name: string } | null
  >(null)
  const [timeoutMins, setTimeoutMins] = useState(10)
  /* Somebody about to be barred, held until it is confirmed. */
  const [banning, setBanning] = useState<
    { id: Id; spaceId: Id; name: string; where: string } | null
  >(null)
  /* A message to go to once its channel is loaded. Followed across channels,
     which is why it cannot simply scroll: the list it is in does not exist
     yet at the moment somebody presses the result. */
  const [goingTo, setGoingTo] = useState<Id | null>(null)
  /* Where you are: a server, or your conversations. One or the other, never
     both — a conversation belongs to nobody, which is the whole point of it. */
  const [where, setWhere] = useState<{ kind: 'space'; id: Id } | { kind: 'dms' }>(
    () => (world.spaces[0] ? { kind: 'space', id: world.spaces[0].id } : { kind: 'dms' }),
  )
  const [channelId, setChannelId] = useState<Id | null>(null)
  /*
   * The channel you were last reading in each server.
   *
   * Coming back to a server put you in its first text channel every time,
   * whatever you had been reading - so a glance at another server cost you
   * your place, and you had to find the channel again by hand. The rail
   * already remembers which conversation you were in; this is the same idea
   * for a server.
   *
   * Held for the session rather than saved: it is where you were a moment
   * ago, not a preference, and a server you have not opened since starting
   * the app has no answer to give.
   */
  const lastChannelIn = useRef<Map<Id, Id>>(new Map())
  const [slid, setSlid] = useState<'nav' | 'members' | null>(null)

  /* Whose card is open, and beside what. Both, because a card with no anchor
     has nowhere to be and one with no person has nothing to say. */
  const [card, setCard] = useState<{ id: Id; anchor: Anchor } | null>(null)
  /*
   * Settings, and which pane to land on.
   *
   * A flag could only say "open settings", so everything that wanted a
   * particular pane got the account instead - which is how "All the release
   * notes" opened on somebody's display name. Null is closed; a pane id is
   * open on that one; true means open wherever it opens by itself.
   */
  const [showSettings, setShowSettings] = useState<PaneId | ServerPaneId | boolean>(false)
  /* Making a server, or joining one with a code. */
  const [makingServer, setMakingServer] = useState(false)
  /* And inviting somebody into the one being looked at. */
  const [inviting, setInviting] = useState(false)
  /* And starting a conversation with several people at once. */
  const [makingGroup, setMakingGroup] = useState(false)

  /*
   * Tell the room what you are watching.
   *
   * Nothing streams until somebody asks for it, so without this only the
   * media server knew who had asked — and a person sharing had no way of
   * knowing whether anybody was looking. Sent whole rather than as changes,
   * so two of them arriving out of order cannot leave the server believing
   * somebody is watching a thing they closed.
   */
  const watchKey = [...call.call.watching].sort().join(',')
  useEffect(() => {
    if (!call.call.channel) return
    send(watchingFrame(watchKey ? watchKey.split(',') : []))
  }, [watchKey, call.call.channel, send])
  /* A heading being named, before it exists. */
  /**
   * Something being named: a new heading, or an existing thing renamed.
   *
   * One dialog rather than three. What differs between them is the title, the
   * placeholder and where the answer is sent, and all three of those fit in
   * the state that opens it.
   */
  const [naming, setNaming] = useState<
    | { kind: 'category' }
    /* A channel, and where it is going: under a heading, or loose at the top
       when there is no heading to put it under. */
    | { kind: 'channel'; categoryId: Id | null }
    /* What somebody is called in this server, which is a name for a person
       rather than for a thing and so has its own shape. */
    | { kind: 'nickname'; id: Id; was: string }
    | { kind: 'rename'; what: 'channels' | 'categories'; id: Id; was: string
        /* What it says under its name, for a channel. Shown and never
           editable anywhere until now: the server has taken it on this same
           call all along. */
        topic?: string }
    | null
  >(null)
  const [newName, setNewName] = useState('')
  /* And what it is about, for a channel being renamed. */
  const [newTopic, setNewTopic] = useState('')
  /* Slow mode, as a number of seconds, on the same dialog as the topic - it
     is a property of the channel and this is where a channel is changed. */
  const [newSlow, setNewSlow] = useState(0)
  /* Something about to be removed, held until it is confirmed. */
  const [deleting, setDeleting] = useState<
    { what: 'channels' | 'categories'; id: Id; name: string } | null
  >(null)


  /**
   * Opening something to read.
   *
   * Leaves the stage, which is the part that was missing: the stage replaces
   * the conversation rather than floating over it, so picking a channel while
   * watching a screen set the channel underneath a stage that stayed exactly
   * where it was — a click that appeared to do nothing at all.
   *
   * The call itself carries on. What was being watched comes back as the
   * floating panel, which is what it is for.
   */
  /*
   * Leaving a call takes the stage down with it.
   *
   * The stage is drawn when this flag is set AND there is a call, so leaving
   * hid it by removing the second half while the flag stayed on. Rejoining
   * put the call back, both halves were true again, and the stage opened by
   * itself — which is exactly what joining is not supposed to do. Reported as
   * "it still opens sometimes", and the sometimes was "if you had opened it
   * earlier in the session".
   *
   * Watching the call rather than patching each way out, because there are
   * several: the leave button, being moved, being kicked, and the connection
   * dropping. A move is a leave and a join in one step and never reports no
   * channel, so this does not close the stage on the way between rooms.
   */
  useEffect(() => {
    if (!call.call.channel) setOnStage(false)
  }, [call.call.channel])

  /*
   * What this machine is doing, for the people who can see it.
   *
   * Off unless somebody has turned one of the two switches on - and only the
   * desktop app can answer either question, so in a browser this does
   * nothing at all.
   */
  usePresence(server, send as (f: { t: 'activity'; activities: Activity[] }) => void, {
    game: settings.showGame,
    music: settings.showMusic,
  })

  /*
   * Where you were, kept for the button that comes back here.
   *
   * Watched rather than written where a channel is opened: that one function
   * opens server channels too, and this is only about conversations. An
   * effect can read which side you are on without the opening having to know.
   */
  useEffect(() => {
    if (where.kind !== 'dms') return
    /* Whichever of the three the conversations side is showing. A page and a
       conversation are never both on: opening one clears the other. */
    if (channelId) rememberSpot({ kind: 'dm', channelId })
    else if (page) rememberSpot({ kind: 'page', page })
  }, [where, channelId, page])

  /**
   * What to be told about a whole server.
   *
   * Written through the server rather than kept here, because it is a fact
   * about the account and not about this window - and the answer comes back
   * to every other window of theirs as well, so muting a server on the
   * desktop does not leave it ringing on a phone.
   */
  const setSpacePref = useCallback(
    (spaceId: Id, body: { level?: string; muteFor?: number | null }) => {
      void server.put<{ pref?: SpacePref }>(
        `/api/spaces/${encodeURIComponent(spaceId)}/prefs`, body,
      )
        .then((r) => {
          if (!r?.pref) return
          world.spacePrefs.set(spaceId, r.pref)
          /* The same set every badge already asks, so a muted server stops
             counting without anything else having to learn a second rule. */
          const off = (r.pref.mutedUntil !== null && r.pref.mutedUntil > Date.now())
            || r.pref.level === 'nothing'
          if (off) world.muted.add(spaceId)
          else world.muted.delete(spaceId)
          changed()
        })
        .catch(() => { /* refused or offline */ })
    },
    [server, world, changed],
  )

  /*
   * Whether muted channels are hidden, per server.
   *
   * Kept on this machine rather than on the account: it is a view of this
   * screen rather than a fact about the person, and the same list can
   * reasonably be tidied on a laptop and left alone on a phone.
   */
  const [hiddenIn, setHiddenIn] = useState<Set<Id>>(() => {
    try {
      const had = localStorage.getItem('atrium.hideMuted')
      return new Set(had ? (JSON.parse(had) as Id[]) : [])
    } catch { return new Set() }
  })
  const hidingMuted = useCallback((spaceId: Id) => hiddenIn.has(spaceId), [hiddenIn])
  const setHidingMuted = useCallback((spaceId: Id, hide: boolean) => {
    setHiddenIn((was) => {
      const next = new Set(was)
      if (hide) next.add(spaceId)
      else next.delete(spaceId)
      try { localStorage.setItem('atrium.hideMuted', JSON.stringify([...next])) }
      catch { /* a preference that cannot be written is still worth having now */ }
      return next
    })
  }, [])

  const openToRead = useCallback((id: Id | null) => {
    setPage(null)
    setOnStage(false)
    setChannelId(id)
    setSlid(null)
  }, [])

  /**
   * Open the conversation with somebody, from anywhere in the app.
   *
   * Three callers already did this by hand and a fourth did most of it. The
   * one that was wrong is the only one reached from inside a server -
   * "Message" on the member list - and it set which channel was open without
   * setting which server you were in, which is the other half of where you
   * are. While that still says a server the conversation cannot resolve at
   * all, so the id went somewhere the screen had no way to draw: the menu
   * closed and nothing moved.
   *
   * The three that worked were all reached from the conversations screen,
   * where that half was already right - which is why the same few lines
   * copied four times were correct three times.
   *
   * Both halves, and the list, in one place.
   */
  const openConversationWith = useCallback(async (who: Id) => {
    const r = await server.post<{ channel?: { id?: Id } }>('/api/dms', { userId: who })
    const opened = r?.channel?.id
    if (!opened) return null
    /* Fetched rather than appended, so what a conversation is called is the
       server's answer and not a guess made here. */
    world.dms = await loadDms(server).catch(() => world.dms)
    /* And say so. The world is one object changed in place, so a new entry
       in the list is not noticed by itself. */
    changed()
    /* Which server, then which channel. A conversation belongs to nobody, so
       arriving in one means leaving whatever server you were in. */
    setWhere({ kind: 'dms' })
    openToRead(opened)
    return opened
  }, [server, world, changed, openToRead])



  /* Written from the list as it is on screen. Two people rearranging at once
     each send what they are looking at, so the last to arrive wins whole
     rather than interleaving into something neither asked for. */
  const reorderSpaces = useCallback((order: Id[]) => {
    /*
     * Moved here first, asked afterwards.
     *
     * This waited for the write and then for a fresh list before anything on
     * screen changed — two round trips of a tile sitting where it was
     * dropped from, which reads as a drag that did not take. The order is
     * one person's own, so there is nothing to reconcile with anybody:
     * putting it back is only for a server that refuses.
     */
    const before = world.spaces
    const by = new Map(order.map((id, i) => [id, i]))
    world.spaces = [...world.spaces].sort(
      (a, b) => (by.get(a.id) ?? 0) - (by.get(b.id) ?? 0),
    )
    changed()

    void server.post('/api/spaces/reorder', { order })
      .catch(() => {
        /* Refused or offline: back where it was, rather than a rail that
           disagrees with the server until the next reload. */
        world.spaces = before
        changed()
      })
  }, [server, world, changed])

  /*
   * What the app sounds like.
   *
   * A conversation's call is left out of these: it has its own — ringing,
   * answered, hung up — and the room chimes over the top of those is two
   * noises for one thing.
   */
  useCallSounds(call.call, useCallback(
    (channelId: Id | null) =>
      !!channelId && world.channels.every((c) => c.id !== channelId),
    [world],
  ))

  /**
   * Ringing somebody.
   *
   * You are put into the call at once and hear it ringing for ten seconds.
   * If nobody picks up in that time the ringing stops and you are still in
   * the call — which is the difference between a phone and this: there is a
   * room, it is open, and the person you rang can walk into it for as long as
   * the server keeps it (two minutes after you are left alone in it).
   *
   * The ring itself is only ever heard by the person who started it. What
   * reaches the other end is the `call-ring` frame, which is also what makes
   * the server write the call into the conversation.
   */
  const ring = useCallback((channelId: Id, peerId: Id | null) => {
    const already = call.call.channel === channelId
    setOnStage(true)
    if (!already) void call.join(channelId)
    if (!peerId) return
    send({ t: 'call-ring', to: peerId })
    startRinging()
    /* Ten seconds, then quiet — whether or not they answered. Answering
       stops it below; this is the case where nobody does. */
    window.setTimeout(stopRinging, 10_000)
  }, [call, send])

  /*
   * They picked up, or they did not.
   *
   * Either way the ringing stops: it has done its job the moment there is an
   * answer, and going on after a decline is the app arguing with somebody.
   */
  useEffect(() => {
    if (!gateway) return
    const off = gateway.on((e) => {
      if (e.t === 'call-accept') {
        stopRinging()
        playAnswered()
        return
      }
      if (e.t === 'call-decline' || e.t === 'call-cancel') {
        stopRinging()
        playHangup()
        return
      }
      /*
       * Somebody is ringing you.
       *
       * The same ten seconds the caller hears, and then quiet — but the room
       * stays open, so the call row in the conversation keeps its Join button
       * for as long as the server holds it. Not answered automatically and
       * not a dialog over the whole screen: walking into a call has to be
       * something a person did on purpose.
       */
      if (e.t === 'call-incoming') {
        startRinging()
        window.setTimeout(stopRinging, 10_000)
        /* And a word about it, in case they are not looking. Silent, because
           the ringing is the sound — two at once is a mess. */
        const who = world.people.get(e.from)
        /* Their own name: a call is a conversation, and nobody's server has
           a say in what somebody ringing you is called. */
        const name = who?.display_name || who?.username || 'Somebody'
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const note = new Notification(`${name} is calling`, {
              body: 'Open the conversation to join.',
              tag: `call-${e.from}`,
              silent: true,
            })
            note.onclick = () => { window.focus(); note.close() }
          }
        } catch { /* some browsers throw rather than refuse */ }
      }
    })
    return off
  }, [gateway, world])

  const space = where.kind === 'space'
    ? world.spaces.find((s) => s.id === where.id) ?? null
    : null

  /*
   * Everywhere the keyboard can get to.
   *
   * Built from what this client already holds, which is exactly what this
   * account may see - the gateway only ever sent the channels it is allowed
   * to know about, so there is nothing to filter here and nothing that could
   * leak by forgetting to.
   */
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is not
     read in here and is the whole point: the world is mutated in place, so
     its identity never moves and the counter is the only thing that says it
     changed. */
  const targets = useMemo(() => targetsOf(world), [world, version])

  /** Go wherever the switcher was pointed, switching server if need be. */
  const goToTarget = useCallback((t: Target) => {
    if (t.kind === 'space') { setWhere({ kind: 'space', id: t.id }); return }
    if (t.kind === 'dm' || t.kind === 'group') {
      setWhere({ kind: 'dms' })
      openToRead(t.id)
      return
    }
    /* A channel carries its server, and arriving in the channel without
       arriving in the server leaves the rail pointing somewhere else. */
    if (t.spaceId) setWhere({ kind: 'space', id: t.spaceId })
    openToRead(t.id)
  }, [openToRead])

  /* Remembered as it happens, so the switcher can open on where you were. */
  useEffect(() => {
    if (!channelId) return
    const seen = visited.current.filter((id) => id !== channelId)
    seen.unshift(channelId)
    visited.current = seen.slice(0, 20)
  }, [channelId])

  /*
   * The keys that work from anywhere.
   *
   * On the window rather than on a element, because "from anywhere" is the
   * whole point - and refused while somebody is typing into something, since
   * Ctrl+1 in a message box is a person writing rather than a person
   * navigating. The composer's own keys are handled where the composer is.
   */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const target = e.target as HTMLElement | null
      const typing = !!target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      )

      /* Ctrl+K works while typing as well: somebody who has started writing
         and then decides to go elsewhere should not have to clear the box
         first. The rest wait until the keyboard is not being used for words. */
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSwitching((now) => !now)
        return
      }
      if (mod && e.key === '/') {
        e.preventDefault()
        setShowingKeys((now) => !now)
        return
      }
      if (typing) return

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setPanel((now) => (now === 'search' ? null : 'search'))
        return
      }
      /* A server by number, in the order they are on screen. */
      if (mod && /^[1-9]$/.test(e.key)) {
        const sp = world.spaces[Number(e.key) - 1]
        if (sp) { e.preventDefault(); setWhere({ kind: 'space', id: sp.id }) }
        return
      }
      /* And the channel above or below the one that is open. Alt rather than
         Ctrl because Ctrl+Arrow is a caret key everywhere else. */
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (where.kind !== 'space') return
        const list = world.channels
          .filter((c) => c.kind === 'text' && c.space_id === where.id)
          .sort((a, b) => a.position - b.position)
        if (!list.length) return
        const at = list.findIndex((c) => c.id === channelId)
        const next = list[wrapped(at === -1 ? 0 : at, e.key === 'ArrowDown' ? 1 : -1, list.length)]
        if (next) { e.preventDefault(); openToRead(next.id) }
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [world, where, channelId, openToRead])
  /* What this account may do in the server it is looking at, which decides
     what there is to open rather than what happens once it is opened. */
  const here = space ? world.held.in(space.id, null) : []

  /** Everything this server holds, asked for again after changing any of it. */
  const refreshTree = useCallback(async () => {
    if (!space) return
    const cats = await loadCategories(server, space.id).catch(() => null)
    /*
     * This server's headings, put back among everybody else's - as the
     * channels beside them already were.
     *
     * It used to assign the answer straight to world.categories, and the
     * answer is one server's. So renaming a channel in your own server threw
     * away every other server's headings, and the next server you opened drew
     * none of its channels: they are filed under headings, and a channel
     * whose heading is not here is a channel in no section at all. Reported
     * as a friend's server being empty after a rename in mine.
     */
    if (cats) world.categories = replacingSpace(world.categories, space.id, cats)
    changed()
  }, [server, world, space, changed])

  /*
   * Who is in the server you are looking at, fetched when you look at it.
   *
   * Everything used to be fetched before the app would draw: every member and
   * every role assignment of every server, for lists nobody had opened. A
   * server of ten thousand is four and a half megabytes of members and two
   * more of assignments, and you only ever look at one server at a time.
   */
  useEffect(() => {
    if (!space || world.loaded.has(space.id)) return
    let alive = true
    void loadSpace(server, world, space.id)
      /*
       * Said as a change to the world, not as a number of its own.
       *
       * This used to set a piece of state nobody read, which draws
       * everything again and says nothing - so anything worked out once and
       * kept until the world changes was never worked out again. The @ menu
       * was the one that showed: it offered the roles, which are there at
       * sign-in, and not one person, because the roster arrives with this
       * and this never announced it.
       */
      .then(() => { if (alive) changed() })
      .catch(() => { /* refused or offline; the list stays as it is */ })
    return () => { alive = false }
  }, [server, world, space, changed])

  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `world` is
     mutated in place and never changes identity, so `version` is what says
     it changed. Listing world alone froze this for the session. */
  const chats = useMemo(() => conversations(world), [world, version])


  /*
   * Same reason as the conversations above, and it was missed here.
   *
   * `world` is mutated in place and never changes identity, so listing it is
   * listing something that never moves; `space` only changes when somebody
   * opens a different server. Dragging a channel wrote the new order into the
   * world, said so, and this went on handing back the list it had worked out
   * the last time the server changed - so the channel stayed where it was
   * until you opened another server and came back, which is exactly how it
   * was reported. Headings were fine, because they are not memoised.
   */
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is not
     read in here, and that is the point: it is the thing that moves when the
     world is changed in place, and listing it is how this is told. */
  const channels = useMemo(() => (space ? channelsOf(world, space.id) : []), [world, space, version])
  /* In a server, the channel you picked or the first one to read. In your
     conversations, the one you picked and nothing by default — opening
     somebody's conversation because it happened to be first is a message
     marked read that nobody looked at. */
  const channel = space
    ? channels.find((c) => c.id === channelId)
      ?? channels.find((c) => c.kind === 'text')
      ?? null
    : null
  /*
   * And with the muted ones taken out, where somebody has asked for that.
   *
   * Except the one they are looking at. A list that removes the channel
   * currently open is a list that appears to have lost it, and somebody who
   * mutes the channel they are reading should not watch it vanish from under
   * them.
   */
  const shownChannels = useMemo(() => {
    if (!space || !hidingMuted(space.id)) return channels
    return channels.filter((c) => c.id === channelId || !world.muted.has(c.id))
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is what
     says the world changed; the muted set lives on it and is mutated in
     place. */
  }, [channels, space, hidingMuted, channelId, world, version])

  const chat = space ? null : chats.find((c) => c.id === channelId) ?? null
  const openId = channel?.id ?? chat?.id ?? null

  /**
   * Take a conversation off the list without ending it.
   *
   * The messages stay exactly where they are - saying something to that
   * person again brings the row straight back with everything still in it.
   * This is about a list getting long, not about wanting rid of anybody.
   *
   * One function because there are two ways to ask for it now: the menu on
   * the row and the cross at the end of it.
   */
  const closeConversation = useCallback((id: Id) => {
    void server.post('/api/dms/close', { channelId: id })
      .then(() => {
        world.dms = world.dms.filter((d) => d.id !== id)
        if (openId === id) setChannelId(null)
        changed()
      })
      .catch(() => { /* refused; the row stays where it is */ })
  }, [server, world, openId, changed])
  /* Written during render rather than in an effect: it is a note of what is
     on screen now, and an effect would record it one render later - which is
     one render too late if the server is changed in between. */
  if (space && channel) lastChannelIn.current.set(space.id, channel.id)

  /*
   * Where this account is in voice, told to the server.
   *
   * The gateway's whole idea of who is in which room comes from these frames
   * and the React port sent none of them - so rooms said "Nobody in here"
   * with people in them, and a call in a conversation could never end.
   */
  useVoiceState(call.call, world.me.id, send as (f: Record<string, unknown>) => void)

  /* Reading what is open says so. The frame existed and the server has always
     handled it; nothing ever sent one, so a conversation could be read and
     its badge stayed - in the list and on the taskbar icon. */
  useMarkRead(openId, openId ? world.unread.get(openId) ?? 0 : 0, send)

  /* How much is waiting everywhere, for the count in the tab. */
  let waiting = 0
  for (const n of world.unread.values()) waiting += n

  const notify = useNotify(world, {
    wanted: settings.notifications,
    tabCount: settings.tabCount,
    openChannel: openId,
    unread: waiting,
  })

  /*
   * Said about a message when it arrives, not when it is drawn.
   *
   * The list only redraws for a channel somebody has open, and a message
   * arriving anywhere else is exactly the one worth being told about — so
   * this listens to the socket rather than to the messages on screen.
   */
  useEffect(() => {
    if (!gateway) return
    return gateway.on((e) => {
      if (e.t !== 'message') return
      const where = world.channels.find((c) => c.id === e.message.channel_id)
      notify.tell(
        e.message,
        world.people.get(e.message.author_id),
        where ? `#${where.name}` : null,
      )
    })
  }, [gateway, notify, world])
  const title = channel?.name ?? chat?.name ?? null

  const phone = width <= PHONE
  const narrow = width <= TABLET
  /*
   * A thumb, on a phone.
   *
   * The drawers come from the edges somebody is already holding, and reaching
   * a button in the header to open one is the slowest possible way to do it.
   * Off on anything wider, where both panels are simply there.
   */
  useSwipe(phone, { navOpen: slid === 'nav', membersOpen: slid === 'members' },
    useCallback((what) => {
      if (what === 'open-nav') setSlid('nav')
      else if (what === 'open-members') setSlid('members')
      else setSlid(null)
    }, []))

  return (
    <div className="shell" data-slid={slid ?? ''}
      data-side={settings.sideShut ? 'shut' : ''}>
      {/* Row one of the shell's grid. Nothing drew it, so every panel fell
          into that row — which is `auto` — and the whole app was as tall as
          its tallest column rather than as tall as the window. */}
      {/*
        * Where you are, including when where you are is a settings screen.
        *
        * The settings screens cover the app from the very top, so this bar
        * went with them and their first heading jumped to the top of the
        * window — a different height from everything else, and in the desktop
        * app underneath the window's own buttons. They start below it now,
        * and it says which one you are in.
        */}
      {/*
        * The way back, and the only thing left of the panel while it is
        * folded. An arrow pointing at where it went - which is also the
        * direction it comes back from.
        */}
      {settings.sideShut && (
        <button className="sideopen" title="Show the channel list"
          aria-label="Show the channel list" data-fold={fold.side}
          style={{ gridColumn: `var(--col-${fold.against})` }}
          onClick={() => set('sideShut', false)}>
          <Icon name="chev" size={15} />
        </button>
      )}

      <TopBar
        space={showSettings ? null : space}
        channel={showSettings ? 'Settings' : title}
        kind={showSettings ? null : channel?.kind ?? (chat ? 'dm' : null)}
        server={server}
      />

      {/*
        * Anything the app needs to say, over the top of it.
        *
        * These used to live on the loading screen next to each other, which
        * is a screen nobody sees once the app has loaded — so a refused
        * message said nothing, a share that would not start said nothing,
        * and the offer to reload after a deploy never appeared at all.
        */}
      <div className="bars" ref={bars}>
      {/*
        * Not over a full screen of settings.
        *
        * The strip is fixed near the top of the window and sits above
        * everything, which is right for a page you can see past and wrong
        * for one that covers it: on a phone the offer of the desktop app
        * landed squarely on the settings list and its way out, so the first
        * two panes and the close button could not be pressed. Nothing in it
        * is urgent enough to interrupt a screen somebody deliberately
        * opened, and it is still there when they come back.
        */}
      {!showSettings && (
        <Notices
          stale={stale}
          error={error || call.error}
          onClear={() => { clearError(); call.clearError() }}
          share={offerShare && {
            onResume: () => {
              /* The press is what allows a capture to start at all. On the
                 desktop it also skips the picker: the source is remembered,
                 and the picker answers itself with it. */
              intendToResume(offerShare.source)
              setOfferShare(null)
              void call.setShare(true, true).then((started) => {
                if (started) setOnStage(true)
              })
            },
            onDismiss: () => setOfferShare(null),
          }}
        />
      )}
      </div>
      <Rail
        grip={phone ? null : drag('rail', 'right')}
        world={world}
        where={where}
        onNewServer={() => setMakingServer(true)}
        onReadAll={(ids) => { for (const id of ids) send(readFrame(id)) }}
        onMove={(id, by) => reorderSpaces(moved(world.spaces.map((s) => s.id), id, by))}
        onLeave={(s) => setLeaving(s)}
        onInvite={() => setInviting(true)}
        onServerSettings={() => setShowSettings(serverPanesFor(here)[0]?.[0] ?? 'account')}
        onReorder={reorderSpaces}
        onSpacePref={setSpacePref}
        hidingMuted={hidingMuted}
        onHideMuted={setHidingMuted}
        onHome={() => {
          setWhere({ kind: 'dms' })
          /*
           * On a phone the drawer is where the conversations are, so pressing
           * Home must leave it up.
           *
           * Reported twice. The first time this was fixed for the Home in the
           * list, which goes through onPage and never touched the drawer -
           * but the tile on the rail is a different button and comes through
           * here, where restoring what you were reading goes through the one
           * door, and that door closes the drawer. So Home opened the DM list
           * and immediately covered it up, and the panel had to be opened
           * again to reach the thing Home was pressed for.
           *
           * Unlike picking a server, this puts the drawer back whether or not
           * there was something to restore: picking a server means opening
           * what is in it, and pressing Home means asking for the list.
           */
          const wasOpen = slid === 'nav'
          /*
           * Back to what you were reading, not to the greeting.
           *
           * Going to a server and coming back is coming back to something,
           * and being shown the home page instead means finding the
           * conversation again by hand every time. The greeting is still what
           * you get with nothing to return to - and it is still one click
           * away, on Home in the list, which is where somebody asking for it
           * would look.
           *
           * Only if it is still there: a conversation closed on another
           * device is not somewhere to be put back into.
           */
          const back = lastSpot()
          if (back?.kind === 'dm' && world.dms.some((d) => d.id === back.channelId)) {
            /* Through the one door, like every other way of opening
               something: setting the channel directly leaves the stage
               standing over it, which is a click that appears to do nothing. */
            openToRead(back.channelId)
          } else if (back?.kind === 'page') {
            /* The greeting or the friends list, whichever was left. Through
               the same door first, because it is what takes the stage down -
               and then the page, because that door clears it. */
            openToRead(null)
            setPage(back.page)
          } else {
            /* A conversation that is no longer there, or nothing remembered
               at all. Either way the greeting, and the stale one is dropped
               so it is not consulted again. */
            if (back) forgetSpot()
            openToRead(null)
            setPage('home')
          }
          /* On a desktop there is no drawer and this is null, so it stays. */
          if (wasOpen) setSlid('nav')
        }}
        onPick={(id) => {
          setWhere({ kind: 'space', id })
          /*
           * Back to what you were reading in it, or its first channel if this
           * is the first time.
           *
           * Through the one door rather than setting the channel directly:
           * that door also takes the stage down, and picking a server while
           * watching somebody's screen would otherwise set the channel
           * underneath a stage that stayed exactly where it was - a click
           * that appears to do nothing. A test guards that, and caught this.
           */
          const back = lastChannelIn.current.get(id) ?? null
          const wasOpen = slid === 'nav'
          openToRead(back)
          /* And out of Home or Friends, which have no channel to show and
             went on filling the middle of the window after a server had been
             opened — so a server looked like one with nothing in it. */
          setPage(null)
          /*
           * On a phone, opening something to read closes the drawer, which is
           * right when there is something to read. A server nobody has opened
           * before has no channel to go back to, so that closed the drawer
           * over an empty middle - the same complaint as Home. Put back only
           * if it was up: on a desktop there is no drawer and this is null.
           */
          if (!back && wasOpen) setSlid('nav')
        }}
      />

      <Channels
        onCategory={(id, name, x, y) => {
          /*
           * A heading is a thing like any other now that it is a row: it can
           * be renamed, moved and removed. The two a new server starts with
           * are the same kind of row as one somebody makes, which is the
           * whole point of making them real.
           */
          const items: MenuItem[] = []
          if (here.includes('manage_channels')) {
            /* Straight into this heading, which is what right-clicking one
               is for. The plus that appears on hover does the same thing and
               is easy to miss on a touchpad. */
            items.push({
              kind: 'item', label: 'New channel here', icon: 'hash',
              onPick: () => setNaming({ kind: 'channel', categoryId: id }),
            })
            items.push({
              kind: 'item', label: 'Rename', icon: 'pencil',
              onPick: () => {
                setNewName(name)
                setNaming({ kind: 'rename', what: 'categories', id, was: name })
              },
            })
            items.push({
              kind: 'item', label: 'Delete', icon: 'trash', danger: true,
              onPick: () => setDeleting({ what: 'categories', id, name }),
            })
          }
          /* The same panel as a channel's: it is the same question asked of
             a different row, and the routes are the same shape. */
          if (here.includes('manage_roles')) {
            if (items.length) items.push({ kind: 'rule' })
            items.push({
              kind: 'item', label: 'Permissions', icon: 'shield',
              onPick: () => setPermsFor({ what: 'categories', id, name }),
            })
          }
          if (items.length) setChanMenu({ items, x, y })
        }}
        onNewChannel={(categoryId) => setNaming({ kind: 'channel', categoryId })}
        onNewCategory={(x, y) => setChanMenu({
          items: [
            /* A channel first: it is the thing somebody wants most often from
               here, and a heading with nothing under it is the rarer half of
               the pair. Made with no heading, which is why it turns up at the
               top of the list rather than at the bottom of a long one where
               its author would not think to look. */
            ...(here.includes('manage_channels') ? [
              {
                kind: 'item' as const, label: 'New channel', icon: 'hash' as const,
                onPick: () => setNaming({ kind: 'channel', categoryId: null }),
              },
              {
                kind: 'item' as const, label: 'New category', icon: 'layers' as const,
                onPick: () => setNaming({ kind: 'category' }),
              },
            ] : []),
            ...(here.includes('create_invite') ? [
              ...(here.includes('manage_channels') ? [{ kind: 'rule' as const }] : []),
              { kind: 'item' as const, label: 'Invite people', icon: 'addp' as const,
                onPick: () => setInviting(true) },
            ] : []),
          ],
          x,
          y,
        })}
        onReorder={(what, order) => {
          /* On screen first, and put back only if the server refuses — the
             same reasoning as the rail above. */
          const before = what === 'channels' ? world.channels : world.categories
          const by = new Map(order.map((id, i) => [id, i]))
          const moved = [...before].sort(
            (a, b) => (by.get(a.id) ?? a.position) - (by.get(b.id) ?? b.position),
          ).map((row, i) => (by.has(row.id) ? { ...row, position: i } : row))
          if (what === 'channels') world.channels = moved as typeof world.channels
          else world.categories = moved as typeof world.categories
          /*
           * And the two unfiled headings, which are in this order too.
           *
           * They are not rows in the categories list - where they sit is two
           * numbers on the server, kept here as looseOrder - so moving them
           * shifted every real category on screen and left Text and Voice
           * where they were. The server stored the order it was sent, so a
           * reload showed something different from what the drag had just
           * drawn.
           */
          if (what === 'categories' && space) {
            const at = (id: string) => order.indexOf(id)
            const now = world.looseOrder[space.id] ?? { text: -2, voice: -1 }
            world.looseOrder = {
              ...world.looseOrder,
              [space.id]: {
                text: at('loose:text') >= 0 ? at('loose:text') : now.text,
                voice: at('loose:voice') >= 0 ? at('loose:voice') : now.voice,
              },
            }
          }
          changed()

          void server.post(`/api/${what}/reorder`, { order })
            .catch(() => {
              if (what === 'channels') world.channels = before as typeof world.channels
              else world.categories = before as typeof world.categories
              changed()
            })
        }}
        grip={phone ? null : drag('side', 'right')}
        space={space}
        channels={shownChannels}
        chats={chats}
        current={openId}
        page={page}
        /*
         * The drawer stays open.
         *
         * On a phone the rail and the list beside it are the drawer, so
         * pressing Home closed the very thing it was asking for: the
         * conversations appeared behind a panel that had just shut, and you
         * had to open it again to reach them. Changing what the drawer shows
         * is not finishing with it. Picking something to read is, and that
         * still closes it.
         */
        onPage={(which) => { setPage(which); setChannelId(null) }}
        canManage={REARRANGES.some((p) => here.includes(p))}
        /* The door to the settings screen is a different question from
           whether you may move the furniture: an invite is a pane in there. */
        canOpenSettings={MANAGES.some((p) => here.includes(p))}
        /*
         * Absent rather than refused, like everything else gated here:
         * somebody who cannot make an invite is not shown a button that
         * says no.
         */
        canInvite={here.includes('create_invite')}
        onInvite={() => setInviting(true)}
        onNewGroup={() => setMakingGroup(true)}
        /*
         * What a conversation offers, which is not what a channel offers.
         *
         * Reading it and quietening it are the same two questions; the rest
         * are about the person on the other end, or about the row itself -
         * closing one takes it off your list and off nobody else's, and the
         * next thing either of you says brings it back.
         */
        onCloseChat={closeConversation}
        onShut={() => set('sideShut', true)}
        fold={fold.side}
        onChatRules={(id, x, y) => {
          const chat = chats.find((c) => c.id === id)
          const waiting = world.unread.get(id) ?? 0
          const quiet = world.muted.has(id)
          const items: MenuItem[] = [
            {
              kind: 'item', label: 'Mark as read', icon: 'check',
              disabled: waiting <= 0,
              onPick: () => send(readFrame(id)),
            },
            {
              kind: 'item',
              label: quiet ? 'Unmute conversation' : 'Mute conversation',
              icon: quiet ? 'bell' : 'belloff',
              onPick: () => {
                void server.put(`/api/channels/${encodeURIComponent(id)}/prefs`,
                  quiet ? { muteFor: null } : { muteFor: 0 })
                  .then(() => {
                    if (quiet) world.muted.delete(id)
                    else world.muted.add(id)
                    changed()
                  })
                  .catch(() => { /* said no; the row still shows the truth */ })
              },
            },
          ]
          /* Only where there is one person on the other end: a group has
             several, and "their profile" means nothing. */
          if (chat?.peer) {
            items.push({ kind: 'rule' })
            items.push({
              kind: 'item', label: 'Profile', icon: 'user',
              onPick: () => setCard({ id: chat.peer!.id, anchor: { x, y, w: 0, h: 0 } }),
            })
            const friend = world.friends.find((f) => f.id === chat.peer!.id)
            if (friend && friend.state === 'accepted') {
              items.push({
                kind: 'item', label: 'Remove friend', icon: 'out', danger: true,
                onPick: () => { void friendAction('remove', chat.peer!.id) },
              })
            }
          }
          items.push({ kind: 'rule' })
          items.push({
            kind: 'item', label: 'Close conversation', icon: 'x',
            onPick: () => closeConversation(id),
          })
          setChanMenu({ items, x, y })
        }}
        onRules={(id, x, y) => {
          const muted = world.muted.has(id)
          const waitingHere = world.unread.get(id) ?? 0
          const items: MenuItem[] = [{
            kind: 'item',
            label: muted ? 'Unmute' : 'Mute',
            icon: muted ? 'bell' : 'belloff',
            onPick: () => setMuted(id, !muted),
          }, {
            /*
             * One channel, rather than everything everywhere.
             *
             * The only way to clear a badge without opening the channel was
             * the one in the rail that clears all of them, which is a
             * different question - "I have been away, take it all down"
             * rather than "I do not need to read that one".
             *
             * There and grey with nothing waiting, rather than absent:
             * somebody looking for it wants to know it is there and that
             * there is nothing to do.
             */
            kind: 'item',
            label: 'Mark as read',
            icon: 'check',
            disabled: waitingHere <= 0,
            onPick: () => { if (waitingHere > 0) send(readFrame(id)) },
          }]
          /* Only for somebody who may write one. A gated item is absent
             rather than refused, and this is the whole of what decides it. */
          const channel = world.channels.find((c) => c.id === id)
          /*
           * In THIS channel, not merely in this server.
           *
           * The routes behind these three all use guardIn - the channel's
           * answer - because a channel that denies manage_channels to a role
           * is not that role's to rename. The menu asked the server-wide one,
           * so a moderator denied it in one channel was still offered Rename,
           * Delete and Permissions there, and the server refused them on the
           * way out. A gated item is absent rather than refused, and asking
           * the wrong scope is how it ends up being neither.
           */
          const mayHere = world.held.in(space?.id ?? null, id)
          if (mayHere.includes('manage_channels') && channel) {
            items.push({ kind: 'rule' })
            items.push({
              kind: 'item', label: 'Rename', icon: 'pencil',
              onPick: () => {
                setNewName(channel.name)
                setNewTopic(channel.topic ?? '')
                /* Primed from the channel, or opening the dialog to rename
                   something would turn its slow mode off on the way past. */
                setNewSlow('slowmode_seconds' in channel
                  ? channel.slowmode_seconds ?? 0
                  : 0)
                setNaming({ kind: 'rename', what: 'channels', id, was: channel.name,
                  topic: channel.topic ?? '' })
              },
            })
            /*
             * Only a voice room, because only a voice room is drawn with a
             * colour. Offering it on a text channel would be a control that
             * changes nothing anybody can see.
             */
            if (channel.kind === 'voice') {
              items.push({
                kind: 'item', label: 'Colour', icon: 'brush',
                onPick: () => setColouring({
                  id, name: channel.name, was: channel.colour ?? '',
                }),
              })
            }
            items.push({
              kind: 'item', label: 'Delete', icon: 'trash', danger: true,
              onPick: () => setDeleting({ what: 'channels', id, name: channel.name }),
            })
          }
          if (mayHere.includes('manage_roles')) {
            items.push({ kind: 'rule' })
            items.push({
              kind: 'item', label: 'Permissions', icon: 'shield',
              onPick: () => channel && setPermsFor({
                what: 'channels',
                id,
                name: channel.name,
                kind: channel.kind === 'voice' ? 'voice' : 'text',
              }),
            })
          }
          setChanMenu({ items, x, y })
        }}
        onServerSettings={() => setShowSettings(serverPanesFor(here)[0]?.[0] ?? 'account')}
        /* One frame per channel, the same one reading a channel sends. The
           server writes the read row and says so, and the badge clears here
           when that comes back rather than being cleared hopefully. */
        onReadAll={(ids) => { for (const id of ids) send(readFrame(id)) }}
        call={call}
        onStage={() => setOnStage(true)}
        onPick={(id) => {
          /* Opening anything at all leaves the pages that are not a
             conversation — they have no message list to put it in. */
          setPage(null)
          /*
           * A voice room is somewhere you go, not something you read.
           *
           * Joining does not open the stage. Walking into a room is not the
           * same as wanting to look at it — most of the time somebody joins
           * to talk and carries on reading whatever they were reading, and
           * the stage covering that is the app deciding for them. Pressing a
           * room you are already in opens it, which is asking for it.
           */
          const c = channels.find((x) => x.id === id)
          if (c?.kind === 'voice') {
            if (call.call.channel === id) { setOnStage(true); return }
            void call.join(id)
            setSlid(null)
            return
          }
          openToRead(id)
        }}
        world={world}
        onSettings={() => setShowSettings(true)}
        onMe={(x, y) => setChanMenu({
          x,
          y,
          items: [
            { kind: 'item', label: 'Edit profile', icon: 'pencil',
              onPick: () => setShowSettings(true) },
            { kind: 'item', label: 'Appearance', icon: 'brush',
              onPick: () => setShowSettings(true) },
            { kind: 'rule' },
            { kind: 'item', label: 'Settings', icon: 'gear',
              onPick: () => setShowSettings(true) },
            { kind: 'item', label: 'Sign out', icon: 'out', danger: true,
              onPick: onOut },
          ],
        })}
      />

      {page === 'home' ? (
        <Home
          world={world}
          call={call.call}
          channels={world.channels}
          chats={chats}
          server={server}
          phone={phone}
          onNav={() => setSlid(slid === 'nav' ? null : 'nav')}
          onOpen={openToRead}
          onJoin={() => setOnStage(true)}
          onSettings={(pane) => setShowSettings(pane ?? true)}
          onNewServer={() => setMakingServer(true)}
        />
      ) : page === 'friends' ? (
        <Friends
          world={world}
          friends={world.friends}
          tab={friendTab}
          onTab={setFriendTab}
          phone={phone}
          onNav={() => setSlid(slid === 'nav' ? null : 'nav')}
          /*
           * The same menu a member list gives, not the card.
           *
           * The dots on a friend opened a profile card, which says who
           * somebody is and offers nothing to do about them - so the one page
           * in the app that is entirely about your friends was the one place
           * you could not stop being somebody's. Reported as there being no
           * way to remove a friend at all, which is nearly what it was: the
           * only way was to right-click them in a server you happened to
           * share.
           */
          onWho={(id, el) => {
            const r = el.getBoundingClientRect()
            whoMenu(id, Math.round(r.left), Math.round(r.bottom + 4))
          }}
          onAdd={() => { setAddingFriend(''); setFriendSaid('') }}
          onOpenDm={(id) => {
            /* The conversation there already is with them, or a new one.
               The server makes it either way and answers with the channel,
               so there is nothing to decide here — and it is `channel`, not
               `id`: read as an id it comes back undefined and the button is
               one that does nothing at all. */
            void server.post<{ channel?: { id?: Id } }>('/api/dms', { userId: id })
              .then(async (r) => {
                const opened = r?.channel?.id
                if (!opened) return
                /* The list has one more in it than it did. Fetched rather
                   than appended, so what a conversation is called is the
                   server's answer and not a guess made here. */
                world.dms = await loadDms(server).catch(() => world.dms)
                /*
                 * And say so. The list of conversations is worked out once
                 * and kept until the world says it changed - the world is one
                 * object changed in place, so nothing notices a new entry by
                 * itself. Without this the conversation opened and was not in
                 * the list beside it until something else caused a render.
                 */
                changed()
                openToRead(opened)
              })
              .catch(() => { /* refused or offline; the list is unchanged */ })
          }}
          onAccept={(id) => {
            /*
             * Yes, and then into the conversation with them.
             *
             * Becoming friends put a name in a list and nothing else. The
             * conversation only existed once somebody finally wrote in it,
             * so until then the person you had just this second added sat
             * alphabetically among everybody you had never spoken to - and
             * saying yes left you looking at whatever was already on screen.
             * Asked for directly, in those words.
             */
            void friendAction('accept', id)
              .then(() => server.post<{ channel?: { id?: Id } }>('/api/dms', { userId: id }))
              .then(async (r) => {
                const opened = r?.channel?.id
                if (!opened) return
                world.dms = await loadDms(server).catch(() => world.dms)
                changed()
                openToRead(opened)
              })
              .catch(() => { /* accepted anyway; they are in the list */ })
          }}
          onRemove={(id) => { void friendAction('remove', id) }}
        />
      ) : onStage && call.call.channel ? (
        <Stage
          world={world}
          call={call.call}
          controls={call}
          name={channels.find((c) => c.id === call.call.channel)?.name ?? 'Voice'}
          master={settings.volume}
          onClose={() => setOnStage(false)}
        />
      ) : (
      <Conversation
        space={space}
        version={version}
        changed={changed}
        openId={openId}
        title={title}
        kind={channel?.kind ?? (chat ? 'dm' : null)}
        topic={channel?.topic ?? ''}
        world={world}
        server={server}
        send={send}
        gateway={gateway}
        jumbo={settings.jumbo}
        shortcodes={settings.shortcodes}
        previews={settings.previews}
        phone={phone}
        narrow={narrow}
        goingTo={goingTo}
        onArrived={() => setGoingTo(null)}
        peer={chat?.peer ?? null}
        group={!!chat?.group}
        panel={panel}
        inThisCall={call.call.channel === channelId}
        onCall={(id: Id) => ring(id, chat?.peer?.id ?? null)}
        onAnswer={(id: Id) => {
          /* Answering, rather than starting: into the room, and the ringing
             at the other end stops because the server is told it landed. */
          if (call.call.channel !== id) void call.join(id)
          setOnStage(true)
          const peer = chat?.peer?.id
          if (peer) send({ t: 'call-accept', to: peer })
        }}
        onPanel={(which) => setPanel((now) => (now === which ? null : which))}
        onNav={() => setSlid(slid === 'nav' ? null : 'nav')}
        onMembers={() => setSlid(slid === 'members' ? null : 'members')}
        onWho={(id, el) => setCard({ id, anchor: anchorOf(el) })}
      />
      )}

      {/*
        * Every sound in the call, drawn here and nowhere else.
        *
        * Above the stage on purpose: an element inside it would be unmounted
        * the moment somebody closed the stage to go and read something, and
        * the call would go silent while they were still in it.
        */}
      <CallSounds call={call.call} master={settings.volume} me={world.me.id}
        sink={settings.speaker} />

      {/* Where the app says the small things - a save that worked, and
          nothing that needs deciding about. */}
      <Toasts />

      {/* Still watching, while reading somewhere else. Not drawn over the
          stage, which already has the thing full size. */}
      {!onStage && call.call.channel && (
        <Pip
          call={call.call}
          world={world}
          onOpen={() => setOnStage(true)}
          onStop={(key) => call.setWatching(key, false)}
        />
      )}

      {panel === 'search' ? (
        <Search
          server={server}
          world={world}
          onGoto={(id, channelId) => {
            /* The channel first, then the message — a result in a channel
               nobody has open is a message in a list that does not exist
               yet, and scrolling to it now would scroll to nothing. */
            /* And out of the stage, for the same reason as everywhere else:
               a result opened behind it is a jump nobody sees. */
            if (channelId !== openId) openToRead(channelId)
            else setOnStage(false)
            setGoingTo(id)
            setPanel(null)
          }}
          onClose={() => setPanel(null)}
        />
      ) : (
        <Members server={server} world={world} space={space} chat={chat}
          grip={narrow ? null : drag('right', 'left')}
          onWho={whoMenu}
          onOpen={(id, el) => {
            setCard({ id, anchor: anchorOf(el) })
            /* And out of the drawer the row was in. On a phone the member
               list covers the screen, so a card opened from it appeared
               underneath the thing that opened it. */
            setSlid(null)
          }} />
      )}

      {/* Both open from the keyboard and from nowhere else on screen, which
          is why the sheet exists: a shortcut nobody can discover may as well
          not be bound. */}
      {switching && (
        <Switcher
          targets={targets}
          recent={visited.current}
          onGo={goToTarget}
          onClose={() => setSwitching(false)}
        />
      )}
      {showingKeys && <Shortcuts onClose={() => setShowingKeys(false)} />}

      {card && world.people.get(card.id) && (
        <Profile
          user={world.people.get(card.id)!}
          server={server}
          world={world}
          space={space}
          anchor={card.anchor}
          phone={phone}
          activities={world.activities.get(card.id) ?? []}
          onClose={() => setCard(null)}
          onEdit={() => setShowSettings(true)}
          /*
           * Into the room they are in, from their card.
           *
           * Given only when pressing it would do something: not on your own
           * card, and not for the room you are already standing in. The
           * button is absent in both cases rather than present and inert,
           * which is the rule the rest of this app keeps.
           *
           * The card closes on the way, because what you asked for is the
           * call and the card is in front of it.
           */
          {...((() => {
            const where = world.voice.get(card.id)?.channelId
            if (!where || card.id === world.me.id || call.call.channel === where) return {}
            return {
              onOpenVoice: (channelId: Id) => {
                setCard(null)
                void call.join(channelId)
              },
            }
          })())}
          /*
           * Said from the card, into the conversation with them.
           *
           * The conversation is asked for first because there may not be one
           * yet - saying something to somebody for the first time is exactly
           * the case this is for, and the route hands back the existing one
           * where there is. The message goes down the socket like any other,
           * so it arrives back as an event rather than being drawn twice.
           */
          onSay={async (body) => {
            const r = await server.post<{ channel?: { id?: Id } }>(
              '/api/dms', { userId: card.id })
            const into = r?.channel?.id
            if (!into) throw new Error('Could not open that conversation.')
            send({ t: 'send', channelId: into, body })
          }}
        />
      )}

      {slid && <div className="scrim slidscrim" onClick={() => setSlid(null)} />}

      {addingFriend !== null && (
        <Modal
          title="Add a friend"
          onClose={() => setAddingFriend(null)}
          actions={
            <>
              <button className="btn" onClick={() => {
                setAddingFriend(null)
                setFriendSaid('')
              }}>Cancel</button>
              <button className="btn p" onClick={() => {
                void server.post<RequestAnswer>(
                  '/api/friends/request', { name: addingFriend },
                )
                  .then((r) => {
                    const next = afterRequest(r)
                    if (next.kind === 'refused') { setFriendSaid(next.said); return }
                    setAddingFriend(null)
                    setFriendSaid('')
                    setFriendTab(next.tab)
                  })
                  .catch((e: unknown) => {
                    setFriendSaid(e instanceof Error ? e.message : 'That would not send.')
                  })
              }}>Send request</button>
            </>
          }
        >
          <div className="fld">
            <label>Their name</label>
            <input
              type="text"
              value={addingFriend}
              placeholder="somebody"
              onChange={(e) => setAddingFriend(e.target.value)}
            />
            <p className="hint">
              {friendSaid || `They get a request. Nothing is shared until they
                accept — and if they already asked you, this accepts it.`}
            </p>
          </div>
        </Modal>
      )}

      {chanMenu && (
        <Menu x={chanMenu.x} y={chanMenu.y} items={chanMenu.items}
          onClose={() => setChanMenu(null)} />
      )}

      {permsFor && space && (
        <ChannelPerms
          server={server}
          world={world}
          space={space}
          target={permsFor}
          onClose={() => setPermsFor(null)}
        />
      )}

      {colouring && (
        /*
         * The same swatches a name is coloured with, so the app has one set
         * of colours rather than a second one that drifts from it. The first
         * of them is Default, which is not a colour at all - it means the one
         * the room's id gives it, and picking it clears what was chosen.
         */
        <Modal
          title={`Colour for ${colouring.name}`}
          onClose={() => setColouring(null)}
          actions={<button className="btn" onClick={() => setColouring(null)}>Done</button>}
        >
          <div className="swatches">
            {NAME_COLOURS.map((c) => (
              <button
                key={c.id}
                className={colouring.was.toLowerCase() === c.hex.toLowerCase() ? 'sw2 on' : 'sw2'}
                style={c.hex ? { background: c.hex } : undefined}
                title={c.name}
                aria-label={c.name}
                onClick={() => {
                  const job = colouring
                  setColouring({ ...job, was: c.hex })
                  void server.patch(`/api/channels/${job.id}`, { colour: c.hex || null })
                    .then(() => refreshTree())
                    .catch(() => { /* refused, or offline */ })
                }}
              />
            ))}
          </div>
        </Modal>
      )}

      {naming && space && (
        <Modal
          title={naming.kind === 'category' ? 'New category'
            : naming.kind === 'channel' ? 'New channel'
              : naming.kind === 'nickname' ? `Nickname for ${naming.was}`
                : `Rename ${naming.was}`}
          onClose={() => { setNaming(null); setNewName(''); setNewTopic(''); setNewSlow(0) }}
          actions={
            <>
              <button className="btn" onClick={() => { setNaming(null); setNewName(''); setNewTopic(''); setNewSlow(0) }}>
                Cancel
              </button>
              {/* Empty is a real answer for a nickname - it is how somebody
                  takes one off again, and the route already reads it that
                  way. The guard made the one thing the code below documents
                  impossible to actually do. */}
              <button className="btn p"
                disabled={!newName.trim() && naming.kind !== 'nickname'}
                onClick={() => {
                const name = newName.trim()
                const job = naming
                setNaming(null)
                setNewName('')
                /*
                 * Asked for again rather than guessed at: the server decides
                 * the position and trims the name, and a heading drawn from
                 * what was typed moves the moment anything else refreshes.
                 */
                const done = () => void refreshTree()
                if (job.kind === 'category') {
                  void server.post('/api/categories', { spaceId: space.id, name })
                    .then(done).catch(() => { /* refused or offline */ })
                } else if (job.kind === 'channel') {
                  /*
                   * Made under the heading it was asked for from.
                   *
                   * Channels could only be made in the server's settings,
                   * which does not ask where to put one - so everything
                   * landed loose at the top and a category, once made, had no
                   * way of ever getting anything into it.
                   */
                  void server.post('/api/channels', {
                    spaceId: space.id, name, kind: 'text', categoryId: job.categoryId,
                  })
                    .then(async () => {
                      const mine = await loadChannels(server, space.id).catch(() => null)
                      if (mine) world.channels = replacingSpace(world.channels, space.id, mine)
                      done()
                    })
                    .catch(() => { /* refused or offline */ })
                } else if (job.kind === 'nickname') {
                  /*
                   * An empty box puts their own name back, which is what
                   * somebody clearing the field means - not a person called
                   * nothing.
                   */
                  void server.post(
                    `/api/admin/members/${encodeURIComponent(job.id)}/nickname`,
                    { nickname: name, spaceId: space.id },
                  )
                    .then(async () => {
                      /* Asked for again rather than patched in place: what
                         somebody is called is the server's answer, and the
                         roster is where the member list reads names from. */
                      world.loaded.delete(space.id)
                      await loadSpace(server, world, space.id).catch(() => {})
                      changed()
                    })
                    .catch(() => { /* refused or offline */ })
                } else if (job.kind === 'rename') {
                  void server.patch(`/api/${job.what}/${encodeURIComponent(job.id)}`, {
                    name,
                    /* Only for a channel, and only because it was asked for
                       here - a category has no topic and sending one would
                       be a field the route quietly ignores. */
                    ...(job.what === 'channels'
                      ? { topic: newTopic.trim(), slowmodeSeconds: newSlow }
                      : {}),
                  })
                    .then(async () => {
                      if (job.what === 'channels' && space) {
                        const mine = await loadChannels(server, space.id).catch(() => null)
                        if (mine) world.channels = replacingSpace(world.channels, space.id, mine)
                      }
                      done()
                    })
                    .catch(() => { /* refused or offline */ })
                }
              }}>
                {naming.kind === 'rename' ? 'Rename'
                  : naming.kind === 'nickname' ? 'Save'
                    : 'Create'}
              </button>
            </>
          }
        >
          <div className="fld">
            <label>{naming.kind === 'nickname' ? 'Nickname' : 'Name'}</label>
            <input value={newName} autoFocus
              placeholder={naming.kind === 'nickname' ? naming.was || 'What to call them'
                : naming.kind === 'channel' ? 'board-games'
                  : 'Board games'}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null) }} />
          </div>
          {/* What it is about, which is drawn beside the name at the top of
              the conversation and could be read everywhere and set nowhere.
              The route has taken it from the beginning. */}
          {naming.kind === 'rename' && naming.what === 'channels' && (
            <div className="fld">
              <label>Topic</label>
              <input value={newTopic}
                placeholder="What it is for — optional"
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null) }} />

              {/*
                * How long between messages, for a channel that gets busy.
                *
                * A list rather than a number box: the useful settings are a
                * handful of round numbers, and "how many seconds" is a
                * question nobody wants to be asked. The people who manage the
                * channel are not held by it, which is said here because
                * somebody setting it is deciding whether it will be in their
                * own way.
                */}
              <label>Slow mode</label>
              <select className="lab" value={newSlow}
                onChange={(e) => setNewSlow(Number(e.target.value))}>
                {SLOWMODES.map(([seconds, said]) => (
                  <option key={seconds} value={seconds}>{said}</option>
                ))}
              </select>
              <p className="hint" style={{ margin: '4px 0 0' }}>
                {newSlow > 0
                  ? 'Everybody waits this long between messages. Anybody who can manage the channel does not.'
                  : 'Nobody has to wait between messages.'}
              </p>
            </div>
          )}
          {/*
            * Said about the thing being named.
            *
            * This was a two-way branch - a category, or else the channel
            * copy - so naming a *person* explained that their name would be
            * lowercased and hyphenated, which is neither true of a nickname
            * nor a sentence anybody wanted at that moment.
            */}
          <p className="hint">
            {naming.kind === 'nickname'
              ? 'Only in this server, and only you and the others here see it. Leave it empty to put their own name back.'
              : naming.kind === 'category'
                || (naming.kind === 'rename' && naming.what === 'categories')
                ? 'A heading keeps the case you type — it is only ever read.'
                : 'A channel name is an address, so it is lowercased and hyphenated.'}
          </p>
        </Modal>
      )}

      {timingOut && (
        <Modal
          title={`Time out ${timingOut.name}?`}
          onClose={() => setTimingOut(null)}
          actions={
            <>
              <button className="btn" onClick={() => setTimingOut(null)}>Cancel</button>
              <button className="btn danger" onClick={() => {
                void timeOutMember(timingOut.id, timingOut.spaceId, timeoutMins)
                setTimingOut(null)
              }}>Time out</button>
            </>
          }
        >
          <div className="fld">
            <label>For how long</label>
            <select className="lab" value={timeoutMins}
              onChange={(e) => setTimeoutMins(Number(e.target.value))}>
              {TIMEOUTS.map(([minutes, said]) => (
                <option key={minutes} value={minutes}>{said}</option>
              ))}
            </select>
          </div>
          {/* What it does and what it does not, because the whole reason this
              exists is that it is smaller than the other two. */}
          <p className="hint">
            They stay in the server and keep everything they have. They cannot
            send messages until it ends, and it can be lifted early.
          </p>
        </Modal>
      )}

      {banning && (
        <Modal
          title={`Ban ${banning.name}?`}
          onClose={() => setBanning(null)}
          actions={
            <>
              <button className="btn" onClick={() => setBanning(null)}>Cancel</button>
              <button className="btn danger" onClick={() => {
                const job = banning
                setBanning(null)
                void moderateMember('ban', job.id, job.spaceId)
              }}>
                Ban
              </button>
            </>
          }
        >
          <p className="hint">
            They are taken out of {banning.where} and cannot come back on any
            invite until somebody lifts it. Removing them instead lets them
            back in on the next one.
          </p>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          actions={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn danger" onClick={() => {
                const job = deleting
                setDeleting(null)
                void server.delete(`/api/${job.what}/${encodeURIComponent(job.id)}`)
                  .then(() => void refreshTree())
                  .catch(() => { /* refused or offline */ })
              }}>
                Delete
              </button>
            </>
          }
        >
          <p className="hint">
            {deleting.what === 'channels'
              ? 'Everything said in it goes with it, and that cannot be undone.'
              : 'The heading goes. The channels under it stay, and become '
                + 'loose again — nothing that was said anywhere is lost.'}
          </p>
        </Modal>
      )}

      {makingGroup && (
        <NewGroup
          /* Friends only, the same rule a one-to-one conversation follows: a
             group is not a way to open a channel to somebody who has not
             agreed to hear from you. */
          friends={world.friends.filter((f) => f.state === 'accepted')}
          onClose={() => setMakingGroup(false)}
          onCreate={(ids) => {
            setMakingGroup(false)
            void server.post<{ channel?: { id?: Id } }>('/api/dms', { userIds: ids })
              .then(async (r) => {
                const opened = r?.channel?.id
                if (!opened) return
                /* The list has one more in it than it did. Fetched rather
                   than appended, so what the group is called is the server's
                   answer - it is the names of everybody in it, and this end
                   would be guessing at the order and the wording. */
                world.dms = await loadDms(server).catch(() => world.dms)
                changed()
                /* Through the one door, like everything else that opens a
                   conversation - it takes the stage down on the way. */
                openToRead(opened)
              })
              .catch(() => { /* refused or offline; the list is unchanged */ })
          }}
        />
      )}

      {/*
        * Asked about, because walking back in needs an invite somebody else
        * has to send - there is no undo for this that is in your own hands.
        *
        * Nothing is removed here: the server takes the membership away and
        * says so down the socket, which is the same path as being kicked or
        * being removed while offline, and the one that is already known to
        * work.
        */}
      {leaving && (
        <Modal
          title={`Leave ${leaving.name}?`}
          onClose={() => { setLeaving(null); setLeaveSaid('') }}
          actions={(
            <>
              <button className="btn" onClick={() => { setLeaving(null); setLeaveSaid('') }}>
                Stay
              </button>
              <button
                className="btn d"
                onClick={() => {
                  const going = leaving
                  void server.post(`/api/spaces/${encodeURIComponent(going.id)}/leave`, {})
                    .then(() => {
                      setLeaving(null)
                      setLeaveSaid('')
                      /* Off the server you just left, or the app is looking at
                         a place it can no longer read. */
                      if (where.kind === 'space' && where.id === going.id) {
                        setWhere({ kind: 'dms' })
                        setChannelId(null)
                      }
                    })
                    .catch((e: unknown) => setLeaveSaid(
                      e instanceof Error ? e.message : 'That would not go through.',
                    ))
                }}
              >
                Leave
              </button>
            </>
          )}
        >
          <p className="hint">
            You will stop seeing its channels, and getting back in needs an
            invite from somebody still there. Nothing you have said in it is
            deleted.
          </p>
          {leaveSaid && <p className="hint">{leaveSaid}</p>}
        </Modal>
      )}

      {inviting && space && (
        <InvitePeople
          server={server}
          spaceId={space.id}
          spaceName={space.name}
          onClose={() => setInviting(false)}
        />
      )}

      {makingServer && (
        <NewServer
          server={server}
          onClose={() => setMakingServer(false)}
          /*
           * Straight into it, whether it was made or joined. The list is
           * fetched again first: a server that is not in the world yet
           * cannot be opened, and the rail would show nothing to open.
           */
          onDone={(id) => {
            void loadSpaces(server).then((spaces) => {
              world.spaces = spaces
              setWhere({ kind: 'space', id })
              setPage(null)
              setChannelId(null)
            })
          }}
        />
      )}

      {showSettings && (
        <SettingsWindow
          server={server}
          onMe={(user) => {
            /* The row that came back, not the one that was sent — the server
               trims and refuses, so what it stored is the answer. */
            world.me = user
            remember(world, user)
            changed()
          }}
          world={world}
          settings={settings}
          set={set}
          reset={reset}
          onOut={onOut}
          {...(typeof showSettings === 'string' ? { openOn: showSettings } : {})}
          space={space}
          permissions={here}
          onChanged={() => changed()}
          onClose={() => setShowSettings(false)}
          onArrange={() => {
            /* Out of settings first: it covers the app, and the app is what
               is being arranged. */
            setShowSettings(false)
            setArranging(true)
          }}
        />
      )}

      {arranging && (
        <Arrange
          order={settings.panelOrder}
          onChange={(next) => set('panelOrder', next)}
          onReset={() => set('panelOrder', [...PANELS] as Panel[])}
          onDone={() => setArranging(false)}
        />
      )}
    </div>
  )
}

/** The servers, down the left. */
function Rail({
  world, where, onHome, onPick, onMove, onReorder, grip, onNewServer, onReadAll, onLeave,
  onInvite, onServerSettings, onSpacePref, hidingMuted, onHideMuted,
}: {
  /** Make one, or walk into somebody else's. */
  onNewServer: () => void
  world: World
  where: { kind: 'space'; id: Id } | { kind: 'dms' }
  onHome: () => void
  /** Up, or down for the one already at the top. */
  onMove: (id: Id, by: -1 | 1) => void
  /** Walk out of one. Asked about first, because walking back in needs an
   *  invite somebody else has to send. */
  onLeave: (space: Space) => void
  /** Open the invite dialog, for whichever server was just picked. */
  onInvite: () => void
  /** And its settings. */
  onServerSettings: () => void
  /** Dropped somewhere else in the list, which sends the whole new order. */
  onReorder: (order: Id[]) => void
  /** Clear everything waiting anywhere, from where everywhere is visible. */
  onReadAll?: (ids: Id[]) => void
  /** How much to be told about this server, and for how long. */
  onSpacePref: (spaceId: Id, body: { level?: string; muteFor?: number | null }) => void
  /** Whether muted channels are hidden in this server, and the switch. */
  hidingMuted: (spaceId: Id) => boolean
  onHideMuted: (spaceId: Id, hide: boolean) => void
  onPick: (id: Id) => void
  grip: Grip
}) {
  const { rowProps } = useDragOrder(world.spaces.map((s) => s.id), onReorder)
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null)
  /* Every pick closes the menu it was in, which is right for every item
     except the two that hand over to a second list in the same place. They
     say so, and this is how. */
  const stayOpen = useRef(false)

  /**
   * What right-clicking a server offers.
   *
   * Asked of that server rather than of the one being looked at: the point of
   * this menu is that it is about the icon under the pointer, and permissions
   * are held per server - somebody can run one and be an ordinary member of
   * the next.
   *
   * Everything gated is absent rather than greyed, like the rest of the app:
   * a member who cannot invite is not shown an Invite that says no.
   */
  const menuFor = (s: Space, i: number): MenuItem[] => {
    const held = world.held.in(s.id, null)
    const pref = world.spacePrefs.get(s.id)
    const level = pref?.level ?? 'all'
    /* A mute that has already lapsed is not a mute, and offering to lift one
       that is over reads as the app having lost track. */
    const mine = pref && pref.mutedUntil !== null && pref.mutedUntil > Date.now()
      ? pref
      : null
    const waiting = [...world.unread.entries()]
      .filter(([id, n]) => n > 0
        && world.channels.some((c) => c.id === id && c.space_id === s.id))
      .map(([id]) => id)
    return [
      {
        kind: 'item', label: 'Mark as read', icon: 'check',
        /* There but grey with nothing to do: somebody looking for it wants to
           know it exists and that it has already happened. */
        disabled: waiting.length === 0,
        onPick: () => onReadAll?.(waiting),
      },
      ...(held.includes('create_invite')
        ? [{ kind: 'item' as const, label: 'Invite people', icon: 'addp' as const,
             onPick: () => { onPick(s.id); onInvite() } }]
        : []),
      ...(MANAGES.some((p) => held.includes(p))
        ? [{ kind: 'item' as const, label: 'Server settings', icon: 'gear' as const,
             onPick: () => { onPick(s.id); onServerSettings() } }]
        : []),
      { kind: 'rule' },
      /*
       * What to be told about, from where somebody is looking at the server
       * rather than at one of its channels. The channel menu has said "use my
       * default" from the beginning; this is where that default is set.
       */
      ...(mine
        ? [{
            kind: 'item' as const,
            label: `Unmute server (${leftToRun(mine.mutedUntil)})`,
            icon: 'bell' as const,
            onPick: () => onSpacePref(s.id, { muteFor: null }),
          }]
        : [{
            kind: 'item' as const,
            label: 'Mute server',
            icon: 'belloff' as const,
            /* Hands over to a second menu in the same place, the way the
               channel one does - every other item closes on picking. */
            onPick: () => {
              stayOpen.current = true
              setMenu((at) => at && { ...at, items: MUTES.map(([label, ms]) => ({
                kind: 'item' as const, label,
                onPick: () => onSpacePref(s.id, { muteFor: ms }),
              })) })
            },
          }]),
      {
        kind: 'item',
        /* The current setting on the row, because a menu that hides what it
           is set to makes somebody open it to find out and then close it
           again. */
        label: `Notifications: ${LEVEL_LABEL[level]}`,
        icon: 'bell',
        onPick: () => {
          stayOpen.current = true
          setMenu((at) => at && { ...at, items: (['all', 'mentions', 'nothing'] as const)
            .map((id) => ({
              kind: 'item' as const,
              label: level === id ? `${LEVEL_LABEL[id]} ✓` : LEVEL_LABEL[id],
              onPick: () => onSpacePref(s.id, { level: id }),
            })) })
        },
      },
      {
        kind: 'item',
        /* A view of this screen rather than a setting about you, so it is
           kept on this machine - the same list can reasonably look different
           on a phone and on a desktop. */
        label: hidingMuted(s.id) ? 'Show muted channels' : 'Hide muted channels',
        icon: 'hash',
        onPick: () => onHideMuted(s.id, !hidingMuted(s.id)),
      },
      { kind: 'rule' },
      { kind: 'item', label: 'Move up', icon: 'up', disabled: i === 0,
        onPick: () => onMove(s.id, -1) },
      { kind: 'item', label: 'Move down', icon: 'dn',
        disabled: i === world.spaces.length - 1, onPick: () => onMove(s.id, 1) },
      /* Absent for whoever owns it rather than refused: the server answers
         "you own this server, so you cannot leave it", and an item that only
         ever says that is one worth not drawing. Theirs is Delete, in
         settings, behind typing the name. */
      ...(s.owner_id === world.me.id ? [] : [
        { kind: 'rule' as const },
        { kind: 'item' as const, label: 'Leave server', icon: 'out' as const,
          danger: true, onPick: () => onLeave(s) },
      ]),
    ]
  }
  /* Every channel holding something, muted ones left alone - the point of
     muting one is not to be told about it, and clearing it is being told. */
  const everywhere = [...world.unread.entries()]
    .filter(([id, n]) => n > 0 && !world.muted.has(id))
    .map(([id]) => id)
  return (
    <div className="pane rail">
      <PanelGrip on={grip} />
      <div className="railin">
        {/* The label is what this button is; the tooltip is what is in it.
            Kept apart so the name stays something a person - or a spec - can
            find the button by while the tooltip changes underneath. */}
        <button className={`rl ${where.kind === 'dms' ? 'on' : ''}`}
          aria-label="Conversations" title={homeTooltip(world)}
          onClick={onHome}
          style={{ background: 'linear-gradient(140deg,var(--acc),var(--acc2))', color: '#fff' }}>
          <span><Icon name="home" size={20} /></span>
          {/*
            * Everything waiting behind this button.
            *
            * Messages, and people asking to be friends. A request arrives on
            * the Friends page, which is behind here - so with nothing on this
            * tile the only way to find out somebody had added you was to go
            * and look, and nothing gave you a reason to. It is the same badge
            * every server carries, and it says the same thing: there is
            * something in here.
            */}
          {homeWaiting(world) > 0 && (
            <span className="pip">{homeWaiting(world)}</span>
          )}
        </button>

        {/*
          * Clear everything, everywhere.
          *
          * The one in the channel list clears what is in front of you, which
          * is the right scope for it. This is the other question - "I have
          * been away, take it all down" - and it belongs where every server
          * can be seen at once rather than inside one of them.
          *
          * Always here, asked for that way. It first appeared only when
          * something was waiting, on the reasoning that a button which does
          * nothing most of the time is noise - but a control that comes and
          * goes is worse than one that is sometimes idle: you cannot learn
          * where it lives, and you go looking for it at the moment you want
          * it, which is the moment it is there. It says how much it would
          * clear, and says nothing when that is nothing.
          */}
        {onReadAll && (
          <button className="rl rlread" title={everywhere.length > 0
            ? `Mark everything as read (${everywhere.length})`
            : 'Nothing waiting anywhere'}
            onClick={() => everywhere.length > 0 && onReadAll(everywhere)}>
            {/* The words, not a tick. Every other tile on this rail is a
                place, and a mark on its own was one more picture to learn -
                somebody has to press it once to find out what it does.
                No number on it either, the same as the one in the channel
                list: a count on this reads as one more thing waiting, which
                is the opposite of what pressing it does. How much it would
                clear is in what it says when you hover it. */}
            <span className="rlt">Read all</span>
          </button>
        )}
        <span className="rdv" />
        {world.spaces.map((s, i) => (
          <button key={s.id}
            className={`rl ${where.kind === 'space' && s.id === where.id ? 'on' : ''}`}
            title={s.name}
            onClick={() => onPick(s.id)}
            {...rowProps(s.id)}
            /*
             * Where they sit is yours and nobody else's — the order comes
             * from your own membership row, not from the server, so
             * rearranging your rail moves nothing for anybody else.
             *
             * Dragged, or moved from the menu. Right-clicking used to nudge
             * a server along the rail with no menu at all, which was meant as
             * an easier aim than a drag in a narrow column - but a
             * right-click that rearranges things is a right-click nobody
             * meant, and it happened to people looking for a menu. The nudge
             * is still here; it is in the menu now, where it can say what it
             * is about to do.
             */
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, items: menuFor(s, i) })
            }}>
            {s.icon_path
              ? <Still className="sicon" path={s.icon_path} />
              : <span>{s.name.slice(0, 2).toUpperCase()}</span>}
            {/* `.pip`, which the stylesheet already places in the corner of
                a rail tile — `.rdot` is a dot for a row, and inside a tile it
                sits in the middle of the icon. */}
            {waitingIn(world, s.id) > 0 && (
              <span className="pip">{waitingIn(world, s.id)}</span>
            )}
          </button>
        ))}

        {/*
          * A way in.
          *
          * There was none: both routes have existed since servers did and
          * nothing in this client called either, so an account could be in
          * the servers it happened to be added to and could do nothing about
          * it. Last in the rail, under the ones you are in, which is where
          * everything else puts it and where somebody looks.
          */}
        <button className="rl rlnew" title="Make or join a server"
          aria-label="Make or join a server" onClick={onNewServer}>
          <span><Icon name="plus" size={20} /></span>
        </button>
      </div>

      {/* Drawn through a portal, so it does not matter that the rail is a
          narrow column with its own overflow. */}
      {menu && (
        <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => {
          if (stayOpen.current) { stayOpen.current = false; return }
          setMenu(null)
        }} />
      )}
    </div>
  )
}

/** The channels of the open server, and you along the bottom. */
function Channels({
  space, channels, chats, current, onPick, world, onSettings, call, onStage,
  page, onPage, canManage, canOpenSettings, canInvite, onInvite, onNewGroup,
  onServerSettings, onRules, onChatRules, onCloseChat, onShut, fold, grip, onMe, onReorder,
  onNewCategory, onNewChannel, onCategory, onReadAll,
}: {
  /** Clear everything waiting where you are looking. */
  onReadAll: (ids: Id[]) => void
  /** Asked for from the blank space under the channels. */
  onNewCategory: (x: number, y: number) => void
  /** Make a channel under a heading, or loose at the top when there is none. */
  onNewChannel: (categoryId: Id | null) => void
  /** And from a heading itself, which is a row like any other now. */
  onCategory: (id: Id, name: string, x: number, y: number) => void
  /** A new order for one of the two lists, whole rather than a position. */
  onReorder: (what: 'channels' | 'categories', order: Id[]) => void
  space: Space | null
  channels: Channel[]
  chats: Conversation[]
  current: Id | null
  onPick: (id: Id) => void
  world: World
  onSettings: () => void
  /** Your own menu, from your own name. */
  onMe: (x: number, y: number) => void
  call: CallControls
  onStage: () => void
  page: 'home' | 'friends' | null
  onPage: (which: 'home' | 'friends') => void
  /** Whether the channels may be rearranged: made, moved, renamed. */
  canManage: boolean
  /** Whether there is anything in the settings screen for this person. */
  canOpenSettings: boolean
  canInvite: boolean
  onInvite: () => void
  onNewGroup: () => void
  onServerSettings: () => void
  /* Every channel has a menu; what is in it is decided where it is built,
     because that is where the permissions are known. The list used to say
     whether there was a menu at all, which meant a channel could not be
     muted by anybody who could not also rewrite its permissions. */
  onRules: (id: Id, x: number, y: number) => void
  /** The same, for a conversation, which is a different set of answers. */
  onChatRules: (id: Id, x: number, y: number) => void
  /** Take a conversation off the list, without ending it. */
  onCloseChat: (id: Id) => void
  /** Fold the whole list away, out of the arrangement. */
  onShut: () => void
  /* Which way it folds, so the arrow points where it goes. */
  fold: 'left' | 'right'
  grip: Grip
}) {
  const me = world.me
  const status = world.presence.statusFor(me.id)
  /* How many people are waiting on an answer from you. */
  const pending = world.friends.filter((f) => f.state === 'incoming').length
  /* Who is in this server, and how many of them are here — off its own
     roster, not off everybody this client has heard of. */
  const roster = space ? world.membersBySpace.get(space.id) : undefined
  const total = roster?.size ?? 0
  let online = 0
  if (roster) for (const id of roster) if (world.presence.appearsHere(id)) online++

  /* What is waiting where this list is looking. How much of it is no longer
     asked: the button that clears it does not say a number. */
  const waiting = waitingHere(world, space, chats)

  const sections = space
    ? sectionsOf(channels, world.categories, space.id, world.looseOrder[space.id], canManage)
    : []

  /*
   * Everyone in every voice room, grouped once for the whole list.
   *
   * Each card used to scan the whole occupancy looking for its own room,
   * which is every person in a call multiplied by every room in the server,
   * every time the list drew. One pass answers all of them.
   */
  const inVoice = occupantsByRoom(world)

  /*
   * Dragging a channel or a category into a different place.
   *
   * Both send the whole order rather than a position, so two people
   * rearranging at once cannot interleave into something neither asked for.
   * Only where somebody may manage channels — a row that lifts under the
   * pointer and then snaps back is worse than one that does not move.
   */
  const chans = useDragOrder(
    sections.flatMap((sec) => sec.channels.map((c) => c.id)),
    (order) => onReorder('channels', order),
  )
  /* Every heading, including the two unfiled ones - the server has taken
     them in this list from the beginning under names of its own, and leaving
     them out is what made them the only headings nobody could move. */
  const cats = useDragOrder(
    sections.map(sectionId),
    (order) => onReorder('categories', order),
  )

  return (
    <div className="pane sidepane">
      <PanelGrip on={grip} />

      {/*
        * The strip behind a server's name, which was missing entirely.
        *
        * Its own picture where it has one, and the art grown from its id
        * where it does not — never nothing, because a server with no banner
        * would otherwise have a blank rectangle where every other server has
        * something, which reads as a picture that failed to load.
        */}
      {space && (
        <div className="banner">
          {/* Folds the list away. In the corner of the banner rather than the
              corner of the panel, which is where the server's own settings
              button already was. */}
          <button className="sideshut" title="Hide the channel list"
            aria-label="Hide the channel list" data-fold={fold}
            onClick={onShut}>
            <Icon name="chev" size={14} />
          </button>
          {/*
            * Its banner where it has one, its icon where it does not, and art
            * grown from its id where it has neither - never nothing, because
            * a blank rectangle where every other server has something reads
            * as a picture that failed to load.
            *
            * The icon is the fallback rather than the answer: it is a small
            * square read at thirty pixels, and across a strip it looks like a
            * small square blown up. Which is why a banner of its own exists.
            */}
          {space.banner_path
            ? <Still className="bimg" path={space.banner_path} />
            : space.icon_path
              ? <Still className="bimg" path={space.icon_path} />
              : <Scene seed={seedOf(space.id)} tall />}
          {/* Over the picture, or the words sit on whatever the art happens
              to be brightest at. */}
          <span className="vg" />
          <span className="bnacts">
            {canInvite && (
              <button className="icb" onClick={onInvite}
                title={`Invite people to ${space.name}`} aria-label="Invite people">
                <Icon name="plus" size={16} />
              </button>
            )}
            {canOpenSettings && (
              <button className="icb" onClick={onServerSettings}
                title={`${space.name} settings`} aria-label={`${space.name} settings`}>
                <Icon name="gear" size={16} />
              </button>
            )}
          </span>
          <span className="tx">
            <div className="nm">{space.name}</div>
            <div className="ds">{space.description ?? ''}</div>
            <div className="bst">
              <b><i />{online} online</b>
              <b style={{ color: 'var(--fnt)' }}>{total} members</b>
            </div>
          </span>
        </div>
      )}
      {/* Without a server there is no banner, so the name goes here. With
          one it is on the banner already, and saying it twice in eighty
          pixels is the panel repeating itself. */}
      <div className="chd" style={{ height: 52, display: space ? 'none' : undefined }}>
        <span className="tt t" style={{ fontSize: '1em' }}>
          {space?.name ?? 'Conversations'}
        </span>
        <span className="gw" />
        {/* Absent rather than refused: with none of the permissions behind it
            there is nothing in there to open, and a button that opens an
            empty screen is worse than no button. */}
        {space && canOpenSettings && (
          <button className="icb" onClick={onServerSettings}
            title={`${space.name} settings`} aria-label={`${space.name} settings`}>
            <Icon name="gear" size={15} />
          </button>
        )}
      </div>
      {/* `scroll`, which is what makes it scroll — the class here was one
          invented for this file and styled nowhere, so a server with more
          channels than fit simply lost the ones past the bottom. */}
      {/* Two elements, not one. `scroll` is a flex child that fills the pane
          and `chlist` is a grid — put on the same element, the grid stretches
          its rows to share out that height, and Text and Voice ended up a
          screen apart with nothing between them. */}
      <div className="scroll">
      {/*
        * The empty space under the channels is a place to ask for a new
        * heading. Right-clicking a channel has always offered what to do with
        * that channel; there was nowhere to say "and another category",
        * because there is nothing there to right-click.
        */}
      <div
        className="chlist"
        onContextMenu={(e) => {
          /* Either question: there is a channel to make, or people to
             invite. What is inside is gated item by item. */
          if (!space || (!canManage && !canInvite)) return
          /* Only the blank space. On a channel or a heading, that thing's own
             menu is the one somebody meant. */
          if ((e.target as Element).closest('.chan,.vcard,.sect')) return
          e.preventDefault()
          onNewCategory(e.clientX, e.clientY)
        }}
      >
        {/* Outside a server the two pages sit above the conversations, which
            is where they are in every app that has them — and where somebody
            looks for "who do I know" rather than "what did they say". */}
        {!space && (
          <>
            <button className={page === 'home' ? 'nrow on' : 'nrow'}
              onClick={() => onPage('home')}>
              <Icon name="home" size={16} /><span className="nm">Home</span>
            </button>
            <button className={page === 'friends' ? 'nrow on' : 'nrow'}
              onClick={() => onPage('friends')}>
              <Icon name="people" size={16} /><span className="nm">Friends</span>
              {/* Somebody waiting to hear back.
                  This number was worked out on the Friends page itself, on the
                  Pending tab - so the only way to find out that somebody had
                  added you was to go and look, which nothing gave you a reason
                  to do. It belongs on the way in, not past it. */}
              {pending > 0 && <span className="pill">{pending}</span>}
            </button>
            <p className="sect">
              Conversations
              {/* A group is made from here because this is the list it will
                  appear in. There was no way to start one at all: the server
                  has taken a list of people on this call from the beginning
                  and the client only ever sent one, so every group anybody
                  had was one made before the rewrite. */}
              <button className="group-add" onClick={onNewGroup}
                title="New group conversation" aria-label="New group conversation">
                <Icon name="plus" size={14} />
              </button>
            </p>
          </>
        )}

        {/*
          * Everything waiting here, cleared at once.
          *
          * Only where there is something, so it is not a button that does
          * nothing most of the time - and counting only what is in front of
          * you, because the original counted everything anywhere and put this
          * in the header of a server with nothing unread in it.
          */}
        {waiting.length > 0 && (
          <button className="readall" onClick={() => onReadAll(waiting)}>
            <Icon name="check" size={14} />
            {/* No number on it. It is a button that clears what is
                waiting, and a count on it reads as one more thing waiting -
                which is the opposite of what pressing it does. */}
            <span>Read all</span>
          </button>
        )}
        {space
          ? sections.map((section) => (
            <div key={section.category?.id ?? section.label}>
              {/* Named, so a server that has arranged its rooms can see that
                  it has. Drawn as one flat run they were jumbled together and
                  the categories were invisible.

                  The heading is the handle, not the box around the channels:
                  a draggable box swallows the drag of everything inside it,
                  so making the section draggable was what stopped a channel
                  being dragged at all. */}
              <p className="sect"
                {...(canManage ? cats.rowProps(sectionId(section)) : {})}
                onContextMenu={(e) => {
                  if (!section.category) return
                  e.preventDefault()
                  e.stopPropagation()
                  onCategory(section.category.id, section.category.name, e.clientX, e.clientY)
                }}>
                {section.label}
                {/* And a way to put something in it. Channels could only be
                    made in the server's settings, which does not ask where to
                    put one - so everything landed loose at the top and a
                    category, once made, had no way of getting anything into
                    it at all. */}
                {canManage && (
                  <button className="group-add"
                    title={`New channel in ${section.label}`}
                    aria-label={`New channel in ${section.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onNewChannel(section.category?.id ?? null)
                    }}>
                    <Icon name="plus" size={13} />
                  </button>
                )}
              </p>
              {section.channels.map((c) => (c.kind === 'voice' ? (
            <VoiceRoom
              key={c.id}
              channel={c}
              call={call}
              world={world}
              here={inVoice.get(c.id) ?? []}
              onJoin={() => onPick(c.id)}
              /* A voice room is a channel: the same menu, for the same
                 reasons. It had none at all, so muting one, renaming it,
                 removing it or setting who may enter were reachable for a
                 text channel and for nothing else. */
              onRules={(x, y) => onRules(c.id, x, y)}
              {...(canManage ? chans.rowProps(c.id) : {})}
            />
          ) : (
            <button
              key={c.id}
              className={`chan ${c.id === current ? 'on' : ''}`}
              onClick={() => onPick(c.id)}
              {...(canManage ? chans.rowProps(c.id) : {})}
              /* Where anybody looks for what a thing is set to. Absent
                 without the permission, rather than opening a panel whose
                 every control would be refused. */
              /* Where anybody looks for what a thing is set to. */
              onContextMenu={(e) => {
                e.preventDefault()
                onRules(c.id, e.clientX, e.clientY)
              }}
            >
              <Icon name="hash" size={15} />
              <span className="nm">{c.name}</span>
              {/* Said, and quietly. A muted channel that looks like any other
                  is one somebody mutes again wondering why it did nothing. */}
              {world.muted.has(c.id) && <Icon name="belloff" size={13} />}
              {/* What is waiting. Absent at zero rather than a nought, and
                  absent on a muted channel — the point of muting it is not to
                  be told, and a number is being told. */}
              {!quietIn(c.id, space.id, world.prefs, world.spacePrefs, Date.now(), isNamed(world, c.id, c.space_id))
                && !!world.unread.get(c.id) && (
                /* Through badgeLabel, like the badge on the taskbar. The
                   server stops counting at a hundred, so the raw number is a
                   ceiling wearing the clothes of an exact count - and the
                   same fact read "100" here and "99+" on the taskbar. */
                <span className="pill">{badgeLabel(world.unread.get(c.id) ?? 0)}</span>
              )}
            </button>
          )))}
            </div>
          ))
          : chats.length
            ? chats.map((c) => (
              /* Wrapped so the cross can sit on the row: a button cannot go
                 inside a button, and the row is one. */
              <div className="chanrow" key={c.id}>
              <button
                className={`chan${c.group ? ' dm-group' : ''}${c.id === current ? ' on' : ''}`}
                onClick={() => onPick(c.id)}
                /* A conversation is a row like any other and had no menu at
                   all: everything about one - reading it, quietening it,
                   closing it, the person on the other end - was somewhere
                   else or nowhere. */
                onContextMenu={(e) => {
                  e.preventDefault()
                  onChatRules(c.id, e.clientX, e.clientY)
                }}>
                {c.peer
                  ? <AvatarWithStatus user={c.peer} size="sm"
                      status={world.presence.statusFor(c.peer.id)} />
                  : <Icon name="people" size={15} />}
                <span className="nm">{c.name}</span>
                {world.muted.has(c.id) && <Icon name="belloff" size={13} />}
                {/* No server: a conversation belongs to the people in it, so
                    there is nothing above it to defer to. */}
                {!quietIn(c.id, null, world.prefs, world.spacePrefs, Date.now(), isNamed(world, c.id, null))
                  && !!world.unread.get(c.id) && (
                  <span className="pill">{badgeLabel(world.unread.get(c.id) ?? 0)}</span>
                )}
              </button>
              {/* Off the list, not ended. Shown on hover and to the keyboard,
                  because a cross on every row all the time reads as a list of
                  things asking to be got rid of. */}
              <button className="chanx" title="Close conversation"
                aria-label={`Close conversation with ${c.name}`}
                onClick={() => onCloseChat(c.id)}>
                <Icon name="x" size={13} />
              </button>
              </div>
            ))
            : <p className="hint" style={{ padding: '10px 12px' }}>
                No conversations yet. Add somebody, or open one from a member list.
              </p>}
      </div>
      </div>




      {call.call.channel && (
        <InCall call={call} world={world}
          name={channels.find((c) => c.id === call.call.channel)?.name ?? 'Voice'}
          onStage={onStage} />
      )}

      {/* Your own banner, behind your own name — the same one a profile card
          shows, at the height a card gives it. */}
      <div className="mebar">
        <div className="mebn">
          {me.banner_path
            ? <Still className="bimg" path={me.banner_path} />
            : <Scene seed={seedOf(me.id) + 3} height={76} />}
          <span className="vg" />
        </div>
        {/* It had no handler at all: pressing your own name did nothing.
            The one place everything about you is reachable from. */}
        <button className="meid" onClick={(e) => onMe(e.clientX, e.clientY)}>
          <AvatarWithStatus user={me} status={status} size="md" />
          <span>
            {/* Your own name, the way you asked for it to be drawn. This
                is the one place you see it all the time, and it was the one
                place it was drawn plain. */}
            <span className={`n ${nameLook(me).className}`} style={nameLook(me).style}>
              {me.display_name || me.username}
            </span>
            <span className="s">{status === 'online' ? 'Online'
              : status === 'away' ? 'Idle'
                : status === 'busy' ? 'Do not disturb' : 'Invisible'}</span>
          </span>
        </button>
        <button className="icb" title="Settings" aria-label="Your settings"
          onClick={onSettings}>
          <Icon name="gear" size={16} />
        </button>
      </div>
    </div>
  )
}

function Conversation({
  space, openId, title, kind, topic, world, version, server, send, gateway, jumbo,
  shortcodes, previews, phone, narrow, onNav, onMembers, onWho, onCall, inThisCall,
  onAnswer, changed,
  panel, onPanel, goingTo, onArrived, peer, group,
}: {
  space: Space | null
  openId: Id | null
  title: string | null
  kind: ChannelKind | null
  topic: string
  world: World
  /* What says the world changed, since it never changes identity itself. */
  version: number
  /** Say it changed, for the things this pane alters that others draw. */
  changed: () => void
  server: Api
  send: (payload: unknown) => void
  gateway: import('../lib/gateway').Gateway | null
  jumbo: boolean
  shortcodes: boolean
  previews: boolean
  phone: boolean
  narrow: boolean
  onNav: () => void
  onMembers: () => void
  onWho: (id: Id, el: Element) => void
  /** Start, or go back to, a call in this conversation. */
  onCall: (channelId: Id) => void
  /** Whether the call already running is this conversation's. */
  inThisCall: boolean
  /** Walking into a call that is already open here, from its row. */
  onAnswer: (channelId: Id) => void
  panel: 'pins' | 'search' | null
  onPanel: (which: 'pins' | 'search') => void
  /** A message to scroll to once this channel's messages are here. */
  goingTo: Id | null
  onArrived: () => void
  /** In a conversation with one person, them — for the opener's picture. */
  peer: User | null
  group: boolean
}) {
  const { messages, loading, error, older, hasOlder } = useMessages(server, world, openId)
  const { typing, iAmTyping } = useTyping(gateway, openId, world.me.id)
  const up = useUpload(server)

  /*
   * Files dragged onto the app land in the conversation that is open.
   *
   * The browser's answer to a page that ignores a drop is to open the file
   * itself, which navigates away from the app - so the drop is caught
   * whatever it lands on, and only turned into an attachment here, where
   * there is somewhere to put it.
   */
  const dropping = useFileDrop(useCallback((files: File[]) => {
    for (const f of files) void up.add(f)
    /*
     * And the cursor goes to the box, so Enter sends it.
     *
     * A picture on its own has always been a message - send() says so, and
     * says why - but dropping one left focus wherever the drop landed, and
     * Enter is handled on the box. So the preview appeared, Enter did
     * nothing, and the only way to send was to click into the box first.
     * Reported as not being able to send without typing something.
     *
     * Not on a phone, for the reason opening a channel does not do it either:
     * there is no Enter key waiting, and focusing a text box slides the
     * keyboard up over the picture somebody has just added - so it takes away
     * the preview in exchange for a key they do not have.
     */
    if (!phone) setFocusComposer((n) => n + 1)
  }, [up, phone]))

  /**
   * Who can be named here.
   *
   * This server's roster, or the people in this conversation — never everyone
   * the client has heard of. Offering somebody from another server in the
   * menu tells you they exist, which is the one thing servers are not
   * supposed to say about each other.
   */
  const mentionable = useMemo<Mention[]>(() => {
    const ids = space
      ? world.membersBySpace.get(space.id)
      : new Set([world.me.id, ...(peer ? [peer.id] : [])])
    const out: Mention[] = []
    for (const id of ids ?? []) {
      const u = world.people.get(id)
      if (!u) continue
      out.push({
        id: u.id,
        name: nameIn(world, space?.id ?? null, u),
        handle: u.username,
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    /*
     * And the roles of this server, which name a group at once.
     *
     * Above the people, because there are few of them and they are what
     * somebody is reaching for when they type an @ meaning "everyone who".
     * A conversation has no roles, so it offers none.
     */
    const roles = space
      ? world.roles
        .filter((r) => r.space_id === space.id && r.kind !== 'everyone')
        .map((r) => ({ id: r.id, name: r.name, handle: r.name, kind: 'role' as const }))
      : []
    return [...roles, ...out]
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `world` is
     mutated in place and never changes identity, so `version` is what says
     it changed. Without it this was worked out once, before the server's
     roster had arrived, and never again: the @ menu offered the roles - which
     are there at sign-in - and not one person, until you opened another
     server and came back. The same trap as the conversation list. */
  }, [world, version, space, peer])

  /* One menu at a time, where it was asked for. */
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null)

  /**
   * What this channel is set to, and whether it is quiet right now.
   *
   * A mute is stored as the moment it lapses rather than as a flag, so "is
   * it muted" is a comparison against now and there is no second thing to
   * keep in step. Read at render, which is close enough: nobody watches a
   * bell change back at the exact second, and anything that redraws the
   * conversation reads it again.
   */
  /* Set by the one item that opens another menu, read by the close that
     would otherwise put it away the moment it appeared. */
  const stayOpen = useRef(false)
  const pref = openId ? world.prefs.get(openId) : undefined
  const mutedUntil = pref?.mutedUntil ?? null
  const muted = mutedUntil !== null && mutedUntil > Date.now()
  const quiet = muted || pref?.level === 'nothing'

  const setPref = (body: { level?: string; muteFor?: number | null }) => {
    if (!openId) return
    const where = openId
    void server.put<{ pref?: ChannelPref }>(
      `/api/channels/${encodeURIComponent(where)}/prefs`, body,
    )
      .then((r) => {
        if (!r?.pref) return
        world.prefs.set(where, r.pref)
        const off = (r.pref.mutedUntil !== null && r.pref.mutedUntil > Date.now())
          || r.pref.level === 'nothing'
        if (off) world.muted.add(where)
        else world.muted.delete(where)
        changed()
      })
      .catch(() => { /* Said no; the bell still shows what the server last said. */ })
  }

  const bellMenu = (): MenuItem[] => {
    const level = pref?.level ?? 'default'
    const pick = (id: 'default' | 'all' | 'mentions' | 'nothing', label: string): MenuItem => ({
      kind: 'item',
      label: level === id ? `${label} ✓` : label,
      onPick: () => setPref({ level: id }),
    })
    return [
      pick('default', 'Use my default'),
      pick('all', 'All messages'),
      pick('mentions', 'Only @mentions'),
      pick('nothing', 'Nothing'),
      { kind: 'rule' },
      muted
        ? {
            kind: 'item',
            /* How long is left, because "muted" alone leaves somebody
               wondering whether they did it five minutes or five days ago. */
            label: `Unmute channel (${leftToRun(mutedUntil)})`,
            icon: 'bell',
            onPick: () => setPref({ muteFor: null }),
          }
        : {
            kind: 'item',
            label: 'Mute channel',
            icon: 'belloff',
            /* Hands over to a second menu in the same place rather than
               closing. Every pick closes the menu it was in - which is right
               for every other item and wrong for this one, so it says so. */
            onPick: () => {
              stayOpen.current = true
              setMenu((at) => at && { ...at, items: muteMenu() })
            },
          },
    ]
  }

  const muteMenu = (): MenuItem[] => MUTES.map(([label, ms]) => ({
    kind: 'item',
    label,
    onPick: () => setPref({ muteFor: ms }),
  }))
  /* Which message is having a reaction chosen for it, and beside what. */
  const [reacting, setReacting] = useState<{ id: Id; anchor: Anchor } | null>(null)
  /* Which message is being rewritten, if any. An edit and a new message go to
     different places, so the composer has to know which it is holding. */
  const [editing, setEditing] = useState<{ id: Id; body: string } | null>(null)
  /* Whether a question is being written. */
  const [asking, setAsking] = useState(false)

  /* And what is being answered. Not the same thing as an edit and never both
     at once — you cannot answer a message by rewriting a different one. */
  /*
   * Who is being replied to, in each conversation.
   *
   * A reply is aimed at a message in one place, so it belongs to that place.
   * Held as one, choosing Reply and then glancing at another channel left
   * the composer there armed at a message that is not in it - and coming
   * back found the aim gone. Kept for the session, like the drafts beside
   * them: a half-written answer, not a preference.
   */
  const [replies, setReplies] = useState<Record<string, { id: Id; who: string }>>({})
  const replyTo = openId ? replies[openId] ?? null : null
  const setReplyTo = useCallback((to: { id: Id; who: string } | null) => {
    setReplies((now) => {
      if (!openId) return now
      if (!to) {
        if (!(openId in now)) return now
        const next = { ...now }
        delete next[openId]
        return next
      }
      return { ...now, [openId]: to }
    })
  }, [openId])
  /* Bumped to ask the composer for the cursor; see beginReply. */
  const [focusComposer, setFocusComposer] = useState(0)

  /*
   * Where the line saying "new messages" goes, taken once on the way in.
   *
   * Read when the conversation opens and then left alone: it marks where you
   * came in, not where you have got to, so it does not creep down the screen
   * as the app marks things read behind you. Opening the same conversation
   * again asks afresh, which is what puts it back at the bottom once
   * everything has been seen.
   */
  const [markFrom, setMarkFrom] = useState<number | null>(null)
  /*
   * When this conversation was last read, taken on the way in with the count.
   *
   * Read live, this was always "a moment ago": opening a channel while the
   * window is watched marks it read, the server answers with the time it did
   * so, and the client keeps that - so the bar settled on the second somebody
   * opened it and said "12 new messages since 17:42" about the 17:42 they
   * were reading it at. The honest answer is when they were last here, and
   * that value only exists until the read lands.
   */
  const [markSince, setMarkSince] = useState<number | null>(null)
  /*
   * When this conversation was opened, so the line is not cleared by the app
   * scrolling rather than by the reader.
   *
   * Opening a channel left at the end puts it at the end, which is a scroll
   * to the bottom that happens before anybody has looked at anything. Only
   * scrolling that happens after that counts as having got there.
   */
  const openedAt = useRef(0)
  /*
   * How much of the channel is drawn, as against how much is loaded.
   *
   * A channel opens showing the end of it and grows upwards as somebody
   * scrolls in - see messageWindow.ts. Reset on the way in, because the
   * window belongs to this visit rather than to the channel.
   */
  const [shown, setShown] = useState(FIRST)
  useEffect(() => {
    openedAt.current = Date.now()
    /* A different conversation is not a direction. Without this, opening a
       channel that restores higher up than the last one left off reads as
       somebody scrolling up, and the new channel starts off having let go. */
    lastTop.current = 0
    setShown(FIRST)
    setMarkFrom(openId ? world.unread.get(openId) ?? null : null)
    setMarkSince(openId ? world.lastRead.get(openId) ?? null : null)
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- on the way in
     and no other time. Following the count would move the line every time
     something arrived or was marked read, which is the one thing it must
     not do: it says where you came in. */
  }, [openId])

  /* The server's answer for this exact channel — a channel can take away what
     the server allows, and the pair of them is one fact. */
  const may = world.held.in(space?.id ?? null, openId)

  /*
   * An edit belongs to the message it started on. Moving channels would leave
   * the composer addressed to a message nobody is looking at any more.
   *
   * Not the reply, which is now kept per conversation: it is aimed at a
   * message in one place and waits there, the same way the half-written
   * words beside it do.
   */
  useEffect(() => { setEditing(null); setMenu(null) }, [openId])

  /*
   * Opening something puts the cursor in the message box.
   *
   * focusComposer existed, was passed to the composer, and was never once
   * changed - so nothing ever asked for the focus and it stayed wherever the
   * click left it, usually on the body. Opening a conversation and typing put
   * the words nowhere, which is the first thing anybody does.
   *
   * Only when there is somewhere to type: focusing a box that is not there,
   * or is disabled because this is a channel somebody may only read, would
   * take the focus off whatever they were using and give it to nothing.
   */
  useEffect(() => {
    if (!openId) return
    /*
     * Not on a phone.
     *
     * Focusing a text box there slides the keyboard up over the messages
     * somebody just opened the channel to read - every time they tap one.
     * Worse than the tap on the message box it saves them.
     */
    if (phone) return

    /*
     * And not out of somewhere somebody is already typing.
     *
     * Switching channels with a half-typed word in the search box took the
     * cursor away mid-word and put it in the message box - the search stayed
     * open, still holding the half of the word they had got to, and their
     * next keystroke went somewhere else entirely.
     *
     * The message box itself does not count: it is where the cursor is being
     * sent anyway, and re-asking is harmless.
     */
    const on = document.activeElement
    const typingElsewhere = on instanceof HTMLElement
      && (on.tagName === 'INPUT' || on.tagName === 'TEXTAREA' || on.isContentEditable)
      && !on.closest('.cmp')
    if (typingElsewhere) return

    setFocusComposer((n) => n + 1)
  }, [openId, phone])

  /* Who a reply is to, shown above the composer. In the server being read,
     because the message it answers is signed that way three lines up. */
  const nameOf = (id: Id) => {
    const u = world.people.get(id)
    return u ? nameIn(world, space?.id ?? null, u) : 'someone'
  }

  const stream = useRef<HTMLDivElement>(null)

  /**
   * Go and look at the message a reply was answering.
   *
   * Only what is loaded — a reply to something from last week is a fetch and
   * a jump in the list, and the quote says so rather than offering a press
   * that does nothing.
   */
  const goTo = (id: Id): boolean => {
    const el = stream.current?.querySelector(`[data-msg="${CSS.escape(id)}"]`)
    if (!el) return false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    /* Long enough to find with your eyes, short enough not to sit there. */
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1400)
    return true
  }

  /*
   * Down to the newest, when the newest changes.
   *
   * Only when already near the bottom, or when it is your own — somebody
   * reading back through a week of conversation should not be yanked to the
   * end because a message arrived somewhere below them. Your own is always
   * followed: you just wrote it, and watching it not appear is the report
   * that came back.
   */
  const wasAtBottom = useRef(true)
  /*
   * Two distances, because "near the end" is two different questions.
   *
   * FOLLOW is the forgiving one: coming back down, or a list growing under
   * somebody who has not moved, counts as being at the end well before it is
   * exact - a message that arrives while the last one is still settling must
   * not be treated as somebody reading history.
   *
   * GLUED is the strict one, and it is only asked when somebody has
   * deliberately gone up. One message is about sixty pixels, so a rule that
   * called anything under 120 "at the end" dragged the reader back down off
   * the very message they nudged up to re-read. Reported as clunky, measured
   * at exactly that: sixty pixels up, and the next thing anybody said pulled
   * them to the bottom.
   *
   * Not zero, because being pinned is not always pixel-exact - a row that has
   * just finished growing can leave a few over, and stopping following for
   * those would be the worse of the two faults.
   */
  const FOLLOW = 120
  const GLUED = 24
  /* Where the list was last time it moved, so the direction can be told from
     the position. Every input the app has to cope with - a wheel, a finger,
     Page Up, a hand on the scrollbar - arrives as this same event. */
  const lastTop = useRef(0)
  /*
   * Whether the reader has let go of the end, as something the page can draw.
   *
   * The same fact as wasAtBottom, which is a ref because it is read inside
   * scroll handlers many times a second and must never cause a render. This
   * is set only when the answer changes, which is when somebody leaves the
   * end or comes back to it - a handful of times in a session rather than on
   * every scroll event.
   */
  const [away, setAway] = useState(false)
  /* When they let go, so what arrived after it can be counted. A time rather
     than a length: loading an older page prepends to the list, and counting
     by length would report fifty new messages for fifty old ones. */
  const awayAt = useRef(0)
  /*
   * How many have arrived since they let go.
   *
   * Counted from the newest backwards and stopped at the first one that is
   * older, because the list is in order and what is being counted is a run at
   * the end of it. That makes this the length of the run rather than the
   * length of the list, so a channel with ten thousand loaded costs the same
   * as one with ten.
   */
  const sinceAway = (() => {
    if (!away) return 0
    let n = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i]?.created_at ?? 0) <= awayAt.current) break
      n++
    }
    return n
  })()
  const lastId = messages[messages.length - 1]?.id
  const lastMine = messages[messages.length - 1]?.author_id === world.me.id

  /*
   * Measured the moment before a new message is put into the list.
   *
   * This was decided only by the scroll handler, which is to say only when
   * somebody had scrolled. Sitting at the end reading, with the list never
   * touched since it opened, the answer was whatever it had last been - so a
   * message arriving found a stale yes or a stale no, and the list stayed
   * where it was. Reported as the chat not following along.
   *
   * Read during the render that first sees the new message, which is before
   * that message is in the page: the list on screen at this instant is still
   * the one the person was looking at, so the distance is the real one. The
   * scroll handler still keeps this up to date while they move about.
   */
  const seenLast = useRef<Id | undefined>(undefined)
  if (lastId !== seenLast.current) {
    seenLast.current = lastId
    const el = stream.current
    /* Not before there is a list to measure - the first render of a channel
       has the one before it, or nothing at all, and the effect that opens a
       channel decides that case for itself. */
    if (el && el.scrollHeight > 0) {
      /*
       * The strict distance here, not the forgiving one.
       *
       * This runs before the new message is in the page, so what it measures
       * is the list the reader is looking at right now - and somebody who is
       * following is pinned to the end, within a pixel or two. Anything
       * further is somebody who has gone up, and asking the forgiving
       * question here would take hold of them again on every message and
       * undo the letting go the scroll handler had just decided.
       */
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= GLUED
    }
  }

  /**
   * Back to where you had got to, when a channel opens.
   *
   * Reading back through a week, glancing at a conversation and coming back
   * put you at the end of the week again — so the only way to read anything
   * long was to not look away from it. The position itself is kept on the
   * world, which outlives this pane.
   */
  const putBack = useRef<Id | null>(null)

  useEffect(() => {
    const el = stream.current
    if (!el || !openId || loading) return
    /* Once per opening. This runs again whenever the list changes, and
       putting somebody back where they were while they are reading is worse
       than never having done it at all. */
    if (putBack.current === openId) return
    putBack.current = openId

    const back = world.parked.get(openId) ?? 0
    /*
     * A channel left at the end opens at the end. Restoring "nought from the
     * end" would work, but going through this path would take it out of the
     * hands of the effect below - which keeps it at the end as the last
     * message finishes loading, and is the only thing that gets that right.
     */
    if (back < 120) { wasAtBottom.current = true; return }
    wasAtBottom.current = false
    const id = requestAnimationFrame(() => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - back)
    })
    return () => cancelAnimationFrame(id)
  /* world.parked is listed to satisfy the rule and changes nothing: the world
     is mutated in place and its maps keep the identity they were made with,
     so this runs when a channel opens and not otherwise. */
  }, [openId, loading, world.parked])

  useEffect(() => {
    const el = stream.current
    if (!el) return
    if (!wasAtBottom.current && !lastMine) return
    /*
     * Held at the end while the page settles, rather than put there once.
     *
     * After the browser has laid the new message out - or this measures the
     * height the list had a moment ago and stops short of the bottom. One
     * frame is enough when a message arrives into a list that is already
     * drawn, and it is not enough when the whole list is being built: coming
     * back from a call rebuilds it from nothing, and everything in it settles
     * over the next few hundred milliseconds.
     *
     * Reported as leaving a voice channel and finding the conversation a
     * message short of the bottom. There is an observer below that re-pins as
     * rows and the list itself resize, and it did not catch this - so rather
     * than work out which of the several things that move on the way back is
     * the one it misses, this simply keeps asking for the end until the
     * answer stops changing.
     *
     * Cheap: it is a scrollTop assignment a few times over a third of a
     * second, and it stops as soon as the height holds still.
     */
    let frame = 0
    let settled = 0
    let was = -1
    const tick = () => {
      if (!wasAtBottom.current) return
      const height = el.scrollHeight
      el.scrollTop = height
      settled = height === was ? settled + 1 : 0
      was = height
      /* Three frames with the same height is settled; twenty frames is about
         a third of a second, which is the most this will ever spend. */
      if (settled < 3 && ++frame < 20) id.current = requestAnimationFrame(tick)
    }
    const id = { current: requestAnimationFrame(tick) }
    return () => cancelAnimationFrame(id.current)
  /* lastMine is read but not listed: it is worked out from the last
     message, and lastId already changes whenever that does. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, loading, openId])

  /*
   * And stay there while the page is still growing.
   *
   * The scroll above happens on the next frame, which is before a link card
   * has been fetched and long before a picture has loaded. Both of those
   * arrive later and make the list taller underneath somebody who was told
   * they were at the bottom — so opening a channel whose last message had a
   * preview in it always stopped short of the end, by exactly the height of
   * the thing that had not loaded yet.
   *
   * Watched rather than waited for: there is no moment when everything has
   * finished loading, and guessing one is how this was meant to work already.
   * A message growing is a resize of the row it is in, so the rows are what
   * is watched. Only while already at the bottom — somebody reading back
   * through a week is left where they are.
   */
  useEffect(() => {
    const el = stream.current
    if (!el) return

    const pin = () => {
      if (!wasAtBottom.current) return
      el.scrollTop = el.scrollHeight
    }

    /*
     * A picture finishing is not a resize of anything React drew.
     *
     * A link card arrives with no height and then gets one when its picture
     * loads, and that load fires on the <img> itself. `load` does not bubble,
     * so it is caught on the way down instead — without this, opening a
     * channel whose last message carries a preview still stopped short by
     * exactly the height of that picture, which is the report this is for.
     */
    el.addEventListener('load', pin, true)

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pin)
    /* Every row, and the list itself: a row added while this is watching is
       not observed until the effect runs again, and the container growing is
       the one signal that covers that gap. */
    if (ro) {
      for (const row of Array.from(el.children)) ro.observe(row)
      ro.observe(el)
    }
    return () => {
      el.removeEventListener('load', pin, true)
      ro?.disconnect()
    }
  }, [lastId, loading, openId])

  /*
   * And the same, for a message asked for before its channel was loaded.
   *
   * Following a search result changes which channel is open, so the message
   * is not on the page at the moment somebody presses the result — the list
   * it lives in has not been fetched yet. Tried once the messages arrive, and
   * then given up on rather than retried for ever: a message older than the
   * page that was loaded is not going to turn up by waiting for it.
   */
  useEffect(() => {
    if (!goingTo || loading) return
    goTo(goingTo)
    onArrived()
  /* onArrived is called, not depended on. It is a fresh function on every
     render of the parent, so listing it would run this on every render -
     and it is what clears goingTo, so that would be a loop. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goingTo, loading, messages])

  const beginReply = (m: Message) => {
    setEditing(null)
    setReplyTo({ id: m.id, who: nameOf(m.author_id) })
    /*
     * Choosing to reply is choosing to write one.
     *
     * Reported: picking Reply left the cursor wherever it was and the reply
     * box sat there empty, so clicking into it was a step the app asked for
     * and then did not take.
     *
     * On a phone too, unlike opening a channel or adding a picture. Those are
     * things somebody did for another reason and a keyboard over them is in
     * the way; this one is the decision to type, so the keyboard is what was
     * asked for.
     *
     * Asked once. This was written twice, in two commits, each with its own
     * comment saying the same thing - so every reply bumped the counter twice
     * and focused the box twice.
     */
    setFocusComposer((n) => n + 1)
  }
  const beginEdit = (m: Message) => {
    setReplyTo(null)
    setEditing({ id: m.id, body: m.body })
  }
  /*
   * Pinning is a request, not a frame down the socket — the server does it
   * over HTTP and then announces it to the channel, so there is nothing to
   * draw here and nothing to undo if it is refused.
   */
  const pin = (m: Message, pinned: boolean) => {
    void server.post(`/api/messages/${encodeURIComponent(m.id)}/pin`, { pinned })
      .catch(() => { /* Refused or offline. The message keeps the mark it has. */ })
  }

  return (
    <div className="pane chatpane">
      {/* Said out loud while something is being carried over the app, so it
          is obvious the drop will land somewhere rather than being a guess.
          Drawn over everything and taking no clicks: the window is what is
          listening, not this. */}
      {dropping && (
        <div className="dropveil">
          <span><Icon name="dl" size={26} /> Drop to attach</span>
        </div>
      )}
      <div className="wall">
        <Scene seed={seedOf(space?.id ?? 'home') + 7} tall />
      </div>
      <div className="chd">
        {phone && (
          <button className="navtog" onClick={onNav} aria-label="Channels">
            <Icon name="menu" size={20} />
          </button>
        )}
        <span className="tt t">
          {/* A conversation is a person, not a room, so it takes an @ rather
              than a hash — and a voice room takes neither. */}
          <span className="k">
            {kind === 'text' ? '#' : kind === 'dm' ? '@' : ''}
          </span>
          {title ?? 'Nothing open'}
        </span>
        {topic && <span className="tp">{topic}</span>}
        <span className="gw" />
        {/*
          * Calling somebody you are talking to.
          *
          * The server has always allowed this — a call in a conversation uses
          * the conversation itself as the room, so the people in it are the
          * only ones who could ever be in the call — and there was no way to
          * ask for one. Which reads as a feature nobody built rather than a
          * button nobody drew.
          */}
        {openId && kind === 'dm' && (
          <button
            className={inThisCall ? 'icb on' : 'icb'}
            onClick={() => onCall(openId)}
            title={inThisCall ? 'Back to the call' : 'Start a call'}
            aria-label={inThisCall ? 'Back to the call' : 'Start a call'}
          >
            <Icon name="phone" size={17} />
          </button>
        )}
        {openId && (
          <button className={panel === 'pins' ? 'icb on' : 'icb'}
            onClick={() => onPanel('pins')}
            title="Pinned messages" aria-label="Pinned messages">
            <Icon name="pin" size={16} />
          </button>
        )}
        {/*
          * What to be told about this channel.
          *
          * The whole thing existed on the server - four levels and a mute
          * with a deadline on it - and there was nothing anywhere to set it
          * with, so a busy channel could only be left or endured.
          */}
        {openId && (
          <button
            className={quiet ? 'icb is-off' : 'icb'}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ items: bellMenu(), x: r.left, y: r.bottom + 6 })
            }}
            title={quiet ? 'Muted' : 'Notification settings'}
            aria-label="Notification settings"
          >
            <Icon name={quiet ? 'belloff' : 'bell'} size={16} />
          </button>
        )}
        <button className={panel === 'search' ? 'icb on' : 'icb'}
          onClick={() => onPanel('search')}
          title="Search" aria-label="Search">
          <Icon name="search" size={16} />
        </button>
        {narrow && (
          <button className="navtog memtog" onClick={onMembers} aria-label="Members">
            <Icon name="people" size={19} />
          </button>
        )}
      </div>
      {/*
        * What arrived while they were away.
        *
        * Between the header and the messages, so it is there before any
        * scrolling: the line in the list says the same thing but is inside
        * the list, and a channel with forty new messages opens at the end of
        * them with the line somewhere above, off screen.
        */}
      <NewSince
        count={markFrom ?? 0}
        since={markSince}
        onGo={() => {
          const el = stream.current
          if (!el) return
          /*
           * The line if it is drawn, and otherwise the message it would have
           * sat above.
           *
           * The list only draws the line when it is worth drawing - a long
           * enough gap, and the start of the run actually on screen - so the
           * bar can honestly say "sixteen new" with no line to jump to. The
           * count is from the end, which is the one thing true either way.
           */
          const line = el.querySelector('.unread-line')
          const target = line
            ?? (() => {
              const rows = el.querySelectorAll('[data-msg]')
              const at = rows.length - (markFrom ?? 0)
              return rows[Math.max(0, Math.min(at, rows.length - 1))] ?? null
            })()
          target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }}
        onRead={() => {
          if (openId) send(readFrame(openId))
          /* Cleared here as well as asked for: the count comes back from the
             server on the next frame, and a bar that lingers until it does
             reads as a button that did nothing. */
          setMarkFrom(null)
        }}
      />
      {/* The list and the way back to the end of it, in one box: the button
          is placed against the bottom of the conversation rather than the
          bottom of the pane, so it lands just above the composer whatever
          height the composer happens to be. */}
      <div className="streamwrap">
      <div
        className="stream"
        ref={stream}
        /* Remembered as they scroll rather than measured when a message
           arrives: by then the list has already grown and every position
           reads as "not at the bottom". */
        onScroll={(e) => {
          const el = e.currentTarget
          const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight
          /*
           * Which way they went decides which question this is.
           *
           * Going up is a decision, and it is made about the message they
           * went up to look at rather than about a distance - so anything
           * further than glued lets go, even the sixty pixels that is one
           * message. Everything else is forgiving: coming back down, or the
           * list growing under somebody who never moved, takes hold again
           * anywhere near the end.
           */
          const wentUp = el.scrollTop < lastTop.current - 1
          lastTop.current = el.scrollTop
          wasAtBottom.current = wentUp ? fromEnd <= GLUED : fromEnd < FOLLOW
          if (openId) world.parked.set(openId, fromEnd)

          /* Only on the change, so scrolling does not re-render the
             conversation on every frame of it. */
          const gone = !wasAtBottom.current
          if (gone !== away) {
            if (gone) awayAt.current = Date.now()
            setAway(gone)
          }

          /*
           * Reaching the end is having caught up, so the line saying what was
           * missed has done its job and goes.
           *
           * Not while the app is still putting the list where it belongs -
           * that is a scroll nobody made, and it would take the line away in
           * the same frame it appeared in.
           */
          if (fromEnd < 120 && Date.now() - openedAt.current > 1000) setMarkFrom(null)

          /*
           * Near the top: read the page before this one.
           *
           * Not at the very top - by the time somebody reaches zero they have
           * been looking at a stationary list for a moment, and the messages
           * arrive after they have decided nothing is coming.
           *
           * The scroll is put back afterwards. Prepending to a scrolled list
           * pushes everything down by the height of what was added, so a
           * reader at the top would find themselves in the middle of what
           * they had already read. Measuring the height before and after and
           * moving by the difference keeps the same message under their eyes.
           */
          if (el.scrollTop > 240) return

          const was = el.scrollHeight
          const at = el.scrollTop
          /* Put the same message back under their eyes after the list grows
             above them, whether it grew from memory or from the network. */
          const keepPlace = () => {
            const now = stream.current
            if (!now) return
            now.scrollTop = at + (now.scrollHeight - was)
          }

          /*
           * Two stages, and the instant one first.
           *
           * More is loaded than is drawn for as long as the window is
           * catching up, and drawing it costs nothing but a render - so
           * asking the server while there are still messages in hand would
           * be a wait for something already here.
           */
          if (moreToShow(messages.length, shown)) {
            setShown((n) => grown(messages.length, n))
            requestAnimationFrame(keepPlace)
            return
          }

          if (!hasOlder) return
          void older().then((added) => {
            if (!added) return
            /* Drawn as well as loaded: a page fetched into a window that
               stopped at the old end would arrive and not appear, and the
               scroll would be put back to a place with nothing new above it. */
            setShown((n) => n + STEP)
            keepPlace()
          })
        }}
      >
        {!openId && (
          <div className="empty2">
            {space ? 'Pick a channel to start reading.' : 'Pick a conversation.'}
          </div>
        )}
        {openId && loading && <div className="empty2">Reading…</div>}
        {openId && error && <div className="empty2">{error}</div>}
        {/* The top of it, when the top of it is what is on screen. The
            server sends one page and nothing pages back yet, so a full page
            is the only sign there may be more above — which is why this is
            asked rather than assumed. */}
        {openId && !loading && !error && (
          <Intro
            name={title ?? ''}
            kind={kind}
            topic={topic}
            peer={peer}
            group={group}
            atStart={messages.length < 50}
          />
        )}
        {openId && !loading && !error && (
          <Messages
            world={world}
            space={space}
            /* The end of the channel, growing upwards as it is scrolled
               into - see messageWindow.ts. */
            messages={visible(messages, shown)}
            jumbo={jumbo}
            shortcodes={shortcodes}
            permissions={may}
            server={server}
            previews={previews}
            onWho={onWho}
            onReact={(m, emoji) => send(reactFrame(m.id, emoji))}
            onPickReaction={(m, el) => setReacting({ id: m.id, anchor: anchorOf(el) })}
            onReply={beginReply}
            onEdit={beginEdit}
            onPin={pin}
            onPins={() => onPanel('pins')}
            unreadFrom={markFrom}
            onDelete={(m) => send(deleteFrame(m.id))}
            onGoto={goTo}
            onJoinCall={onAnswer}
            onVote={(messageId, picked) => {
              void server.post(`/api/polls/${encodeURIComponent(messageId)}/vote`, { picked })
                .catch(() => { /* refused, closed, or offline */ })
            }}
            editingId={editing?.id ?? null}
            onCancelEdit={() => setEditing(null)}
            onSaveEdit={(id, body) => {
              /* Cleared and saved is almost certainly a deletion — the server
                 refuses an empty body outright, which would leave somebody
                 with a message that did not change and no word said why. */
              send(editIsDelete(body) ? deleteFrame(id) : editFrame(id, body))
              setEditing(null)
            }}
            onMenu={(m, actions, x, y) => {
              const items: MenuItem[] = []
              if (actions.includes('react')) {
                /* The few anybody actually reaches for. Browsing every emoji
                   there is belongs in a picker, not in a menu. */
                for (const e of quickRow()) {
                  items.push({
                    kind: 'item', label: e, wide: true,
                    onPick: () => {
                      /* Remembered before it is sent, so the row has learned
                         it by the time the next menu opens - whether or not
                         the server ever answers. */
                      rememberEmoji(e)
                      send(reactFrame(m.id, e))
                    },
                  })
                }
                /* And the way to the rest of them. Six is the handful anybody
                   reaches for, not the whole vocabulary, and without this the
                   menu quietly said those six were all there was. */
                items.push({
                  kind: 'item', label: '+', hint: 'More reactions', wide: true,
                  onPick: () => setReacting({ id: m.id, anchor: { x, y, w: 0, h: 0 } }),
                })
                items.push({ kind: 'rule' })
              }
              if (actions.includes('reply')) {
                items.push({
                  kind: 'item', label: 'Reply', icon: 'reply',
                  onPick: () => beginReply(m),
                })
              }
              if (actions.includes('pin')) {
                items.push({
                  kind: 'item',
                  label: m.pinned_at ? 'Unpin' : 'Pin',
                  icon: 'pin',
                  onPick: () => pin(m, !m.pinned_at),
                })
              }
              if (actions.includes('copy') && m.body) {
                items.push({
                  kind: 'item', label: 'Copy text', icon: 'copy',
                  onPick: () => { void navigator.clipboard?.writeText(m.body) },
                })
              }
              /*
               * The picture itself, onto the clipboard.
               *
               * The bitmap rather than a link. A link here is signed and
               * stops working after a week, so "Copy image address" would
               * hand somebody something that quietly dies - and making it not
               * die means unexpiring public URLs, which is a decision about
               * who can reach an upload rather than a menu item.
               *
               * Offered for one picture, because "copy" with several is a
               * question rather than an action. GIFs are drawn as video and
               * copy as their first frame, so they are left out.
               */
              const picture = (m.attachments ?? []).filter(
                (a) => a.mime?.startsWith('image/') && !a.is_gif)
              if (picture.length === 1 && canCopyPictures()) {
                items.push({
                  kind: 'item', label: 'Copy image', icon: 'img',
                  onPick: () => {
                    void copyPicture(picture[0]!.path).then((ok) => {
                      /* Said either way. A menu that closes and does nothing
                         is indistinguishable from one that worked. */
                      toast(ok ? 'Copied' : 'That would not copy')
                    })
                  },
                })
              }
              if (actions.includes('edit')) {
                items.push({
                  kind: 'item', label: 'Edit', icon: 'pencil',
                  onPick: () => setEditing({ id: m.id, body: m.body }),
                })
              }
              if (actions.includes('delete')) {
                /* A line the app wrote is not a message somebody sent, and
                   "Delete" beside it reads as deleting what was pinned. */
                items.push({
                  kind: 'item',
                  label: m.kind === 'pin' ? 'Delete this line' : 'Delete',
                  icon: 'trash', danger: true,
                  onPick: () => send(deleteFrame(m.id)),
                })
              }
              setMenu({ items, x, y })
            }}
          />
        )}
      </div>
      <JumpDown
        show={away}
        count={sinceAway}
        onGo={() => {
          const el = stream.current
          if (!el) return
          /* Taking hold again is part of pressing it: somebody who asked to
             be at the end means to stay there. */
          wasAtBottom.current = true
          lastTop.current = el.scrollHeight
          el.scrollTop = el.scrollHeight
          setAway(false)
        }}
      />
      </div>

      {replyTo && (
        <div className="replybar">
          <Icon name="reply" size={13} />
          <span>Replying to <b>{replyTo.who}</b></span>
          <span className="gw" />
          <button className="icb" onClick={() => setReplyTo(null)} aria-label="Stop replying">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      <Typing world={world} spaceId={space?.id ?? null} who={typing} />

      {asking && openId && (
        <PollMaker
          onClose={() => setAsking(false)}
          onAsk={(poll) => {
            setAsking(false)
            /* Over HTTP rather than the socket, like pinning: the server
               writes it and then announces it to the channel, so there is
               nothing to draw optimistically and nothing to reconcile. */
            void server.post('/api/polls', { channelId: openId, ...poll })
              .catch(() => { /* refused or offline */ })
          }}
        />
      )}

      <Composer
        where={openId}
        mentionable={mentionable}
        focusAt={focusComposer}
        replying={!!replyTo}
        onCancelReply={() => setReplyTo(null)}
        {...(may.includes('create_polls') || kind === 'dm'
          ? { onPoll: () => setAsking(true) }
          : {})}
        {...(space ? { permissions: may } : {})}
        onEditLast={() => {
          /* One at a time. A second Up while an edit is open would move the
             edit to an older message with the first one half rewritten. */
          if (editing) return
          /* The last thing you said that is still there to change — not the
             last message in the channel, which is usually somebody else's,
             and not one that has been deleted. */
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (m && m.author_id === world.me.id && !m.deleted_at) {
              beginEdit(m)
              return
            }
          }
        }}
        name={title}
        kind={kind}
        onTyping={iAmTyping}
        pending={up.pending}
        onPick={(f) => {
          void up.add(f)
          /* The same as a drop, phone included: choosing a picture leaves
             focus on the button that opened the picker, so Enter had nowhere
             to land there either - and on a phone there is no Enter to land,
             only a keyboard over the preview. */
          if (!phone) setFocusComposer((n) => n + 1)
        }}
        onDrop={up.remove}
        uploadError={up.error}
        server={server}
        /*
          * A GIF goes as soon as it is picked.
          *
          * It used to be attached and left waiting for somebody to press
          * send, which is a step nobody wants: choosing one out of a wall of
          * them IS the decision, and nothing gets typed alongside it. The
          * emoji picker is deliberately the other way round - an emoji is
          * usually part of a sentence.
          *
          * Sent on its own rather than with whatever else is attached, so
          * picking a GIF never carries a half-written message out with it.
          */
        onGif={(g) => {
          if (!openId) return
          void importGif(server, g)
            .then((file) => {
              send({ t: 'send', channelId: openId, body: '', attachments: [file] })
            })
            .catch(() => { /* refused, or the provider would not give it up */ })
        }}
        onSend={(body) => {
          if (!openId) return
          /* Sent down the socket, which is where this server takes a message.
             What comes back arrives as an event, the same way it does for
             everybody else in the channel — so there is nothing to draw
             optimistically and nothing to reconcile afterwards. */
          /* `url`, and the whole signed string. The server's check is
             `if (!f?.url) continue`, so an attachment under any other key is
             not refused — it is skipped, and the message arrives without the
             picture and without a word said. */
          send({
            t: 'send', channelId: openId, body, attachments: up.attachments(),
            /* The server reads `replyTo`, and only writes reply_to when it is
               there — so a message that is not a reply must not carry the key
               with a stale id still in it. */
            ...(replyTo ? { replyTo: replyTo.id } : {}),
          })
          setReplyTo(null)
          up.clear()
        }}
      />

      {menu && (
        <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => {
          if (stayOpen.current) { stayOpen.current = false; return }
          setMenu(null)
        }} />
      )}

      {reacting && (
        <EmojiPicker
          anchor={reacting.anchor}
          forReaction
          onPick={(glyph) => {
            /* Chosen from the whole picker, which is the strongest sign of
               all that this is one they reach for - it cost them a trip
               through every emoji there is to find it. */
            rememberEmoji(glyph)
            send(reactFrame(reacting.id, glyph))
            setReacting(null)
          }}
          onClose={() => setReacting(null)}
        />
      )}

      {panel === 'pins' && openId && (
        <Pins
          server={server}
          world={world}
          space={space}
          phone={phone}
          channelId={openId}
          canUnpin={may.includes('manage_pins') || may.includes('manage_messages')}
          onGoto={(id) => { goTo(id); onPanel('pins') }}
          onUnpin={(id) => {
            void server.post(`/api/messages/${encodeURIComponent(id)}/pin`, { pinned: false })
              .catch(() => { /* refused or offline; the list refetches on open */ })
          }}
          onClose={() => onPanel('pins')}
        />
      )}
    </div>
  )
}

/** The reactions worth a place in a menu. The rest belong in a picker. */
/* The row a message menu offers. What somebody actually uses goes to the
   front of it - see lib/recentEmoji.ts. */

/**
 * A voice room in the channel list.
 *
 * Named for what it is: a place with people standing in it, not a document
 * with a title. So it says who is in there before you decide to go in —
 * which is the only thing anybody actually wants to know about a voice room.
 */
function VoiceRoom({ channel, call, world, here: fromGateway, onJoin, onRules, ...drag }: {
  channel: Channel
  call: CallControls
  world: World
  /** Who the gateway says is in here, grouped once for the whole list. */
  here: Face[]
  onJoin: () => void
  /** Where anybody looks for what a room is set to. */
  onRules: (x: number, y: number) => void
  /* Whatever it takes to be picked up and dropped on, or nothing where
     somebody may not rearrange this server. A voice room is a channel like
     any other and was the only kind that could not be moved. */
} & Partial<React.HTMLAttributes<HTMLElement>> & { draggable?: boolean }) {
  /*
   * Who is in there, from the media server while you are in the room and from
   * the gateway while you are not.
   *
   * It used to be the first alone, which meant a room you had not joined
   * always looked empty: that roster comes from the call itself, and you only
   * have one once you are in it. The gateway has been sending the occupancy
   * of every room you can see all along - the client kept only the watch
   * lists out of it and dropped the rest.
   *
   * The call's own is still preferred where there is one: it is the same
   * people, arriving faster and carrying who is talking.
   */
  const inRoom = call.call.channel === channel.id
  const here: Face[] = inRoom ? call.call.members : fromGateway
  const anySharing = here.some((m) => m.sharing)
  /* A few faces and then a number. Fifty of them would push the Join button
     out of the card, and say nothing the count above has not already said. */
  const { shown, more } = facesShown(here)
  return (
    <button
      {...drag}
      onContextMenu={(e) => { e.preventDefault(); onRules(e.clientX, e.clientY) }}
      className={`vcard ${here.length ? 'live' : 'empty'} ${
        call.call.channel === channel.id ? 'here' : ''}`}
      onClick={onJoin}
      /* Whatever was chosen for it, or one of four accent colours from the
         id rather than from its position in the list — a room should not
         change colour because somebody added another above it. */
      style={{ ['--vc' as string]:
        (channel.kind === 'voice' && channel.colour)
          ? channel.colour
          : `var(--v${(seedOf(channel.id) % 4) + 1})` }}
    >
      <span className="top">
        <span className="vi"><Icon name="vol" size={14} /></span>
        <span className="nm">{channel.name}</span>
        {anySharing && (
          <span style={{ color: 'var(--ok)' }} title="Somebody is sharing">
            <Icon name="share" size={13} />
          </span>
        )}
      </span>
      <span className="cnt">
        {here.length
          ? `+ ${here.length} ${here.length === 1 ? 'person' : 'people'}`
          : 'Nobody in here'}
      </span>
      <span className="row">
        {here.length ? (
          /* Wraps rather than running off the side: the panel goes down to
             two hundred pixels and the faces grow with it, so at the narrow
             end nine of them are two rows. */
          <span className="stack">
            {shown.map((m) => (
              <Avatar key={m.id}
                user={world.people.get(m.id) ?? someone(m.id, m.name)} size="sm" />
            ))}
            {more > 0 && (
              <span className="more" title={`and ${more} more`}>+{more}</span>
            )}
          </span>
        ) : <span className="et">open</span>}
        <span className="join">{call.call.channel === channel.id ? 'Open' : 'Join'}</span>
      </span>
    </button>
  )
}

/**
 * The call, while you are somewhere else.
 *
 * Being in a call and looking at it are different things — you join a room
 * and then go and read a channel — so the controls have to be reachable
 * without the stage, or leaving means finding your way back to it first.
 */
function InCall({ call, world, name, onStage }: {
  call: CallControls
  world: World
  name: string
  onStage: () => void
}) {
  const c = call.call
  /* Whether the word under each face is allowed to change - see the rows
     below. The ring is not asked; it keeps up either way. */
  const watching = useWatching()
  /* Read off the roster, the same way the stage reads it, so both bars agree
     about whether a share is running. */
  const sharing = !!c.members.find((m) => m.id === world.me.id)?.sharing
  const [shareMenu, setShareMenu] = useState<{ x: number; y: number } | null>(null)
  /* Off the call rather than out of storage, so picking one moves the
     tick straight away instead of on the next open. */
  const preset = call.quality

  /*
   * What the arrow offers.
   *
   * The sound comes first because it is the one people reach for mid-share,
   * and it is only listed where there is something to turn off — a share
   * started without sound never captured any, and an entry that cannot do
   * what it says is worse than no entry.
   */
  const shareItems: MenuItem[] = [
    ...(c.shareAudio.has
      ? [{
          kind: 'item' as const,
          label: c.shareAudio.on ? 'Mute the shared sound' : 'Share the sound too',
          icon: c.shareAudio.on ? ('voloff' as const) : ('vol' as const),
          onPick: () => call.setShareAudio(!c.shareAudio.on),
        }, { kind: 'rule' as const }]
      : []),
    ...SHARE_PRESETS.map((x): MenuItem => ({
      kind: 'item',
      /* Named in the two numbers people actually think in, and ticked where
         it is the one running — a list of four sizes with no mark on it does
         not say which you are already sending. */
      label: `${qualityLabel(x)} — ${x.name}`,
      /* Spread rather than set to undefined: the project refuses an optional
         property that is present and empty, which is the same rule that stops
         a half-filled object being mistaken for a filled one. */
      ...(x.id === preset.id ? { icon: 'check' as const } : {}),
      onPick: () => call.setShareQuality(x),
    })),
  ]

  return (
    <div className="vhud">
      <button className="wv" onClick={onStage} title="Open the stage">
        <span className="ov">
          <span className="dot" />
          <span className="t">{name}</span>
          {/*
            * How the connection is holding up, when it is worth saying.
            *
            * The client before this one drew four bars here and the rewrite
            * dropped the event that fed them, so a call that had gone bad
            * looked exactly like one that had not - the only clue being
            * people asking you to repeat yourself.
            *
            * Drawn only when there is something to say: 'unknown' is the
            * first second or two of every call and is also what a browser
            * with no opinion reports for ever, and four confident bars about
            * nothing is worse than no bars.
            */}
          {c.quality !== 'unknown' && c.quality !== 'excellent' && (
            <span className={`sig ${c.quality}`}
              title={c.quality === 'lost' ? 'Connection lost'
                : c.quality === 'poor' ? 'Poor connection' : 'Connection is holding up'}
              aria-label={c.quality === 'lost' ? 'Connection lost'
                : c.quality === 'poor' ? 'Poor connection' : 'Connection is holding up'}>
              <i /><i /><i />
            </span>
          )}
          <span className="ti"><Icon name="up" size={13} /></span>
        </span>
      </button>

      {c.members.map((m) => {
        const person = world.people.get(m.id) ?? someone(m.id, m.name)
        const loud = c.speaking.has(m.id)
        return (
          <button className={loud ? 'vrow sp' : 'vrow'} key={m.id}>
            <span className={loud ? 'ring on' : 'ring'}>
              <Avatar user={person} size="md" />
            </span>
            <span>
              <span className="n" style={{ display: 'block' }}>
                {nameIn(world, spaceOfChannel(world, c.channel), person)}
              </span>
              <span className="s">
                {/*
                  * Still, while nobody is looking.
                  *
                  * This word changes every time somebody starts or stops
                  * talking, and the stylesheet makes it heavier when it says
                  * Speaking - so each turn of a conversation re-laid the line
                  * out, in a window on another monitor that nobody was
                  * reading. The rule that quietens everything else cannot
                  * reach this: it pauses animations, and this is neither an
                  * animation nor a transition but a different word.
                  *
                  * The ring keeps up regardless, which is the one thing that
                  * was asked to carry on moving.
                  */}
                {voiceLabel({
                  mine: m.id === world.me.id, deaf: c.deaf,
                  muted: m.muted, loud: loud && watching, sharing: m.sharing,
                })}
              </span>
            </span>
            {m.sharing && <Icon name="share" size={13} />}
          </button>
        )
      })}

      <div className="vctl">
        <button className={c.muted ? 'off' : ''} title={c.muted ? 'Unmute' : 'Mute'}
          aria-label={c.muted ? 'Unmute' : 'Mute'}
          onClick={() => call.setMuted(!c.muted)}>
          <Icon name={c.muted ? 'micoff' : 'mic'} size={16} />
        </button>
        <button className={c.deaf ? 'off' : ''} title={c.deaf ? 'Undeafen' : 'Deafen'}
          aria-label={c.deaf ? 'Undeafen' : 'Deafen'}
          onClick={() => call.setDeaf(!c.deaf)}>
          <Icon name={c.deaf ? 'headoff' : 'head'} size={16} />
        </button>
        {/* It stops as well as starts. It only ever passed true, so the one
            button that begins a share could not end one — the stage was the
            only way to stop sharing from anywhere in the app. */}
        <button className={sharing ? 'on' : ''}
          title={sharing ? 'Stop sharing' : 'Share screen'}
          aria-label={sharing ? 'Stop sharing' : 'Share screen'}
          /* And onto the stage with it, but only once a screen has actually
             been chosen: opening the picker and changing your mind must not
             move you somewhere you did not ask to be. Stopping a share leaves
             you where you are. */
          onClick={() => {
            void call.setShare(!sharing, true).then((started) => {
              if (started) onStage()
            })
          }}>
          <Icon name="share" size={16} />
        </button>
        {/*
          * Everything else about the share, behind one arrow.
          *
          * The sound and the quality both used to need the stage, and the
          * first fix for that put a second button on this bar — which is how
          * a row of four controls becomes a row of seven, each one a glyph
          * with no room for a word. An arrow beside the thing it is about
          * says "there is more here" in the space of one button, and the
          * menu has room to name what it is offering.
          */}
        <button className="sup" title="Sharing options" aria-label="Sharing options"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect()
            setShareMenu({ x: box.left, y: box.top })
          }}>
          <Icon name="up" size={14} />
        </button>
        <button className="lv" title="Leave the call" aria-label="Leave the call"
          onClick={() => void call.leave()}>
          <Icon name="x" size={16} />
        </button>
      </div>

      {shareMenu && (
        <Menu x={shareMenu.x} y={shareMenu.y} items={shareItems}
          onClose={() => setShareMenu(null)} />
      )}
    </div>
  )
}

/** Somebody in a call the app has not otherwise heard of. */
const someone = (id: Id, name: string) => ({
  id, username: name, discriminator: '0000', verified: 0, display_name: name,
  bio: '', accent: '', accent_2: '', name_font: 'default',
  name_effect: 'none', avatar_path: null, banner_path: null,
  status_text: '', presence: 'online' as const, created_at: 0,
})

/** Who is here, grouped by the roles that ask for a heading of their own. */
/**
 * Somebody in a list, with everything they can be asked for.
 *
 * A tap opens them and a right-click opens their menu. A phone has no
 * right-click, and this was bound to `contextmenu` alone — so on a phone the
 * only way to anybody's menu was absent, in the same way and for the same
 * reason a message's actions once were. A long press is the gesture people
 * already make for exactly this.
 */
function PersonRow({ className, onOpen, onWho, children }: {
  className: string
  onOpen: (el: Element) => void
  onWho: (x: number, y: number) => void
  children: React.ReactNode
}) {
  const press = useLongPress((x, y) => onWho(x, y))
  return (
    <button
      className={className}
      onClick={(e) => onOpen(e.currentTarget)}
      onContextMenu={(e) => { e.preventDefault(); onWho(e.clientX, e.clientY) }}
      {...press}
    >
      {children}
    </button>
  )
}

/**
 * The person on the other side of a conversation, drawn as their card.
 *
 * What you have in common comes off the server rather than being worked out
 * here. This used to filter your own servers by which of them holds them -
 * which can only see a server whose roster has been fetched, and that happens
 * when you open one. So it was not the servers you share, it was the ones you
 * share and had opened since the app started, and it read as a shrinking
 * number for no visible reason.
 */
/* Exported for its own test: what it draws depends on an answer that has to
   be fetched, and mounting the whole shell to see it is not a test. */
export function PeerCard({ server, world, peer, grip, onOpen }: {
  server: Api
  world: World
  peer: User
  grip: Grip
  onOpen: (id: Id, el: Element) => void
}) {
  const them = world.people.get(peer.id) ?? peer
  const mutual = useMutual(server, peer.id)
  const look = nameLook(them)

    return (
      <div className="pane mempane">
        <PanelGrip on={grip} atLeft />
        <div className="pbanner">
          {them.banner_path
            ? <Still className="bimg" path={them.banner_path} />
            : <Scene seed={seedOf(them.id)} tall />}
          <span className="vg" />
        </div>
        <div className="pbody">
          <span className="pav">
            <AvatarWithStatus user={them} size="xl"
              status={world.presence.statusFor(them.id)} />
          </span>
          <h3 className={`pname ${look.className}`} style={look.style}>
            {them.display_name || them.username}
          </h3>
          <p className="phandle">@{them.username}</p>
          {them.bio && <p className="pbio">{them.bio}</p>}

          {mutual.spaces.length > 0 && (
            <>
              <p className="lab">
                {mutual.spaces.length} mutual server{mutual.spaces.length === 1 ? '' : 's'}
              </p>
              <div className="pshared2">
                {mutual.spaces.map((sp) => (
                  <span className="chip" key={sp.id}>
                    <span className="tbi">
                      {sp.icon_path
                        ? <img src={sp.icon_path} alt="" />
                        : sp.name.slice(0, 2).toUpperCase()}
                    </span>
                    {sp.name}
                  </span>
                ))}
              </div>
            </>
          )}

          {/*
            * People you both know.
            *
            * Dropped at zero rather than drawn as "0 mutual friends", which
            * is a sentence nobody needs to read. Only the overlap is sent,
            * and every name in it is already in your own friend list.
            */}
          {mutual.friends.length > 0 && (
            <>
              <p className="lab">
                {mutual.friends.length} mutual friend{mutual.friends.length === 1 ? '' : 's'}
              </p>
              <div className="pshared2">
                {mutual.friends.map((f) => (
                  <span className="chip" key={f.id}>
                    <span className="tbi">
                      {f.avatar_path
                        ? <img src={f.avatar_path} alt="" />
                        : (f.display_name || f.username).slice(0, 2).toUpperCase()}
                    </span>
                    {/* Their own name. Mutual friends are not a fact about
                        any one server, so no server's nickname applies -
                        and the one this used to read was the account-wide
                        column, which is gone. */}
                    {f.display_name || f.username}
                  </span>
                ))}
              </div>
            </>
          )}

          <p className="lab">Member since</p>
          <p className="pbio">{since(them.created_at)}</p>

          <button className="btn" style={{ width: '100%', marginTop: 10 }}
            onClick={(e) => onOpen(them.id, e.currentTarget)}>
            View full profile
          </button>
        </div>
      </div>
    )
}

/**
 * One person in a server's member list.
 *
 * Its own component so what it draws can be tested. It was a closure inside
 * the list, and the line under the name - the part this is really about - was
 * only ever the sentence somebody typed about themselves.
 */
export function MemberRow({ u, world, space, onOpen, onWho }: {
  u: User
  world: World
  space: Space
  onOpen: (id: Id, el: Element) => void
  onWho: (id: Id, x: number, y: number) => void
}) {
  const theirs = rolesOf(u.id, space, world.roles, world.assignments)
  const colour = nameColourFrom(theirs)
  const look = nameLook(u, colour ?? undefined)
  const status = world.presence.statusFor(u.id)
  return (
    <PersonRow key={u.id} className="mrow"
      onOpen={(el) => onOpen(u.id, el)}
      onWho={(x, y) => onWho(u.id, x, y)}>
      <AvatarWithStatus user={u} status={status} size="md" />
      <span>
        <span className={`n ${look.className}`}
          style={look.style}>
          {/* Their nickname first: it is what this server calls them, which
              is the whole point of setting one. This row ignored it, so a
              nickname could be stored and shown nowhere. */}
          {nameIn(world, space.id, u)}
        </span>
        {/*
          * What they are doing beats what they wrote about themselves.
          *
          * One line, because there is one line: a row with a name, a status
          * and an activity is three lines tall and the list stops being a
          * list. What somebody is doing now is the more useful of the two,
          * and the one they did not have to remember to update.
          *
          * The panel beside a conversation has done this since it was
          * written. This list - the one with forty people in it, where it
          * matters most - only ever drew the sentence somebody typed about
          * themselves, so a room full of people playing things looked
          * exactly like a room full of people doing nothing.
          */}
        {status !== 'offline' && (() => {
          /* The game wins the line when there are two: everybody's music
             says the same thing and only one of them is in a raid. Both are
             on the profile, which has the room for both. */
          const doing = primaryActivity(world.activities.get(u.id))
          if (doing) {
            return <span className="a"><ActivityLine activity={doing} /></span>
          }
          /*
           * Then being in a call, which beats what they wrote about
           * themselves for the same reason a game does: it is true now.
           *
           * Under both of those rather than over them, because a game and a
           * call go together - most people in a voice room are in one while
           * doing something else, and "In voice" said instead of the game
           * would be the less interesting half of the same sentence.
           *
           * world.voice only holds rooms this account may see: the server
           * filters the occupancy per client through canAccessChannel, so a
           * private room cannot be revealed by somebody standing in it.
           */
          if (world.voice.has(u.id)) {
            return <span className="a"><InVoiceLine /></span>
          }
          return statusOf(u) ? <span className="a">{statusOf(u)}</span> : null
        })()}
      </span>
      <span className="dots"><Icon name="dots" size={15} /></span>
    </PersonRow>
  )
}

function Members({ server, world, space, chat, onOpen, grip, onWho }: {
  server: Api
  world: World
  space: Space | null
  chat: Conversation | null
  onOpen: (id: Id, el: Element) => void
  grip: Grip
  /** Where anybody looks for what can be done about a person. */
  onWho: (id: Id, x: number, y: number) => void
}) {
  /* In a conversation the column holds who you are talking to, because a
     roster of one is not a roster. */
  if (!space) {
    if (!chat) return <div className="pane mempane" />

    /*
     * One person, drawn as their card rather than as a list of one.
     *
     * A roster of one is not a roster, and the column beside a conversation
     * is the only place their picture, what they wrote about themselves and
     * the servers you share have anywhere to be. It showed a heading and
     * their name.
     */
    if (!chat.group && chat.peer) {
      /* Its own component, because what the two of you have in common has to
         be fetched - and a hook cannot live after the early returns above. */
      return (
        <PeerCard server={server} world={world} peer={chat.peer}
          grip={grip} onOpen={onOpen} />
      )
    }

    return (
      <div className="pane mempane">
        <PanelGrip on={grip} atLeft />
        <div className="chd" style={{ height: 52, padding: '0 14px' }}>
          <span className="tt t" style={{ fontSize: '1em' }}>
            {chat.group ? 'In this group' : 'About them'}
          </span>
        </div>
        <div className="mem">
          {chat.others.map((u) => (
            <PersonRow key={u.id} className="mrow"
              onOpen={(el) => onOpen(u.id, el)}
              onWho={(x, y) => onWho(u.id, x, y)}>
              <AvatarWithStatus user={u} size="md"
                status={world.presence.statusFor(u.id)} />
              <span>
                {/* However they have asked to be drawn. The server's own
                    list applied this and the conversation's did not, so a
                    name with a colour or an effect had both in a channel and
                    neither in a DM — same person, two answers. */}
                <span className={`n ${nameLook(u).className}`} style={nameLook(u).style}>
                  {/* Null, deliberately: a conversation is nobody's server,
                      so the people in it are shown the names they chose for
                      themselves whatever a server they share calls them. */}
                  {nameIn(world, null, u)}
                </span>
                {/* What they are, under their name. A list of names with
                    nothing under them says nothing about who is actually
                    about to read what you write. */}
                {/* What they are doing beats what they wrote about
                    themselves: one is true right now and the other was true
                    whenever they last thought about it. */}
                <span className="a">
                  {/* What they are doing beats what they wrote about
                      themselves, and the thing itself is the part somebody
                      scans for - so it carries the weight and the verb does
                      not. */}
                  {primaryActivity(world.activities.get(u.id))
                    ? <ActivityLine activity={primaryActivity(world.activities.get(u.id))} />
                    /* Then a call, on the same rule as the server list: a
                       game or music wins the line, and being in one beats a
                       sentence somebody typed about themselves. */
                    : world.voice.has(u.id)
                    ? <InVoiceLine />
                    : (statusOf(u) && world.presence.appearsHere(u.id)
                      ? statusOf(u)
                      : world.presence.statusFor(u.id) === 'offline' ? 'offline' : 'online')}
                </span>
              </span>
            </PersonRow>
          ))}
        </div>
      </div>
    )
  }

  /*
   * Who is in *this* server.
   *
   * Read off the roster this server answered with rather than off everybody
   * this client has heard of — which is friends, DM partners and the members
   * of every other server as well, and showed all of them in every server.
   *
   * Nobody at all until that roster has arrived, rather than everybody: a
   * list that is briefly wrong about who is in a server is worse than one
   * that is briefly empty.
   */
  const roster = world.membersBySpace.get(space.id)
  const mine = [...world.people.values()].filter((u) => roster?.has(u.id))
  /* How they appear, not whether a socket is open: somebody who has chosen
     to appear offline belongs in the second list, and this is the most
     visible place in the app that could have said otherwise. */
  const here = mine.filter((u) => world.presence.appearsHere(u.id))
  const away = mine.filter((u) => !world.presence.appearsHere(u.id))
  const groups = memberGroups(here, space, world.roles, world.assignments)

  const row = (u: (typeof here)[number]) => (
    <MemberRow key={u.id} u={u} world={world} space={space}
      onOpen={onOpen} onWho={onWho} />
  )

  return (
    <div className="pane mempane">
      <PanelGrip on={grip} atLeft />
      <div className="chd" style={{ height: 52, padding: '0 14px' }}>
        <span className="tt t" style={{ fontSize: '1em' }}>Members</span>
      </div>
      <div className="mem">
        {groups.filter((g) => g.people.length).map((g) => (
          <div key={g.label}>
            <div className="sect" style={{
              padding: '6px 8px 4px',
              ...(g.colour ? { color: g.colour } : {}),
            }}>
              {g.label} — {g.people.length}
            </div>
            {g.people.map(row)}
          </div>
        ))}
        {away.length > 0 && (
          <div>
            <div className="sect" style={{ padding: '12px 8px 4px' }}>
              Offline — {away.length}
            </div>
            {away.map(row)}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * How long a mute can be set for.
 *
 * Zero means until it is turned back on. A duration rather than a deadline
 * because the server works the deadline out: a client sending its own
 * "until" would be sending its own clock, and a machine an hour out would
 * mute for an hour too long or not at all.
 */
const MUTES: ReadonlyArray<readonly [string, number]> = [
  ['For 15 minutes', 15 * 60_000],
  ['For 1 hour', 60 * 60_000],
  ['For 3 hours', 3 * 60 * 60_000],
  ['For 8 hours', 8 * 60 * 60_000],
  ['For 24 hours', 24 * 60 * 60_000],
  ['Until I turn it back on', 0],
]

/** What is left of a mute, said the way somebody would say it. */
function leftToRun(until: number | null): string {
  if (until === null) return 'off'
  const ms = until - Date.now()
  /* The server stores "until I turn it back on" as a date far enough away
     that it never lapses, so anything past a month is that rather than a
     mute somebody set for five weeks. */
  if (ms > 30 * 86400_000) return 'until you turn it back on'
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `another ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  return `another ${hours} hour${hours === 1 ? '' : 's'}`
}
