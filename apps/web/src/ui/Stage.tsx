import { voiceLabel } from '../lib/voiceLabel'
import { useWatching } from './useWatching'
import { nameIn, spaceOfChannel } from '../lib/names'
import { useEffect, useRef, useState } from 'react'
import { keyOf, partsOf, tilesOf, watched, type Call, type StreamKey } from '../lib/call'
import type { Id } from '../lib/wire'
import type { World } from '../lib/world'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { isWatching, onAttentionChange } from '../lib/attention'
import type { CallControls } from './useCall'
import { TileMenu } from './TileMenu'
import { Menu, type MenuItem } from './Menu'
import { qualityLabel, SHARE_PRESETS } from '../lib/sharequality'
import { watchersOf } from '../lib/watchers'
import { Spectators } from './Spectators'

/**
 * The call, as a room you can see.
 *
 * Screens and cameras get a tile each; everybody else gets a face, so a call
 * where nobody is sharing still looks like a room with people in it rather
 * than an empty box with a mute button.
 */
export function Stage({ world, call, controls, name, master, onClose }: {
  world: World
  call: Call
  controls: CallControls
  name: string
  /** The master volume, for what a tile's own slider starts at. */
  master: number
  onClose: () => void
}) {
  const me = world.me.id
  /* Whether the word under each face is allowed to change while nobody is
     looking at the window. */
  const watching = useWatching()
  /* Which server's room this is, resolved once for every name below.
     Null for a conversation's call, where nobody has been renamed. */
  const here = spaceOfChannel(world, call.channel)
  /* One tile's options at a time, and it knows which tile. */
  const [menu, setMenu] = useState<StreamKey | null>(null)
  /* Where the arrow beside Sharing put its menu, or nothing while it is shut. */
  const [shareMenu, setShareMenu] = useState<{ x: number; y: number } | null>(null)
  /* The one filling the call, or none. A tile in a grid of four is a
     thumbnail of somebody's monitor: fine for knowing they are sharing, no
     use at all for reading anything on it. */
  const [big, setBig] = useState<StreamKey | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const tiles = tilesOf(call, me)
  /*
   * What is actually filling the call, which is not always what was asked to.
   *
   * `big` is a key, and a key outlives the thing it names: somebody stops
   * sharing and their tile leaves the grid while this still points at it.
   * The stylesheet then hides every cell and shows the expanded one - and
   * there is no expanded one - so the whole stage went blank, with everybody
   * in the call still there and nothing on screen. Reported exactly that way,
   * from full screen.
   *
   * Read through rather than trusted, so the drawing can never disagree with
   * what is in the room; the state is put straight below.
   */
  const filling = big !== null && tiles.includes(big) ? big : null
  /*
   * And the state put straight, not only the drawing.
   *
   * Without this it would come back on its own: the key is still held, so the
   * moment that person shares again their tile would fill the call, which
   * nobody asked for a second time.
   *
   * Depends on one plain string rather than the array, because tilesOf builds
   * a new array every render - and the keys are joined with a character that
   * cannot appear in one.
   */
  const tileList = tiles.join('|')
  useEffect(() => {
    const there = tileList.split('|')
    setBig((was) => (was !== null && !there.includes(was) ? null : was))
  }, [tileList])
  const facesOnly = call.members.filter(
    (m) => !tiles.some((k) => partsOf(k).id === m.id),
  )
  const theirShares = call.members.filter((m) => m.sharing && m.id !== me)
  const unwatched = theirShares.filter((m) => !call.watching.has(keyOf('share', m.id)))

  return (
    <div className="pane stagepane">
      <div className="sthead">
        <button className="icb" onClick={onClose} title="Back to chat">
          <Icon name="dn" size={18} />
        </button>
        <span className="tt t" style={{ fontSize: '1.15em' }}>{name}</span>
        <span className="live">
          <i />
          {call.members.length} connected
          {theirShares.length > 0 && ` · ${theirShares.length} sharing`}
        </span>
        <span className="gw" />
        {/*
          * Who is watching the screen filling the stage.
          *
          * Up here only while one is expanded: with a grid of tiles each one
          * carries its own faces, and a set in the header could only be
          * about one of them without saying which.
          */}
        {filling && (
          <Spectators people={watchersOf(world, filling, me)} size="sm"
            nameFor={(u) => nameIn(world, here, u)} />
        )}
        {/* Only worth offering when there is more than one to decide about —
            with a single share, the tile's own control says the same thing. */}
        {theirShares.length > 1 && (
          <button
            className="bdg"
            onClick={() => {
              const watchAll = unwatched.length > 0
              for (const m of theirShares) {
                controls.setWatching(keyOf('share', m.id), watchAll)
              }
            }}
          >
            {unwatched.length > 0 ? 'Watch all' : 'Stop watching all'}
          </button>
        )}
        <button className="icb" onClick={onClose} aria-label="Close">
          <Icon name="x" size={17} />
        </button>
      </div>

      <div
        ref={body}
        className={
          filling ? 'stbody big'
            : tiles.length === 1 && call.members.length <= 2 ? 'stbody one' : 'stbody'
        }
      >
        {tiles.map((key) => (
          <Tile
            key={key}
            streamKey={key}
            call={call}
            world={world}
            me={me}
            up={filling === key}
            onGrow={() => setBig(filling === key ? null : key)}
            onWatch={(on) => controls.setWatching(key, on)}
            onOptions={() => setMenu(key)}
          />
        ))}
        {facesOnly.map((m) => {
          const person = world.people.get(m.id) ?? fallback(m.id, m.name)
          const loud = call.speaking.has(m.id)
          /* Talking, and allowed to say so in a way that costs a repaint -
             see the rows in the sidebar. The ring is not asked. */
          const says = loud && watching
          return (
            <div
              className={says ? 'scell talking' : 'scell'}
              key={m.id}
              /*
               * Right-click a face for the same menu a picture gets, which
               * for somebody with no camera is where their volume lives. A
               * tile with nothing to click was the only place in a call
               * without a way in, and one friend being twice as loud as
               * everybody else is the ordinary case.
               */
              onContextMenu={(e) => {
                if (m.id === me) return
                e.preventDefault()
                setMenu(keyOf('voice', m.id))
              }}
            >
              <div className="face">
                <span className={loud ? 'ring on' : 'ring'}>
                  <Avatar user={person} size="xl" />
                </span>
                <span className="nm2">{nameIn(world, here, person)}</span>
                <span className="sub">
                  {/* Held still while nobody is looking, like the rows in the
                      sidebar - the ring is what carries on saying who is
                      talking. */}
                  {voiceLabel({
                    mine: m.id === me, deaf: call.deaf, muted: m.muted, loud: says,
                  })}
                </span>
              </div>
              <span className="nmchip">
                {m.muted && <Icon name="micoff" size={11} />}
                {nameIn(world, here, person)}
              </span>
            </div>
          )
        })}
        {call.members.length === 0 && (
          <div className="empty2">Connecting…</div>
        )}

        {shareMenu && (
          <Menu
            x={shareMenu.x}
            y={shareMenu.y}
            items={[
              /* The sound first, because it is the one people reach for while
                 a share is running - and only where there is one to turn off.
                 A share started without sound never captured any, and an entry
                 that cannot do what it says is worse than no entry. */
              ...(call.shareAudio.has ? [{
                kind: 'item' as const,
                label: call.shareAudio.on ? 'Mute the shared sound' : 'Share the sound too',
                icon: call.shareAudio.on ? ('voloff' as const) : ('vol' as const),
                onPick: () => controls.setShareAudio(!call.shareAudio.on),
              }, { kind: 'rule' as const }] : []),
              ...SHARE_PRESETS.map((x): MenuItem => ({
                kind: 'item',
                label: `${qualityLabel(x)} — ${x.name}`,
                /* Spread rather than set to undefined: an optional property
                   that is present and empty is refused here. */
                ...(x.id === controls.quality.id ? { icon: 'check' as const } : {}),
                onPick: () => controls.setShareQuality(x),
              })),
            ]}
            onClose={() => setShareMenu(null)}
          />
        )}

        {menu && (
          <TileMenu
            streamKey={menu}
            call={call}
            me={me}
            master={master}
            label={nameOf(world, call, partsOf(menu).id)}
            onClose={() => setMenu(null)}
            onVolume={(level) => controls.setLevel(menu, level)}
            onQuality={(preset) => controls.setShareQuality(preset)}
            quality={controls.quality}
            onWatch={(on) => controls.setWatching(menu, on)}
            onFull={() => void videoFor(body.current, menu)?.requestFullscreen?.()
              .catch(() => { /* refused, or already somewhere else */ })}
            onPopOut={() => void videoFor(body.current, menu)
              ?.requestPictureInPicture?.()
              .catch(() => { /* no window to put it in, which is not an error */ })}
          />
        )}
      </div>

      <div className="stctl">
        <button
          className={call.muted ? 'cbtn off' : 'cbtn'}
          onClick={() => controls.setMuted(!call.muted)}
        >
          <Icon name={call.muted ? 'micoff' : 'mic'} size={18} />
          {call.muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className={call.deaf ? 'cbtn off' : 'cbtn'}
          onClick={() => controls.setDeaf(!call.deaf)}
        >
          <Icon name={call.deaf ? 'headoff' : 'head'} size={18} />
          {call.deaf ? 'Undeafen' : 'Deafen'}
        </button>
        <button
          className={mine(call, 'cam', me) ? 'cbtn on' : 'cbtn'}
          onClick={() => controls.setCam(!mine(call, 'cam', me))}
        >
          <Icon name={mine(call, 'cam', me) ? 'cam' : 'camoff'} size={18} />
          {mine(call, 'cam', me) ? 'Camera on' : 'Camera'}
        </button>
        {/*
          * The share button, and what to do about the share.
          *
          * Everything about a running share lives behind the arrow beside it:
          * the sound, and what it is being sent at. The sound used to be a
          * button of its own out here, and the quality could only be reached
          * from a menu on the tile - so the one control people wanted mid-
          * share was the one that was not next to the share button.
          */}
        <span className="cbtnpair">
          <button
            className={mine(call, 'share', me) ? 'cbtn on' : 'cbtn'}
            onClick={() => controls.setShare(!mine(call, 'share', me), true)}
          >
            <Icon name="share" size={18} />
            {mine(call, 'share', me) ? 'Sharing' : 'Share screen'}
          </button>
          {mine(call, 'share', me) && (
            <button
              className="cbtn cbtnmore"
              aria-label="What to send, and the sound with it"
              title="What to send, and the sound with it"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setShareMenu({ x: r.left, y: r.top })
              }}
            >
              <Icon name="chev" size={16} />
            </button>
          )}
        </span>
        <button className="cbtn lv" onClick={() => void controls.leave()}>
          <Icon name="x" size={18} />Leave
        </button>
      </div>
    </div>
  )
}

/** Whether one of my own sources is going, read off the roster. */
const mine = (call: Call, what: 'cam' | 'share', me: Id): boolean => {
  const row = call.members.find((m) => m.id === me)
  return what === 'cam' ? !!row?.cam : !!row?.sharing
}

function Tile({ streamKey, call, world, me, onWatch, onOptions, up, onGrow }: {
  streamKey: StreamKey
  call: Call
  world: World
  me: Id
  onWatch: (on: boolean) => void
  onOptions: () => void
  /** Whether this is the one filling the call. */
  up?: boolean
  onGrow?: () => void
}) {
  const el = useRef<HTMLVideoElement>(null)
  const stream = call.video.get(streamKey)
  const { source, id } = partsOf(streamKey)
  const who = world.people.get(id)
  const row = call.members.find((m) => m.id === id)
  const label = (who ? nameIn(world, spaceOfChannel(world, call.channel), who) : null)
    ?? row?.name ?? 'Someone'
  const mine = id === me
  const asked = watched(call, streamKey, me)

  /*
   * Your own picture stops while you are looking elsewhere.
   *
   * A share is already being drawn by the thing you are sharing; decoding it
   * again to show you a picture of your own screen, in a window you are not
   * looking at, is the machine doing the same work twice for nobody. Other
   * people's keep playing — they are why the call exists, and pausing them
   * would be pausing the thing somebody tabbed away to listen to.
   *
   * pause() rather than unmounting: the last frame stays, so the tile still
   * shows what you are sharing instead of going black.
   */
  /* Everybody who has asked for this stream, as people rather than ids. */
  const watchers = watchersOf(world, streamKey, me)

  const canGrow = !!onGrow && asked && !!stream
  const [looking, setLooking] = useState(isWatching)
  useEffect(() => onAttentionChange(setLooking), [])
  useEffect(() => {
    const v = el.current
    if (!v) return
    /* Re-applied when the stream changes, because attaching a new one starts
       it playing and would quietly undo this. */
    if (mine && !looking) v.pause()
    else void v.play().catch(() => { /* not attached yet, or refused */ })
  }, [mine, looking, stream])

  /* Assigned rather than set as an attribute, and only when it changes —
     writing the same stream again restarts it, which shows as a black frame
     every time anything else on the stage re-renders. */
  useEffect(() => {
    const v = el.current
    if (v && stream && v.srcObject !== stream) v.srcObject = stream
  }, [stream])

  return (
    <div
      className={[
        'scell',
        asked ? 'live' : '',
        /* Only something with a picture in it is worth filling the call
           with — an avatar at full height is a very large circle. */
        canGrow ? 'can-grow' : '',
        up ? 'up' : '',
      ].filter(Boolean).join(' ')}
      data-tile={streamKey}
      /* Pressed to fill the call, pressed again to go back to everyone.
         Not on the buttons inside it, which have their own jobs. */
      onClick={(e) => {
        if (!canGrow) return
        if ((e.target as Element).closest('button')) return
        onGrow?.()
      }}
      title={canGrow ? (up ? 'Back to everyone' : 'Fill the call with this') : undefined}
      /* The same panel a right-click opens, because that is where anybody
         looks for options on a thing. */
      onContextMenu={(e) => { e.preventDefault(); onOptions() }}
    >
      {asked && stream && (
        <video
          ref={el}
          autoPlay
          playsInline
          /* Muted deliberately: a share's sound comes out of its own element,
             which lives outside the stage so that closing the stage does not
             take the sound with it. A tile playing its own would play it
             twice, a fraction apart. */
          muted
        />
      )}

      {/*
        * Said, rather than left to look like a stall.
        *
        * Only ever your own: a frozen picture with no explanation is
        * indistinguishable from a share that has died, and the person most
        * likely to worry about that is the one sharing it. Everybody else is
        * still watching it move.
        */}
      {mine && !looking && asked && stream && (
        <div className="paused">
          {/* The reassurance first. What somebody seeing a frozen picture of
              their own screen wants to know is whether the people watching
              are still seeing it, and they are. */}
          <strong>Your stream is still running</strong>
          <span>The preview is paused while you are looking elsewhere.</span>
        </div>
      )}

      {asked && !stream && (
        <div className="face">
          <Avatar user={who ?? fallback(id, label)} size="xl" />
          <span className="nm2">Connecting…</span>
        </div>
      )}

      {/* Not asked for, and so not being sent. The tile is here to be asked
          *from* — drawn only once a stream had arrived, there would be
          nothing on screen to press, and a share would look like something
          that had not happened. */}
      {!asked && (
        <div className="face">
          <Avatar user={who ?? fallback(id, label)} size="xl" />
          <span className="nm2">
            {label} is {source === 'share' ? 'sharing' : 'on camera'}
          </span>
          <span className="sub">
            Nothing is sent until you ask for it — every viewer costs them upload.
          </span>
          <button className="watch" onClick={() => onWatch(true)}>
            Watch {label}
          </button>
        </div>
      )}

      <span className="nmchip">
        <Icon name={source === 'share' ? 'share' : 'cam'} size={12} />
        {mine
          ? (source === 'share' ? 'Your screen' : 'Your camera')
          : source === 'share' ? `${label}'s screen` : label}
      </span>

      {/*
        * The things you can do to a screen, on the screen.
        *
        * They were behind a three-dot button, so every one of them cost a
        * press to find out what was in there. These appear under the pointer
        * and go away again, which is where somebody's hand already is — and
        * the panel is still there on a right-click for everything that does
        * not earn a place here.
        */}
      {asked && stream && (
        <span className="hov">
          {onGrow && (
            <button className="hovb" title={up ? 'Back to everyone' : 'Fill the call'}
              aria-label={up ? 'Back to everyone' : 'Fill the call'}
              onClick={onGrow}>
              <Icon name={up ? 'shrink' : 'grow'} size={16} />
            </button>
          )}
          <button className="hovb" title="Full screen" aria-label="Full screen"
            onClick={() => void el.current?.requestFullscreen?.()}>
            <Icon name="full" size={16} />
          </button>
          {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
            <button className="hovb" title="Pop out" aria-label="Pop out"
              onClick={() => void el.current?.requestPictureInPicture?.().catch(() => {})}>
              <Icon name="pip" size={16} />
            </button>
          )}
          {!mine && (
            <button className="hovb" title="Stop watching" aria-label="Stop watching"
              onClick={() => onWatch(false)}>
              <Icon name="eyeoff" size={16} />
            </button>
          )}
          <button className="hovb" title="More" aria-label="More" onClick={onOptions}>
            <Icon name="dots" size={16} />
          </button>
        </span>
      )}

      {asked && !mine && !stream && (
        <span className="tl">
          <button className="bdg" onClick={() => onWatch(false)}>Stop watching</button>
        </span>
      )}

      {/* Always drawn, and hidden by the stylesheet wherever the hover bar
          has taken over — so a touch screen, which has no hover to reveal
          anything, keeps the one way in it has ever had. */}
      {/*
        * Who is looking at this.
        *
        * Always there, not only on hover: it is the answer to "is anybody
        * watching", which is what somebody sharing wants to know without
        * having to go and ask for it. Yourself excluded — you know.
        */}
      <Spectators people={watchers}
        nameFor={(u) => nameIn(world, spaceOfChannel(world, call.channel), u)} />

      <span className="tr">
        <button
          className="bdg dots3"
          onClick={onOptions}
          title={`Options for ${mine ? 'your ' : `${label}'s `}${
            source === 'share' ? 'screen' : 'camera'}`}
        >
          ⋯
        </button>
      </span>
    </div>
  )
}

/** The <video> a tile is drawing, for the things only an element can do. */
function videoFor(root: HTMLElement | null, key: StreamKey): HTMLVideoElement | null {
  return root?.querySelector<HTMLVideoElement>(
    `[data-tile="${CSS.escape(key)}"] video`) ?? null
}

/**
 * What to call somebody, whether or not the app has heard of them.
 *
 * In the server whose room this is - a voice tile sits beside a member list
 * that has been showing the nickname since nicknames became per server, and
 * the same person under two names on one screen reads as two people. Null
 * for a conversation's call, which is nobody's server.
 */
function nameOf(world: World, call: Call, id: Id): string {
  const person = world.people.get(id)
  if (person) return nameIn(world, spaceOfChannel(world, call.channel), person)
  return call.members.find((m) => m.id === id)?.name ?? 'Someone'
}

/** Somebody in the call the app has not otherwise heard of. */
const fallback = (id: Id, name: string) => ({
  id, username: name, discriminator: '0000', verified: 0, display_name: name,
  bio: '', accent: '', accent_2: '', name_font: 'default',
  name_effect: 'none', avatar_path: null, banner_path: null,
  status_text: '', presence: 'online' as const, created_at: 0,
})
