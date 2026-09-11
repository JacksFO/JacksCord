import { isConversationKind } from './kinds.js'
import { survivable } from './survivable.js'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import compress from '@fastify/compress'
import type { FastifyCorsOptions } from '@fastify/cors'
import type { FastifyRequest, FastifyError } from 'fastify'
import { randomUUID, createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform, Readable } from 'node:stream'
import { resolve, dirname, join, sep } from 'node:path'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { enableOffsite, offsiteLogTo } from './offsite.js'
import { db, setConversationClosed, seed, hydrate, isDirect, dmMembers, freeDiscriminator, joinSpace, rememberUpload, visibleMembers, areFriends, addFriend, removeFriend, friendsOf, blockUser, unblockUser, blockedBy, blockedBetween, setChannelPref, setSpacePref, isSpaceMember, MUTED_INDEFINITELY, ACTIVE_USERS, PUBLIC_USER_COLUMNS, tightenSpaceColumns, type MessageRow } from './db.js'
import { attachGateway, pushAboutMember, pushToUsers, pushChannelEvent, announceJoin, dmBetweenOrMake } from './gateway.js'
import { nameProblem, NAME_REFUSED } from './names.js'
import { allow, retryAfter, reset } from './ratelimit.js'
import { searchGifs, trendingGifs, importGif, gifProvider, OVER_BUDGET } from './gifs.js'
import {
  fetchRemoteImage, fetchPreview, MEDIA_MAX_BYTES,
  cachedImage, holdImage, MEDIA_CACHE_ENTRY_MAX,
} from './media.js'
import { registerAdminRoutes, registerAvatarRoutes } from './routes/admin.js'
import { registerPollRoutes } from './routes/polls.js'
import { registerFeedbackRoutes } from './routes/feedback.js'
import { registerSpaceRoutes } from './routes/spaces.js'
import { permissionsFor, permissionsIn, writeAudit } from './permissions.js'
import { canAccessChannel, accessibleChannelIds, canBeInVoice } from './access.js'
import * as art from './artcache.js'
import { changelog } from './changelog.js'
import { mintVoiceToken, voiceConfigured } from './voice.js'
import { ensureCertificate } from './tls.js'
import { ensureTrustedCertificate, certificateDaysLeft } from './acme.js'
import { startDynamicDns } from './dyndns.js'
import { reconcileUploads, sweepDeleted, knownMissing, rememberMissing, newlyMissing } from './uploads.js'
import { looksLike, SNIFF_BYTES, describedTypes } from './filetype.js'
import { saveFromUrl } from './fetchimage.js'
import { isEmptySearch, parseSearch } from './searchQuery.js'
import { signatureValid, signPath } from './signing.js'
import httpProxy from '@fastify/http-proxy'
import { serverMuted, gatewayStats } from './gateway.js'
import {
  createUser, findByHandle, loginCandidates, findUser, issueToken, readToken, isOperator,
  verifyPassword, consumeInvite, usernameTaken, nameTaken, hashPassword, revokeSessions,
  revokeToken, tokenIdOf,
} from './auth.js'

seed()

/**
 * The single source of truth for what may be uploaded, and — critically —
 * what extension the stored file gets.
 *
 * The extension is derived from the *validated* MIME type, never from the
 * client-supplied filename. Taking it from the filename allowed anyone to
 * upload `content-type: image/png` named `pwn.html`, which was then served
 * back as text/html from this origin: a stored XSS leaking session tokens.
 */
/**
 * Fonts a name may be drawn in.
 *
 * A fixed set, and every one of them already loaded by the page or present
 * in the app. Accepting a family name from the browser would mean either
 * a request to a font service every time somebody renders a message, or a
 * name that silently falls back to nothing on everybody else's computer.
 */
export const NAME_FONTS = ['default', 'display', 'mono', 'serif', 'system'] as const

/** Decorations a name may carry. Fixed, for the same reason as the fonts. */
export const NAME_EFFECTS = ['none', 'glow', 'gradient', 'shimmer', 'outline'] as const

const ALLOWED_MIME = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['application/pdf', '.pdf'],
])

/**
 * Nothing may be accepted that cannot also be recognised.
 *
 * Adding a type to the list above without teaching filetype.ts about it
 * would quietly accept it on the sender's word alone, which is the hole this
 * was closing. Better to refuse to start than to be subtly wrong.
 */
{
  const described = new Set(describedTypes())
  const unchecked = [...ALLOWED_MIME.keys()].filter((m) => !described.has(m))
  if (unchecked.length > 0) {
    throw new Error(
      `these upload types have no signature to check them against: ${unchecked.join(', ')}`
    )
  }
}

// A trusted certificate if one can be had, otherwise self-signed. Either
// way https is on, because browsers only offer the microphone prompt on a
// secure origin.
const tls = config.tls
  ? (await ensureTrustedCertificate()) ?? await ensureCertificate()
  : null

// Renew well before expiry. Let's Encrypt certificates last 90 days, so a
// daily check is many times more often than needed and costs nothing.
if (config.tls && config.acmeDomain) {
  setInterval(() => {
    const left = certificateDaysLeft()
    if (left !== null && left > 30) return
    void ensureTrustedCertificate().then((renewed) => {
      if (renewed) console.log('[acme] renewed; restart to serve the new certificate')
    })
  }, 24 * 60 * 60_000).unref()
}

const app = Fastify({
  bodyLimit: 1_000_000,
  ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
  /*
   * Pretty logs for a person, plain JSON for a file.
   *
   * This asked NODE_ENV, and nothing sets it - not the launcher, not the
   * watchdog, not the scheduled task - so the live server always took the dev
   * branch and wrote pino-pretty into a log file, colour codes and all:
   * 35,823 lines of escape sequences in a single day.
   *
   * Asking whether anybody is watching settles it without an environment
   * variable somebody has to remember to set. A terminal gets the pretty
   * output; a redirect to a file gets one JSON object per line, which is what
   * you would want to grep anyway.
   *
   * Worth being straight about the size, since it is easy to assume: this is
   * not what made a day's log thirteen megabytes. Measured, it is about 15%
   * of it - 12.9MB against 11MB for the same events as JSON. The rest is
   * below.
   */
  logger: process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
    : true,

  /*
   * And the actual reason: 57,000 logged events in a day.
   *
   * Fastify logs every request twice, in and out, at info. On a day with
   * 29,000 requests - most of them a browser fetching an avatar it has
   * already got - that is 57,000 lines saying that something entirely
   * ordinary happened, and it is the whole of the log.
   *
   * Nothing reads them. What anybody actually wants from a log is the
   * requests that went wrong and the ones that took too long, so those are
   * what the hook below writes, and the routine ones stop being written at
   * all.
   */
  disableRequestLogging: true,
})

/*
 * The requests worth a line in the log: the ones that failed, and the ones
 * that were slow.
 *
 * A threshold rather than a sample, because the reason to read a log is
 * always "what went wrong" or "why was that slow", and neither question is
 * answered by the other 28,000 lines. A second is generous for anything here
 * - the slowest ordinary query on this instance is under a millisecond - so
 * anything crossing it is worth seeing.
 */
const SLOW_MS = 1000

app.addHook('onResponse', async (req, reply) => {
  const ms = reply.elapsedTime
  if (reply.statusCode < 400 && ms < SLOW_MS) return
  app.log[reply.statusCode >= 500 ? 'error' : 'warn'](
    {
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(ms),
    },
    reply.statusCode >= 400 ? 'request failed' : 'slow request',
  )
})


// ------------------------------------------------------------ hardening ----

/**
 * CORS.
 *
 * Registered in the delegated form because the decision needs the request,
 * not just the Origin header. The web client is served from this same origin,
 * and Vite marks its script and stylesheet `crossorigin` - so the browser
 * sends an Origin header on requests the server is answering about itself.
 * Judging that header without knowing which host was asked is how a server
 * ends up refusing to serve its own page.
 */
type CorsDecision = (err: Error | null, options: FastifyCorsOptions) => void

await app.register(cors, () => (req: FastifyRequest, cb: CorsDecision) => {
  const origin = req.headers.origin

  // No Origin at all: the desktop app, curl, a top-level navigation.
  if (!origin) return cb(null, { origin: true, credentials: false })

  // Same origin. Not a cross-origin request in the first place, so there is
  // nothing here for CORS to protect against.
  const self = `${req.protocol}://${req.headers.host}`
  if (origin === self) return cb(null, { origin: true, credentials: false })

  // The packaged desktop client. It is served from a registered standard
  // scheme precisely so it has a real origin we can name here, instead of
  // the null origin a file:// page would have.
  // Both names: the packaged client is served from app://atrium now, and
  // every copy installed before the rename still says app://jackscord. This
  // is what lets those talk to the server at all, so it goes when nothing is
  // left running that sends it.
  if (origin === 'app://atrium' || origin === 'app://jackscord') {
    return cb(null, { origin: true, credentials: false })
  }

  if (config.allowedOrigins.includes(origin)) {
    return cb(null, { origin: true, credentials: false })
  }

  // Browsers on the private network are fine; anything else on the public
  // internet is not.
  if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)) {
    return cb(null, { origin: true, credentials: false })
  }

  // Withhold the header rather than failing the request. The browser then
  // refuses to hand the response to the calling page, which is the actual
  // protection; a 500 would add nothing and breaks non-browser callers.
  // Auth is a Bearer token, not a cookie, so credentials are never needed.
  cb(null, { origin: false, credentials: false })
})

app.addHook('onSend', async (_req, reply) => {
  // nosniff is what stops a browser second-guessing our Content-Type and
  // deciding that an image is really a document.
  reply.header('x-content-type-options', 'nosniff')
  reply.header('x-frame-options', 'DENY')
  reply.header('referrer-policy', 'no-referrer')

  /*
   * Things this app never does, turned off for anything running in the page.
   *
   * Written as denials only, and it names nothing the app uses. A
   * Permissions-Policy header affects the features it lists and leaves the
   * rest at their defaults, so camera, microphone and display-capture are
   * left out on purpose: naming them would mean getting their allowlist
   * exactly right or silently breaking voice, and the win here is not worth
   * that risk. Denying what is never used cannot break what is.
   */
  reply.header(
    'permissions-policy',
    'geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), '
    + 'bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), '
    + 'idle-detection=(), local-fonts=(), storage-access=()',
  )

  /*
   * And a window opened from this one cannot reach back into it.
   *
   * `allow-popups` rather than plain `same-origin`: links do open in a new
   * window, and the strict form severs those in ways that read as a link
   * doing nothing. The opener reference is already dropped by rel="noopener"
   * on every link the client draws; this is the same rule stated by the
   * server, for anything that forgets to.
   */
  reply.header('cross-origin-opener-policy', 'same-origin-allow-popups')

  /*
   * Come back over https, and do not ask first.
   *
   * Without this, the first request of a session is whatever the address bar
   * decided - and somebody typing the address on a network they do not
   * control hands over a session token in the clear before any redirect can
   * happen. A year, so it survives being away for a while.
   *
   * Only when this server is actually serving TLS. Sent from a plain http
   * development server it would pin a browser to https for a host that has no
   * certificate, and the only cure is clearing site data.
   */
  if (config.tls) {
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }
})

/**
 * Compression.
 *
 * The client bundle is roughly 770 kB uncompressed and about 215 kB gzipped.
 * That difference is the whole experience on a phone: a large uncompressed
 * transfer over a slow or lossy mobile connection is what fails, and it fails
 * as a blank page rather than as anything a person could act on.
 *
 * Registered before the static plugins so their responses pass through it.
 * Already-compressed formats (images, video, audio) are left alone by the
 * plugin's own mime list, so nothing is spent recompressing a PNG.
 */
await app.register(compress, {
  global: true,
  encodings: ['br', 'gzip', 'deflate'],
  // Below about a kilobyte the headers cost more than the saving.
  threshold: 1024,
})

/**
 * An attachment is only served to somebody we handed a link to.
 *
 * The names are random, but a link is a thing people copy, and a file posted
 * in a private channel was readable by whoever it reached - for ever, and
 * after the message had been deleted. Signed links put an end on that.
 *
 * Avatars and banners are deliberately left open: everybody in the space can
 * see them anyway, they are referenced from a dozen places, and an expiring
 * link to a profile picture buys nothing.
 *
 * A hook rather than a replacement for the static plugin, which is still the
 * thing that knows how to serve a file properly - ranges, caching and all.
 */
/*
 * A ceiling on writes, above whatever each route asks for itself.
 *
 * Eleven routes had a limit of their own and forty-four did not, which meant
 * the ones nobody had thought about were the ones with no floor under them.
 * A backstop in one place covers those, and covers the next route somebody
 * adds without remembering.
 *
 * Deliberately looser than every per-route limit, so it never fires first:
 * the specific ones are the policy, this catches what the policy missed. The
 * budget is not a guess - the live log was read before it was chosen. The
 * busiest real minute on this machine was 241 profile writes while somebody
 * dragged a colour picker, which is now debounced at the client; four hundred
 * a minute leaves room for that to misbehave again without anybody legitimate
 * ever meeting it.
 *
 * Keyed on the session rather than the account, because the account is read
 * out of a token this has not verified yet - and verifying one here would put
 * an HMAC on the front of every write. Two buckets: the session, and the
 * address it came from, so holding several tokens does not multiply the
 * budget. Reads are untouched, and sending a message is not here at all - it
 * goes over the socket, which has had a limit of its own all along.
 */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

app.addHook('onRequest', async (req, reply) => {
  if (!WRITES.has(req.method)) return
  const where = req.url.split('?')[0] ?? ''
  if (!where.startsWith('/api/')) return

  /* Not a security boundary, only which bucket to count in - so the header is
     hashed rather than verified. Two people cannot share a token, and one
     person holding several is caught by the address below. */
  const header = String(req.headers.authorization ?? '')
  const who = header
    ? `s:${createHash('sha256').update(header).digest('base64url').slice(0, 16)}`
    : `a:${req.ip}`

  if (!allow(`w:${who}`, 400, 60_000) || !allow(`w:a:${req.ip}`, 1200, 60_000)) {
    reply.header('retry-after', String(Math.max(1, retryAfter(`w:${who}`))))
    return reply.code(429).send({ error: 'that is a lot of changes at once. wait a moment' })
  }
})

app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0] ?? ''
  if (!path.startsWith('/uploads/')) return

  const name = decodeURIComponent(path.slice('/uploads/'.length))
  if (!name || name.includes('/')) return

  const isAttachment = db
    .prepare('SELECT 1 AS x FROM attachments WHERE path = ?')
    .get(`/uploads/${name}`)
  if (!isAttachment) return

  const query = req.query as { e?: string; s?: string }
  if (!signatureValid(name, query.e, query.s)) {
    return reply.code(403).send({ error: 'that link has expired' })
  }
})

await app.register(fastifyStatic, {
  root: config.uploadDir,
  prefix: '/uploads/',
  // v10 hands the callback a Fastify reply rather than a raw response.
  setHeaders(reply, path) {
    reply.header('x-content-type-options', 'nosniff')
    // Images and video render inline; a PDF is handed over as a download
    // because PDF viewers execute script.
    if (path.endsWith('.pdf')) reply.header('content-disposition', 'attachment')
  },
})

/**
 * The web client, served from this same origin.
 *
 * Same origin matters: relative /api and /gateway URLs just work, there is no
 * CORS to negotiate, and nobody has to be told a server address. Someone who
 * would rather not install anything opens the address in a browser and gets
 * the same app.
 */
/**
 * Overridable, so a test server can serve a different build.
 *
 * Without this there is one built copy of the client in the app and the
 * live server is serving it - which means building anything to try it out
 * hands the half-finished version to whoever is using the real one.
 */
/*
 * apps/web, which is where the client is.
 *
 * This pointed at apps/client, which is the client that came before the React
 * one and is now only the desktop app's offline fallback. The live client was
 * reaching people anyway, by a copy: build apps/web, copy the result into
 * apps/client/dist, serve that. Two folders, one of them named after the
 * wrong thing, and a hand copy in between that nothing checks and nobody
 * would notice going stale.
 */
const CLIENT_DIST = process.env.CLIENT_DIST
  ? resolve(process.env.CLIENT_DIST)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const hasClient = existsSync(join(CLIENT_DIST, 'index.html'))

/**
 * Content-Security-Policy for the browser client.
 *
 * The desktop app has had one since it existed; browsers had none, which is
 * the half that actually renders other people's messages and hosts uploads.
 *
 * index.html carries two inline scripts on purpose - the startup error
 * surface has to run even when everything else fails to load, so it cannot
 * live in an external file. Rather than opening the policy with
 * 'unsafe-inline', their hashes are computed from the built file at boot, so
 * the policy stays correct whenever that file changes and no build step has
 * to remember to update it.
 */
function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    hashes.push(`'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`)
  }
  return hashes
}

/**
 * Rebuilt whenever index.html changes on disk.
 *
 * Updating the client is "pull, build" - the server serves the new files
 * without restarting. If these hashes were computed once at boot they would
 * go stale the moment the inline scripts changed, and the page would break
 * with a blocked-script error rather than anything obvious. Keying the cache
 * on the file's timestamp costs one stat per request and removes the trap.
 */
/**
 * The page, and the last copy of it that was readable.
 *
 * Updating the client is "pull, build", and the build writes into the very
 * folder being served - so for a moment index.html does not exist. A read
 * that lands in that moment threw, which Fastify turned into a 500 for
 * somebody who had done nothing but open the app. It happened once here, at
 * 01:43, and it will happen again on every build that coincides with a
 * request.
 *
 * Holding the last good copy makes the window invisible instead: whoever
 * arrives mid-build gets the page that was there a second ago, which is a
 * page that works. Only a server that has never managed to read one at all
 * has nothing to offer, and that says so rather than throwing.
 */
let lastGoodPage: Buffer | null = null

/*
 * Warmed at boot, because the first read has to happen before the window
 * does. Left to the handler alone, a server that had served nothing but
 * successful requests held no copy at all - so the very first build after a
 * restart was the one nobody was covered for. Proved by hiding index.html
 * from a running server: it answered 503, which is honest and was not the
 * point of writing this.
 */
function warmClientPage(): void {
  try { lastGoodPage = readFileSync(join(CLIENT_DIST, 'index.html')) } catch { /* none yet */ }
}

function clientPage(): Buffer | null {
  try {
    const page = readFileSync(join(CLIENT_DIST, 'index.html'))
    lastGoodPage = page
    return page
  } catch {
    /* Mid-build, or no client at all. The first is worth covering for and
       the second cannot be. */
    return lastGoodPage
  }
}

/*
 * Held from the start, so the first build after a restart is covered too.
 *
 * Below the declarations rather than beside the other startup lines two
 * hundred lines up: lastGoodPage is a `let`, so calling this before it is
 * declared is a ReferenceError at boot, not a type error. tsc is happy with
 * it either way, which is why this line is here and commented rather than
 * where it reads more naturally.
 */
warmClientPage()

let cspCache: { key: string; value: string } | null = null

function webCsp(): string {
  const file = join(CLIENT_DIST, 'index.html')
  let key = 'missing'
  let html = ''
  try {
    const stat = statSync(file)
    key = `${stat.mtimeMs}:${stat.size}`
    if (cspCache?.key === key) return cspCache.value
    /*
     * Read once, kept twice.
     *
     * This runs on every request that reaches the client, and reads the file
     * only when its timestamp has moved - which is to say once per build. So
     * it is also the cheapest place to keep the page itself current: the copy
     * held for the build window is refreshed by the same read that notices a
     * new build, rather than going stale until something happens to 404.
     */
    const bytes = readFileSync(file)
    lastGoodPage = bytes
    html = bytes.toString('utf8')
  } catch {
    // No client built; the policy below is still valid, just unused.
  }

  const value = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    // Vite inlines a little CSS, and the theme sets custom properties directly.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // GIF search shows results straight from Tenor/Giphy before they are saved.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    // The gateway, LiveKit, the GIF providers, and screen-share peers.
    "connect-src 'self' https: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  cspCache = { key, value }
  return value
}

/**
 * Where the built desktop installers are, if this machine has ever built one.
 *
 * The desktop app pulls the web client from this server after its first run,
 * so a deploy reaches desktop users like everybody else. What it cannot
 * update that way is its own shell - the window, the screen capture handler,
 * the per-program audio - and the configured route for that is GitHub
 * Releases, which has never had anything published to it. So the only way
 * anybody has ever got this app is somebody handing them a file.
 *
 * Serving it from here is not the eventual answer: a hundred megabytes goes
 * out of a house on a domestic upload, and publishing a release would both
 * cost nothing and switch the built-in updater on. It is, however, a place
 * the download button can point at today.
 */
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/release')
/**
 * Two folders, because the installer comes in two pieces now.
 *
 * The download is a 700KB stub that fetches the rest while showing a
 * progress bar - so what lands when somebody presses the button is small and
 * immediate, and the hundred megabytes happens where there is something on
 * screen to explain it. electron-builder puts the stub and its package in
 * release/nsis-web and leaves older one-piece builds in release itself.
 */
const DESKTOP_DIRS = [join(DESKTOP_ROOT, 'nsis-web'), DESKTOP_ROOT].filter((d) => existsSync(d))

type Installer = {
  filename: string
  version: string
  /** The stub, which is what actually downloads when the button is pressed. */
  bytes: number
  /** The package it then fetches itself, when there is one. */
  packageBytes: number | null
  /** Where it lives, when that is somewhere other than this machine. */
  url?: string
}

/** The newest installer across those folders, if there is one. */
function newestInstaller(): Installer | null {
  try {
    const seen = new Map<string, Installer>()
    for (const dir of DESKTOP_DIRS) {
      const packages = readdirSync(dir).filter((n) => n.endsWith('.nsis.7z'))
      for (const filename of readdirSync(dir)) {
        if (!SETUP_NAME.test(filename)) continue
        const version = filename.replace(SETUP_STRIP, '')
        // The first folder wins: a two-piece build of a version is preferred
        // over an older one-piece build of the same one.
        if (seen.has(version)) continue
        const pkg = packages.find((p) => p.includes(version))
        seen.set(version, {
          filename,
          version,
          bytes: statSync(join(dir, filename)).size,
          packageBytes: pkg ? statSync(join(dir, pkg)).size : null,
        })
      }
    }
    const found = [...seen.values()]
    if (found.length === 0) return null
    // Sorted by version rather than by mtime: rebuilding an old tag should
    // not make it look like the newest thing anybody can install.
    found.sort((a, b) => {
      const pa = a.version.split('.').map(Number)
      const pb = b.version.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    })
    return found[found.length - 1]!
  } catch {
    return null
  }
}

/**
 * The repository releases are published to, read from the desktop app's own
 * configuration so it is stated in one place rather than two.
 */
/*
 * What an installer is called.
 *
 * The name follows electron-builder's productName, which the app has now
 * changed - so both are matched, and will be for as long as anybody can
 * still be offered a build published under the old one. Matching only the
 * new name would make every release already out there undownloadable
 * through here; matching only the old would do the same to every release
 * after the rename.
 */
/**
 * What the old address says now.
 *
 * Deliberately one sentence and one link. Somebody who arrives here has an
 * old bookmark or an old message, and the only useful thing this page can do
 * is get them to the right place - a copy of the app would leave them using
 * an address that is going to stop working.
 */
function movedPage(to: string): string {
  const url = `https://${to}/`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atrium has moved</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
    background:#06090A;color:#E8F0F3;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px}
  main{max-width:34rem}
  h1{font-size:1.6rem;margin:0 0 .6rem;font-weight:800}
  p{margin:0 0 1.6rem;color:#9FB3BC;line-height:1.5}
  a{display:inline-block;padding:13px 22px;border-radius:999px;
    background:#2FD4C6;color:#06090A;font-weight:800;text-decoration:none;
    word-break:break-all}
  a:hover{filter:brightness(1.08)}
  small{display:block;margin-top:1.4rem;color:#6C838D}
</style></head>
<body><main>
  <h1>Atrium has moved</h1>
  <p>This address is no longer where Atrium lives. Everything is at the new one &mdash; your account, your servers and your messages are all still there.</p>
  <a href="${url}">${url}</a>
  <small>Update your bookmark. The desktop app moves itself.</small>
</main></body></html>`
}

const SETUP_NAME = /^(?:JacksCord|Atrium)-Setup-[\d.]+\.exe$/
const SETUP_STRIP = /^(?:JacksCord|Atrium)-Setup-|\.exe$/g

function releaseRepo(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(DESKTOP_ROOT, '..', 'package.json'), 'utf8'))
    const github = (pkg?.build?.publish ?? []).find((p: { provider?: string }) => p.provider === 'github')
    return github?.owner && github?.repo ? `${github.owner}/${github.repo}` : null
  } catch {
    return null
  }
}

/**
 * The newest published release, if the project has any.
 *
 * Preferred over the copy on this disk for one reason: downloading the
 * installer from here means downloading from a house. The request goes out to
 * the public address and the router sends it back in, so it runs at the
 * server's UPLOAD speed - measured at about 530 KB/s, which is three and a
 * half minutes of a saturated connection for one install. GitHub serves the
 * same file at around 1.8 MB/s and costs nothing.
 *
 * Cached, because this is asked on every sign-in page load and a rate limit
 * reached is a download button that disappears.
 */
let releaseCache: { at: number; value: Installer | null } | null = null
const RELEASE_TTL_MS = 10 * 60_000

async function publishedRelease(): Promise<Installer | null> {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_TTL_MS) return releaseCache.value
  const repo = releaseRepo()
  if (!repo) return null

  let value: Installer | null = null
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Atrium' },
      signal: AbortSignal.timeout(6_000),
    })
    if (res.ok) {
      const body = (await res.json()) as {
        tag_name?: string
        assets?: Array<{ name: string; size: number; browser_download_url: string }>
      }
      const assets = body.assets ?? []
      const stub = assets.find((a) => SETUP_NAME.test(a.name))
      const pkg = assets.find((a) => a.name.endsWith('.nsis.7z'))
      if (stub) {
        value = {
          filename: stub.name,
          version: (body.tag_name ?? '').replace(/^v/, '') || stub.name.replace(SETUP_STRIP, ''),
          bytes: stub.size,
          packageBytes: pkg?.size ?? null,
          url: stub.browser_download_url,
        }
      }
    }
  } catch {
    // Offline, rate limited, or GitHub having a bad day. The copy on disk is
    // still here, which is the whole reason it is still here.
  }

  releaseCache = { at: Date.now(), value }
  return value
}

/**
 * Send update traffic to GitHub, for clients that have never heard of it.
 *
 * Every desktop app already out there was built with the updater pointed at
 * this machine, and that cannot be changed from here - it is baked into the
 * copy they installed. So the download does not move by changing what future
 * builds ask for; it moves by this machine declining to be the one that
 * serves it.
 *
 * The manifest is handed over as GitHub wrote it, and the installer is a
 * redirect to GitHub's own network. electron-updater follows redirects, and
 * the checksum in the manifest is of that very file, so nothing has to be
 * kept in step by hand.
 *
 * Falls through to the copy on disk whenever there is no published release,
 * or GitHub cannot be reached. An update that comes slowly out of the house
 * is worth having; an update that fails because a third party is down is not.
 */
async function githubAssetFor(name: string): Promise<string | null> {
  const repo = releaseRepo()
  if (!repo) return null
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Atrium' },
      signal: AbortSignal.timeout(6_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      assets?: Array<{ name: string; browser_download_url: string }>
    }
    return (body.assets ?? []).find((a) => a.name === name)?.browser_download_url ?? null
  } catch {
    return null
  }
}

/**
 * The manifest, and the file it names.
 *
 * Cached for the same ten minutes as the download page's lookup, because an
 * app checking hourly should not mean an API call per client per hour.
 */
let updateCache: { at: number; manifest: string | null } | null = null
const UPDATE_TTL_MS = 10 * 60_000

app.get('/download/latest.yml', async (_req, reply) => {
  if (!updateCache || Date.now() - updateCache.at > UPDATE_TTL_MS) {
    let manifest: string | null = null
    const url = await githubAssetFor('latest.yml')
    if (url) {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'Atrium' },
          signal: AbortSignal.timeout(8_000),
        })
        if (res.ok) manifest = await res.text()
      } catch {
        // Fall through to the copy on disk.
      }
    }
    updateCache = { at: Date.now(), manifest }
  }

  if (updateCache.manifest) {
    return reply
      .header('content-type', 'text/yaml')
      .header('cache-control', 'public, max-age=300')
      .send(updateCache.manifest)
  }

  // Nothing published, or GitHub unreachable: serve ours.
  const local = DESKTOP_DIRS.map((d) => join(d, 'latest.yml')).find((p) => existsSync(p))
  if (!local) return reply.code(404).send({ error: 'no update manifest' })
  return reply
    .header('content-type', 'text/yaml')
    .send(readFileSync(local, 'utf8'))
})

/**
 * The installer itself, when GitHub has it.
 *
 * Done as a hook rather than a route on purpose. A route would have to serve
 * the file itself when GitHub does not have it, and doing that by hand loses
 * range requests - which is exactly what electron-updater uses to resume a
 * download and to fetch only the changed blocks. Declining to handle it here
 * leaves the static plugin to do what it already did properly.
 */
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0] ?? ''
  const file = path.startsWith('/download/') ? decodeURIComponent(path.slice(10)) : ''
  if (!SETUP_NAME.test(file)) return

  const url = await githubAssetFor(file)
  if (!url) return
  // 302 rather than 301: which host serves this is a decision that can change
  // again, and a permanent redirect would be cached past that decision.
  return reply.redirect(url, 302)
})

/**
 * Is there a desktop app to download, and which one.
 *
 * Answered rather than assumed by the page, so a server with no installer
 * built simply does not offer one - a download button leading to a 404 is
 * worse than no button.
 */
/**
 * The newest build, wherever it happens to live.
 *
 * Preferring the published release unconditionally was wrong the moment a
 * newer one existed only on this disk: a release that turned out to be broken
 * went on being handed out while the fix sat here unoffered, because it had
 * not been published yet. Whichever version is higher wins, and the release
 * is preferred only when they are the same - it is the cheaper of the two to
 * serve.
 */
function higher(a: Installer | null, b: Installer | null): Installer | null {
  if (!a) return b
  if (!b) return a
  const pa = a.version.split('.').map(Number)
  const pb = b.version.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? a : b
  }
  return a
}

app.get('/api/desktop', async (_req, reply) => {
  const latest = higher(await publishedRelease(), newestInstaller())
  reply.header('cache-control', 'no-cache')
  if (!latest) return { available: false }
  const { url, ...rest } = latest
  return { available: true, ...rest, from: url ? 'github' : 'server' }
})

/** The newest installer, by a URL that does not change when the version does. */
app.get('/download', async (_req, reply) => {
  const latest = higher(await publishedRelease(), newestInstaller())
  if (!latest) return reply.code(404).send({ error: 'no desktop build is available yet' })
  if (latest.url) return reply.redirect(latest.url, 302)
  return reply.redirect(`/download/${encodeURIComponent(latest.filename)}`, 302)
})

/**
 * Only the installers, and the metadata an updater would need.
 *
 * The release folder is a build output directory: alongside the installers it
 * holds unpacked application trees, elevation helpers and whatever else
 * electron-builder felt like leaving there. None of that is anybody's
 * business, and "it is all build output anyway" is how a folder ends up
 * served whole.
 *
 * As a hook rather than the plugin's own allowedPath, so it sits beside the
 * /uploads rule and is enforced the same way - one mechanism to understand
 * when somebody wonders why a file is or is not being served.
 *
 * Three things are allowed out: the stub, the .nsis.7z package it fetches
 * while showing its progress bar, and the blockmap and latest.yml an updater
 * reads. Everything else in there - unpacked application trees, elevation
 * helpers, build logs - is nobody's business.
 */
const DESKTOP_ALLOWED =
  /^\/download\/((?:JacksCord|Atrium)-Setup-[\d.]+\.exe(\.blockmap)?|[A-Za-z0-9@._-]+\.nsis\.7z|latest\.yml)$/

app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0] ?? ''
  if (!path.startsWith('/download')) return

  /*
   * Collapse repeated slashes before judging the path.
   *
   * The installer builds its download address by joining a base and a
   * filename with a slash, so a base that already ends in one asks for
   * /download//name - which is a 404 that looks exactly like the package
   * being missing, and sends somebody hunting for a file that is right
   * there. The base is correct now; this means a stub built before it was
   * still finds the thing it is asking for.
   */
  if (path.includes('//')) {
    return reply.redirect(path.replace(/\/{2,}/g, '/') + (req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''), 308)
  }

  if (path === '/download' || path === '/download/') return
  if (DESKTOP_ALLOWED.test(decodeURIComponent(path))) return
  return reply.code(404).send({ error: 'not found' })
})

if (DESKTOP_DIRS.length > 0) {
  await app.register(fastifyStatic, {
    // An array, so one prefix can cover both folders - the stub's own
    // download of its package has to resolve against the same base URL.
    root: DESKTOP_DIRS,
    prefix: '/download/',
    decorateReply: false,
    setHeaders(reply) {
      reply.header('x-content-type-options', 'nosniff')
      reply.header('content-type', 'application/octet-stream')
      reply.header('cache-control', 'public, max-age=3600')
    },
  })
}

if (hasClient) {
  await app.register(fastifyStatic, {
    root: CLIENT_DIST,
    prefix: '/',
    // Only one static plugin may decorate the reply, and /uploads got there
    // first.
    decorateReply: false,
    setHeaders(reply, path) {
      reply.header('x-content-type-options', 'nosniff')
      // Hashed asset filenames can be cached hard; index.html must not be,
      // or people keep running whichever build they first loaded.
      if (path.endsWith('.html')) reply.header('content-security-policy', webCsp())
      if (path.includes(`${sep}assets${sep}`)) {
        reply.header('cache-control', 'public, max-age=31536000, immutable')
      } else {
        reply.header('cache-control', 'no-cache')
      }
    },
  })

  /*
   * The old address says where the app went, and nothing else.
   *
   * Every name on the certificate after the first is a name this used to
   * answer to: the list is what the certificate is issued for, so a name in
   * it still works, and a name that is no longer the address should say so
   * rather than quietly serving a second copy of the app on a second URL -
   * two addresses for one thing is how half of somebody's friends end up on
   * a link the other half cannot use.
   *
   * Pages only. The API, the gateway, the uploads and the downloads all go on
   * answering, so a session already open does not die mid-sentence and an
   * installer link already sent still works.
   *
   * The desktop app never sees this: it moves its own stored address on the
   * launch after it updates. It has no address bar, so a person reading this
   * inside the app could not act on it.
   */
  const movedTo = config.acmeDomains[0]
  const movedFrom = new Set(config.acmeDomains.slice(1).map((d) => d.toLowerCase()))
  if (movedTo && movedFrom.size) {
    app.addHook('onRequest', async (req, reply) => {
      const host = String(req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? ''
      if (!movedFrom.has(host)) return
      if (/^\/(api|gateway|uploads|download|assets)\b/.test(req.url)) return
      /* Anything that is not a page - a stylesheet, an icon - is left alone
         rather than answered with a page, which would only draw a broken
         image where a favicon should be. */
      if (!String(req.headers.accept ?? '').includes('text/html')) return
      /*
       * Never to the desktop app.
       *
       * It has no address bar, so this page is a wall: the app loads what it
       * has stored, and everything installed before the rename has the old
       * address stored. Shipping this before anybody had the build that
       * rewrites its own address locked every one of them out of the app -
       * which is exactly what it did, for about an hour.
       *
       * So the shell is served the app and moves itself on the next launch
       * after it updates. This exception comes out when nothing is left
       * running that needs it.
       */
      const ua = String(req.headers['user-agent'] ?? '')
      if (/Electron\//.test(ua)) return
      reply.header('cache-control', 'no-store')
      return reply.type('text/html').send(movedPage(movedTo))
    })
  }

  /*
   * Which builds of the desktop app are actually out there.
   *
   * Everything still carrying the old name is a compatibility hook - the
   * bridge under two names, the old origin, the old installer names, the
   * settings carried across - and every one of them can go the moment
   * nothing older than 0.2.34 is running. That was a thing nobody could
   * answer: the app says its version in its user agent and nothing read it,
   * so the choice was guesswork against silently breaking whoever had not
   * updated.
   *
   * One line per version per restart. Not a counter, not a table: the
   * question is "is anything old still connecting", and a name in the log is
   * the whole answer.
   */
  const seenBuilds = new Set<string>()
  app.addHook('onRequest', async (req) => {
    const ua = String(req.headers['user-agent'] ?? '')
    if (!/Electron\//.test(ua)) return
    const build = /(?:Atrium|JacksCord)\/([\d.]+)/.exec(ua)?.[0] ?? 'desktop/unknown'
    if (seenBuilds.has(build)) return
    seenBuilds.add(build)
    const old = build.startsWith('JacksCord')
    console.log(`[builds] ${build} connected${old ? ' - older than the rename' : ''}`)
  })

  // Client-side routing: anything that is not an API call or an upload falls
  // back to index.html so a refresh on any screen still works.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/') || req.url.startsWith('/gateway')) {
      return reply.code(404).send({ error: 'not found' })
    }
    /*
     * Same page, same headers.
     *
     * This hands out index.html itself rather than going through the static
     * plugin, so the plugin's setHeaders never ran - and every deep link was
     * served with no policy and no cache rule at all. The root URL was fine,
     * which is what made it easy to miss: /  had a CSP and /anything did not,
     * and a refresh on any screen but the first landed here.
     */
    reply.header('content-security-policy', webCsp())
    reply.header('cache-control', 'no-cache')
    /* webCsp above has already refreshed the held copy if a build landed, so
       this asks for the page after the freshest thing that reads it. */
    const page = clientPage()
    if (page === null) return reply.code(503).send('The app is being updated. Try again in a moment.')
    return reply.type('text/html').send(page)
  })
}

/**
 * LiveKit signalling, proxied through this origin.
 *
 * An https page cannot open a plain ws:// socket - the browser calls that
 * mixed content and refuses. Rather than give LiveKit its own certificate,
 * its WebSocket is proxied here, so clients speak wss:// to us and we speak
 * ws:// to it over the loopback interface.
 *
 * Only signalling goes through this. The media itself is UDP straight to the
 * server and is already encrypted by DTLS-SRTP, so it needs no help.
 */
if (voiceConfigured()) {
  await app.register(httpProxy, {
    upstream: config.livekitUrl.replace(/^ws/, 'http'),
    prefix: '/livekit',
    rewritePrefix: '',
    // The WebSocket half is handled in the gateway instead. Letting this
    // plugin do it attaches a second `upgrade` listener, and two listeners
    // on one server race for every upgrade - which intermittently turned
    // gateway connections into 404s.
    websocket: false,
    replyOptions: { rewriteRequestHeaders: (_req, headers) => headers },
  })
}

// Fastify parses JSON and nothing else. Uploads arrive as a raw binary body,
// so hand the stream through untouched for exactly the types we accept —
// buffering a 25 MB file into memory is the thing we are avoiding. Scoped to
// the allowlist rather than '*', so no other route silently accepts a body.
/**
 * Error handling.
 *
 * Fastify's default handler puts the underlying message in the response, so a
 * database error arrives at the client as "no such column: x". That tells an
 * attacker about the schema and tells an ordinary person nothing at all.
 *
 * Log the detail, return the shape. Deliberate 4xx replies - which carry
 * messages written for people - pass through untouched.
 */
/**
 * Nothing takes the whole server down without saying why.
 *
 * A rejected promise nobody awaited - a timer, a socket handler, a
 * fire-and-forget send - ends the process by default. On a server six
 * people are sitting in a voice call on, that drops everybody, and the
 * watchdog needs up to five minutes to notice. Almost every one of these is
 * a background task that failed and can be survived, so it is logged and
 * the server carries on.
 */
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'a promise was rejected with nobody listening')
})

/**
 * A thrown exception is different: the state it left behind is unknown, so
 * this logs and stands down deliberately rather than limping. The watchdog
 * starts a clean one.
 */
process.on('uncaughtException', (err) => {
  /*
   * Unless it is a connection ending, which is not an unknown state.
   *
   * On 11 September a remote host reset a connection in the middle of an
   * outbound fetch - a picture somebody had linked - and this took the server
   * down with it. Everybody was disconnected, voice calls included, for the
   * two minutes it took the watchdog to notice, over a link that had nothing
   * to do with this app.
   *
   * The rule is in survivable.ts and is deliberately narrow: network
   * conditions, by name. Anything else still stands down, because the reason
   * for standing down is real.
   */
  if (survivable(err)) {
    app.log.error({ err }, 'a connection ended abruptly; carrying on')
    return
  }
  app.log.fatal({ err }, 'uncaught exception, shutting down for a clean restart')
  setTimeout(() => process.exit(1), 100).unref()
})

app.setErrorHandler((err: FastifyError, req, reply) => {
  const status = err.statusCode ?? 500
  if (status < 500) {
    return reply.code(status).send({ error: err.message })
  }
  req.log.error({ err, url: req.url }, 'request failed')
  return reply.code(500).send({ error: 'something went wrong on the server' })
})

app.addContentTypeParser([...ALLOWED_MIME.keys()], (_req, payload, done) => done(null, payload))

/** Pull the bearer token off a request and resolve it to a user. */
async function authed(req: { headers: Record<string, unknown> }) {
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Bearer ')) return null
  const id = await readToken(header.slice(7))
  return id ? findUser(id) ?? null : null
}

registerAdminRoutes(app, authed as never)
registerPollRoutes(app, authed as never)
registerFeedbackRoutes(app, authed as never, allow)
registerSpaceRoutes(app, authed as never)

// ---------------------------------------------------------------- auth ----

app.post('/api/register', async (req, reply) => {
  const ipKey = `register:${req.ip}`
  if (!allow(ipKey, 10, 60 * 60_000)) {
    const wait = retryAfter(ipKey)
    return reply.code(429).header('retry-after', wait)
      .send({ error: `too many sign-up attempts, try again in ${wait}s` })
  }

  const { username, displayName, password, invite } = (req.body ?? {}) as Record<string, string>

  if (!username || !password) return reply.code(400).send({ error: 'username and password required' })
  if (!/^[a-z0-9_.]{2,24}$/i.test(username)) {
    return reply.code(400).send({ error: 'username must be 2-24 chars: letters, numbers, _ or .' })
  }
  if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' })

  /*
   * Both names, because either one is enough to put a slur on everybody's
   * screen: the username is what @ mentions and the display name is what the
   * member list actually shows.
   *
   * Only at sign-up, which is what was asked for. Worth being plain about
   * what that does and does not cover - a name changed afterwards does not
   * come back through here.
   *
   * The reason is logged and not sent. Telling somebody which word tripped
   * the check is telling them exactly what to edit.
   */
  /*
   * Every account, with no exception for the first one.
   *
   * There used to be one: the account that claimed the install skipped this,
   * on the reasoning that somebody naming themselves on their own machine
   * has nobody to aim a name at. There is no such account any more - this is
   * one app that people sign up to - so the first person through the door is
   * simply the first person, and held to what everybody else is.
   */
  for (const candidate of [username, displayName]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const why = nameProblem(candidate)
    if (why) {
      req.log.info({ why }, 'sign-up refused: name not allowed')
      return reply.code(400).send({ error: NAME_REFUSED })
    }
  }

  /*
   * One name, one person.
   *
   * Four digits after a name is how a service with millions of people lets
   * two of them both be Keeko. This one has six, and among six the collision
   * that machinery exists to solve does not happen - so all it would buy is a
   * number on everybody's name and a thing to explain.
   *
   * The column behind it stays. Removing it means rebuilding the table again
   * for no gain, and leaving it means this is a decision that can be taken
   * back later, when there might actually be enough people to need it.
   */
  if (nameTaken(username)) {
    return reply.code(409).send({ error: 'that name is already taken' })
  }

  /*
   * An invite is checked whenever one is given, open registration or not.
   *
   * This used to be skipped entirely when registration was open - the whole
   * branch was behind `if (!openRegistration)`. Harmless while an invite was
   * the only way in and the flag was off, and a hole the moment it was
   * turned on: joining was keyed on the invite field being non-empty rather
   * than on it being real, so any string at all would have let somebody into
   * the seeded server.
   *
   * An invite that does not work is said out loud rather than ignored.
   * Silently making an account in no server, for somebody who pasted a code
   * they were given, is a worse answer than "that did not work".
   */
  let joining: string | null = null
  if (invite) {
    const row = db.prepare('SELECT space_id FROM invites WHERE code = ?').get(invite) as
      { space_id: string | null } | undefined
    if (!consumeInvite(invite)) {
      return reply.code(403).send({ error: 'that invite is not valid' })
    }
    /* The server the invite is for, and no other. It used to fall back to the
       oldest one, so an invite with no server - which can no longer exist -
       would have walked somebody into the seeded server instead. */
    joining = row?.space_id ?? null
  } else if (!config.openRegistration) {
    /* Signing up is either open or by invitation, and nothing else decides
       it. There used to be a third answer here about an install nobody had
       claimed yet, which no longer exists. */
    return reply.code(403).send({ error: 'a valid invite code is required' })
  }

  /*
   * Bounded here as well as in PATCH /api/me.
   *
   * That route cuts a display name to five hundred characters; this one went
   * straight to createUser, so the only ceiling on the way in was the 1MB
   * body limit - and a display name is carried to everybody in the member
   * list on every connection. Measured: a four thousand character name was
   * accepted and stored whole.
   */
  const shown = (displayName ?? '').trim().slice(0, 500) || username
  const user = await createUser(username, shown, password)

  /*
   * An account on its own is worth nothing until somebody asks it in.
   *
   * Signing up makes an account and joins no servers. Only a real invite
   * does that, and only into the server that invite belongs to - which is
   * what lets the front door stand open safely: somebody who walks up on
   * their own sees an app with nothing in it until they are invited, or
   * until they make a server of their own from the page they land on.
   */
  if (joining) joinSpace(user.id, joining)

  // And tell that server, which member-update below cannot do on its own: it
  // says who somebody is, not which server they are now in.
  if (joining) announceJoin(joining, user.id)

  // Tell everybody already here. Without this a new member is invisible
  // until each person happens to reload, which is a strange welcome:
  // they are in the channel, talking, and absent from the member list.
  pushAboutMember(user.id, { t: 'member-update', user })

  return { user, token: await issueToken(user.id) }
})

app.post('/api/login', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as Record<string, string>

  // Two budgets: one per IP so a single machine cannot spray the whole member
  // list, one per account so an attacker cannot spread attempts across IPs.
  const ipKey = `login-ip:${req.ip}`
  const userKey = `login-user:${String(username ?? '').toLowerCase()}`
  if (!allow(ipKey, 20, 10 * 60_000) || !allow(userKey, 10, 10 * 60_000)) {
    const wait = Math.max(retryAfter(ipKey), retryAfter(userKey))
    return reply.code(429).header('retry-after', wait)
      .send({ error: `too many attempts, try again in ${wait}s` })
  }

  /*
   * A bare name is enough, and the password says which account it meant.
   *
   * Nobody should have to recite four digits to get into their own account.
   * The digits exist so two people can share a name, and the password is
   * already the thing only the right person has - so where a name is shared,
   * it is the password that picks, not a guess about who is likeliest.
   *
   * Every candidate is checked rather than stopping at the first match, so
   * that the impossible-but-real case of two people sharing both a name and a
   * password is caught and refused instead of quietly signing somebody into
   * somebody else's account.
   */
  const candidates = username ? loginCandidates(username) : []
  let row: (typeof candidates)[number] | null = null
  let matched = 0
  for (const candidate of candidates) {
    if (await verifyPassword(password ?? '', candidate.pass_hash, candidate.pass_salt)) {
      row = candidate
      matched += 1
    }
  }

  /*
   * One answer for every failure, including "more than one of you matched".
   *
   * Saying that out loud looked harmless - you can only reach it by proving a
   * password - but it is a password oracle. Register as Keeko, try signing in
   * as bare Keeko with a guess, and a different error means some other Keeko
   * uses that password. Run a wordlist and login becomes a way to test
   * passwords against everybody who shares a name, without ever needing to
   * know which one it hit.
   *
   * So an ambiguous match is refused exactly like a wrong password, and with
   * exactly the same words. One sentence for every failure is the whole of
   * what keeps them indistinguishable: a message that said which one it was
   * would tell an attacker that the name exists and is shared, which is the
   * thing being protected.
   *
   * It used to carry advice about typing the digits after a name, with a
   * real account as the example. That named somebody: a sign-in page anybody
   * can reach should not confirm who has an account here.
   */
  if (matched > 1) row = null

  if (!row) {
    return reply.code(401).send({ error: 'Invalid username or password' })
  }

  reset(userKey)
  return { user: findUser(row.id), token: await issueToken(row.id) }
})

/**
 * Change a password.
 *
 * The current one is required, so somebody who walks up to an unlocked
 * machine cannot lock the owner out of their own account. Every other
 * session ends: if the reason for changing it is that somebody else has it,
 * leaving their token working would defeat the whole exercise. This session
 * gets a fresh token so the person doing it is not signed out of the tab
 * they are standing in.
 */
app.post('/api/me/password', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const key = `password:${user.id}`
  if (!allow(key, 5, 15 * 60_000)) {
    return reply.code(429).header('retry-after', retryAfter(key))
      .send({ error: 'too many attempts, try again shortly' })
  }

  const { current, next } = (req.body ?? {}) as Record<string, string>
  if (typeof next !== 'string' || next.length < 8) {
    return reply.code(400).send({ error: 'the new password must be at least 8 characters' })
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as
    unknown as { pass_hash: string; pass_salt: string } | undefined
  if (!row || !(await verifyPassword(current ?? '', row.pass_hash, row.pass_salt))) {
    return reply.code(403).send({ error: 'that is not your current password' })
  }

  const { hash, salt } = await hashPassword(next)
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, user.id)
  revokeSessions(user.id)
  writeAudit(user.id, 'account.password', user.username)

  // Minted after the revocation, so it is the only one left standing.
  return { token: await issueToken(user.id) }
})

/*
 * Sign out — this session, and only this one.
 *
 * The client has always called this and it has never existed: the request
 * 404'd into a silent catch, the browser forgot its token, and the token went
 * on working for the rest of its thirty days. Anybody holding a copy still
 * had the account, and the only thing that ended a session was changing the
 * password, which ends every session everywhere.
 *
 * No body, no arguments: what gets signed out is whatever the caller is
 * holding, which is the only session it has any business ending.
 */
app.post('/api/logout', async (req, reply) => {
  /* Keyed on the address rather than the account, because the account is
     read out of the very token this is about — and a request holding a
     rubbish one has no account to key on. Signing out is something a person
     does once; twenty a minute is already far past anything real. */
  if (!allow(`logout:${req.ip}`, 20, 60_000)) {
    return reply.code(429).send({ error: 'too many attempts. wait a moment' })
  }
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorised' })
  const held = await tokenIdOf(header.slice(7))
  /* A token minted before tokens carried an id cannot be ended on its own.
     Saying so plainly beats reporting a sign-out that did not happen — though
     in practice the client has already forgotten it either way. */
  if (!held) return reply.send({ ok: true, revoked: false })
  revokeToken(held.jti, held.exp)
  return reply.send({ ok: true, revoked: true })
})

app.get('/api/me', async (req, reply) => {
  const user = await authed(req as never)
  return user ? { user } : reply.code(401).send({ error: 'not signed in' })
})

// ------------------------------------------------------------ messages ----

/**
 * Which server a channel belongs to.
 *
 * Every permission inside a channel has to be judged in that channel's own
 * server. Left off, permissionsFor falls back to the first one - so reading
 * history, searching and speaking in voice were all decided by whether you
 * held the permission in the original server, whatever server you were
 * actually in. Null for a DM, which belongs to no server and is governed by
 * being in it.
 */
function spaceOfChannel(channelId: string): string | null {
  const row = db.prepare('SELECT space_id FROM channels WHERE id = ?').get(channelId) as
    { space_id: string | null } | undefined
  /*
   * Null when there is no server, which is what the paragraph above always
   * said and what this did not do.
   *
   * It fell back to the first server, so a conversation - which has no
   * space_id at all - was judged by whatever the asker holds in the seeded one.
   * The mute check below is the one that mattered: `serverMuted` is asked on
   * every voice token, conversations included, and it takes null to mean
   * "nowhere to be muted". Handed the first server instead, a mute applied
   * there followed somebody into their private one-to-one calls - which is
   * word for word the fault the comment beside that call says was fixed.
   *
   * Fails closed for the other caller. A voice channel always has a server,
   * so nothing legitimate reaches the fallback; an orphaned one now answers
   * "no permissions here" rather than borrowing another server's.
   */
  return row?.space_id ?? null
}


app.get('/api/channels/:id/messages', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }

  // A private channel is readable only by its members. Without this check the
  // endpoint would hand anyone else's DMs to any signed-in member.
  if (isDirect(id) && !dmMembers(id).includes(user.id)) {
    return reply.code(403).send({ error: 'that conversation is not yours' })
  }

  // read_history is a real permission, not a decorative toggle. A DM is
  // always readable by its own members regardless.
  if (!isDirect(id)) {
    if (!canAccessChannel(user.id, id)) {
      return reply.code(403).send({ error: 'you cannot read that channel' })
    }
    // In this channel, not in whichever server comes first - and in the
    // channel rather than the server, so a channel that takes reading away
    // from a role actually takes it away.
    const mine = permissionsIn(user.id, id)
    if (!mine.has('view_channels') || !mine.has('read_history')) {
      return reply.code(403).send({ error: 'you cannot read the history here' })
    }
  }

  const { before, limit } = req.query as { before?: string; limit?: string }
  /*
   * A ceiling that is actually a ceiling.
   *
   * Math.min(Number(x), 200) looks like one and is not. SQLite reads LIMIT -1
   * as "no limit", and a limit that is not a number at all becomes NaN, which
   * binds as null and makes node:sqlite throw - so ?limit=-1 handed back every
   * message in the channel in one response, and ?limit=abc answered 500.
   * Measured: 240 of 240 rows against a stated cap of 200.
   *
   * Clamped at both ends, and anything unreadable falls back to the default
   * rather than being passed through to be interpreted by the database.
   */
  const asked = Math.floor(Number(limit))
  const take = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 60

  /*
   * The same for `before`, which is a timestamp to page back from.
   *
   * Unreadable input binds as null here too, and `created_at < null` is never
   * true - so a bad cursor answered "no more messages" rather than saying it
   * could not read the cursor. Quieter than a 500 and just as wrong.
   */
  const cursor = Number(before)
  const from = before !== undefined && Number.isFinite(cursor) ? cursor : null

  // Two statements rather than one clever one: node:sqlite does not allow
  // mixing positional and named binding in the same query.
  const rows = from !== null
    ? db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
          ORDER BY created_at DESC LIMIT ?`
      ).all(id, from, take)
    : db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT ?`
      ).all(id, take)

  const ordered = (rows as unknown as MessageRow[]).reverse()
  return { messages: hydrate(ordered, user.id) }
})

/**
 * Turn what someone typed into an FTS5 query.
 *
 * FTS5 has its own query language, and the search box does not: to it, `-`
 * is NOT, `:` is a column filter, and a lone quote is a syntax error. Passing
 * raw input through means "it's", "well-known" and an email address all fail
 * the request outright, which is most of what people actually search for.
 *
 * So take the words and nothing else, quote each one as a literal, and let
 * the last one match by prefix so results appear while still typing.
 */
function ftsQuery(raw: string): string {
  const words = raw.match(/[\p{L}\p{N}_]+/gu)
  if (!words?.length) return ''
  const quoted = words.slice(0, 12).map((w) => `"${w.replace(/"/g, '""')}"`)
  quoted[quoted.length - 1] += '*'
  return quoted.join(' ')
}

/**
 * ICE servers for screen sharing.
 *
 * STUN is what lets two home connections find each other; it is free, public,
 * and carries no traffic beyond a couple of packets. Most pairs need nothing
 * else.
 *
 * TURN is the fallback for the pairs that cannot connect directly - roughly
 * one in six, usually a strict corporate or mobile NAT. A TURN server relays
 * the packets but cannot read them: the media is encrypted end to end between
 * the two people, so this stays private even though the bytes pass through
 * somebody else's machine.
 *
 * Credentials are short-lived and minted per request, so nothing long-lived
 * is ever handed to a client.
 */
/* ------------------------------------------------------------ cover art --
 * A picture travels once; its name travels after that.
 *
 * Presence used to carry the cover itself, which sent a few kilobytes to
 * everybody who could see somebody on every track change - almost all of it
 * for profiles nobody opened. Now the name is the hash of the bytes, which is
 * both an address that can never go stale and a receipt that cannot be forged.
 */
/**
 * Collect a stream, up to a point.
 *
 * Null for anything over the limit rather than a truncated picture, because a
 * truncated one would hash to something nobody asked for and be refused a
 * moment later for a reason that says nothing about what went wrong.
 */
async function readAtMost(body: unknown, limit: number): Promise<Buffer | null> {
  if (Buffer.isBuffer(body)) return body.length <= limit ? body : null
  const stream = body as AsyncIterable<Buffer> | null
  if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    return null
  }
  const parts: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > limit) return null
    parts.push(chunk)
  }
  return total > 0 ? Buffer.concat(parts) : null
}

app.head('/api/art/:hash', async (req, reply) => {
  const { hash } = req.params as { hash: string }
  return reply.code(art.has(hash) ? 200 : 404).send()
})

app.put('/api/art/:hash', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })
  if (!allow(`art:${user.id}`, 60, 60_000)) {
    return reply.code(429).send({ error: 'too many covers at once' })
  }

  const { hash } = req.params as { hash: string }

  /*
   * A stream, not a buffer.
   *
   * Image types already have a parser here - the one uploads use - and it
   * hands the payload through untouched so a large file never has to be held
   * in memory. So `req.body` on this route is a readable stream, and the
   * first version of it tested for a Buffer, found none, and refused every
   * cover with a 400 while the client dutifully tried again on each track.
   *
   * Read with a limit rather than to the end: this is a thumbnail, and a
   * client that sent a gigabyte should be cut off rather than believed.
   */
  const bytes = await readAtMost(req.body, art.MAX_ART_BYTES)
  if (!bytes) return reply.code(400).send({ error: 'send the picture as bytes' })

  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim()
  /*
   * Nothing is trusted here, because nothing has to be: keep() re-hashes what
   * arrived and refuses it unless it really is the picture the name is for.
   * So the worst a client can do is store its own picture under its own name.
   */
  if (!art.keep(hash, type, bytes)) {
    return reply.code(400).send({ error: 'that is not a cover, or not the one it claims to be' })
  }
  return reply.send({ ok: true })
})

/*
 * Read without a token on purpose.
 *
 * An <img> cannot carry an authorization header, and the alternatives are a
 * cookie or a query string that would end up in logs. The hash is the
 * permission: two hundred and fifty-six bits of it, handed only to the people
 * already allowed to see that person's presence. Not knowing it is the same
 * as not being told.
 */
app.get('/api/art/:hash', async (req, reply) => {
  const { hash } = req.params as { hash: string }
  const found = art.find(hash)
  if (!found) return reply.code(404).send({ error: 'no such cover' })
  return reply
    .header('content-type', found.type)
    .header('x-content-type-options', 'nosniff')
    /* The address is the content, so this can never be the wrong picture and
       a browser need never ask twice. */
    .header('cache-control', 'public, max-age=31536000, immutable')
    .send(found.bytes)
})

app.get('/api/rtc/ice', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  // Each miss costs a call to somebody else's API, so this is one of the few
  // read routes worth a budget. Joining a share needs one.
  if (!allow(`ice:${user.id}`, 30, 60_000)) {
    return reply.code(429).header('retry-after', retryAfter(`ice:${user.id}`))
      .send({ error: 'too many requests' })
  }

  const iceServers: Array<Record<string, unknown>> = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  ]

  /**
   * Relays are additive.
   *
   * A browser is given the whole list and picks whatever answers, so a second
   * provider is pure resilience: if one is misconfigured or unreachable, the
   * pairs that cannot connect directly still get through instead of failing
   * as a share that never starts. One provider being down is otherwise
   * invisible until somebody complains.
   */
  if (config.meteredApiUrl) {
    try {
      const res = await fetch(config.meteredApiUrl, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const got = (await res.json()) as unknown
        if (Array.isArray(got)) iceServers.push(...(got as Array<Record<string, unknown>>))
      } else {
        app.log.warn({ status: res.status }, 'secondary turn provider refused')
      }
    } catch (err) {
      app.log.warn({ err }, 'could not reach the secondary turn provider')
    }
  }

  if (config.turnKeyId && config.turnApiToken) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${config.turnKeyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.turnApiToken}`,
            'content-type': 'application/json',
          },
          // Long enough for a session, short enough to be worthless if leaked.
          body: JSON.stringify({ ttl: 4 * 60 * 60 }),
          // A slow relay provider must not become a slow app.
          signal: AbortSignal.timeout(4000),
        }
      )
      if (res.ok) {
        const body = (await res.json()) as { iceServers?: unknown }
        const got = body.iceServers
        if (Array.isArray(got)) iceServers.push(...got)
        else if (got && typeof got === 'object') iceServers.push(got as Record<string, unknown>)
      } else {
        app.log.warn({ status: res.status }, 'turn credentials refused')
      }
    } catch (err) {
      // Losing TURN costs some people their screen share; it must never cost
      // everybody the request.
      app.log.warn({ err }, 'could not reach the turn service')
    }
  }

  return { iceServers }
})

/**
 * Pinned messages.
 *
 * Pinning is a moderation act rather than a personal bookmark: one pin list
 * per channel, visible to everyone in it. So it needs manage_messages, the
 * same permission that lets somebody delete other people's posts.
 */
/**
 * What to be told about one channel.
 *
 * On the account, not in the browser: muting from a phone has to mute on the
 * desktop too, and the flag this replaces lived in localStorage and did not.
 *
 * Anyone who can read a channel may set their own preferences for it - this
 * changes nothing anybody else can see, so it needs no permission beyond
 * being able to open the channel in the first place.
 */
/**
 * What to be told about a whole server.
 *
 * The thing a channel set to "use my default" defers to. Same shape as the
 * channel version beneath it, and for the same reasons - a duration rather
 * than a deadline, every field optional, and your own other windows told.
 */
app.put('/api/spaces/:id/prefs', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  /* Only for a server you are in. Somebody can hold a preference about a
     place they have left, but they cannot make one about a place they have
     never been - and the row would outlive nothing useful. */
  if (!isSpaceMember(user.id, id)) {
    return reply.code(403).send({ error: 'you are not in that server' })
  }

  const body = (req.body ?? {}) as {
    level?: string; muteFor?: number | null; suppressEveryone?: boolean
  }
  const patch: {
    level?: 'all' | 'mentions' | 'nothing'
    mutedUntil?: number | null
    suppressEveryone?: boolean
  } = {}

  if (body.level !== undefined) {
    /*
     * No 'default' here, unlike a channel. This *is* the default - a server
     * deferring to itself is a question with no answer, and accepting the
     * word would store a level that nothing could resolve.
     */
    if (!['all', 'mentions', 'nothing'].includes(body.level)) {
      return reply.code(400).send({ error: 'that is not a notification setting' })
    }
    patch.level = body.level as typeof patch.level
  }

  /* A duration rather than a deadline, for the same reason as a channel: a
     client sending its own "until" is sending its own clock. */
  if (body.muteFor !== undefined) {
    if (body.muteFor === null) patch.mutedUntil = null
    else if (typeof body.muteFor !== 'number' || body.muteFor < 0 || body.muteFor > 30 * 86400_000) {
      return reply.code(400).send({ error: 'that is not a length of time' })
    } else {
      patch.mutedUntil = body.muteFor === 0 ? MUTED_INDEFINITELY : Date.now() + body.muteFor
    }
  }

  if (body.suppressEveryone !== undefined) {
    if (typeof body.suppressEveryone !== 'boolean') {
      return reply.code(400).send({ error: 'that is not a yes or a no' })
    }
    patch.suppressEveryone = body.suppressEveryone
  }

  const pref = setSpacePref(user.id, id, patch)
  /* Your own other windows, the same as a channel: muting a server on one
     machine must not leave it ringing on another. */
  pushToUsers([user.id], { t: 'space-prefs-changed', pref })
  return { pref }
})

app.put('/api/channels/:id/prefs', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  if (isDirect(id)) {
    if (!dmMembers(id).includes(user.id)) {
      return reply.code(403).send({ error: 'that conversation is not yours' })
    }
  } else if (!canAccessChannel(user.id, id)) {
    return reply.code(403).send({ error: 'you cannot read that channel' })
  }

  const body = (req.body ?? {}) as { level?: string; muteFor?: number | null }
  const patch: { level?: 'default' | 'all' | 'mentions' | 'nothing'; mutedUntil?: number | null } = {}

  if (body.level !== undefined) {
    if (!['default', 'all', 'mentions', 'nothing'].includes(body.level)) {
      return reply.code(400).send({ error: 'that is not a notification setting' })
    }
    patch.level = body.level as typeof patch.level
  }

  /*
   * A duration rather than a deadline, deliberately.
   *
   * A client sending its own "until" would be sending its own clock, and a
   * phone an hour out would mute for an hour too long or not at all. null
   * unmutes, and 0 means until it is turned back on.
   */
  if (body.muteFor !== undefined) {
    if (body.muteFor === null) patch.mutedUntil = null
    else if (typeof body.muteFor !== 'number' || body.muteFor < 0 || body.muteFor > 30 * 86400_000) {
      return reply.code(400).send({ error: 'that is not a length of time' })
    } else {
      patch.mutedUntil = body.muteFor === 0 ? MUTED_INDEFINITELY : Date.now() + body.muteFor
    }
  }

  const pref = setChannelPref(user.id, id, patch)
  /*
   * Your own other windows again.
   *
   * Muting a channel on one machine left it ringing on another, which is the
   * opposite of what somebody muting a channel is asking for.
   */
  pushToUsers([user.id], { t: 'prefs-changed', pref })
  return { pref }
})

/**
 * Mark the pins of a channel as looked at.
 *
 * Called when somebody opens the panel. Separate from reading the channel:
 * scrolling past the line that says something was pinned is not the same as
 * having looked at what it was, and the icon is where a pin lives once the
 * announcement has scrolled away.
 */
app.post('/api/channels/:id/pins/seen', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  // Somewhere they can actually read, or this is a way to write rows about
  // channels they cannot see.
  if (isDirect(id)) {
    if (!dmMembers(id).includes(user.id)) return reply.code(403).send({ error: 'not yours' })
  } else if (!canAccessChannel(user.id, id)) {
    return reply.code(403).send({ error: 'not yours' })
  }

  db.prepare(
    `INSERT INTO channel_prefs (user_id, channel_id, pins_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET pins_seen_at = excluded.pins_seen_at`
  ).run(user.id, id, Date.now())
  return { ok: true }
})

app.get('/api/channels/:id/pins', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  if (isDirect(id) && !dmMembers(id).includes(user.id)) {
    return reply.code(403).send({ error: 'that conversation is not yours' })
  }
  if (!isDirect(id) && (
    !canAccessChannel(user.id, id) ||
    !permissionsIn(user.id, id).has('read_history')
  )) {
    return reply.code(403).send({ error: 'you cannot read that channel' })
  }

  const rows = db.prepare(
    `SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND pinned_at IS NOT NULL
      ORDER BY pinned_at DESC LIMIT 100`
  ).all(id)
  return { messages: hydrate(rows as unknown as MessageRow[], user.id) }
})

app.post('/api/messages/:id/pin', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  const { pinned } = (req.body ?? {}) as { pinned?: boolean }

  const row = db.prepare('SELECT channel_id FROM messages WHERE id = ? AND deleted_at IS NULL').get(id) as
    unknown as { channel_id: string } | undefined
  if (!row) return reply.code(404).send({ error: 'no such message' })

  // In a DM there is nobody to moderate, so any participant may pin.
  const isDm = isDirect(row.channel_id)
  if (isDm) {
    if (!dmMembers(row.channel_id).includes(user.id)) {
      return reply.code(403).send({ error: 'that conversation is not yours' })
    }
  } else {
    /*
     * Either permission. manage_pins is the one that says pinning;
     * manage_messages is the heavier one that used to be the only way to get
     * it, and taking it away from people who have it would be a change
     * nobody asked for.
     */
    const mine = permissionsIn(user.id, row.channel_id)
    if (!mine.has('manage_pins') && !mine.has('manage_messages')) {
      return reply.code(403).send({ error: 'you need the pin messages permission' })
    }
  }

  if (pinned === false) {
    db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(id)
  } else {
    db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?')
      .run(Date.now(), user.id, id)
  }

  const updated = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(id)
  const message = hydrate([updated as unknown as MessageRow], user.id)[0]
  pushChannelEvent({ t: 'message-update', message })

  /*
   * A line in the conversation saying it happened.
   *
   * Pinning is otherwise silent: the message gets a mark that only shows if
   * you happen to be looking at it, and it joins a panel behind an icon
   * nobody has a reason to open. So it is announced where the conversation
   * is, and then scrolls away like anything else - which is why this is a
   * message rather than a banner somebody has to dismiss.
   *
   * Only on pinning. Unpinning quietly is fine; a line announcing that
   * somebody unpinned something is housekeeping nobody needs read out.
   */
  if (pinned !== false) {
    const noteId = randomUUID()
    db.prepare(
      `INSERT INTO messages (id, channel_id, author_id, body, created_at, kind)
       VALUES (?, ?, ?, '', ?, 'pin')`
    ).run(noteId, row.channel_id, user.id, Date.now())
    // deleted_at guarded like every other read of this table. The row was
    // written a line ago and cannot be deleted yet - but the rule is that no
    // query reads a message back without asking, and a query that is right by
    // luck is the one that gets copied somewhere it is wrong.
    const note = db.prepare(
      'SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL'
    ).get(noteId)
    pushChannelEvent({
      t: 'message',
      message: hydrate([note as unknown as MessageRow], user.id)[0],
    })
  }

  return { message }
})

app.get('/api/search', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { q } = req.query as { q?: string }
  if (!q || q.length < 2) return { results: [] }

  /*
   * The filters come out first, and what is left is what to match on.
   *
   * `from:bailey in:general has:image` is a real search with no words in it -
   * so the words are optional now, and a search with none of them skips the
   * full-text index entirely rather than matching everything and filtering
   * afterwards. searchQuery.ts is the little language and is tested on its
   * own; this is what the answers mean.
   */
  const terms = parseSearch(q)
  if (isEmptySearch(terms)) return { results: [] }

  const match = terms.text ? ftsQuery(terms.text) : ''
  if (terms.text && !match) return { results: [] }

  /*
   * A person, by whichever name the searcher knows them by.
   *
   * Their username, their display name, or the nickname they wear in a
   * server. Names are not unique across those, so this takes everybody who
   * answers to it rather than picking one - "from:jack" meaning three people
   * is a better answer than it silently meaning the wrong one.
   */
  const whoFilter: string[] = []
  if (terms.from) {
    const like = `%${terms.from.replace(/[%_\\]/g, '\\$&')}%`
    const found = db.prepare(
      `SELECT DISTINCT u.id AS id FROM users u
         LEFT JOIN member_nicknames n ON n.user_id = u.id
        WHERE u.username LIKE ? ESCAPE '\\'
           OR u.display_name LIKE ? ESCAPE '\\'
           OR n.nickname LIKE ? ESCAPE '\\'
        LIMIT 25`
    ).all(like, like, like) as Array<{ id: string }>
    /* Nobody by that name is an empty result rather than no filter at all -
       otherwise a typo quietly widens the search instead of narrowing it. */
    if (!found.length) return { results: [] }
    for (const r of found) whoFilter.push(r.id)
  }

  /* And a channel, by name, among the ones that exist. Same rule: a name
     nothing answers to means nothing found. */
  const whereFilter: string[] = []
  if (terms.in) {
    const like = `%${terms.in.replace(/[%_\\]/g, '\\$&')}%`
    const found = db.prepare(
      `SELECT id FROM channels WHERE name LIKE ? ESCAPE '\\' LIMIT 25`
    ).all(like) as Array<{ id: string }>
    if (!found.length) return { results: [] }
    for (const r of found) whereFilter.push(r.id)
  }

  /* Built as text because the number of ids is not known until now, and every
     one of them is still bound - the SQL carries `?`, never a value. */
  const holes = (n: number): string => Array.from({ length: n }, () => '?').join(', ')
  const extra: string[] = []
  /* Strings throughout: every bound value here is an id or a millisecond, and
     the driver's own input type is what keeps it that way. */
  const bound: Array<string | number> = []
  if (whoFilter.length) {
    extra.push(`AND m.author_id IN (${holes(whoFilter.length)})`)
    bound.push(...whoFilter)
  }
  if (whereFilter.length) {
    extra.push(`AND m.channel_id IN (${holes(whereFilter.length)})`)
    bound.push(...whereFilter)
  }
  if (terms.before !== undefined) { extra.push('AND m.created_at < ?'); bound.push(terms.before) }
  if (terms.after !== undefined) { extra.push('AND m.created_at >= ?'); bound.push(terms.after) }
  if (terms.has === 'link') {
    /* What the message renderer calls a link is an http address in the body.
       Asked of the text rather than of a table, because links are not stored
       anywhere - they are read out of the words every time they are drawn. */
    extra.push("AND (m.body LIKE '%http://%' OR m.body LIKE '%https://%')")
  }
  if (terms.has === 'image') {
    extra.push("AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.mime LIKE 'image/%')")
  }
  if (terms.has === 'file') {
    extra.push('AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)')
  }
  if (terms.has === 'poll') {
    extra.push('AND EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id)')
  }
  const filters = extra.length ? ' ' + extra.join(' ') : ''

  /*
   * Two shapes of the same question.
   *
   * With words, the full-text index decides which rows and in what order, and
   * the filters narrow what it found. With no words - "everything Bailey
   * posted a picture of" - there is nothing to match on and nothing to rank
   * by, so the index is not touched at all and the newest come first. Running
   * the index over a match-everything query instead would be the same answer
   * arrived at expensively.
   *
   * `?` is bound throughout, including every id in the filters: the only
   * thing built as text is how many holes to leave.
   *
   * The conversation clause keeps private conversations out of everybody
   * else's results - a search box is the easiest place to leak a DM by
   * accident.
   */
  const mine = `AND (
            c.kind IN ('text', 'voice')
            OR EXISTS (
              SELECT 1 FROM container_members cm
                JOIN containers k ON k.id = cm.container_id AND k.kind IN ('dm','group')
               WHERE cm.container_id = c.id AND cm.user_id = ?
            )
          )`

  const results = match
    ? db.prepare(
        `SELECT m.* FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN channels c ON c.id = m.channel_id
          WHERE messages_fts MATCH ?
            AND m.deleted_at IS NULL
            ${mine}${filters}
          ORDER BY rank
          LIMIT 50`
      ).all(match, user.id, ...bound)
    : db.prepare(
        `SELECT m.* FROM messages m
           JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted_at IS NULL
            ${mine}${filters}
          ORDER BY m.created_at DESC
          LIMIT 50`
      ).all(user.id, ...bound)

  // Private channels are filtered after the query rather than inside it: the
  // access rule involves roles and individual members, which is more than an
  // FTS join wants to carry. A search box is the easiest place in an app to
  // leak something by accident, so this happens on every result.
  const reachable = accessibleChannelIds(user.id)
  /*
   * And being able to see a channel is not being able to read what was said
   * in it before you arrived.
   *
   * read_history was never asked here, which cost nothing while it could
   * only be given or withheld across a whole server: somebody without it saw
   * no history anywhere, so there was nothing for a search to reveal. A
   * channel can now take it away on its own, and the search box is the
   * easiest place in an app to hand back exactly what was just withheld.
   *
   * Cached per channel, because a search returns up to fifty rows and they
   * cluster into a handful of channels - resolving the overrides once per
   * result would resolve them fifty times to get five answers.
   */
  const mayRead = new Map<string, boolean>()
  const readable = (channelId: string): boolean => {
    const known = mayRead.get(channelId)
    if (known !== undefined) return known
    const answer = permissionsIn(user.id, channelId).has('read_history')
    mayRead.set(channelId, answer)
    return answer
  }
  // A conversation has already been vetted by the query above, which only
  // returns DMs the searcher belongs to. Everything else has to be reachable.
  const visible = (results as unknown as MessageRow[]).filter(
    (m) => isDirect(m.channel_id) || (reachable.has(m.channel_id) && readable(m.channel_id))
  )

  return { results: visible }
})

// ------------------------------------------------------------- uploads ----

/**
 * Stream a request body to disk under a generated name.
 *
 * Shared by the attachment endpoint and the avatar/banner endpoints so the
 * size ceiling and the never-trust-the-filename rule only exist in one place.
 */
/**
 * How much room the disk must keep for everything that is not a picture.
 *
 * The database and its log grow with every message; the nightly backup needs
 * space to write a snapshot before it can compress one. A gigabyte is forty
 * times the largest upload allowed, which is the point: this is a floor for
 * the things that cannot be asked to wait, not a tight fit for one more file.
 */
const FREE_SPACE_FLOOR = 1024 * 1024 * 1024

/**
 * What somebody is told when there is nowhere to put their file.
 *
 * One string, in one place, because it is not only a message: two checks
 * below recognise this refusal by reading it back, so it is control flow
 * wearing a sentence. It used to say "this server is out of disk space -
 * tell whoever runs it", which was wrong twice over - it called the machine
 * a server, which now means something else entirely to whoever reads it,
 * and it made somebody using an app responsible for the hardware under it.
 *
 * Rewording it broke both checks the moment it was tried: the floor's own
 * refusal stopped being recognised and was swallowed, and an out-of-space
 * write started being reported as a file that was too large - the exact lie
 * the code below exists to prevent. Matched by identity now rather than by
 * prefix or by a fragment, so the next person to reword it cannot.
 */
const NO_ROOM = 'there is no room to store that right now - try again later'

async function streamToDisk(
  req: any, ext: string, mime: string,
  /**
   * Who is uploading, so it can be written down.
   *
   * Nothing recorded this, which is why the attach step could not check it:
   * the message named a path and the server believed the message. Taken here
   * rather than at the call sites because this is the only place that knows
   * the stored name and the true size at the same moment.
   */
  uploaderId: string,
): Promise<{ id: string; url: string; bytes: number }> {
  const id = randomUUID()
  const stored = `${id}${ext}`
  const target = resolve(config.uploadDir, stored)

  // Reject early when the client declares an oversized body, so we do not
  // stream 500 MB to disk before noticing.
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > config.maxUploadBytes) throw new Error('that file is larger than we allow')

  /*
   * And refuse before writing anything if the disk is nearly full.
   *
   * Everything shares one disk here - the database, its write-ahead log, the
   * uploads, the nightly backups and the operating system. The
   * health page has always read the free space and nothing has ever acted on
   * it, so uploads would go on being accepted until a write failed, and the
   * write that fails need not be the upload: SQLite writing a message can be
   * the thing that runs out of room. Pictures are the part that can wait, so
   * pictures are the part that stops first.
   *
   * A gigabyte is far more than any one upload - twenty-five megabytes is the
   * ceiling - and is meant to leave the database, the log and a backup room
   * to work in rather than to be a tight fit.
   */
  try {
    const room = await statfs(config.uploadDir)
    const free = room.bavail * room.bsize
    if (free < FREE_SPACE_FLOOR) {
      throw new Error(NO_ROOM)
    }
  } catch (err) {
    /* A filesystem that will not answer is not a reason to refuse an upload;
       only an answer below the floor is. */
    if (err instanceof Error && err.message === NO_ROOM) throw err
  }

  // Count bytes inside the pipeline rather than with a `data` listener — a
  // listener switches the stream to flowing mode before the writer attaches,
  // which can drop the first chunk.
  let bytes = 0
  // Enough of the beginning to recognise the format, kept until there is
  // enough of it to judge - the first chunk off a socket can be tiny.
  let head: Buffer = Buffer.alloc(0)
  let judged = false

  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length
      if (bytes > config.maxUploadBytes) return cb(new Error('too large'))

      if (!judged) {
        head = head.length ? Buffer.concat([head, chunk]) : Buffer.from(chunk)
        if (head.length >= SNIFF_BYTES) {
          judged = true
          if (!looksLike(mime, head)) {
            return cb(new Error(`that file is not ${mime}`))
          }
          head = Buffer.alloc(0)
        }
      }
      cb(null, chunk)
    },
    flush(cb) {
      // A file too short to have been judged has also never been shown to be
      // what it claims. Nothing legitimate on the allowed list is this small.
      if (!judged) return cb(new Error('that file is too short to be what it says it is'))
      cb(null)
    },
  })

  try {
    await pipeline(req.raw, meter, createWriteStream(target))
  } catch (err) {
    await unlink(target).catch(() => {})
    // The size limit and the format check both land here, and they are not
    // the same complaint - saying "too large" about a renamed executable
    // sends somebody looking in entirely the wrong place.
    /*
     * Running out of room says so, rather than being rewritten as "too
     * large".
     *
     * Everything that was not a format complaint used to come back as the
     * size ceiling, so a full disk told somebody their file was too big -
     * sending them off to shrink a file that was never the problem, on a
     * server where no file of any size would have worked.
     */
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new Error(NO_ROOM)
    }
    throw err instanceof Error
      && (err.message === NO_ROOM || /not |too short/.test(err.message))
      ? err
      : new Error('that file is larger than we allow')
  }

  rememberUpload(stored, uploaderId, mime, bytes)
  return { id, url: signPath(`/uploads/${stored}`), bytes }
}

app.post('/api/upload', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  // A per-file ceiling does not stop someone uploading a thousand files.
  if (!allow(`upload:${user.id}`, 40, 60_000)) {
    return reply.code(429).send({ error: 'too many uploads at once, give it a minute' })
  }

  const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim()
  const ext = ALLOWED_MIME.get(mime)
  if (!ext) return reply.code(415).send({ error: `${mime || 'unknown type'} is not allowed` })

  // The client-supplied name is kept only as a display label. It never
  // influences where the file lands or how it is served.
  const originalName = String(req.headers['x-filename'] ?? 'file').slice(0, 200)

  try {
    const saved = await streamToDisk(req, ext, mime, user.id)
    return { ...saved, filename: originalName, mime }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'upload failed'
    // Too big and not-what-it-claims are different problems, and answering
    // "too large" about a renamed file sends somebody looking in entirely
    // the wrong place.
    const wrongType = /is not |too short/.test(detail)
    return reply.code(wrongType ? 415 : 413).send({ error: detail })
  }
})

registerAvatarRoutes(app, authed as never, async (req: any, mime: string, uploaderId: string) => {
  const ext = ALLOWED_MIME.get(mime)!
  return streamToDisk(req, ext, mime, uploaderId)
}, saveFromUrl)
// ----------------------------------------------------------------- gifs ----

app.get('/api/gifs', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const provider = gifProvider()
  if (!provider) return { provider: null, gifs: [] }

  const { q, offset } = req.query as { q?: string; offset?: string }
  // Paging, so the picker can keep loading rather than showing one
  // screenful and stopping. Bounded, so a crafted offset cannot walk
  // the provider's whole catalogue in a single request.
  const from = Math.max(0, Math.min(Number(offset) || 0, 500))
  // One search per keystroke would burn the quota; the client debounces, and
  // this caps it regardless.
  if (!allow(`gifs:${user.id}`, 60, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  try {
    const gifs = q && q.trim().length >= 2
      ? await searchGifs(q.trim(), 48, from)
      : await trendingGifs(48, from)
    return { provider, gifs, offset: from }
  } catch (err) {
    /*
     * Being out of budget is not a failure, and saying "unavailable" for it
     * sends somebody looking for a broken server. The provider's own limit is
     * shared by everybody here and it refills; the message should say so.
     */
    if (err instanceof Error && err.message === OVER_BUDGET) {
      req.log.info('gif search over the hourly provider budget')
      return reply.code(429).send({
        error: 'The GIF picker has done a lot of searching this hour. Anything already searched for still works — new searches will be back shortly.',
      })
    }
    req.log.warn({ err }, 'gif search failed')
    return reply.code(502).send({ error: 'GIF search is unavailable right now' })
  }
})

/**
 * Show a linked image without telling its host who is looking.
 *
 * Every reader fetching the image themselves would hand their IP address to
 * whoever posted the link. The server fetches it once instead. See media.ts
 * for why this endpoint is as narrow as it is.
 */
/**
 * Which build of the web client is on disk.
 *
 * The browser cannot update itself: a new build only reaches somebody when
 * they reload. Without a way to notice, people keep running whichever
 * version they first loaded, sometimes for days, and report bugs that were
 * fixed a week ago.
 *
 * The identity is the built index.html - it changes whenever the client is
 * rebuilt, because the asset filenames inside it are content hashed.
 */
/**
 * What a link is.
 *
 * Cached in memory: a channel full of the same link would otherwise fetch it
 * once per reader per render, which is rude to the site and slow for us.
 */
const previewCache = new Map<string, { at: number; value: unknown }>()
const PREVIEW_TTL = 6 * 60 * 60_000

app.get('/api/preview', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { url } = req.query as { url?: string }
  if (!url) return reply.code(400).send({ error: 'url required' })

  const hit = previewCache.get(url)
  if (hit && Date.now() - hit.at < PREVIEW_TTL) return hit.value

  if (!allow(`preview:${user.id}`, 60, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  try {
    const value = { preview: await fetchPreview(url) }
    // Failures are cached too, or a dead link is retried on every render.
    previewCache.set(url, { at: Date.now(), value })
    if (previewCache.size > 500) previewCache.delete(previewCache.keys().next().value as string)
    return value
  } catch {
    const value = { preview: null }
    previewCache.set(url, { at: Date.now(), value })
    return value
  }
})

/**
 * What somebody needs in order to sign up here.
 *
 * The sign-up screen used to state flatly that "everyone needs a code to
 * join", which stopped being true the moment open registration was turned on
 * - and copy cannot know that on its own. Somebody was told they needed a
 * code by an app that would have let them straight in.
 *
 * Public on purpose: it says only whether the front door is open, which is
 * the one thing anybody standing at it can already find out by trying.
 */
app.get('/api/signup', async () => {
  return {
    openRegistration: config.openRegistration,
  }
})

/**
 * How many people have signed up here, and when the first one did.
 *
 * A count and a date, and nothing else. Who they are is nobody's business
 * unless you are friends or share a server, and that rule does not bend for
 * a number on a page - so this cannot name anybody, and there is nothing in
 * it to leak by being wrong.
 *
 * Signed in only. It says how big this particular server is, which is a thing
 * for the people on it rather than for whoever is scanning the door.
 *
 * Removed accounts are not counted. Somebody who left is not a signup any
 * more, and a number that only goes up is a number that is lying.
 */
app.get('/api/scale', async (req, reply) => {
  const user = await authed(req)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const row = db.prepare(
    `SELECT COUNT(*) AS people, MIN(created_at) AS first
       FROM users WHERE removed_at IS NULL`,
  ).get() as unknown as { people: number; first: number | null }

  return { people: row.people, since: row.first ?? null }
})

/**
 * What the last few releases changed.
 *
 * Asked for as a Changelog in Settings, so somebody who dismissed the card on
 * launch can still read what they got. Fetched by the server rather than the
 * browser for the same reason link previews and GIF searches are: opening a
 * settings pane should not tell GitHub who you are or when you were curious.
 *
 * No rate limit of its own. It is held for half an hour and shared, so the
 * cost of everybody opening it at once is one request, and the answer is the
 * same public page anybody could read anyway.
 */
app.get('/api/changelog', async (req, reply) => {
  /*
   * Which version is asking, so a snapshot that predates their update is not
   * handed back to the one person certain to notice. Only ever compared
   * against a tag name, and bounded because it arrives from outside.
   */
  const asked = (req.query as { mine?: unknown } | undefined)?.mine
  const mine = typeof asked === 'string' && asked.length <= 32 ? asked : undefined
  try {
    return { releases: await changelog(mine) }
  } catch {
    // A settings pane is not worth a 500. Nothing to show is a fine answer.
    return reply.send({ releases: [], unavailable: true })
  }
})

app.get('/api/client-version', async () => {
  try {
    const stat = statSync(join(CLIENT_DIST, 'index.html'))
    /*
     * The name of the script the current build actually loads.
     *
     * `build` alone can only answer "has this changed since you last asked",
     * which means a page can only notice a deploy that happens while it is
     * watching. A page that starts watching afterwards records the new build
     * as its own and never says a word, while it carries on running the old
     * one - which is how two people ended up on different clients, with a
     * screen share negotiated between them that showed nothing.
     *
     * The asset name is absolute rather than relative: a page can compare it
     * against the script it actually loaded, and get the right answer the
     * first time it asks.
     */
    let asset: string | null = null
    try {
      const html = readFileSync(join(CLIENT_DIST, 'index.html'), 'utf8')
      /*
       * Two shapes, because two clients have to be nameable here.
       *
       * The bundled one hashes its filename, so the name is the identity. The
       * one that is plain files served as they are stamps the build onto the
       * query string instead, and that stamp is the identity.
       *
       * Both matter, and one of them matters to copies already installed:
       * the desktop shell polls this route and offers a reload when the name
       * changes, and it is the shell - not the client - so it is frozen at
       * whatever somebody last installed. Reading only the hashed-filename
       * shape would have returned null for the new client, the shell would
       * have quietly stopped noticing new builds, and nobody could have fixed
       * it without shipping an installer.
       */
      asset = (html.match(/src="\/assets\/(index-[^"]+\.js)"/) ?? [])[1]
        ?? (html.match(/src="\/(app\.js\?v=[A-Za-z0-9]+)"/) ?? [])[1]
        ?? null
    } catch {
      // Fall back to the timestamp alone.
    }
    return { build: `${Math.round(stat.mtimeMs)}-${stat.size}`, asset }
  } catch {
    return { build: 'unknown', asset: null }
  }
})

app.get('/api/media', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { url } = req.query as { url?: string }
  if (!url) return reply.code(400).send({ error: 'url required' })

  /*
   * Two budgets, because there are two different costs.
   *
   * This was one, at 120 a minute, with a comment saying "each miss is an
   * outbound request made in somebody else's name" - which was exactly right
   * when every request was a fetch. Since there is a cache, most are not, and
   * counting a hit against a budget written for outbound requests made the
   * limit stricter than its own reason: a channel dense with pictures,
   * scrolled quickly, would start turning them back into links while causing
   * no outbound traffic at all.
   *
   * The wide one below is still needed, though, and it is why a hit is not
   * simply free: serving a held picture costs upload whether or not anybody
   * went out for it, and a thousand requests for one cached 2MB file is two
   * gigabytes of somebody's home connection.
   */
  if (!allow(`media:${user.id}`, 600, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  /* The headers are the same either way, so they are set before we know
     whether anything has to go out at all. */
  const answering = (type: string): void => {
    reply.header('content-type', type)
    reply.header('x-content-type-options', 'nosniff')
    // Cached hard: the URL is the identity, and re-fetching on every scroll
    // would make one busy channel look like a denial of service to the host.
    reply.header('cache-control', 'public, max-age=86400')
    // Never let a proxied response be treated as part of this origin's app.
    reply.header('content-security-policy', "default-src 'none'; sandbox")
  }

  /*
   * Somebody already looked at this one.
   *
   * The browser cache above covers one person scrolling back; this covers the
   * other ten, who each have an empty cache and the same link in front of
   * them. Held for an hour, and gone on a restart - see the note on the store
   * itself for why it is memory rather than disk.
   */
  const already = cachedImage(url)
  if (already) {
    answering(already.type)
    return reply.send(already.body)
  }

  /*
   * And the tighter one, spent only where something actually leaves this
   * machine. This is the budget the comment above was always describing.
   */
  if (!allow(`mediafetch:${user.id}`, 120, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  try {
    const { body, type } = await fetchRemoteImage(url)

    answering(type)

    // Streamed, but counted: a host that ignores content-length must not be
    // able to hand us an unbounded file.
    let seen = 0
    /* Collected as it goes, so the copy we keep costs no second read. Given
       up on the moment it outgrows what the store would accept, rather than
       holding a whole 8MB file to be told no at the end. */
    let keeping: Buffer[] | null = []
    const capped = new Transform({
      transform(chunk, _enc, done) {
        seen += chunk.length
        if (seen > MEDIA_MAX_BYTES) return done(new Error('image too large'))
        if (keeping) {
          if (seen > MEDIA_CACHE_ENTRY_MAX) keeping = null
          else keeping.push(Buffer.from(chunk))
        }
        done(null, chunk)
      },
    })
    /* Only a complete response is worth keeping: a fetch that died halfway
       would otherwise be served to everybody else as the picture. */
    capped.on('end', () => { if (keeping) holdImage(url, type, Buffer.concat(keeping)) })

    return reply.send(Readable.fromWeb(body as never).pipe(capped))
  } catch (err) {
    return reply.code(502).send({
      error: err instanceof Error ? err.message : 'could not fetch that image',
    })
  }
})

app.post('/api/gifs/import', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { url, description } = (req.body ?? {}) as { url?: string; description?: string }
  if (!url) return reply.code(400).send({ error: 'url required' })

  try {
    const saved = await importGif(url, typeof description === 'string' ? description : '')
    /*
     * Recorded against whoever asked for it, like any other upload.
     *
     * Without this every GIF from the picker would be refused the moment it
     * was sent: the send path asks who uploaded the file, and an import
     * never went through streamToDisk, so nothing had written it down. A
     * row per person rather than per file is exactly what this case needs -
     * an imported GIF is stored by its contents, so two people sending the
     * same one share a single file and are both entitled to it.
     */
    rememberUpload(
      (saved.url.split('?')[0] ?? '').split('/').pop() ?? '',
      user.id, saved.mime, saved.bytes,
    )
    return saved
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'import failed' })
  }
})

// ---------------------------------------------------------------- voice ----

app.get('/api/voice/config', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })
  return { enabled: voiceConfigured(), url: livekitUrlFor(req.headers.host) }
})

/**
 * The LiveKit address to hand a particular client.
 *
 * A configured localhost URL is right for the computer the app runs on and
 * useless to everyone else, so when it points at localhost we rewrite the
 * host to whatever the client used to reach us. Anything explicitly set to a
 * real address is left alone.
 */
function livekitUrlFor(host: string | undefined): string {
  if (!config.livekitUrl) return ''
  // Point clients at our own proxied endpoint, on whatever address they used
  // to reach us. That keeps the scheme matching the page: an https page gets
  // wss, so nothing is blocked as mixed content.
  if (!host) return config.livekitUrl
  return `${config.tls ? 'wss' : 'ws'}://${host}/livekit`
}

app.post('/api/voice/token', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  if (!voiceConfigured()) {
    return reply.code(503).send({ error: 'voice is not configured on this server' })
  }

  const { channelId } = (req.body ?? {}) as { channelId?: string }
  if (!channelId) return reply.code(400).send({ error: 'channelId required' })

  const channel = db.prepare('SELECT id, kind FROM channels WHERE id = ?').get(channelId) as
    unknown as { id: string; kind: string } | undefined
  if (!channel || (channel.kind !== 'voice' && !isConversationKind(channel.kind))) {
    return reply.code(404).send({ error: 'no such voice channel' })
  }

  // A call in a DM uses the conversation itself as the room, so the two
  // people talking are the only ones who could ever be in it. Membership
  // is the whole permission check - view_channels governs the public
  // channels, and has nothing to say about somebody's private call.
  if (isConversationKind(channel.kind)) {
    if (!dmMembers(channelId).includes(user.id)) {
      return reply.code(403).send({ error: 'that conversation is not yours' })
    }
  } else {
    /*
     * Or having been moved here by somebody who may move people, which is a
     * permission that lasts exactly as long as they are in the call.
     */
    if (!canBeInVoice(user.id, channelId)) {
      return reply.code(403).send({ error: 'you cannot join that channel' })
    }
    /*
     * And that they may use channels in this server at all.
     *
     * Deliberately the server-wide answer, not this channel's. The line
     * above is where the channel gets its say, and it says more than
     * view_channels does: canBeInVoice also allows somebody a moderator has
     * carried in, who by definition cannot see the room they are being put
     * in. Asking the channel again here would refuse exactly the person the
     * line above just admitted, which is how a move used to strand them.
     */
    const mine = permissionsFor(user.id, spaceOfChannel(channelId))
    if (!mine.has('view_channels')) {
      return reply.code(403).send({ error: 'you cannot join channels here' })
    }
  }

  // In a DM the conversation is the permission - being in it is the whole
  // of it. In a channel, speaking is governed by send_messages, the same
  // way it is for text.
  const canSpeak = isConversationKind(channel.kind)
    ? true
    : permissionsIn(user.id, channel.id).has('send_messages')

  /*
   * Our permissions become LiveKit's permissions. Someone who is server muted
   * receives a token that cannot publish at all, so the mute holds even if
   * they patch the client - the UI is not the enforcement point.
   *
   * The mute is asked for in the server this room belongs to. It used to be
   * asked about the person alone, so a mute applied anywhere in the app
   * followed them into every other server, and into private calls.
   */
  const token = await mintVoiceToken(user.id, user.display_name, channelId, {
    canPublish: canSpeak && !serverMuted(spaceOfChannel(channelId), user.id),
    canSubscribe: true,
    canPublishData: true,
  })

  return { token, url: livekitUrlFor(req.headers.host), room: channelId }
})

/**
 * Is the app actually answering?
 *
 * The watchdog used to ask whether anything was listening on the port, which
 * was true throughout every fault this has ever had. This is the smallest
 * question that cannot be answered by a process that is wedged: it touches
 * the database and comes back.
 *
 * Deliberately unauthenticated and deliberately empty of detail - it is a
 * pulse, not a status page, and the one below is where the detail lives.
 */
app.get('/health', async (_req, reply) => {
  try {
    db.prepare('SELECT 1').get()
  } catch {
    return reply.code(503).send({ ok: false })
  }
  return reply.header('cache-control', 'no-store').send({ ok: true })
})

/**
 * How the server is doing, in the detail the person who runs it needs.
 *
 * There was no way to ask this at all. Every fault found so far was found by
 * somebody trying to use the app and noticing it was wrong, which is a poor
 * way to run a service six people depend on.
 */
/**
 * How much room the database is actually taking.
 *
 * The main file alone is nearly meaningless: this runs in write-ahead mode,
 * so most of what has been written recently lives in the -wal file beside
 * it. Reporting only the first said "4 KB" for a database with a year of
 * conversation in it.
 */
function databaseBytes(): number {
  const base = resolve(config.dataDir, 'atrium.db')
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += statSync(base + suffix).size } catch { /* may not exist */ }
  }
  return total
}

app.get('/api/admin/health', async (req, reply) => {
  /*
   * Whoever runs the app, and nobody in it.
   *
   * Disk, memory and how long the database takes to answer are facts about
   * the hardware. Gating them on manage_space meant anybody who made a
   * server of their own could read them - they hold every permission inside
   * their own server, and this is not inside anybody's server. Gating them
   * on an account that had claimed the install was the same mistake one
   * step further back: it made hosting the thing into a rank inside it.
   *
   * A secret instead, and no sign-in at all: this is not about who anybody
   * is. Unset means the route does not answer, which is what an app that is
   * simply being used should do.
   */
  if (!isOperator(req.headers)) {
    return reply.code(404).send({ error: 'not found' })
  }

  // Timed against a real indexed read rather than SELECT 1, which measures
  // nothing but the driver.
  const started = process.hrtime.bigint()
  db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL').get()
  const dbMicros = Number(process.hrtime.bigint() - started) / 1000

  const dbBytes = databaseBytes()

  let uploadBytes = 0
  let uploadFiles = 0
  try {
    for (const name of readdirSync(config.uploadDir)) {
      try {
        const st = statSync(resolve(config.uploadDir, name))
        if (!st.isFile()) continue
        uploadFiles += 1
        uploadBytes += st.size
      } catch { /* vanished between listing and asking */ }
    }
  } catch { /* no upload directory yet */ }

  let diskFree: number | null = null
  let diskTotal: number | null = null
  try {
    const fs = await statfs(config.dataDir)
    diskFree = fs.bavail * fs.bsize
    diskTotal = fs.blocks * fs.bsize
  } catch { /* not every filesystem answers this */ }

  const counts = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS messages,
       (SELECT COUNT(*) FROM messages WHERE deleted_at IS NOT NULL) AS deleting,
       (SELECT COUNT(*) FROM users WHERE removed_at IS NULL) AS members,
       (SELECT COUNT(*) FROM attachments) AS attachments`
  ).get()

  const memory = process.memoryUsage()

  return reply.header('cache-control', 'no-store').send({
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    realtime: gatewayStats(),
    database: { bytes: dbBytes, readMicros: Math.round(dbMicros), counts },
    uploads: { files: uploadFiles, bytes: uploadBytes, maxUploadBytes: config.maxUploadBytes },
    disk: { free: diskFree, total: diskTotal },
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    certificate: config.tls ? { daysLeft: certificateDaysLeft() } : null,
    voiceConfigured: voiceConfigured(),
  })
})

// -------------------------------------------------------------- people ----

app.get('/api/members', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })
  /*
   * People you actually share something with, not everybody with an account.
   *
   * This returned the whole user table, which was the same set for as long as
   * one server was the whole server. With anybody able to sign up it becomes
   * a directory of every person here, handed to a stranger who made an
   * account a second ago - caught by a test that signed somebody up with no
   * invite and asked what they could see.
   *
   * Three ways somebody is legitimately visible: you are in a server
   * together, you are friends, or you are in a conversation together. Anybody
   * else is nobody you have any business being shown.
   */
  const members = visibleMembers(user.id)

  return { members }
})

/**
 * Take a conversation off your list.
 *
 * Not a delete, and deliberately not offered as one. The messages stay, the
 * other person's list is untouched, and anything said in it afterwards brings
 * it back with its history intact. Tidying your own sidebar should not be
 * able to destroy something two people wrote, least of all their copy of it.
 *
 * Unfriending does not do this either. Losing a conversation because of a
 * falling out would be the app making a decision that is not its to make -
 * closing it is a separate act, and this is it.
 */
app.post('/api/dms/close', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { channelId } = (req.body ?? {}) as { channelId?: string }
  if (!channelId) return reply.code(400).send({ error: 'channelId required' })

  // Only your own row: closing is a fact about your list, and nobody else's.
  const changed = setConversationClosed(user.id, channelId, Date.now())
  if (!changed) return reply.code(404).send({ error: 'not a conversation of yours' })

  /*
   * And your own other windows.
   *
   * A fact about nobody else is still a fact about you in two places: closing
   * a conversation on the desktop left it sitting in the list on the phone
   * until that one was reloaded. Sent to this person alone, which is what
   * "nobody else's" means.
   */
  pushToUsers([user.id], { t: 'friends-changed', channelId })

  return { ok: true }
})

/* --------------------------------------------------------------- friends -- */

/**
 * Who you know, who has asked, and who you have asked.
 *
 * All three in one answer because the friends screen shows all three and
 * asking separately would mean three round trips to draw one page - and a
 * moment where the same person could appear in two of them at once.
 */
app.get('/api/friends', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const people = (ids: string[]) => ids
    .map((id) => findUser(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))

  const incoming = (db.prepare('SELECT from_id FROM friend_requests WHERE to_id = ?')
    .all(user.id) as Array<{ from_id: string }>).map((r) => r.from_id)
  const outgoing = (db.prepare('SELECT to_id FROM friend_requests WHERE from_id = ?')
    .all(user.id) as Array<{ to_id: string }>).map((r) => r.to_id)

  return {
    friends: people(friendsOf(user.id)),
    incoming: people(incoming),
    outgoing: people(outgoing),
  }
})

/**
 * Ask somebody to be friends, by name.
 *
 * Answers the same way whether or not the name exists. A friend request is
 * one of the few places a stranger can type a guess and be told whether
 * somebody is here, and on a server this size that is the whole member list
 * in an afternoon.
 *
 * An outstanding request the other way round is taken as agreement rather
 * than making two people who have each asked wait for one of them to notice.
 */
app.post('/api/friends/request', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { name } = (req.body ?? {}) as { name?: string }
  if (!name?.trim()) return reply.code(400).send({ error: 'a name is required' })

  if (!allow(`friend-req:${user.id}`, 30, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  const sent = { ok: true, sent: true }
  const target = findByHandle(name.trim())
  if (!target || target.id === user.id) return sent

  /*
   * Two answers that are not the generic one, and neither of them leaks.
   *
   * Everything else here is deliberately indistinguishable, so that typing
   * guesses cannot be used to find out who is on the server. These two are
   * different because they only ever describe something the person asking
   * already knows: who their own friends are, and who they have already
   * asked. Saying so tells them nothing they could not read off their own
   * screen, and not saying so leaves them clicking a button that silently
   * does nothing.
   */
  /*
   * A block answers with the generic "sent", and writes nothing.
   *
   * Everything on this route that is not about the asker's own screen is
   * deliberately indistinguishable, so that typing guesses cannot be used to
   * find out who has an account here. Saying "you are blocked" would break
   * that for the blocked person and, worse, would tell them - which is the
   * one fact about a block worth arguing over, and the reason it silently
   * does nothing instead.
   *
   * Both directions. Somebody you blocked asking to be your friend must not
   * reach you; and you asking them, having forgotten, must not quietly
   * undo your own block by putting a request in front of them.
   */
  if (blockedBetween(user.id, target.id)) return sent

  if (areFriends(user.id, target.id)) return { ok: true, already: 'friends' as const }

  // They asked first: that is both of them saying yes.
  const theirs = db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?')
    .get(target.id, user.id)
  if (theirs) {
    addFriend(user.id, target.id)
    pushToUsers([user.id, target.id], { t: 'friends-changed' })
    return { ok: true, accepted: true as const }
  }

  const mine = db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?')
    .get(user.id, target.id)
  if (mine) return { ok: true, already: 'asked' as const }

  db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)')
    .run(user.id, target.id, Date.now())
  pushToUsers([user.id, target.id], { t: 'friends-changed' })
  return sent
})

/** Say yes to somebody who asked. */
app.post('/api/friends/accept', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { userId } = (req.body ?? {}) as { userId?: string }
  if (!userId) return reply.code(400).send({ error: 'userId required' })

  // Only a request addressed to you can be accepted, or accepting would be a
  // way to make somebody your friend without them ever asking.
  const asked = db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?')
    .get(userId, user.id)
  if (!asked) return reply.code(404).send({ error: 'no request from them' })

  /*
   * Not into a friendship with somebody who is blocked.
   *
   * Blocking clears any pending request, so this needs a request that
   * survived the block - which is a request sent before it and answered
   * after. Rare, and it is the whole reason to check: accepting it would
   * put the person straight back on the friends list of somebody who had
   * just decided otherwise.
   */
  if (blockedBetween(user.id, userId)) {
    return reply.code(403).send({ error: 'you cannot be friends with them' })
  }

  addFriend(user.id, userId)
  /*
   * Each side is sent the other.
   *
   * The event used to carry nothing, so a client learned that its friends had
   * changed and could look up the list - but the new friend was not among the
   * people it knows about, and that list is what every row is drawn from. So
   * a new friend appeared in Friends and nowhere else until the next
   * connection: not in the conversations list, not anywhere they could be
   * messaged from. Reported as having to message them and reload to see them.
   */
  const publicUser = (id: string) => db
    .prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ? AND ${ACTIVE_USERS}`)
    .get(id) as unknown as Record<string, unknown> | undefined

  /*
   * The conversation is opened here, by the accept itself.
   *
   * Becoming friends put a name in a list and nothing more: the conversation
   * only came into existence when somebody finally wrote in it, so until then
   * both sides had a row that sorted alphabetically among everybody they had
   * never spoken to. A person you have just this second added is the one you
   * are most likely to want, and they were at the bottom.
   *
   * Made once and shared, so both sides are looking at the same conversation
   * - and pushed to both, so it arrives without a reload.
   */
  const channelId = dmBetweenOrMake(user.id, userId)

  pushToUsers([user.id], { t: 'friends-changed', user: publicUser(userId), channelId })
  pushToUsers([userId], { t: 'friends-changed', user: publicUser(user.id), channelId })
  return { ok: true, channelId }
})

/** Say no, or take back something you asked. Both are just a deletion. */
app.post('/api/friends/decline', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { userId } = (req.body ?? {}) as { userId?: string }
  if (!userId) return reply.code(400).send({ error: 'userId required' })

  db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
    .run(userId, user.id, user.id, userId)
  pushToUsers([user.id, userId], { t: 'friends-changed' })
  return { ok: true }
})

/**
 * Stop being friends.
 *
 * The conversation stays. Removing somebody is about what happens next, not
 * about unsaying what was already said - and quietly deleting a history
 * because of a falling out is not this button's decision to make.
 */
app.post('/api/friends/remove', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { userId } = (req.body ?? {}) as { userId?: string }
  if (!userId) return reply.code(400).send({ error: 'userId required' })

  removeFriend(user.id, userId)
  pushToUsers([user.id, userId], { t: 'friends-changed' })
  return { ok: true }
})

/* ---------------------------------------------------------------- blocks -- */

/**
 * Who you have blocked.
 *
 * Your own list only, and only the direction you decided. Nothing anywhere
 * answers "who has blocked me" - that is somebody else's private decision
 * about their own attention, and it is the one fact about a block that would
 * be worth arguing over.
 */
app.get('/api/blocks', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  /*
   * Whole records, not the ids the opening frame carries.
   *
   * The list has to be usable from settings, and settings is the only place
   * it can be used: block somebody and then leave the server you met them
   * in, and there is no longer anywhere in the app their name appears. A
   * list of ids would be a list of ids.
   *
   * Not through canSeeMember, deliberately. That is the rule for whether two
   * people know of each other, and blocking somebody is not a reason to
   * forget who they were - it would leave a row nobody could identify and
   * nobody could confidently lift.
   */
  /*
   * Enough to recognise them, and no more.
   *
   * This handed back the whole public record - presence, status, bio,
   * banner - which is a standing feed on somebody you have cut off:
   * block them, leave the server you shared, and this still answers with
   * whether they are online right now, for ever, on a route that skips the
   * visibility rule on purpose.
   *
   * The purpose that justified skipping it is only "know which row to
   * lift", and a name and a face are the whole of that. Anything live goes.
   */
  const ids = blockedBy(user.id)
  const blocked = ids.map((id) => db
    .prepare('SELECT id, username, discriminator, display_name, avatar_path FROM users WHERE id = ?')
    .get(id) as unknown as Record<string, unknown> | undefined)
    .filter((u): u is Record<string, unknown> => Boolean(u))
  return { blocked }
})

/**
 * Block somebody.
 *
 * The app was careful about strangers and had nothing for the case that
 * actually happens: somebody you have met. Opening a conversation already
 * requires a friend, a shared server, or an existing conversation - the
 * right rule, and it means the one person you might badly want to stop
 * hearing from has already passed it. Until this, the only remedy was to
 * leave the server.
 *
 * Not told to them, now or ever. A block that announces itself is an
 * argument rather than an ending, and the person doing it is the one who
 * wanted it to stop.
 */
app.post('/api/blocks', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { userId } = (req.body ?? {}) as { userId?: string }
  if (!userId) return reply.code(400).send({ error: 'userId required' })
  if (userId === user.id) return reply.code(400).send({ error: 'you cannot block yourself' })

  const target = db.prepare(`SELECT id FROM users WHERE id = ? AND ${ACTIVE_USERS}`).get(userId)
  if (!target) return reply.code(404).send({ error: 'no such person' })

  /*
   * Budgeted, because it writes and it deletes a friendship.
   *
   * Not because anybody would block at speed on purpose, but because every
   * route on this file that writes on somebody else's behalf has a ceiling,
   * and this one ends a mutual thing as a side effect.
   */
  if (!allow(`block:${user.id}`, 60, 60_000)) {
    return reply.code(429).send({ error: 'slow down a moment' })
  }

  blockUser(user.id, userId)
  /*
   * Only the blocker is told, and only about their own screen.
   *
   * friends-changed goes to them alone here - the usual pattern sends it to
   * both, and doing that would announce the block to the person blocked, by
   * making their friends list change at the moment it happened. They find
   * out the way anybody finds out somebody stopped replying.
   */
  pushToUsers([user.id], { t: 'blocks-changed', blocked: blockedBy(user.id) })
  pushToUsers([user.id], { t: 'friends-changed' })
  return { ok: true }
})

/**
 * Lift one.
 *
 * It does not restore the friendship the block ended. Being willing to hear
 * from somebody again is not the same as being friends with them, and
 * quietly putting it back would be a decision neither of them made.
 */
app.delete('/api/blocks/:id', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const { id } = req.params as { id: string }
  if (!unblockUser(user.id, id)) {
    return reply.code(404).send({ error: 'they are not blocked' })
  }
  pushToUsers([user.id], { t: 'blocks-changed', blocked: blockedBy(user.id) })
  return { ok: true }
})

/**
 * Grant or take away a verified badge, and with it the bare name.
 *
 * The owner's to give, and nobody else's - a badge anybody could hand out is
 * worth nothing, and the whole point of it is that it says something is true.
 *
 * Verifying drops the four digits, because holding the bare name is what
 * being verified means here: there can only be one, so a verified account is
 * the one that cannot be impersonated by picking the same name. If somebody
 * else already holds it the badge is refused rather than quietly granted
 * without the name, which would be a badge that means the opposite.
 */
app.post('/api/admin/verify', async (req, reply) => {
  /*
   * Whoever runs Atrium, and nobody in it.
   *
   * A badge saying an account is who it claims to be is worth exactly as
   * much as the difficulty of getting one, so it cannot be somebody's to
   * hand out from inside the app - and it was, when the first account to
   * sign up held the whole install. It is the same job as any service
   * verifying a name: done by the people running the thing, from outside it.
   */
  if (!isOperator(req.headers)) {
    return reply.code(404).send({ error: 'not found' })
  }

  const { userId, verified } = (req.body ?? {}) as { userId?: string; verified?: boolean }
  if (!userId) return reply.code(400).send({ error: 'userId required' })

  const target = db.prepare('SELECT id, username, discriminator FROM users WHERE id = ?')
    .get(userId) as { id: string; username: string; discriminator: string } | undefined
  if (!target) return reply.code(404).send({ error: 'no such account' })

  if (verified === false) {
    // Taking the badge back also gives up the bare name, or the account would
    // keep the part that actually stops impersonation.
    const digits = freeDiscriminator(target.username)
    if (digits === null) return reply.code(409).send({ error: 'no free digits for that name' })
    db.prepare('UPDATE users SET verified = 0, discriminator = ? WHERE id = ?').run(digits, userId)
    /* No actor: the audit's actor is an account in the app, and this was
       not done by one. The column is nullable for exactly this. */
    writeAudit(null, 'verify.remove', `${target.username} is no longer verified`)
    return { ok: true, discriminator: digits }
  }

  if (target.discriminator !== '' && usernameTaken(target.username)) {
    return reply.code(409).send({ error: 'somebody else already holds that name' })
  }
  db.prepare("UPDATE users SET verified = 1, discriminator = '' WHERE id = ?").run(userId)
  writeAudit(null, 'verify.grant', `${target.username} is verified`)
  return { ok: true, discriminator: '' }
})

app.patch('/api/me', async (req, reply) => {
  const user = await authed(req as never)
  if (!user) return reply.code(401).send({ error: 'not signed in' })

  const body = (req.body ?? {}) as Record<string, string>
  /*
   * Presence is a fixed set, not free text.
   *
   * It went through the loop below with everything else, so any string up to
   * five hundred characters could be stored and then sent to everybody as
   * somebody's presence. Nothing renders it as markup, but it is used as a
   * class name and to decide which dot to draw - so an unknown value is a
   * member who is neither online nor offline, drawn as nothing at all.
   */
  if (typeof body.presence === 'string'
    && !['online', 'idle', 'dnd', 'offline'].includes(body.presence)) {
    return reply.code(400).send({ error: 'that is not a presence' })
  }
  // `key` comes from this const tuple and never from the request, so the
  // interpolation below cannot be used for injection.
  /* As far ahead as a status timer may be set. */
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000
  const allowed = ['display_name', 'bio', 'status_text', 'presence'] as const

  for (const key of allowed) {
    if (typeof body[key] === 'string') {
      db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(body[key].slice(0, 500), user.id)
    }
  }

  /*
   * When the status stops being true. 0 is "until I say otherwise".
   *
   * Bounded ahead as well as behind: a moment in the past is a status that
   * was never shown, and one a year out is the same as no timer at all while
   * looking like a promise this will do something about it.
   */
  if (body.status_until !== undefined) {
    const until = Number(body.status_until)
    if (!Number.isFinite(until) || until < 0 || until > Date.now() + THIRTY_DAYS_MS) {
      return reply.code(400).send({ error: 'that is not a time this can clear at' })
    }
    db.prepare('UPDATE users SET status_until = ? WHERE id = ?')
      .run(Math.round(until), user.id)
  }
  /*
   * Clearing the status clears its timer with it. Otherwise a status set
   * later, with no timer asked for, quietly inherits the one before it.
   */
  if (typeof body.status_text === 'string' && !body.status_text.trim()
    && body.status_until === undefined) {
    db.prepare('UPDATE users SET status_until = 0 WHERE id = ?').run(user.id)
  }

  /*
   * Setting your own nickname is gone from here.
   *
   * It wrote the account-wide column, which no longer exists as anything the
   * app reads: a nickname is what one server calls you, and "my nickname
   * everywhere" is display_name, which this route already sets. Nothing in
   * the app ever sent the field - it was reachable only by calling the API
   * directly - so accepting it now would be storing a value nothing shows.
   *
   * Setting your own nickname inside one server is a real thing and a
   * different one, needing its own permission the way Discord's does. It is
   * not built, and silently half-doing it here is how it would stay that way.
   */

  // The two that are drawn rather than read, and so are checked rather than
  // trimmed. accent has been settable to any string for as long as it has
  // existed; nothing rendered it, so nothing came of that, and now something
  // does.
  if (typeof body.accent === 'string') {
    if (!/^#[0-9a-f]{6}$/i.test(body.accent)) {
      return reply.code(400).send({ error: 'accent must be a hex value like #4C8DFF' })
    }
    db.prepare('UPDATE users SET accent = ? WHERE id = ?').run(body.accent, user.id)
  }
  // Empty is allowed and means "no second colour chosen".
  if (typeof body.accent_2 === 'string') {
    if (body.accent_2 !== '' && !/^#[0-9a-f]{6}$/i.test(body.accent_2)) {
      return reply.code(400).send({ error: 'the second colour must be a hex value like #4C8DFF' })
    }
    db.prepare('UPDATE users SET accent_2 = ? WHERE id = ?').run(body.accent_2, user.id)
  }
  if (typeof body.name_font === 'string') {
    if (!(NAME_FONTS as readonly string[]).includes(body.name_font)) {
      return reply.code(400).send({ error: 'that is not one of the available fonts' })
    }
    db.prepare('UPDATE users SET name_font = ? WHERE id = ?').run(body.name_font, user.id)
  }
  if (typeof body.name_effect === 'string') {
    if (!(NAME_EFFECTS as readonly string[]).includes(body.name_effect)) {
      return reply.code(400).send({ error: 'that is not one of the available effects' })
    }
    db.prepare('UPDATE users SET name_effect = ? WHERE id = ?').run(body.name_effect, user.id)
  }

  const updated = findUser(user.id)
  // The account is the one that just made the request, so it exists - but the
  // id is taken from the session rather than the lookup, which cannot be null.
  pushAboutMember(user.id, { t: 'member-update', user: updated })
  return { user: updated }
})

// Keep the name pointing here, in case the ISP moves us.
startDynamicDns()

/*
 * Copy an upload offsite the moment it lands, if there is anywhere to put it.
 *
 * The nightly run still does the sweeping-up; this only closes the window
 * between an upload arriving and three in the morning, which is the window
 * the files this machine lost fell into. Turned on here rather than decided
 * inside the module, so that nothing but a running server ever makes an
 * outbound copy - a test importing db.ts must not start posting files.
 */
if (process.env.R2_BUCKET) {
  enableOffsite(true)
  offsiteLogTo((line) => app.log.info(line))
  app.log.info('uploads are copied offsite as they arrive')
} else {
  app.log.warn('no offsite storage configured - uploads exist only on this machine')
}

/**
 * Clear out files nothing points at.
 *
 * Once at startup and once a day after. Deleting a message used to leave
 * its upload behind for good, so the folder only ever grew - and the
 * nightly backup carried the whole lot offsite each time.
 */
/*
 * What is on disk against what the database thinks is, said once a day.
 *
 * This used to delete the difference. Nothing anybody uploads is removed
 * automatically any more - only the person who put it there takes it away,
 * by deleting the message it is on or replacing their own picture. A daily
 * count is the useful half of what the sweep was doing, and none of the
 * half that can be wrong about something nobody can get back.
 */
function reportUploads(): void {
  const { unreferenced, missing, bytes } = reconcileUploads()
  if (unreferenced.length > 0) {
    app.log.info(
      { files: unreferenced.length, mb: Number((bytes / 1024 / 1024).toFixed(1)) },
      'files on disk that nothing points at - kept, not removed'
    )
  }

  /*
   * A count, and separately the thing worth being woken up for.
   *
   * The count has been the same seven for days: what the old orphan sweep
   * took before it was stopped. Said once a day at warn, it is a line in a
   * file nobody reads - and the only reason anybody looked at it at all was
   * that a restart happened to print it.
   *
   * So the count stays as it was, and a name that was not missing yesterday
   * is raised as an error instead. Nothing removes a file now except the
   * person who put it there, so a new one means either something is deleting
   * again or the disk is going, and both are worth interrupting somebody for.
   */
  const known = knownMissing(config.dataDir)
  if (missing.length > 0) {
    app.log.warn(
      { files: missing.length, examples: missing.slice(0, 5) },
      'the database points at files that are not there'
    )
  }

  if (known === null) {
    /* First run on this machine. Everything already gone is the baseline,
       or the very first report would be an alarm about old news. */
    rememberMissing(config.dataDir, missing)
    app.log.info({ files: missing.length }, 'recorded which files are already missing')
    return
  }

  const fresh = newlyMissing(known, missing)
  if (fresh.length > 0) {
    app.log.error(
      { files: fresh.length, names: fresh.slice(0, 20) },
      'FILES HAVE GONE MISSING SINCE THE LAST CHECK - something is deleting uploads'
    )
  }
  /* Written either way, so a file put back stops being reported as well. */
  if (fresh.length > 0 || missing.length !== known.length) {
    rememberMissing(config.dataDir, missing)
  }
}
reportUploads()
setInterval(reportUploads, 24 * 60 * 60_000).unref()

/**
 * How long a deleted message is kept before it is really gone.
 *
 * Comfortably past the fifteen seconds the client offers to undo it, and
 * short enough that "I deleted that" is true within the minute rather than
 * within the day.
 *
 * There used to be a second sweeper below this one using the undo window
 * itself, fifteen seconds, on its own identical interval. Two timers doing
 * the same work, and the shorter window is a superset of the longer - so the
 * margin this constant exists to provide did not exist: a message became
 * unrecoverable the instant the client stopped offering to undo it, with no
 * allowance for the round trip. The duplicate is gone and this is the one.
 */
const PURGE_AFTER_MS = 60_000

/**
 * Finish deletions.
 *
 * This existed and was never called, which meant deleting a message deleted
 * nothing whatsoever: the row stayed marked for ever, its attachment row
 * stayed with it, and because that row still pointed at the file the orphan
 * sweep above quite correctly left the file alone too. So the body text, the
 * search index entry and the picture all survived a deletion permanently,
 * and went offsite in every backup taken afterwards.
 *
 * Every minute rather than daily. A deletion that takes a day to happen is
 * not really a deletion, and this is the whole point of the feature: when
 * somebody takes a photo back, it should stop existing.
 */
function sweepDeletions(): void {
  const finished = sweepDeleted(PURGE_AFTER_MS)
  if (finished > 0) app.log.info({ finished }, 'purged deleted messages and their files')
}
sweepDeletions()
setInterval(sweepDeletions, 60_000).unref()

/*
 * Hand every existing space's Owner role to its owner.
 *
 * The role has always been created with the space and never given to anyone,
 * so the two servers made before this looked, in their own settings, as
 * though nobody owned them. Idempotent, so it costs nothing on every start
 * after the first.
 */
{
  /*
   * A DM has no server and never will; a channel in a server always does.
   * Anything else predates servers and belongs to the first one.
   */
  const tightened = tightenSpaceColumns()
  if (tightened.length > 0) {
    app.log.info({ tightened }, 'the database now enforces which server a row belongs to')
  }
}

// ---------------------------------------------------------------- boot ----

// Attach before listening, so there is no window in which a client can reach
// the HTTP server and find no WebSocket handler waiting.
attachGateway(app.server)
await app.listen({ host: config.host, port: config.port })

console.log(`\n  Atrium is up.`)
const scheme = config.tls ? 'https' : 'http'
console.log(`  Local     ${scheme}://localhost:${config.port}`)
console.log(`  Network   ${scheme}://<your-zerotier-ip>:${config.port}`)
if (config.tls) {
  const days = certificateDaysLeft()
  console.log(
    days === null
      ? '  Note      self-signed certificate, so browsers warn once'
      : `  Note      trusted certificate for ${config.acmeDomain}, ${days} days left`
  )
}
console.log(`  Web app   ${hasClient ? 'served from this address' : 'not built - run: pnpm --filter @atrium/web build'}`)
console.log(`  Uploads   ${config.uploadDir}\n`)

