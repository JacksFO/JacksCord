import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

/**
 * The media proxy.
 *
 * Showing a linked image inline is the obvious feature and the obvious leak:
 * every person who scrolls past it fetches it themselves, so whoever posted
 * the link learns the IP address of everyone in the channel. On a private
 * server among friends that is a genuinely unpleasant thing to be able to do
 * by pasting a URL.
 *
 * So the server fetches it instead. One request, from one address, and the
 * people reading are anonymous to whoever is hosting the image.
 *
 * That makes this endpoint a request-forger's dream if it is careless, so it
 * is deliberately narrow: https only, image types only, size and time capped,
 * redirects followed by hand, and every address it is about to contact
 * checked against the private ranges first. Without that last part a member
 * could read anything on the host's home network by pasting its address.
 */

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3

const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
])

/** True for anything that is not a public, routable internet address. */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    const [a, b] = p as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true          // link local
    if (a === 100 && b >= 64 && b <= 127) return true // carrier grade NAT
    if (a >= 224) return true                         // multicast and reserved
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    if (s.startsWith('ff')) return true               // multicast
    // ::ffff:10.0.0.1 and friends - an IPv4 address wearing a disguise.
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1]!)
    return false
  }
  return true
}

/**
 * Reject anything that does not resolve to a public address, and hand back
 * the address that was checked.
 *
 * Handing it back is the whole point. Checking the name and then letting
 * fetch resolve it again leaves a gap between the two: a domain whose DNS
 * answers with a public address the first time and a private one a moment
 * later walks straight through a check that happened, correctly, on a
 * different answer. It is the standard way past this, it needs nothing but a
 * domain somebody controls and a short TTL, and the only fix is to connect to
 * the address that was actually checked.
 */
async function assertPublic(hostname: string): Promise<{ address: string; family: number }> {
  // A literal address skips DNS entirely, so check it directly.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('that address is not reachable')
    return { address: hostname, family: isIP(hostname) }
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new Error('could not resolve that host')
  }
  if (addresses.length === 0) throw new Error('could not resolve that host')
  // Every answer must be public: one private result is enough to refuse,
  // because we cannot control which the connection ends up using.
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new Error('that address is not reachable')
  }
  /* The first, and it is the one the connection will use - not merely the one
     that happened to be checked. */
  return { address: addresses[0]!.address, family: addresses[0]!.family }
}

/** Enough of a Response for the two things here that read one. */
type Answer = {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  body: ReadableStream<Uint8Array> | null
}

/**
 * One request, to an address that has already been checked.
 *
 * node:https rather than fetch, for one reason: it takes a `lookup`, and that
 * is the only way to say "connect to this address" while still speaking TLS
 * to the hostname. Rewriting the URL to the address instead would connect to
 * the right machine and then fail to verify the certificate, which is the
 * same as having no certificate check at all.
 *
 * Redirects are not followed here. Each hop is checked on the way in by the
 * caller, which is what stops a public address redirecting to a private one.
 */
function getPinned(
  url: URL, at: { address: string; family: number }, headers: Record<string, string>,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      headers,
      /*
       * Called instead of DNS. The address is the one assertPublic checked a
       * moment ago, so there is no second answer for anybody to swap.
       *
       * Two shapes, and both have to be answered. Node asks with `all` set
       * when it is willing to try several addresses, and then the callback
       * takes an array rather than an address and a family - answer that one
       * in the single-address shape and it reads the array as an address and
       * fails with "Invalid IP address: undefined", which is what happened
       * the first time this was run against a real site.
       */
      lookup: (_host, opts, cb) => {
        const both = { address: at.address, family: at.family }
        if ((opts as { all?: boolean }).all) {
          (cb as unknown as (e: Error | null, a: Array<typeof both>) => void)(null, [both])
          return
        }
        (cb as (e: Error | null, a: string, f: number) => void)(null, at.address, at.family)
      },
      timeout: TIMEOUT_MS,
      /* The hostname, for SNI and for the certificate check - which is what
         makes connecting by address safe rather than merely direct. */
      servername: url.hostname,
    }, (res) => {
      /*
       * The response's own errors, which are not the request's.
       *
       * This took the whole server down. Once a response has begun, node
       * stops reporting a dropped connection on the request object and
       * destroys the *response* instead - so the handler two lines below was
       * watching the wrong object, nothing was listening here, and an
       * unhandled error event on a stream ends the process. A remote host
       * hanging up in the middle of sending a picture was enough:
       *
       *   Error: aborted
       *     at TLSSocket.socketCloseListener (node:_http_client)
       *   uncaught exception, shutting down for a clean restart
       *
       * Which is every link anybody posts, fetched on their behalf. Two
       * minutes down, and nothing about it was the app's own doing.
       *
       * Listened for rather than handled: toWeb passes the failure on to
       * whoever is reading the body, and they already cope with a fetch that
       * stops early. This is only here so that passing it on is not preceded
       * by the process dying.
       */
      res.on('error', () => { /* the reader is told; see above */ })
      const status = res.statusCode ?? 0
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get: (name: string) => {
            const v = res.headers[name.toLowerCase()]
            return Array.isArray(v) ? v[0] ?? null : v ?? null
          },
        },
        body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
      })
    })
    req.on('timeout', () => { req.destroy(new Error('that link took too long')) })
    /* Before a response begins. Afterwards the failure arrives on the
       response instead, which is what the listener above is for - and
       rejecting a promise that has already settled is a no-op, so this
       staying here costs nothing and covers the earlier half. */
    req.on('error', reject)
    req.end()
  })
}

export type Fetched = {
  body: ReadableStream<Uint8Array>
  type: string
  length: number | null
}

/**
 * Fetch a remote image on behalf of a member.
 *
 * Redirects are followed manually so each hop can be validated - a public URL
 * that redirects to 127.0.0.1 is the standard way around a naive check.
 */
export async function fetchRemoteImage(raw: string): Promise<Fetched> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('that is not a URL')
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:') throw new Error('only https images can be shown')
    /* The address is kept and connected to, rather than the name being
       resolved a second time by whatever does the fetching. */
    const at = await assertPublic(url.hostname)

    const res = await getPinned(url, at, {
      // Some hosts serve nothing without one, and it identifies us honestly.
      'user-agent': 'Atrium/1.0 (+media proxy)',
      accept: 'image/*',
    })

    if (res.status >= 300 && res.status < 400) {
      /* Let go of the hop before starting the next one. A body nobody reads
         holds its socket open until something times it out - which fetch hid
         and node:https does not. */
      void res.body?.cancel().catch(() => {})
      const next = res.headers.get('location')
      if (!next) throw new Error('that link redirects nowhere')
      url = new URL(next, url)
      continue
    }

    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {})
      throw new Error(`that image could not be fetched (${res.status})`)
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!ALLOWED_TYPES.has(type)) {
      throw new Error(type ? `that link is ${type}, not an image` : 'that link is not an image')
    }

    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > MAX_BYTES) {
      throw new Error('that image is too large to show')
    }

    return { body: res.body, type, length: Number.isFinite(length) ? length : null }
  }

  throw new Error('that link redirects too many times')
}

export { MAX_BYTES as MEDIA_MAX_BYTES }

/**
 * A link preview.
 *
 * Same journey as an image, and the same reasons: the server fetches it so
 * that nobody reading a channel announces themselves to whoever posted the
 * link. Every guard in fetchRemoteImage applies here too, which is why this
 * shares assertPublic rather than repeating it.
 *
 * Only the head of the document is read. Open Graph tags live there, and a
 * link to a large page should not mean downloading a large page.
 */
export type Preview = {
  url: string
  title: string
  description: string
  image: string
  site: string
  /**
   * A video, where the page offers one.
   *
   * Kept separate from the image: a card with a still of a video and no way
   * to play it is the thing this was missing, and the two are not
   * interchangeable.
   */
  video: string
  videoType: string
  videoWidth: number
  videoHeight: number
  /** The colour the site says it is, for the stripe down the side. */
  accent: string
}

const PREVIEW_BYTES = 256 * 1024

function meta(html: string, ...names: string[]): string {
  for (const name of names) {
    // Attribute order varies, so try both ways round rather than assuming.
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'),
    ]
    for (const re of patterns) {
      const m = re.exec(html)
      if (m?.[1]) return decode(m[1].trim())
    }
  }
  return ''
}

/** The handful of entities that actually turn up in titles. */
/**
 * Turn the entities in a meta tag back into the characters they stand for.
 *
 * Numbered ones were not handled at all, which is why a quoted nickname
 * arrived as `&#34;Nitro_Camden&#34;` and sat there in the card looking like
 * the site had sent us rubbish.
 *
 * `&amp;` is decoded last on purpose. Doing it first turns `&amp;lt;` into
 * `&lt;` and then into `<`, which is one decode too many and the usual way
 * an escaped angle bracket stops being escaped.
 */
function decode(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) =>
      safeChar(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** A code point, unless it is nonsense - in which case leave it alone. */
function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Sites that only hand Open Graph tags to crawlers they recognise.
 *
 * YouTube is the one that matters here. Asked for a watch page it returns
 * eight hundred kilobytes of JavaScript and not a single og: tag - measured -
 * so a link to a video arrived in the chat as a bare line of text. It
 * publishes an oEmbed endpoint instead, which is a documented API rather than
 * a scrape, and answers with exactly what a card needs.
 *
 * The alternative is to claim to be Discordbot in the user-agent, which is
 * both a lie and a thing that stops working the day somebody tightens it up.
 *
 * The address is built here from a fixed host, never taken from the page, so
 * this cannot become a way to make the server fetch somewhere else.
 */
export function oEmbedFor(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const youtube = host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be'
  if (youtube) {
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`
  }
  return null
}

/** What oEmbed answers with, of the parts worth drawing. */
type OEmbed = {
  title?: string
  author_name?: string
  provider_name?: string
  thumbnail_url?: string
}

async function fetchOEmbed(endpoint: string, original: URL): Promise<Preview | null> {
  let res: Response
  try {
    res = await fetch(endpoint, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
  } catch {
    return null
  }
  // 404 for a video that is private, deleted or does not exist. Nothing to
  // draw, and falling through to the page would only find the same nothing.
  if (!res.ok) return null

  let body: OEmbed
  try {
    body = (await res.json()) as OEmbed
  } catch {
    return null
  }

  const title = String(body.title ?? '').trim()
  if (!title) return null

  // https and nothing else, the same rule every other picture here follows.
  let image = ''
  try {
    const thumb = new URL(String(body.thumbnail_url ?? ''))
    if (thumb.protocol === 'https:') image = thumb.href
  } catch {
    // No thumbnail. The card is still worth drawing.
  }

  return {
    url: original.href,
    title: title.slice(0, 160),
    /* Who made it, which is the line a video card is missing without. */
    description: String(body.author_name ?? '').trim().slice(0, 300),
    image,
    video: '',
    videoType: '',
    videoWidth: 0,
    videoHeight: 0,
    accent: '',
    site: String(body.provider_name ?? '').trim() || original.hostname.replace(/^www\./, ''),
  }
}

export async function fetchPreview(raw: string): Promise<Preview | null> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  /*
   * Ask the site's own API first, where it has one.
   *
   * Only for the handful that will not answer a plain fetch usefully. If it
   * says nothing the ordinary path below still runs, so a provider having a
   * bad afternoon costs a card rather than the whole feature.
   */
  const oembed = oEmbedFor(url)
  if (oembed) {
    const card = await fetchOEmbed(oembed, url)
    if (card) return card
  }

  // Redirects are followed by hand, exactly as fetchRemoteImage does.
  // Letting fetch follow them would check only the first address: a
  // public URL that redirects to 127.0.0.1 is the standard way past a
  // check that happens once.
  let res: Answer | null = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:') return null
    const at = await assertPublic(url.hostname)

    const r = await getPinned(url, at, {
      /**
       * Shaped like a crawler, and still honest about who it is.
       *
       * Plenty of sites decide what to put in their meta tags by looking
       * at this, and hand a name they do not recognise a stripped page.
       * fxtwitter is the case that showed it up: to a known crawler it
       * offers the video, and to "Atrium/1.0" it offered a title and
       * nothing else - so a link to a video arrived as a box of text.
       */
      'user-agent':
        'Mozilla/5.0 (compatible; AtriumBot/1.0; +https://github.com/JacksFO/Atrium)',
      accept: 'text/html,application/xhtml+xml',
    })
    if (r.status >= 300 && r.status < 400) {
      /* The same: a hop nobody reads still holds a socket. */
      void r.body?.cancel().catch(() => {})
      const next = r.headers.get('location')
      if (!next) return null
      url = new URL(next, url)
      continue
    }
    res = r
    break
  }
  if (!res || !res.ok || !res.body) return null

  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!type.startsWith('text/html') && type !== 'application/xhtml+xml') {
    void res.body?.cancel().catch(() => {})
    return null
  }

  // Read the head and stop. Nothing below it is used.
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < PREVIEW_BYTES) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    size += value.length
  }
  void reader.cancel().catch(() => {})

  const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')

  const title =
    meta(html, 'og:title', 'twitter:title') ||
    decode((/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim())
  const description = meta(html, 'og:description', 'twitter:description', 'description')
  /** Only ever https, and only ever absolute. */
  const remote = (value: string): string => {
    if (!value) return ''
    try {
      const abs = new URL(value, url)
      return abs.protocol === 'https:' ? abs.href : ''
    } catch {
      return ''
    }
  }

  const image = remote(meta(html, 'og:image', 'og:image:url', 'twitter:image'))
  const video = remote(meta(
    html, 'og:video:secure_url', 'og:video', 'og:video:url', 'twitter:player:stream',
  ))

  if (!title && !description) return null

  // A colour the site chose for itself beats one we would have guessed.
  const accent = /^#[0-9a-f]{3,8}$/i.test(meta(html, 'theme-color')) ? meta(html, 'theme-color') : ''

  return {
    url: url.href,
    title: title.slice(0, 160),
    description: description.slice(0, 300),
    image,
    video,
    videoType: video ? (meta(html, 'og:video:type', 'twitter:player:stream:content_type') || 'video/mp4') : '',
    videoWidth: Number(meta(html, 'og:video:width', 'twitter:player:width')) || 0,
    videoHeight: Number(meta(html, 'og:video:height', 'twitter:player:height')) || 0,
    accent,
    site: meta(html, 'og:site_name') || url.hostname.replace(/^www\./, ''),
  }
}

/**
 * The bytes of a proxied image, kept for a little while.
 *
 * The comment at the top of this file says "one request, from one address",
 * and until now that was only true per viewer: ten people scrolling past the
 * same link meant ten fetches out to whoever is hosting it, all of the same
 * picture. That is bandwidth on a home connection, and it is also a good way
 * to look like an attack to a small host - one address asking for one file a
 * hundred times in a minute.
 *
 * In memory rather than on disk, deliberately. A cache on disk needs
 * something to remove things from it, and a sweep that deletes files in this
 * codebase has already been wrong once about something nobody could get
 * back. Nothing here can be lost: it is copies of other people's pictures,
 * and a restart is allowed to forget all of it.
 *
 * The pattern it is sized for is a burst - a link is posted and the people
 * in the channel look at it over the next few minutes - not a library.
 */
const ENTRY_MAX = 2 * 1024 * 1024
export { ENTRY_MAX as MEDIA_CACHE_ENTRY_MAX }
const CACHE_MAX = 64 * 1024 * 1024
const CACHE_TTL_MS = 60 * 60_000

type Held = { type: string; body: Buffer; at: number }

/* Insertion-ordered, which a Map already is: re-inserting on a hit moves an
   entry to the end, so the first key is always the least recently wanted. */
const held = new Map<string, Held>()
let heldBytes = 0

/** The bytes for this address, if we still have them and they are not stale. */
export function cachedImage(url: string): Held | null {
  const got = held.get(url)
  if (!got) return null
  if (Date.now() - got.at > CACHE_TTL_MS) {
    held.delete(url)
    heldBytes -= got.body.length
    return null
  }
  held.delete(url)
  held.set(url, got)
  return got
}

/** Keep these bytes, dropping the least recently wanted until we fit. */
export function holdImage(url: string, type: string, body: Buffer): void {
  if (body.length > ENTRY_MAX) return
  const had = held.get(url)
  if (had) heldBytes -= had.body.length
  held.set(url, { type, body, at: Date.now() })
  heldBytes += body.length
  for (const [key, entry] of held) {
    if (heldBytes <= CACHE_MAX) break
    held.delete(key)
    heldBytes -= entry.body.length
  }
}

/** For the tests, and for anything that wants to know what is being held. */
export function imageCacheSize(): { entries: number; bytes: number } {
  return { entries: held.size, bytes: heldBytes }
}

export function forgetCachedImages(): void {
  held.clear()
  heldBytes = 0
}
