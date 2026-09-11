import { Fragment, useMemo, useState } from 'react'
import { actionsFor } from '../lib/actions'
import { joinsRun } from '../lib/messageRun'
import { BY_NAME } from '../lib/emoji'
import { Embeds } from './Embed'
import { CallRow } from './CallRow'
import { PollCard } from './PollCard'
import { Attachment } from './Attachment'
import { MessageEditor } from './MessageEditor'
import { Lightbox } from './Lightbox'
import { isJumbo, oneLine, type RenderOptions } from '../lib/markdown'
import { nameLook } from '../lib/nameStyle'
import { nameIn } from '../lib/names'
import { nameColourFrom, rolesOf } from '../lib/roles'
import type { Message, Space, User } from '../lib/wire'
import type { World } from '../lib/world'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { InviteCard } from './InviteCard'
import { firstInvite } from '../lib/invites'
import { useLongPress } from './useLongPress'

/**
 * The conversation.
 *
 * Two things here are spacing rather than logic, and both were reported three
 * times before they were understood. A message body is `white-space:
 * pre-wrap`, which means the whitespace in the *markup* is content — so the
 * old renderer, which put a newline between the text and the "(edited)"
 * marker for readability, gave every message in the app a blank line on the
 * end of it. In JSX there is no markup to indent, so the whole class is gone.
 *
 * And a run of messages from one person is one block: the second and later
 * ones carry no avatar and no name, only a time that appears on hover. A list
 * that repeats somebody's name six times is a list about the names.
 */

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const fullWhen = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

const dayName = (at: number) => {
  const d = new Date(at)
  const today = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/** What a name says on a message. The same in the header and in a quote —
 *  two ways of writing it is two names for one person in one list. */
/* What somebody is called HERE, which now needs to know where here is: a
   nickname belongs to one server, so the same person signs their messages
   differently in two of them and with their own name in a conversation. The
   member list and the @ menu resolve it the same way, through nameIn — a
   message signed differently from the list beside it reads as two people. */
const label = (world: World, space: Space | null, u: User) =>
  nameIn(world, space?.id ?? null, u)

/** A person, or somebody the app has not heard of — which is not an error. */
function whoOf(world: World, id: string): User {
  return world.people.get(id) ?? {
    id, username: 'someone', discriminator: '0000', verified: 0,
    display_name: 'Someone', bio: '', accent: '', accent_2: '',
    name_font: 'default', name_effect: 'none', avatar_path: null,
    banner_path: null, status_text: '', presence: 'offline',
    created_at: 0,
  }
}

/**
 * Everything the renderer needs to draw a message as it was meant.
 *
 * Out here rather than inside the conversation because the pinned panel draws
 * messages too, and drew them without any of this - so a mention in a pinned
 * message was the raw `<@id>` it is stored as. One copy, so the two cannot
 * disagree about what somebody is called.
 */
/**
 * How long away counts as having missed something.
 *
 * Long enough that changing channel and coming straight back says nothing,
 * short enough that a coffee counts. Nothing hangs on the exact number - it
 * only decides whether a line is drawn.
 */
export const AWHILE = 10 * 60 * 1000

export function renderOptions(
  world: World, space: Space | null, shortcodes: boolean,
): RenderOptions {
    const names = new Set<string>()
    /* Both ways round. By id is how a mention is written now, and is what
       survives a rename; by name is how every message written before that
       reads, and is what makes those clickable too. */
    const nameById = new Map<string, string>()
    const idByName = new Map<string, string>()
    for (const u of world.people.values()) {
      const n = u.display_name || u.username
      if (n) {
        names.add(n)
        nameById.set(u.id, n)
        idByName.set(n.toLowerCase(), u.id)
      }
      /* Their handle answers as well, which is the one thing about somebody
         that does not change. */
      if (u.username) idByName.set(u.username.toLowerCase(), u.id)
    }
    /* The table, without which `shortcodes` was a setting that did nothing:
       the renderer has always known how to swap `:fire:` for the glyph and
       was never handed anything to swap it for. */
    /* The roles of this server, so a role named in a message is drawn as
       that role rather than as the id it is stored by. */
    const roleById = new Map<string, { name: string; colour: string }>()
    for (const r of world.roles) {
      if (space && r.space_id !== space.id) continue
      roleById.set(r.id, { name: r.name, colour: r.colour })
    }
    /* And which of them are yours, so one naming you lights up like your own
       name does. */
    const myRoles = new Set(
      world.assignments
        .filter((a) => a.user_id === world.me.id)
        .map((a) => a.role_id),
    )

    return {
      names, nameById, idByName, roleById, myRoles,
      me: world.me.display_name || world.me.username,
      meId: world.me.id,
      shortcodes, emoji: BY_NAME,
    }
}

export function Messages({
  world, space, messages, jumbo = true, shortcodes = true, permissions = [],
  server, previews = true,
  onMenu, onWho, onReact, onPickReaction, onReply, onEdit, onPin, onPins, onDelete, onGoto,
  unreadFrom,
  onJoinCall, onVote, editingId = null, onSaveEdit, onCancelEdit,
}: {
  world: World
  space: Space | null
  messages: Message[]
  jumbo?: boolean
  shortcodes?: boolean
  /** What the server said you may do here. It decides what is offered, never
   *  what is allowed — the server settles that, and this only avoids putting
   *  a refusal in front of somebody. */
  permissions?: readonly string[]
  /** For link previews, which are fetched. Without one, none are drawn. */
  server?: import('../lib/api').Api
  /** Somebody who does not want them gets none, and none are asked for. */
  previews?: boolean
  onMenu?: (m: Message, actions: string[], x: number, y: number) => void
  /** Open the pinned messages, from the line saying there is one. */
  onPins?: () => void
  /**
   * How many messages were waiting when this conversation was opened.
   *
   * A line goes above the first of them saying so. A count rather than a
   * time: the server works the badge out from when the channel was last
   * read and sends the number, and the number is the same fact without a
   * clock in it - the client is told "three waiting" and can put the line
   * three from the end, whatever the timestamps say.
   *
   * Held still while the channel is open. It marks where you came in, not
   * where you have got to, so it does not creep down the screen as the app
   * marks things read behind you.
   */
  unreadFrom?: number | null
  onWho?: (id: string, el: Element) => void
  /** Adding one, and taking one back — the same frame does both, because the
   *  server toggles. Pressing a pill you are already in removes you. */
  onReact?: (m: Message, emoji: string) => void
  /** Browse them all, anchored to whatever was pressed. */
  onPickReaction?: (m: Message, el: Element) => void
  onReply?: (m: Message) => void
  onEdit?: (m: Message) => void
  onPin?: (m: Message, pinned: boolean) => void
  onDelete?: (m: Message) => void
  /** Somebody pressed the quoted line above a reply, asking to see what it
   *  was a reply to. */
  onGoto?: (id: string) => void
  /** Walk into the call this conversation still has open, if it has one. */
  onJoinCall?: (channelId: string) => void
  /** Which message is being rewritten, and where that happens. */
  /** Answering a poll: the whole answer, not one option toggled. */
  onVote?: (messageId: string, picked: number[]) => void
  editingId?: string | null
  onSaveEdit?: (id: string, body: string) => void
  onCancelEdit?: () => void
}) {
  /**
   * Every name that can be mentioned right now, so @someone only lights up
   * when there really is a someone.
   */
  const options = useMemo(
    () => renderOptions(world, space, shortcodes),
    [world, space, shortcodes],
  )

  /* Whichever picture is being looked at, or none.
     Above the early return, and every other hook must stay above it too: a
     render that takes that branch runs one hook fewer than the render before
     it, which React answers by throwing — and a throw during render with
     nothing to catch it is the whole app going blank. It did, on changing to
     a server whose messages had not arrived yet. */
  const [big, setBig] = useState<{ src: string; alt: string } | null>(null)
  /*
   * Blocked messages somebody has chosen to look at anyway.
   *
   * Per message and only for as long as this list is drawn - reading one
   * is not a decision to stop blocking them, and it should not quietly
   * become one. Above the early return, like every other hook here: a
   * render that takes that branch running one hook fewer is the whole app
   * going blank.
   */
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())

  if (!messages.length) {
    /*
     * Nothing at all. The opener above says whose conversation this is and
     * that it is the beginning of one — saying "nothing here yet" underneath
     * that is the same fact twice, in a duller voice, and it is what every
     * empty conversation showed.
     */
    return null
  }

  const who_ = { id: world.me.id, permissions }

  /* What each reply is a reply *to*, by id. Built once for the whole list
     rather than searched per message: a channel holding a few hundred
     messages where most of them are replies is that search a few hundred
     times, on every single render. */
  const byId = new Map(messages.map((m) => [m.id, m]))
  /* The whole message rather than just who wrote it, because how long ago it
     was said is now part of whether the next one joins it. */
  let prev: Message | null = null
  let prevDay = ''

  /*
   * The first one you have not read, and how many follow it.
   *
   * Worked out from the whole list rather than as it is drawn, because the
   * line has to know its own count before the message it sits above is
   * reached. A system row is not something anybody wrote, so it does not
   * count as a message to have missed.
   */
  const said = messages.filter((m) => m.kind !== 'pin' && m.kind !== 'call')
  const missed = said.slice(said.length - Math.min(unreadFrom ?? 0, said.length))
  /*
   * Your own messages are not something you missed.
   *
   * They are counted as unread by the server whenever they were sent from
   * somewhere else - another device, or this one before a reload - so a line
   * saying "1 new message" appeared above something you had just typed.
   */
  const fromOthers = missed.filter((m) => m.author_id !== world.me.id)
  /*
   * And nothing arriving while you were sitting here counts either.
   *
   * The line is for finding your place again after being away. Stepping into
   * another channel for a moment and coming back put a line above the one
   * message that had arrived meanwhile, which is noise about something you
   * had not missed at all. Measured from the oldest one you have not read:
   * that is as close as the client can get to how long you were gone without
   * the server keeping track of it.
   */
  const gap = fromOthers[0] ? Date.now() - fromOthers[0].created_at : 0
  /*
   * And only when the start of the run is actually on screen.
   *
   * The list drawn is the end of the channel, not all of it, so a run of
   * unread longer than the window begins above the first message here. The
   * line would then sit at the top of what is drawn saying a number that is
   * whatever happened to fit, which is worse than not drawing it: it is a
   * count nobody can check, in a place that is not where they left off. It
   * appears as the window grows into it.
   */
  const wholeRun = missed.length < said.length
  const worth = wholeRun && fromOthers.length > 0 && gap >= AWHILE
  const newCount = worth ? fromOthers.length : 0
  const firstUnread = worth ? fromOthers[0]!.id : null

  return (
    <>
      {messages.map((m) => {
        const who = whoOf(world, m.author_id)

        /*
         * Somebody this account has blocked.
         *
         * Hidden here rather than refused by the server, because a channel in
         * a shared server is other people's as well: one reader deciding they
         * do not want to hear from somebody is not a veto on what everybody
         * else can see, and it is not a reason to stop the message being
         * written down. A conversation between two people is the opposite
         * case and is refused outright, so nothing blocked ever reaches a DM.
         *
         * A line rather than nothing at all. A message that simply vanishes
         * takes the shape of the conversation with it - replies to it, and
         * the answers around it, stop making sense - and leaves no way back
         * to it for somebody who wants to see what was said. Discord settled
         * on the same answer for the same reason.
         */
        if (world.blocked.has(m.author_id) && !shown.has(m.id)) {
          return (
            <div className="sys-row" key={m.id}>
              <Icon name="ban" size={13} />
              <span>Blocked message</span>
              <button
                className="sys-link"
                onClick={() => setShown((was) => new Set(was).add(m.id))}
              >
                Show
              </button>
            </div>
          )
        }

        /*
         * A call is not something somebody said.
         *
         * The server has written these rows all along and this drew them as
         * ordinary messages — which, with an empty body, is a blank line where
         * a call should be. Its own shape, and its own words.
         */
        if (m.kind === 'call') {
          return (
            <CallRow
              key={m.id}
              message={m}
              author={world.people.get(m.author_id)}
              me={world.me}
              canJoin={!m.call_ended_at && !!onJoinCall}
              {...(onJoinCall ? { onJoin: () => onJoinCall(m.channel_id) } : {})}
            />
          )
        }

        /*
         * And a pin is not something somebody said either.
         *
         * The same shape as a call, and missed when calls were given theirs:
         * the server writes a row with an empty body to announce that
         * somebody pinned something, and drawn as an ordinary message that
         * is a blank line with a name over it. Pinning is worth saying out
         * loud - a pinned message is one nobody has a reason to open - so it
         * is said where the conversation is, quietly, in its own shape.
         */
        if (m.kind === 'pin') {
          const by = world.people.get(m.author_id)
          return (
            <div
              className="sys-row"
              key={m.id}
              /*
               * And it can be tidied away.
               *
               * Only the delete: there is nothing to reply to, react to or
               * pin about a line the app wrote, and the permission that
               * allows pinning is the one the server accepts for clearing
               * these up. Offering the rest would be five items where one
               * is meant.
               */
              onContextMenu={(e) => { e.preventDefault(); onMenu?.(m, ['delete'], e.clientX, e.clientY) }}
            >
              <Icon name="pin" size={13} />
              <span>
                <b>{by ? label(world, space, by) : 'Somebody'}</b>
                {' pinned a message.'}
              </span>
              {/* The way to what was pinned, on the line that says something
                  was. A pinned message is one nobody has a reason to open,
                  which is the whole reason this line exists. */}
              {onPins && (
                <button className="sys-link" onClick={onPins}>See pins</button>
              )}
            </div>
          )
        }

        const day = dayName(m.created_at)
        const newDay = day !== prevDay
        if (newDay) prevDay = day

        /* A run is broken by a new day, by a reply, and by a long enough
           quiet - all three being reasons to see who is speaking, and when.
           The rule is in messageRun.ts, where it can be tested at a chosen
           moment rather than whenever the suite happens to run. */
        const run = joinsRun(prev, m, newDay)
        prev = m

        const theirRoles = space
          ? rolesOf(who.id, space, world.roles, world.assignments)
          : []
        const roleColour = nameColourFrom(theirRoles)
        /* The role colour goes IN rather than being painted over the top: an
           effect paints from --name-colour, so a gradient on somebody whose
           only colour comes from a role was a gradient from var(--fg) to
           var(--fg) — transparent letters over the text colour, which is
           exactly what no effect looks like. */
        const look = nameLook(who, roleColour ?? undefined)
        const big = jumbo && isJumbo(m.body)

        const actions = actionsFor(m, who_)
        const can = {
          react: actions.includes('react'),
          reply: actions.includes('reply'),
          edit: actions.includes('edit'),
          pin: actions.includes('pin'),
          delete: actions.includes('delete'),
        }
        const open = (x: number, y: number) => onMenu?.(m, actions, x, y)
        const to = m.reply_to ? byId.get(m.reply_to) : undefined
        const pinned = !!m.pinned_at

        return (
          <Fragment key={m.id}>
            {/* Where you got up to. Above the first one you have not read,
                and above the day it falls on, because the day is a heading
                for what comes after it. */}
            {firstUnread === m.id ? (
              /*
               * One rule, not two.
               *
               * Where somebody got up to and which day it is are both
               * headings for the same message, and drawing them as separate
               * lines reads as two things having happened. So when the
               * boundary falls on a new day the date is the label in the
               * middle of this one, and the day below is left out.
               *
               * The badge on the end is what says which line this is. The
               * middle otherwise carries the count, which the badge does not
               * and which is worth keeping.
               */
              <div className="unread-line">
                <span>{newDay
                  ? day
                  : newCount === 1 ? '1 new message' : `${newCount} new messages`}</span>
                <i className="urule" />
                <b className="upill">New</b>
              </div>
            ) : newDay ? <div className="day">{day}</div> : null}
            <Row
              m={m}
              run={run}
              onOpen={open}
            >
              {m.reply_to && (
                /* What they were answering, above what they said. Without it a
                   reply is a sentence with no question in front of it, and the
                   run is broken for a reason nobody on screen can see. */
                <button
                  className="reply-to"
                  onClick={() => onGoto?.(m.reply_to!)}
                  title={to ? 'Go to that message' : undefined}
                  disabled={!to}
                >
                  <Icon name="reply" size={12} />
                  <b>{label(world, space, whoOf(world, to?.author_id ?? ''))}</b>
                  <span>
                    {/* Not drawn as markdown: a quote is one line, and a code
                        block or a picture in it is the reply's own body all
                        over again in miniature.
                        And not at all when it quotes somebody blocked - their
                        message is collapsed where it was said, and a reply to
                        it was carrying the words straight back onto the screen
                        one line further down. */}
                    {to && world.blocked.has(to.author_id)
                      ? 'a blocked message'
                      : to ? oneLine(to.body) || 'a picture' : 'a message from further up'}
                  </span>
                </button>
              )}

              {run ? (
                <span className="ava">
                  <span className="hat" title={fullWhen(m.created_at)}>
                    {clock(m.created_at)}
                  </span>
                </span>
              ) : (
                <button className="ava" onClick={(e) => onWho?.(who.id, e.currentTarget)}>
                  <Avatar user={who} />
                </button>
              )}

              <div className="mbody">
                {!run && (
                  <div className="mh">
                    <button
                      className={`nm ${look.className}`}
                      style={look.style}
                      onClick={(e) => onWho?.(who.id, e.currentTarget)}
                    >
                      {label(world, space, who)}
                    </button>
                    <span className="at" title={fullWhen(m.created_at)}>
                      {clock(m.created_at)}
                    </span>
                  </div>
                )}

                {/* Being edited: the box goes where the words were, so the
                    sentence somebody is changing is the one they are looking
                    at. It used to be in the composer, a screen away. */}
                {editingId === m.id && onSaveEdit && onCancelEdit ? (
                  <MessageEditor
                    body={m.body}
                    onSave={(body) => onSaveEdit(m.id, body)}
                    onCancel={onCancelEdit}
                  />
                ) : m.poll ? (
                  /* A poll is drawn instead of the words, because it has
                     none — the question is inside the card. */
                  <PollCard
                    poll={m.poll}
                    asked={label(world, space, who)}
                    {...(onVote ? { onVote: (picked: number[]) => onVote(m.id, picked) } : {})}
                  />
                ) : (
                <div className={big ? 'bd jumbo' : 'bd'}>
                  <Markdown text={m.body} options={options} onWho={onWho} />
                  {m.edited_at && <span className="edited">(edited)</span>}
                </div>
                )}

                {/* What the links in it turn out to be — a picture as
                    itself, anything else as a card once the server has had a
                    look. Drawn after the words, because they are about the
                    message rather than part of it. */}
                {server && (
                  <Embeds server={server} body={m.body} on={previews} />
                )}

                {/* And an invite as something to press rather than a code to
                    copy out and type into a box somewhere else. One per
                    message, like the link card: somebody who pastes six
                    invites should not turn a message into six cards. */}
                {server && firstInvite(m.body) && (
                  <InviteCard server={server} code={firstInvite(m.body)!} />
                )}

                {/* As what it is. Everything was an <img> whatever it was,
                    so a video arrived as a broken image with its filename
                    beside it - and the mime type had been on the wire all
                    along with nothing reading it. */}
                {m.attachments.map((a) => (
                  <Attachment key={a.id} a={a}
                    onOpen={(src, alt) => setBig({ src, alt })} />
                ))}

                {m.reactions.length > 0 && (
                  <div className="rcs">
                    {m.reactions.map((r) => (
                      <button
                        className={r.me ? 'rc mine' : 'rc'}
                        key={r.emoji}
                        disabled={!can.react}
                        title={r.me ? `Take back ${r.emoji}` : `React ${r.emoji}`}
                        onClick={() => onReact?.(m, r.emoji)}
                      >
                        {r.emoji} <span>{r.count}</span>
                      </button>
                    ))}
                    {can.react && (
                      <button
                        className="rc add"
                        aria-label="React"
                        onClick={(e) => onPickReaction?.(m, e.currentTarget)}
                      >
                        <Icon name="smile" size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <span className="tools">
                {can.react && (
                  <button title="React" aria-label="React"
                    onClick={(e) => onPickReaction?.(m, e.currentTarget)}>
                    <Icon name="smile" size={15} />
                  </button>
                )}
                {can.reply && (
                  <button title="Reply" aria-label="Reply" onClick={() => onReply?.(m)}>
                    <Icon name="reply" size={15} />
                  </button>
                )}
                {can.edit && (
                  <button title="Edit" aria-label="Edit" onClick={() => onEdit?.(m)}>
                    <Icon name="pencil" size={15} />
                  </button>
                )}
                {can.pin && (
                  <button
                    className={pinned ? 'on' : ''}
                    title={pinned ? 'Unpin' : 'Pin'}
                    aria-label={pinned ? 'Unpin' : 'Pin'}
                    onClick={() => onPin?.(m, !pinned)}
                  >
                    <Icon name="pin" size={15} />
                  </button>
                )}
                {can.delete && (
                  <button title="Delete" aria-label="Delete" onClick={() => onDelete?.(m)}>
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </span>
            </Row>
          </Fragment>
        )
      })}
      {big && (
        <Lightbox src={big.src} alt={big.alt} onClose={() => setBig(null)} />
      )}
    </>
  )
}

/**
 * One message's row, and the two ways to ask it for a menu.
 *
 * A right-click, and a long press — which is what a right-click is on a
 * phone. Bound to `contextmenu` alone, every action on a message was absent
 * on a phone: replying, editing, deleting, pinning, all of it.
 */
function Row({ m, run, onOpen, children }: {
  m: Message
  run: boolean
  onOpen: (x: number, y: number) => void
  children: React.ReactNode
}) {
  const press = useLongPress((x, y) => onOpen(x, y))
  return (
    <div
      className={run ? 'msg cont' : 'msg'}
      data-msg={m.id}
      onContextMenu={(e) => { e.preventDefault(); onOpen(e.clientX, e.clientY) }}
      {...press}
    >
      {children}
    </div>
  )
}
