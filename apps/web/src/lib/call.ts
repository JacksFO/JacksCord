import type { Id } from './wire'
import { rememberedLevels } from './levels'

/**
 * What is in a call, and what each of it is.
 *
 * The old client kept a call's sounds as <audio> elements in the document,
 * found again by an id built out of the person and the kind — "a7" for a
 * voice, "sa7" for the sound of what they are sharing. Four different places
 * then went looking for them with a selector that guessed at how those ids
 * were spelled, and every guess was wrong about one of the two kinds:
 * stopping a share deleted the sharer's *voice*, deafening left everybody's
 * game playing, and a share's element was never removed at all.
 *
 * So the sounds are held here, keyed, and drawn from this. Nothing looks an
 * element up; a sound that is gone from this map is gone from the page,
 * because React took it away. The whole class of bug needs a place to live
 * and this removes it.
 */

/** The three things a person can be sending. */
export type Source = 'voice' | 'share' | 'cam'

/** One person's one thing, named so it cannot be confused with their other. */
/** What the room thinks of your connection, in the words a person reads. */
export type CallQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

export type StreamKey = `${Source}:${Id}`

export const keyOf = (source: Source, id: Id): StreamKey => `${source}:${id}`

export const partsOf = (key: StreamKey): { source: Source; id: Id } => {
  const cut = key.indexOf(':')
  return { source: key.slice(0, cut) as Source, id: key.slice(cut + 1) }
}

export type CallMember = {
  id: Id
  /** What the media server calls them, which is not always what we call them. */
  identity: string
  name: string
  muted: boolean
  sharing: boolean
  cam: boolean
}

export type Call = {
  /** The channel this call is in, or null when not in one. */
  channel: Id | null
  /**
   * How well your own connection is holding up.
   *
   * 'unknown' until the room has an opinion, which is a second or two after
   * joining - and it stays that way on a browser that does not report one,
   * so nothing is drawn rather than four confident bars about nothing.
   */
  quality: CallQuality
  since: number
  members: CallMember[]
  /** Pictures — a shared screen or a camera — by whose they are. */
  video: Map<StreamKey, MediaStream>
  /** Sounds, likewise. A voice and a shared game are two entries. */
  sounds: Map<StreamKey, MediaStream>
  /** Who is making noise right now, as the media server hears it. */
  speaking: Set<Id>
  /** How loud each thing is, 0–100, for as long as the call lasts. */
  levels: Map<StreamKey, number>
  /**
   * What is being watched, having been asked for.
   *
   * Opt in, not opt out. Nothing streams until somebody asks for it, because
   * every viewer costs the person sharing their upload — a room of eight
   * where one person shares is one stream or seven depending only on this.
   * Your own is always in here: it is already on your machine.
   */
  watching: Set<StreamKey>
  muted: boolean
  deaf: boolean
  /**
   * The sound of your own share.
   *
   * `has` is whether any was captured — a share started without it never
   * captured any, and nothing can turn on what was never taken. `on` is
   * whether what was captured is going out. Two facts rather than one,
   * because "off" and "there is none" want different words on screen.
   */
  shareAudio: { has: boolean; on: boolean }
}

export function emptyCall(): Call {
  return {
    channel: null, since: 0, members: [], quality: 'unknown',
    video: new Map(), sounds: new Map(), speaking: new Set(),
    /*
     * Not empty: how loud somebody is was set on purpose and is about them,
     * not about this particular call. Seeded here rather than at each of the
     * five places a call is made or cleared, because four of those are the
     * ones nobody would remember to change.
     */
    levels: rememberedLevels(), watching: new Set(),
    muted: false, deaf: false,
    shareAudio: { has: false, on: false },
  }
}

/**
 * Whether a sound should be coming out of the speakers.
 *
 * Deafened means every sound in the call, not every voice. Selecting only the
 * voices is what left somebody who had deafened themselves listening to four
 * people's games — which is the one thing deafening is for.
 */
export function audible(call: Call, key: StreamKey, me: Id): boolean {
  if (call.deaf) return false
  const { source, id } = partsOf(key)
  /* Your own microphone comes back from the room, and playing it is hearing
     yourself talk a fraction of a second late. */
  if (id === me) return false
  /* A screen and its sound are one thing to whoever is watching, so the sound
     follows the picture: not watching means not hearing it either, which is
     also what stops it being sent. */
  if (source === 'share') return call.watching.has(key)
  return true
}

/**
 * How loud, 0–1, for the element carrying one sound.
 *
 * A call has several sounds in it and they are not interchangeable: somebody
 * talking, and whatever the window they are sharing is playing. One slider
 * for the lot means turning down a game turns down the person telling you
 * about it. `master` is the one in settings and applies to voices only — a
 * share is set on its own tile, which is where you are looking at it.
 */
export function volumeOf(call: Call, key: StreamKey, master: number): number {
  const own = call.levels.get(key)
  if (own !== undefined) return clamp(own / 100)
  return partsOf(key).source === 'share' ? 1 : clamp(master / 100)
}

const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Put a track where it belongs, by what it is rather than by who sent it.
 *
 * Returns a new map so React sees the change; the call is small enough that
 * copying it is cheaper than reasoning about when it did not.
 */
export function withStream(
  from: Map<StreamKey, MediaStream>,
  key: StreamKey,
  stream: MediaStream,
): Map<StreamKey, MediaStream> {
  const next = new Map(from)
  next.set(key, stream)
  return next
}

export function withoutStream(
  from: Map<StreamKey, MediaStream>,
  key: StreamKey,
): Map<StreamKey, MediaStream> {
  if (!from.has(key)) return from
  const next = new Map(from)
  next.delete(key)
  return next
}

/** Everything one person was sending, when they leave or the call ends. */
export function withoutPerson(
  from: Map<StreamKey, MediaStream>,
  id: Id,
): Map<StreamKey, MediaStream> {
  const next = new Map(from)
  for (const key of from.keys()) if (partsOf(key).id === id) next.delete(key)
  return next.size === from.size ? from : next
}

/**
 * The tiles to draw, in the order they should appear.
 *
 * Screens before cameras, because a screen is what somebody is showing you
 * and a camera is who is showing it. Yours last in each group: you know what
 * you are sharing, and putting it first pushes what you joined to watch off
 * the end of a narrow window.
 */
export function tilesOf(call: Call, meId: Id): StreamKey[] {
  /*
   * Read off who is in the room, not off the streams that have arrived.
   *
   * A share nobody has asked for has no stream — that is the point of it —
   * and drawing only what has arrived means a share you have not opted into
   * is invisible, so there is nothing to opt in *from*. The tile exists as
   * soon as somebody is sharing; whether it has a picture in it is a separate
   * question the tile answers for itself.
   */
  const keys: StreamKey[] = []
  for (const m of call.members) if (m.sharing) keys.push(keyOf('share', m.id))
  for (const m of call.members) if (m.cam) keys.push(keyOf('cam', m.id))

  const rank = (k: StreamKey) => {
    const { source, id } = partsOf(k)
    return (source === 'share' ? 0 : 2) + (id === meId ? 1 : 0)
  }
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/**
 * What to keep in the corner, best first.
 *
 * Screens before faces, and everybody else before you.
 *
 * Your own used to be left out entirely, on the grounds that your screen in
 * the corner of your own window is a mirror. It is - and it is also the only
 * thing there is to show when you are the one sharing, which was a corner
 * that stayed empty in exactly the call where somebody wanted to check they
 * were still sharing. So it goes in, last: it can never take the place of a
 * stream you chose to watch, and it is one press of an arrow away.
 *
 * Sharing a whole screen, this shows the screen it is drawn on, which nests
 * until it is too small to see. That is what a mirror pointed at itself does
 * and it is not a fault - but it is why yours is last rather than first.
 *
 * A list rather than one, because more than one person shares at once and the
 * corner used to pick whichever came out of the set first, with no way to say
 * you meant the other one.
 *
 * Cameras only when no screen is being watched. A face is who somebody is
 * rather than what they are showing you, so it is never worth covering a
 * screen with - but a call where two people have their cameras on and nobody
 * is sharing has something worth keeping in view, and used to show nothing.
 * Ordered by the room, so the order does not shuffle as streams arrive.
 */
export function pipList(call: Call, me: Id): StreamKey[] {
  /*
   * Read off what you asked to watch, not off who the room says is here.
   *
   * Built from the member list, a share whose member row had not caught up -
   * which happens, because the two arrive separately - was a corner window
   * that vanished for no reason anybody could see. What you asked for is the
   * thing being answered, so it is the thing to read.
   *
   * The room only decides the order, and where it cannot, the key does: the
   * one on the right has to stay the one on the right while streams come and
   * go, or the arrows move somewhere different each time.
   */
  const rank = new Map(call.members.map((m, i) => [m.id, i]))
  const theirs = (source: 'share' | 'cam') => [...call.watching]
    .filter((key) => {
      const at = partsOf(key)
      return at.source === source && at.id !== me && call.video.has(key)
    })
    .sort((a, b) =>
      (rank.get(partsOf(a).id) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(partsOf(b).id) ?? Number.MAX_SAFE_INTEGER)
      || a.localeCompare(b))

  /*
   * And your own, which is never something you asked to watch - nothing
   * subscribes to itself. It is in `video` because the room says so the
   * moment you publish it, which is the only evidence there is that you are
   * sharing at all.
   */
  const mine = (source: 'share' | 'cam'): StreamKey[] => {
    const key = keyOf(source, me)
    return call.video.has(key) ? [key] : []
  }

  const all = (source: 'share' | 'cam') => [...theirs(source), ...mine(source)]
  const screens = all('share')
  return screens.length ? screens : all('cam')
}

/** The one it settles on, where only one is wanted. */
export function pipKey(call: Call, me: Id): StreamKey | null {
  return pipList(call, me)[0] ?? null
}

/**
 * Whether a tile should have a picture in it yet.
 *
 * Your own always: it is on your machine and costs nobody anything, and
 * waiting for it to come back from the room was a tile that never appeared,
 * because the thing that would have redrawn it was the stream arriving.
 */
export function watched(call: Call, key: StreamKey, me: Id): boolean {
  return partsOf(key).id === me || call.watching.has(key)
}
