import {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, protocol, net, clipboard,
  globalShortcut, Notification, nativeImage, safeStorage, dialog,
  session, desktopCapturer, powerMonitor,
} from 'electron'
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, rmSync,
  mkdirSync, copyFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { autoUpdater } from 'electron-updater'
import { matchGame } from './matchgame.js'
import { movedDeliberately } from './seek.js'
import {
  asked, cameBack, NOT_HUNG, shouldAsk, shouldReload, stuckFor, whatDied, wentQuiet,
  worthReloading, type Hang,
} from './hang.js'
import { noteTrouble } from './troubleLog.js'
import {
  gotFor, iconFor, noIconYet, nothingYet, wantsIconRead, wantsRead, withIconRead, withRead,
  type Hunt, type IconHunt,
} from './gameIcon.js'
import { whatsNewFor, type Saved } from './whatsnew.js'
import { whatToTidy, humanBytes } from './tidy.js'
import { join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

// The package name would otherwise decide where userData goes, and that
// folder holds saved
// credentials and must be a stable, sane path, so name the app explicitly
// before anything reads it.
app.setName('Atrium')

/*
 * Bring across what the app kept under its old name.
 *
 * userData is `%APPDATA%\<the app's name>`, so renaming the app moves it -
 * and everything in it stays behind: which server you are on, whether
 * hardware acceleration is off, and the saved password, which is encrypted
 * by the operating system and cannot simply be typed again from memory.
 * Somebody who updates would have been quietly signed out and handed a
 * first-run screen.
 *
 * Copied rather than moved, so a build from before the rename still finds
 * its own files if somebody goes back to one. Only when there is nothing
 * under the new name: after the first run this is a directory listing and
 * nothing else.
 */
function carryOverUserData(): void {
  try {
    const now = app.getPath('userData')
    const before = join(app.getPath('appData'), 'JacksCord')
    if (before === now || !existsSync(before)) return
    if (existsSync(join(now, 'system.json'))) return
    mkdirSync(now, { recursive: true })
    for (const name of readdirSync(before)) {
      /* The top level only. Chromium's own caches are large, rebuilt on
         demand, and none of them are worth copying. */
      const from = join(before, name)
      if (!statSync(from).isFile()) continue
      const to = join(now, name)
      if (!existsSync(to)) copyFileSync(from, to)
    }
    console.log('[name] carried settings over from the old name')
  } catch (err) {
    /* Nothing here is worth failing to start over. The cost is looking new. */
    console.warn('[name] could not carry settings over', err)
  }
}
carryOverUserData()

/*
 * And the old settings folder, once what was copied out of it has been used.
 *
 * Not on the run that copied it: if that copy were somehow bad, the original
 * is the only way back. `carriedOver` is written the first time and read the
 * next, so the folder goes on the second launch - by which point a whole
 * session has been run on the copy.
 */
function tidyOldUserData(): void {
  try {
    const before = join(app.getPath('appData'), 'JacksCord')
    if (!existsSync(before)) return
    const system = join(app.getPath('userData'), 'system.json')
    if (!existsSync(system)) return
    const held = JSON.parse(readFileSync(system, 'utf8')) as Record<string, unknown>
    if (!held.carriedOver) {
      writeFileSync(system, JSON.stringify({ ...held, carriedOver: true }, null, 2))
      return
    }
    rmSync(before, { recursive: true, force: true })
    console.log('[name] removed the settings folder from the old name')
  } catch { /* Nothing here is worth failing to start over. */ }
}
tidyOldUserData()

// Read before anything else: Chromium only honours this before "ready", so it
// cannot be a setting the renderer applies later.
try {
  const early = JSON.parse(readFileSync(join(app.getPath('userData'), 'system.json'), 'utf8'))
  if (early?.hardwareAcceleration === false) app.disableHardwareAcceleration()
} catch {
  // No file yet, or unreadable. Acceleration stays on, which is the default.
}


const DEV_URL = process.env.ATRIUM_DEV_URL
const isDev = Boolean(DEV_URL)

/**
 * Where the built web client lives when packaged.
 *
 * Only the first-run screen comes from here now. The app used to run this
 * copy forever, which meant it silently kept whatever version it shipped
 * with: the web app could be fixed a dozen times over and the desktop app
 * would still be showing the code it was built with, looking perfectly
 * healthy the whole time.
 */
const APP_ROOT = isDev ? '' : join(process.resourcesPath, 'app')

/** The file the main process already keeps for things it must read early. */
const SYSTEM_FILE = join(app.getPath('userData'), 'system.json')

function readSystem(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SYSTEM_FILE, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The server this app talks to, if it has been told one.
 *
 * Kept out here rather than only in the page, because it decides what to
 * load before there is a page to ask.
 */
/**
 * The address this copy was built for.
 *
 * Baked in at build time, the same value the bundled page carries. Without it
 * the shell had no idea where the server was until somebody typed it in - and
 * once the page stopped needing to ask, nobody ever did. So the shell kept
 * falling back to the copy of the client inside the installer, which works
 * perfectly and silently freezes at whatever it shipped with. Every fix
 * deployed to the server went nowhere.
 */
const BUILT_FOR_SERVER = (process.env.ATRIUM_DEFAULT_SERVER ?? '').replace(/\/+$/, '')

/*
 * The address this copy talks to, brought forward if it names the old one.
 *
 * Everybody who had the app before the rename has the old address saved, and
 * the old address now answers with a page saying where to go instead. A
 * person reading that in a browser can click the link; a person reading it
 * inside the app cannot, because the app is the browser and its address bar
 * is a file nobody knows about. So the shell moves itself, once, and the
 * moved page is only ever seen by somebody who can act on it.
 */
const MOVED_FROM = 'jackscord.duckdns.org'
const MOVED_TO = 'atriumapp.duckdns.org'

function storedServer(): string | null {
  const value = readSystem().server
  if (typeof value === 'string' && value) {
    const url = value.replace(/\/+$/, '')
    if (url.includes(MOVED_FROM)) {
      const moved = url.replace(MOVED_FROM, MOVED_TO)
      /* Written back, so this happens once rather than on every launch and
         so anything else reading the file agrees with what was loaded. */
      rememberServer(moved)
      console.log(`[name] the server address moved to ${MOVED_TO}`)
      return moved
    }
    return url
  }
  return BUILT_FOR_SERVER || null
}

function rememberServer(url: string | null): void {
  const next = { ...readSystem() }
  if (url) next.server = url.replace(/\/+$/, '')
  else delete next.server
  try {
    writeFileSync(SYSTEM_FILE, JSON.stringify(next, null, 2))
  } catch {
    // Not fatal: the page keeps its own copy, so the next start asks again.
  }
}

// The renderer is served from app://atrium rather than file://. A file://
// page has a null origin, which would force us to loosen CORS on the server;
// a registered standard scheme gets a real origin we can allow explicitly.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/** Where the page has got to, if it has stopped answering. */
let hang: Hang = NOT_HUNG

/**
 * Whether the box asking about it is on screen.
 *
 * Electron repeats "unresponsive" for as long as a page is stuck, and the
 * time this was written down was the moment of *asking* rather than the
 * moment of answering - so leaving the box open for longer than the gap
 * between asks opened a second one on top of it, and then a third. Which is
 * exactly the thing the comment beside that gap says it exists to prevent.
 */
let asking = false

/**
 * When the window was last brought back by itself.
 *
 * A page that dies on the way up dies again the moment it is reloaded, and
 * nothing here would have stopped that going round for ever.
 */
let reloads: number[] = []

/**
 * A small file of what went wrong, so the next freeze can be read about.
 *
 * In userData rather than beside the app: the app's own folder is not
 * writable once it is installed, and this has to work on the machine it
 * happens on rather than on a developer's. troubleLog.ts does the writing and
 * is tested against a real directory.
 */
function noteToLog(what: string, detail = ''): void {
  noteTrouble(app.getPath('userData'), what, detail)
}

/*
 * Started by the login item rather than by a person.
 *
 * setLoginItemSettings has always passed --hidden, with a comment saying the
 * app should appear in the tray rather than throwing a window at somebody who
 * has just logged in - and nothing anywhere read process.argv, so it did the
 * opposite of what the comment promised. Launch on startup was never offered
 * in the settings window, which is why nobody found out.
 *
 * Cleared the first time anybody asks for the window, so that a window built
 * later - closed to the tray and opened again - is not held back by how this
 * particular run began.
 */
let openedByLogin = process.argv.includes('--hidden')

/** Bring the window up, whatever the app was started by. */
function showMainWindow(): void {
  openedByLogin = false
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// A second launch should focus the existing window, not open another copy.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    /* Somebody has just clicked the icon, so this is a person asking - even
       if the first launch was the login item starting it quietly. */
    showMainWindow()
  })
}

/**
 * The little window that says something is happening.
 *
 * The main window is deliberately not shown until it has something to draw,
 * which is right - a half-painted app is worse than none - but it means the
 * gap between clicking the icon and seeing anything is blank. On a cold start
 * or an update that gap is long enough for somebody to click the icon again.
 *
 * Frameless, transparent and always on top, so it reads as the app arriving
 * rather than as a window of its own. It is closed by whoever finishes first:
 * the main window becoming ready, or an update deciding to restart.
 */
let splash: BrowserWindow | null = null
/** When the splash reached the screen, so it can be given a moment on it. */
let splashShownAt = 0
/**
 * How long it stays, at least.
 *
 * Asked for as wanting to see it on every launch. It was already made on
 * every launch - and then closed the instant the main window said it was
 * ready, which on a warm start is before the splash has finished loading its
 * own page. So it was created, and destroyed, having never been drawn.
 *
 * Long enough to register as a thing that happened rather than a flicker,
 * and short enough that nobody is waiting on it.
 */
const MIN_SPLASH_MS = 900

function createSplash(saying?: string): void {
  splash = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    // It renders one local file with no network access of its own. Nothing
    // is loaded into it, so it needs nothing from the preload bridge.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  splash.once('ready-to-show', () => splash?.show())
  // When it actually reached the screen, which is what the minimum below is
  // measured from. Being created is not being seen.
  splash.once('show', () => { splashShownAt = Date.now() })
  /* Anything to say is said once the page is there to say it in: the splash
     is told things by running script inside it, and there is nothing to run
     in until it has loaded. */
  if (saying) splash.webContents.once('did-finish-load', () => saySplash(saying, Number.NaN))
  void splash.loadFile(join(__dirname, 'splash.html'))
  splash.on('closed', () => { splash = null })
}

/**
 * Tell the splash what is going on.
 *
 * `percent` null hides the bar, a number fills it, and NaN means "downloading
 * something whose size nobody told us" - which still has to look alive.
 */
function saySplash(text: string, percent: number | null = null): void {
  if (!splash || splash.isDestroyed()) return
  /*
   * The number is written into the call rather than serialised with it.
   *
   * JSON has no NaN - it comes out as null - and null is this splash's word
   * for "no bar at all". So the one case the bar was built for, progress
   * with no total, arrived as "nothing is happening", and the moving bar it
   * has always had was unreachable from here. The text went through fine,
   * which is what made it look like a styling choice.
   */
  const shown = percent === null ? 'null'
    : Number.isFinite(percent) ? String(percent) : 'NaN'
  void splash.webContents.executeJavaScript(
    `window.setSplash && window.setSplash({ text: ${JSON.stringify(text)}, percent: ${shown} })`,
  ).catch(() => {
    // The splash can close between the check and the call. Nothing to do.
  })
}

/**
 * Show the app, once the splash has had its moment.
 *
 * Both together and in this order: showing the window first and closing the
 * splash after is what stops a frame of nothing in between, and it is why
 * this is one function rather than two calls anybody could reorder.
 *
 * Never waits for ever. A splash that fails to appear at all must not be the
 * reason an app does not either.
 */
let revealed = false

function revealMainWindow(): void {
  const now = () => {
    if (revealed) return
    revealed = true
    closeSplash()
    /* Ready, and deliberately not shown: this run began at login, so the app
       waits in the tray. Everything behind the window is already running, so
       opening it from the tray is instant. */
    if (openedByLogin) return
    if (win && !win.isDestroyed()) win.show()
  }
  if (!splash || splash.isDestroyed()) return now()
  if (splashShownAt) {
    setTimeout(now, Math.max(0, MIN_SPLASH_MS - (Date.now() - splashShownAt)))
    return
  }
  // Not drawn yet. Wait for it, with a cap in case it never manages.
  const cap = setTimeout(now, 1500)
  splash.once('show', () => {
    clearTimeout(cap)
    setTimeout(now, MIN_SPLASH_MS)
  })
}

function closeSplash(): void {
  if (splash && !splash.isDestroyed()) splash.close()
  splash = null
}

function createWindow(): void {
  /* Per window, not per run: a second one built later - closed to the tray
     and opened again - has its own showing to do, and a flag left true from
     the first would leave it built and never shown. */
  revealed = false
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#04070A',
    titleBarStyle: 'hidden',
    /*
     * No titleBarOverlay, so the app draws its own buttons.
     *
     * The overlay hands the caption buttons to Windows, and Windows will
     * style exactly three things about them: the strip's colour, the glyph
     * colour, and the height. Not the size of the hover slab, not its
     * corners, not the red - so they stayed Windows buttons sitting in an
     * app that looks nothing like Windows.
     *
     * What this costs is Snap Layouts: hovering maximise on Windows 11 pops
     * a grid of arrangements, and that comes from the overlay being the real
     * caption button. There is no way to ask for it from a page. Snapping by
     * dragging to an edge, and Win+arrow, both still work.
     *
     * The page is told to draw them by `windowButtons` on the bridge rather
     * than by its own guess, so a client served to an older shell - which
     * still has the overlay - does not draw a second set beside them.
     */
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The three that matter. Without them an XSS in the renderer is
      // arbitrary code execution on the user's machine.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  })

  win.once('ready-to-show', () => {
    // The splash goes as the real thing arrives, not before: closing it first
    // leaves a moment of nothing, which is the gap it exists to cover. And
    // not before it has been on screen long enough to have been seen.
    revealMainWindow()
    try {
      writeFileSync(
        join(app.getPath('userData'), 'last-boot.json'),
        JSON.stringify({ at: Date.now(), version: app.getVersion() })
      )
    } catch {
      // Diagnostics only; never let this stop the app opening.
    }

    /*
     * And clear up after old updates, once, a minute after the window is up.
     * Late because it is housekeeping: nothing here is worth a moment of
     * somebody's launch, and a minute in the app is still every session.
     */
    setTimeout(tidyUpdaterCache, 60_000).unref()
  })

  // Load diagnostics. A blank window is otherwise indistinguishable from a
  // working one that simply has nothing to draw yet.
  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] loaded', win?.webContents.getURL())
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] FAILED to load ${url} — ${desc} (${code})`)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer console]', message)
  })

  /**
   * Two addresses being the same place, rather than one starting with the
   * other.
   *
   * This compared with startsWith, and the stored address has its trailing
   * slash stripped - so `https://atriumapp.duckdns.org` allowed
   * `https://atriumapp.duckdns.org.evil.example/`, which is a different site
   * that merely begins with the right letters. Anything that got the window
   * to follow such a link would be handed the whole preload bridge, because
   * that is exposed to whatever page is loaded and this check is what decides
   * which pages those are.
   *
   * Compared as scheme and host, not as `origin`: a custom scheme has no
   * origin - `new URL('app://atrium').origin` is the string "null", and two
   * of those would match each other.
   */
  const sameHost = (url: string, base: string): boolean => {
    const a = placeOf(url)
    return a !== null && a === placeOf(base)
  }

  // Never let the app itself navigate somewhere else, and send real links to
  // the system browser instead of opening a window with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // The bundled first-run page, and the server it points us at. Anything
    // else is a link, and links belong in a browser with an address bar
    // rather than in a window that has none.
    const server = storedServer()
    const allowed = isDev
      ? [DEV_URL!]
      : server ? ['app://atrium', server] : ['app://atrium']

    /*
     * And not everything the server serves is a page.
     *
     * Being on our own server was the whole test, so any link to it was
     * followed - including the ones that are files. An installer, or an
     * attachment of a kind this window cannot display, then became the
     * window: Electron renders what it cannot show as text, so the app was
     * replaced by screenfuls of binary with no way back except restarting
     * it. Reported with a screenshot of exactly that.
     *
     * These are files wherever they came from, and a file belongs in the
     * browser that knows how to save it.
     */
    const isFile = /\/(uploads|download)(\/|$|\?)/.test(url)

    if (isFile || !allowed.some((base) => sameHost(url, base))) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  /* Both events, because a window leaves maximised as often as it enters. */
  const sayMaximised = () => win?.webContents.send('win:maximised', win.isMaximized())
  /*
   * When the app stops answering.
   *
   * Reported, with a screenshot of a window that would not take a click - and
   * there was nothing to find afterwards, because nothing here listened for
   * any of it. A freeze nobody can read about is one that gets guessed at.
   *
   * hang.ts holds every decision about time and repetition; this is the
   * wiring, and it is short on purpose.
   */
  win.on('unresponsive', () => {
    hang = wentQuiet(hang, Date.now())
    if (!shouldAsk(hang, Date.now())) return
    hang = asked(hang, Date.now())
    const how = stuckFor(hang, Date.now())
    noteToLog('unresponsive', `the window has not answered for ${how}`)

    const target = win
    if (!target || target.isDestroyed()) return
    /* One box at a time. See `asking`. */
    if (asking) return
    asking = true
    /*
     * Asked rather than decided. Reloading throws away whatever was half
     * typed, and a page that is merely slow is often about to come back -
     * so the choice belongs to the person watching it, and Wait is the
     * default because it is the one that loses nothing.
     */
    void dialog.showMessageBox(target, {
      type: 'warning',
      buttons: ['Wait', 'Reload'],
      defaultId: 0,
      cancelId: 0,
      title: 'Atrium is not responding',
      message: 'Atrium is not responding',
      detail: `It has not answered for ${how}. Waiting often works. Reloading `
        + 'starts the window again and loses anything half-typed.',
    }).then((answer) => {
      asking = false
      if (answer.response !== 1) return
      noteToLog('reload', 'asked for by the person watching it')
      /* Asked for by hand, so no cap: somebody pressing the button is not a
         loop, and refusing them because the page has crashed twice already is
         the app arguing with the person trying to fix it. */
      reloads = [...reloads, Date.now()]
      if (win && !win.isDestroyed()) win.webContents.reload()
    }).catch(() => {
      /* The window went while the box was open. */
      asking = false
    })
  })

  /* And it came back on its own, which is the common ending. */
  win.on('responsive', () => {
    if (hang.since > 0) noteToLog('responsive', `after ${stuckFor(hang, Date.now())}`)
    hang = cameBack()
  })

  win.on('maximize', sayMaximised)
  win.on('unmaximize', sayMaximised)

  win.on('close', (event) => {
    // Closing hides to tray; quitting is explicit, from the tray menu.
    if (quitting) return
    if (!readPrefs().minimiseToTray) return
    event.preventDefault()
    win?.hide()
  })

  if (isDev) {
    void win.loadURL(DEV_URL!)
  } else {
    void loadClient(win)
  }
}

/**
 * Load the client from the server, so it can never be out of date.
 *
 * The bundled copy is the fallback rather than the norm: it greets a first
 * run that has no address yet, and it catches a server that is not
 * answering - an empty window with no way to change the address is a poor
 * thing to hand somebody whose connection is down.
 */
/**
 * Notice when the server is serving a newer client than this window loaded.
 *
 * The client has its own check, and it cannot cover this case: it ships
 * inside the very thing that is out of date, so a window running a build from
 * before that check existed will never say a word. That is not hypothetical -
 * it is exactly how a desktop app and a browser ended up on different builds,
 * with a screen share between them showing nothing.
 *
 * Watched from the shell instead, which updates separately and does not care
 * which client is loaded. It offers rather than reloads: a reload in the
 * middle of a call is worse than a day-old client, and only the client knows
 * whether there is a call.
 */
let loadedAsset: string | null = null
let offeredFor: string | null = null

async function servedAsset(): Promise<string | null> {
  const server = storedServer()
  if (!server) return null
  try {
    const res = await net.fetch(`${server}/api/client-version`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { asset?: string | null }
    return body.asset ?? null
  } catch {
    return null
  }
}

function watchClientVersion(): void {
  const check = async () => {
    const asset = await servedAsset()
    if (!asset) return
    // The first answer after a load is what this window is running.
    if (!loadedAsset) { loadedAsset = asset; return }
    if (asset === loadedAsset || asset === offeredFor) return
    offeredFor = asset

    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Atrium has an update',
        body: 'Reload when you are ready - from the tray icon, or here.',
      })
      n.on('click', () => { win?.webContents.reload() })
      n.show()
    }
  }
  void check()
  setInterval(() => void check(), 5 * 60_000).unref()
}


/**
 * Take away the installers an earlier update left behind.
 *
 * Asked for: if somebody already has an old build's leftovers on their PC,
 * can a new one clear them out? Measured on one machine, the updater's cache
 * held 298 MB - two copies of the current installer and a 99 MB archive from
 * an update two days earlier. That is a third of a gigabyte on every friend's
 * PC for an app they use to talk.
 *
 * Timid on purpose. This folder belongs to electron-updater, not to us: it
 * runs only when no update is in flight, only on things untouched for a week,
 * never on the small files the updater uses to resume, and any file that will
 * not delete is left alone. It also never runs before the window is up -
 * clearing disk is not worth a millisecond of somebody's launch.
 */
function tidyUpdaterCache(): void {
  /*
   * The cache under the old name, which nothing will ever read again.
   *
   * It is named after the package, so the rename left a folder holding up to
   * a hundred megabytes of an installer that has already been installed.
   */
  try {
    const gone = join(app.getPath('appData'), '..', 'Local', 'jackscord-desktop-updater')
    if (existsSync(gone)) {
      rmSync(gone, { recursive: true, force: true })
      console.log('[tidy] removed the update cache from the old name')
    }
  } catch { /* in use, or not ours. Leaving it is always safe. */ }

  try {
    const dir = join(app.getPath('appData'), '..', 'Local', UPDATER_CACHE)
    if (!existsSync(dir)) return

    const busy = updateState.stage === 'downloading' || updateState.stage === 'ready'
    const found = readdirSync(dir).map((name) => {
      try {
        const s = statSync(join(dir, name))
        return s.isFile() ? { name, modified: s.mtimeMs, bytes: s.size } : null
      } catch {
        return null
      }
    }).filter((f): f is { name: string; modified: number; bytes: number } => f !== null)

    const going = whatToTidy(found, Date.now(), busy)
    if (going.length === 0) return

    let freed = 0
    for (const f of going) {
      try {
        unlinkSync(join(dir, f.name))
        freed += f.bytes
      } catch {
        // In use, or not ours to remove. Leaving it is always safe.
      }
    }
    if (freed > 0) console.log(`[tidy] cleared ${humanBytes(freed)} of old update files`)
  } catch {
    // Never worth failing a launch over.
  }
}

/**
 * How long to leave it before trying the server again, and the timer doing it.
 *
 * Backed off rather than hammered: a server that is restarting is back in a
 * few seconds, and one that is off for the evening should not be asked twice
 * a second all evening.
 */
const RETRY_WAITS = [4000, 8000, 15000, 30000] as const
let retryAt = 0
let retryTimer: NodeJS.Timeout | null = null

function stopRetrying(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryAt = 0
}

/**
 * Load the client, and say so plainly when it cannot be loaded.
 *
 * The fallback used to be the copy of the client inside the installer, at
 * app://atrium. It works, and it is the wrong thing: the client keeps
 * everything it remembers in the browser's storage, storage belongs to an
 * origin, and app://atrium is a different origin from the address the app
 * normally loads from. So a launch during a restart came up signed out, on
 * the default theme, with the panels back where they started and every toggle
 * reset - and undid itself the next time the server answered. There is no way
 * to tell that apart from having genuinely lost it.
 *
 * A page that stores nothing cannot look reset. This one says what is wrong
 * and keeps trying, and the app stays on one origin for as long as it is
 * installed.
 */
/**
 * An address reduced to the place it is, for comparing two of them.
 *
 * Scheme and host, not `origin`: a custom scheme has no origin -
 * `new URL('app://atrium').origin` is the string "null", and two of those
 * would match each other and make every custom scheme the same place.
 */
function placeOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/**
 * The places allowed to hold the app, and so to be handed the bridge.
 *
 * Asked for by the preload rather than baked in at window creation: the
 * address of the server can change while the app is running, and a list fixed
 * when the window was made would be wrong from then on.
 */
function allowedPlaces(): string[] {
  const server = storedServer()
  const from = isDev ? [DEV_URL!] : server ? ['app://atrium', server] : ['app://atrium']
  return from.map(placeOf).filter((p): p is string => p !== null)
}

ipcMain.on('app:where-allowed', (event) => {
  event.returnValue = allowedPlaces()
})

async function loadClient(target: BrowserWindow): Promise<void> {
  stopRetrying()
  const server = storedServer()
  if (!server) {
    /* No address yet, so there is nothing to be signed in to and nothing to
       lose: the bundled copy is the first-run screen. */
    await target.loadURL('app://atrium/index.html')
    return
  }
  try {
    await target.loadURL(`${server}/`)
    // Whatever it was running is no longer what it is running.
    loadedAsset = null
    offeredFor = null
  } catch {
    const wait = RETRY_WAITS[Math.min(retryAt, RETRY_WAITS.length - 1)]!
    retryAt += 1
    try {
      await target.loadFile(join(__dirname, 'offline.html'), {
        search: new URLSearchParams({ server, wait: String(wait) }).toString(),
      })
    } catch {
      /* Even the local page would not load. Nothing left to try but again. */
    }
    retryTimer = setTimeout(() => { if (win) void loadClient(win) }, wait)
  }
}

/**
 * Content Security Policy for the packaged app.
 *
 * `script-src 'self'` is the line that matters: even if something injected
 * markup into a message, no inline or remote script would run. connect-src
 * and img-src stay broad because the server address is chosen by the user and
 * cannot be known ahead of time.
 *
 * Applied as a response header here rather than a meta tag in index.html, so
 * it does not interfere with Vite's dev server during development.
 */
/**
 * index.html carries inline scripts on purpose - the startup error surface
 * has to run even when everything else has failed to load, so it cannot live
 * in an external file. A flat `script-src 'self'` blocked them, which is only
 * ever seen in the fallback page nobody is supposed to reach, so it went
 * unnoticed: the console said the action had been blocked and the window
 * carried on looking fine.
 *
 * Hashing the built file rather than listing hashes here means the policy
 * cannot drift from the page it is protecting, and no build step has to
 * remember anything. Same approach the server takes for the web client.
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

let cspCache: string | null = null

function csp(): string {
  if (cspCache) return cspCache
  let hashes: string[] = []
  try {
    hashes = inlineScriptHashes(readFileSync(join(APP_ROOT, 'index.html'), 'utf8'))
  } catch {
    // No bundled page to protect; the strict default below still applies.
  }
  cspCache = [
    "default-src 'self' app:",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "connect-src 'self' http: https: ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  return cspCache
}

/** Serve the built client over app://, refusing anything outside its folder. */
function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname)
    const target = normalize(join(APP_ROOT, rel))

    // Reject traversal outside the bundled app directory.
    if (!target.startsWith(normalize(APP_ROOT))) {
      return new Response('forbidden', { status: 403 })
    }

    const res = await net.fetch(pathToFileURL(target).toString())
    const headers = new Headers(res.headers)
    headers.set('content-security-policy', csp())
    headers.set('x-content-type-options', 'nosniff')
    return new Response(res.body, { status: res.status, headers })
  })
}

function createTray(): void {
  /*
   * The mark, at tray size.
   *
   * This was a 1x1 transparent PNG - a placeholder from before any art
   * existed, which nobody went back to. It does not fail; it just leaves an
   * empty square in the tray beside every other program's icon, with a
   * tooltip and nothing to look at.
   *
   * Loaded from beside the bundle rather than embedded, and checked: a tray
   * icon that fails to load is silent in exactly the same way, so falling
   * back to something visible beats falling back to nothing.
   */
  let icon = nativeImage.createFromPath(join(__dirname, 'tray.png'))
  if (icon.isEmpty()) {
    console.warn('[tray] tray.png missing or unreadable; using the app icon')
    icon = nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 16, height: 16 })
  }
  tray = new Tray(icon)
  tray.setToolTip('Atrium')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Atrium', click: showMainWindow },
      /*
       * There was no way to reload at all.
       *
       * The client is fetched from the server, so a window left open runs
       * whichever build it first loaded - and the thing that notices that and
       * offers a reload lives INSIDE the client, which means a window running
       * an old enough client can never be told. Quitting and reopening worked
       * and is a strange thing to have to know.
       */
      { label: 'Reload', click: () => { win?.webContents.reload() } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } },
    ])
  )
  tray.on('double-click', showMainWindow)
}

// ------------------------------------------------------------------ IPC ----

ipcMain.on('win:minimise', () => win?.minimize())
ipcMain.on('win:toggle-maximise', () => {
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('win:close', () => win?.hide())
/* Which glyph the middle button shows. Asked once when the bar mounts, and
   told from then on - a window is maximised by ways that are nothing to do
   with the button: a double-click on the bar, Win+Up, a drag to the top. */
ipcMain.handle('win:is-maximised', () => win?.isMaximized() ?? false)

/**
 * The clipboard, for the message box's own right-click menu.
 *
 * The renderer has navigator.clipboard, and on the web that is what gets
 * used. The desktop goes through here instead: navigator.clipboard.readText
 * needs a permission and a user gesture, and answers asynchronously through
 * a handler this app has never set - so what it does is a question about
 * Electron's defaults rather than something this code decides. Electron's
 * own clipboard needs neither, and a Paste that silently does nothing is
 * worse than no Paste at all.
 *
 * It is not a widening of what the renderer can reach: with no permission
 * handler set, a page here could already read the clipboard by asking. This
 * only makes it a named capability like everything else in the bridge.
 *
 * Capped on the way in. This is a named capability like everything else in
 * the bridge, and a renderer that has been got at should not be able to put
 * a hundred megabytes into the clipboard through it.
 */
ipcMain.handle('clip:read', () => clipboard.readText().slice(0, 100_000))
ipcMain.on('clip:write', (_e, text: string) => {
  clipboard.writeText(String(text).slice(0, 100_000))
})

app.on('before-quit', () => {
  try { appAudio?.stop() } catch { /* nothing to stop */ }
})

app.whenReady().then(() => {
  try {
    installSharePicker()
  } catch (err) {
    // Screen sharing will fail loudly rather than the app failing to start.
    console.error('[share] could not install the picker', err)
  }
})

ipcMain.on('app:notify', (_e, title: string, body: string) => {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  /* Through the one place, so that clicking a notification after a login
     start counts as asking for the window - see showMainWindow. */
  n.on('click', showMainWindow)
  n.show()
})

/**
 * The page has been told which server to talk to; remember it out here.
 *
 * Sent by the first-run screen. Without this the address would live only in
 * the bundled page's storage, and the main process - which has to decide
 * what to load before any page exists - would never learn it.
 */
ipcMain.on('app:set-server', (_e, url: string) => {
  const clean = String(url ?? '').slice(0, 300).trim()
  if (!/^https?:\/\/[^\s]+$/.test(clean)) return
  rememberServer(clean)
  if (win) void loadClient(win)
})

/** Try the server again now, from the page that says it could not be reached. */
ipcMain.on('app:retry', () => {
  /* By hand, so start the backoff over: somebody pressing this knows
     something the timer does not. */
  retryAt = 0
  if (win) void loadClient(win)
})

/** Forget it, and fall back to the first-run screen. */
ipcMain.on('app:clear-server', () => {
  rememberServer(null)
  if (win) void loadClient(win)
})

ipcMain.on('app:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true)
})

/**
 * The unread badge: a mark on the taskbar button, and on the dock elsewhere.
 *
 * A toast and a flashing taskbar button both stop after a few seconds, so
 * somebody who was away from the machine came back to no sign that anything
 * had happened. This is the part that is still there an hour later.
 *
 * The picture is drawn by the app and arrives as a PNG data URL, because the
 * main process has no DOM to draw one with. It is checked before use: an
 * exact prefix, a length cap, and nativeImage refusing to decode it are three
 * separate ways for a bad string to end up doing nothing at all.
 */
let badgeCount = 0

ipcMain.on('app:badge', (_e, count: number, icon: string | null, tooltip: string) => {
  badgeCount = Math.max(0, Math.min(Math.floor(Number(count) || 0), 9999))

  /*
   * macOS and most Linux desktops have a real badge of their own, and it
   * takes a number rather than a picture. Windows has no such thing - there
   * the badge IS the overlay below.
   */
  if (process.platform !== 'win32' && typeof app.setBadgeCount === 'function') {
    try { app.setBadgeCount(badgeCount) } catch { /* no dock, no badge */ }
  }

  applyOverlay(icon)

  // The window can be hidden to the tray, and then there is no taskbar button
  // to put a badge on. The tooltip is the only thing left that can say so.
  if (tray) tray.setToolTip(String(tooltip ?? 'Atrium').slice(0, 120))
})

function applyOverlay(icon: string | null): void {
  if (!win || process.platform !== 'win32') return
  if (!icon) {
    win.setOverlayIcon(null, '')
    return
  }
  if (!icon.startsWith('data:image/png;base64,') || icon.length > 64_000) return
  try {
    const image = nativeImage.createFromDataURL(icon)
    // An image that would not decode comes back empty, and handing an empty
    // one to Windows leaves a blank square sitting on the icon.
    if (image.isEmpty()) return
    win.setOverlayIcon(image, badgeCount > 0 ? `${badgeCount} unread` : 'unread messages')
  } catch {
    // A malformed data URL is not worth taking the app down for.
  }
}


/**
 * Global push-to-talk.
 *
 * This is the capability a browser fundamentally cannot provide: the key has
 * to register while the game has focus and Atrium does not.
 *
 * Electron only gives a key-down event for a global shortcut, so the release
 * is inferred on a timer that each repeat refreshes.
 */
/**
 * Capturing the sound of one program.
 *
 * The compiled part is loaded lazily and allowed to be missing: it is
 * Windows-only and has to be built against this exact Electron, and neither
 * is worth refusing to start over. When it is not there the renderer is told
 * so and does not offer the choice.
 */
type AppAudio = {
  available: () => boolean
  unavailableBecause: () => string | null
  sessions: () => Array<{ pid: number; name: string; active: boolean }>
  pidForWindow: (handle: number) => number | null
  start: (pid: number, onData: (chunk: Buffer) => void) => void
  stop: () => void
  running: () => boolean
  format: () => { sampleRate: number; channels: number; bitsPerSample: number }
}

let appAudio: AppAudio | null = null
let appAudioError: string | null = null

function loadAppAudio(): AppAudio | null {
  if (appAudio || appAudioError) return appAudio
  try {
    // Beside the bundled main process when packaged, and in the workspace
    // when not - require resolves both from here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    appAudio = require('../native/appaudio') as AppAudio
  } catch (err) {
    appAudioError = err instanceof Error ? err.message : String(err)
  }
  return appAudio
}

/**
 * Choosing what to share.
 *
 * Electron refuses getDisplayMedia outright unless something answers this,
 * which meant screen sharing did not work in the desktop app at all - it
 * failed with "Not supported" and nobody noticed, because everybody was
 * using the browser.
 *
 * Answering it ourselves also settles the audio. The source id for a window
 * carries the window handle, the handle names the process, and the process
 * is exactly what the capture below wants - so picking a window to share
 * picks its sound at the same time, without asking the same question twice.
 */
let shareAudioPid: number | null = null

/** The pid whose sound belongs to the share just started, if any. */
ipcMain.handle('appaudio:current', () => shareAudioPid)

function installSharePicker(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    shareAudioPid = null
    try { loadAppAudio()?.stop() } catch { /* nothing running */ }

    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      })
    } catch {
      callback({})
      return
    }

    const offer = sources.map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }))

    const { id: chosenId, audio: wantAudio } = await askWindowToChoose(offer)
    const source = sources.find((s) => s.id === chosenId)
    if (!source) {
      // Cancelled. An empty answer is how this API says "never mind".
      callback({})
      return
    }

    /**
     * A window brings its own program's sound; a whole screen brings the
     * machine's. Neither is a question worth asking separately - what you
     * picked already said which you meant.
     */
    const audio = loadAppAudio()
    const handle = source.id.startsWith('window:') ? Number(source.id.split(':')[1]) : 0
    let perProgram = false

    if (wantAudio && handle && audio?.available()) {
      const pid = audio.pidForWindow(handle)
      if (pid) {
        try {
          audio.start(pid, (chunk) => {
            if (!win || win.isDestroyed()) return
            win.webContents.send('appaudio:data', chunk)
          })
          shareAudioPid = pid
          perProgram = true
        } catch {
          // Fall through to whatever the platform will give us.
          shareAudioPid = null
        }
      }
    }

    /**
     * The key has to be absent, not undefined.
     *
     * Electron checks the shape rather than the value and refuses the whole
     * request with "Invalid capture constraints" - which arrives at the page
     * as an AbortError and reads exactly like the person having cancelled.
     *
     * Loopback only for a whole screen, and only when we are not already
     * sending the program's own: two copies of the same sound arriving
     * together is an echo, not redundancy.
     */
    const answer: { video: typeof source; audio?: 'loopback' } = { video: source }
    if (wantAudio && !perProgram && source.id.startsWith('screen:')) answer.audio = 'loopback'
    callback(answer)
  }, { useSystemPicker: false })
}

/**
 * Ask the window which source, and wait for the answer.
 *
 * The picker is drawn by the app rather than by the platform, because the
 * platform's does not tell us what was chosen - and what was chosen is the
 * whole reason the sound can follow it.
 */
type Chosen = { id: string | null; audio: boolean }

let choosing: ((chosen: Chosen) => void) | null = null

ipcMain.on('share:chosen', (_e, id: string | null, audio?: boolean) => {
  const settle = choosing
  choosing = null
  // An older page sends only the id and means what it always meant: sound
  // goes with the share.
  settle?.({ id, audio: audio !== false })
})

function askWindowToChoose(offer: unknown[]): Promise<Chosen> {
  if (!win || win.isDestroyed()) return Promise.resolve({ id: null, audio: false })
  // A previous question that never got an answer is abandoned, or the two
  // would both be waiting on the one reply.
  choosing?.({ id: null, audio: false })
  win.webContents.send('share:choose', offer)
  return new Promise((resolve) => {
    choosing = resolve
    // Nothing forces somebody to answer, and a promise nobody settles keeps
    // getDisplayMedia hanging for the life of the app.
    setTimeout(() => {
      if (choosing === resolve) { choosing = null; resolve({ id: null, audio: false }) }
    }, 120_000)
  })
}

ipcMain.handle('appaudio:available', () => {
  const mod = loadAppAudio()
  if (!mod) return { available: false, reason: appAudioError ?? 'not built into this copy' }
  return mod.available()
    ? { available: true, reason: null, format: mod.format() }
    : { available: false, reason: mod.unavailableBecause() }
})

ipcMain.handle('appaudio:sessions', () => {
  const mod = loadAppAudio()
  if (!mod || !mod.available()) return []
  try {
    return mod.sessions()
  } catch {
    return []
  }
})

ipcMain.handle('appaudio:start', (_e, pid: number) => {
  const mod = loadAppAudio()
  if (!mod || !mod.available()) {
    return { ok: false, error: appAudioError ?? mod?.unavailableBecause() ?? 'unavailable' }
  }
  try {
    mod.stop()
    mod.start(Number(pid), (chunk) => {
      // Straight through. The window is the only thing that wants it, and
      // holding any of it here would only add delay.
      if (!win || win.isDestroyed()) return
      win.webContents.send('appaudio:data', chunk)
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('appaudio:stop', () => {
  try { loadAppAudio()?.stop() } catch { /* already stopped */ }
  return true
})

let pttAccelerator: string | null = null
let pttTimer: NodeJS.Timeout | null = null

ipcMain.handle('ptt:register', (_e, accelerator: string | null) => {
  if (pttAccelerator) {
    globalShortcut.unregister(pttAccelerator)
    pttAccelerator = null
  }
  if (!accelerator) return true

  const ok = globalShortcut.register(accelerator, () => {
    if (!pttTimer) win?.webContents.send('ptt:state', true)
    if (pttTimer) clearTimeout(pttTimer)
    pttTimer = setTimeout(() => {
      pttTimer = null
      win?.webContents.send('ptt:state', false)
    }, 300)
  })

  if (ok) pttAccelerator = accelerator
  return ok
})

/* --------------------------------------------------------------- updates --
 * Updates come from GitHub releases on the public repo. Nothing is installed
 * behind anyone's back: we check, we tell the renderer, and we only download
 * when someone asks. The install happens on quit so it never interrupts a
 * conversation mid-sentence.
 */
/*
 * Fetch it without being asked.
 *
 * The update used to announce itself and wait for a button, which puts a
 * decision in front of somebody who has just opened the app to talk to their
 * friends - and the honest answer to "would you like the new version" is
 * always yes, so it was a question with one answer. It downloads in the
 * background now and says so with a bar, which is the only part worth
 * showing.
 *
 * Installing is deliberate, and only from the button.
 *
 * autoInstallOnAppQuit was on, and it is a trap when the install fails. The
 * sequence: quitting releases the single-instance lock and starts the silent
 * installer; the installer is configured to run the app afterwards, so a new
 * copy starts and takes the lock while the old process is still winding down;
 * the old process still holds the executable, so the installer cannot replace
 * it and gives up. Nothing is shown, because this path is silent. The version
 * has not changed, so the next quit does exactly the same thing.
 *
 * What that looks like from the outside is an app that will not stay closed -
 * reported as "I quit out of it but it keeps opening by itself". It had also
 * left two copies running earlier in the day, which is what made an ordinary
 * update refuse to install at all.
 *
 * So updates download in the background and wait for Restart now, which sets
 * `quitting`, hides the window, puts a splash up and installs where somebody
 * can see it happening. A failure there is visible and can be acted on; a
 * failure on the way out is invisible and repeats.
 */
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = false

/**
 * Where the downloaded update waits. Named in the electron-builder config as
 * `updaterCacheDirName`, and it has to agree with it.
 */
const UPDATER_CACHE = 'atrium-desktop-updater'

/**
 * Throw away an update that is already installed.
 *
 * Reported as the app freezing for several seconds on every start and every
 * reload, on the desktop only. A downloaded update is checked before it is
 * offered - the whole hundred megabytes read back and its publisher
 * signature verified, which on Windows means shelling out and waiting - and
 * that happens in the process that owns the window, so the window stops
 * answering while it runs.
 *
 * Which is fine once for an update somebody is about to install, and pure
 * waste for ever afterwards: the copy left behind after installing is an
 * installer for the version already running, re-read and re-verified on
 * every check, and never used again.
 *
 * Only ever removes a cache whose pending update is this exact version, so
 * the worst it can do is make something re-download that was going to be
 * installed anyway.
 */
function forgetInstalledUpdate(): void {
  const base = process.env.LOCALAPPDATA
  if (!base) return
  const dir = join(base, UPDATER_CACHE)
  try {
    const raw = readFileSync(join(dir, 'pending', 'update-info.json'), 'utf8')
    const { fileName } = JSON.parse(raw) as { fileName?: string }
    const waiting = /(\d+\.\d+\.\d+)/.exec(fileName ?? '')?.[1]
    if (!waiting || waiting !== app.getVersion()) return
    rmSync(dir, { recursive: true, force: true })
    console.log(`[update] cleared a downloaded ${waiting}, which is what is running`)
  } catch {
    /* Nothing cached, nothing readable, or nothing we are allowed to remove.
       None of those is worth a word: this is housekeeping. */
  }
}

function toRenderer(channel: string, payload?: unknown): void {
  win?.webContents.send(channel, payload)
}

/**
 * The last thing the updater said, kept so it can be asked for again.
 *
 * Update news used to be an event and nothing else, and the thing listening
 * for it lives inside the chat view - which does not exist until somebody has
 * signed in. The first check runs eight seconds after launch and then hourly,
 * so an update found on the sign-in screen was announced to nobody, and the
 * banner did not appear until the next hourly check came round.
 *
 * Worse across restarts: an update downloaded yesterday is sitting there
 * ready to install, and its "ready" event fired in a session that has since
 * ended. Nothing ever said so again.
 *
 * So the state is remembered here, and the banner asks for it when it mounts.
 */
type UpdateStage = 'idle' | 'available' | 'downloading' | 'ready' | 'error'
let updateState: { stage: UpdateStage; version: string; percent: number; error: string } = {
  stage: 'idle', version: '', percent: 0, error: '',
}

/* ------------------------------------------------------------- presence --
 * What this machine is doing, for the people who can see it.
 *
 * Nothing here runs until somebody turns it on. When they do, this asks
 * Windows two questions every few seconds - what is playing, and what is
 * running - and hands up a finished line.
 *
 * The matching happens here, and that is the whole point of it being here.
 * The list of what is running is read, compared against the games list, and
 * dropped. Only a match crosses to the renderer, so nothing anywhere else in
 * this program has ever seen the rest of it - not the page, not the socket,
 * not the server. "We check whether a game is running" is a different promise
 * from "we upload what you are running", and only the first is being made.
 */
type Watching = { game: boolean; music: boolean }
type Game = {
  kind: 'game'; name: string; since?: number
  /** The icon out of the game's own executable, on its way to being a name. */
  artPixels?: { width: number; height: number; rgba: Uint8Array }
}
type Music = {
  kind: 'music'; name: string; detail?: string; at?: number; length?: number
  /** The cover, full size, on its way to being made small in the renderer. */
  art?: string
}
type Reported = Game | Music | null

let watching: Watching = { game: false, music: false }
let presenceTimer: ReturnType<typeof setInterval> | null = null
let lastReported = 'null'
/** When the game that is running now was first seen, for "for 40 minutes". */
let gameSince: { name: string; at: number } | null = null

/** Five seconds. A track is minutes long and a game is hours. */
const PRESENCE_MS = 5_000

let games: Record<string, string> | null = null
function gamesList(): Record<string, string> {
  if (games) return games
  try {
    games = JSON.parse(readFileSync(join(__dirname, 'games.json'), 'utf8')) as Record<string, string>
  } catch {
    // A build without the list recognises nothing, which is the safe way to
    // be wrong: it says nobody is playing anything rather than guessing.
    games = {}
  }
  return games
}

type PresenceNative = {
  available: boolean
  whatIsPlaying: (wantArt?: boolean) => Record<string, unknown> | null
  runningNames: () => string[]
  iconForName: (name: string) => { width: number; height: number; rgba: Uint8Array } | null
  /* The expensive two, answered on a thread of their own. */
  whatIsPlayingLater: (wantArt?: boolean) => Promise<Record<string, unknown> | null>
  iconForNameLater: (name: string) => Promise<{ width: number; height: number; rgba: Uint8Array } | null>
  watchMedia: (onChange: () => void) => boolean
  /** The id of a running program by name, or 0. Costs a full snapshot. */
  pidForName: (name: string) => number
  /** Whether that exact process is still running. Costs almost nothing. */
  stillRunning: (pid: number, name: string) => boolean
  stopWatchingMedia: () => boolean
  /** Which player to read, by part of its app id. "" for whichever is current. */
  preferApp: (name: string) => boolean
}

/** Nothing, rather than a crash, in a copy where the native part is missing. */
const NO_PRESENCE: PresenceNative = {
  available: false,
  whatIsPlaying: () => null,
  runningNames: () => [],
  iconForName: () => null,
  whatIsPlayingLater: () => Promise.resolve(null),
  preferApp: () => false,
  iconForNameLater: () => Promise.resolve(null),
  watchMedia: () => false,
  pidForName: () => 0,
  stillRunning: () => false,
  stopWatchingMedia: () => false,
}

let presenceNative: PresenceNative | null = null

function nativePresence(): PresenceNative {
  if (presenceNative) return presenceNative
  let loaded: PresenceNative
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require(join(__dirname, '..', 'native', 'presence', 'index.js')) as PresenceNative
  } catch {
    loaded = NO_PRESENCE
  }
  presenceNative = loaded
  return loaded
}

/**
 * Music, but only from a music player.
 *
 * Windows reports whatever is playing, browsers included - and a browser
 * means the title of any video anybody has open, which is a good deal more
 * revealing than a song and was never what anybody agreed to. So this asks
 * the narrow question it was allowed to ask.
 */
/*
 * The cover, and the track it belongs to.
 *
 * Reading the artwork costs 424ms against 4ms without it - it is a stream to
 * open and a few hundred kilobytes to copy - and it cannot change without the
 * track changing. So it is fetched once when the title does, and kept.
 */
/*
 * Where the reading of the current track's cover has got to.
 *
 * The same shape as the game's icon, and for the same reason: this latched
 * the track before the read and never asked again, so a cover that came back
 * empty once was missing for as long as the song played. gameIcon.ts holds
 * the rule; this is the other thing that reads the same way.
 */
let artHunt: Hunt<string> = nothingYet<string>('')
/*
 * Where the track was said to be, and when it was said.
 *
 * A position moves on its own, so a report of one is only news if it is not
 * where it would have got to by now. That is the whole difference between a
 * rewind, which ten people should see, and a second passing, which they
 * should not - and reporting every position was twelve messages a minute per
 * person for a bar the receiving card already advances by itself.
 */
let toldAt = 0
let toldAtTime = 0
/** The game whose icon is in hand, so it is read once rather than per check. */
/*
 * The game being reported, as one process rather than as a name.
 *
 * A game runs for hours, and for every one of those hours the only
 * question is whether it is still on. Listing every process in the app
 * to answer that was measured at 4.7ms a time against 0.018ms for asking
 * about one known id - 255 times the cost, every five seconds, for an
 * answer that is almost always the same one.
 */
let gamePid = 0
let gameExe = ''
/*
 * A full look round anyway, once a minute.
 *
 * The cheap check can only confirm what is already known, so on its own it
 * would never notice somebody starting a second game while the first is
 * open. That is rare and this is cheap: twelve ticks is a minute, which
 * keeps the old behaviour and a twelfth of the old cost.
 */
let ticksSinceLook = 0
const LOOK_ROUND_EVERY = 12
/*
 * Where the reading of the current game's icon has got to.
 *
 * Not a picture and a name any more, because one read is not enough: the
 * shell hands back the generic application icon for an entry it has not
 * extracted yet, and the one moment this was ever asked was seconds after a
 * game launched. gameIcon.ts is the rule and has the whole story.
 */
let iconHunt: IconHunt = noIconYet('')

/**
 * Read the icon, if the hunt still wants one.
 *
 * Costs a string comparison on the hot path, which is where a game somebody
 * has had open for three hours spends every tick.
 */
async function keepIconFresh(exe: string, name: string): Promise<void> {
  if (!wantsIconRead(iconHunt, name)) return
  const got = await nativePresence().iconForNameLater(exe)
  iconHunt = withIconRead(iconHunt, name, got)
}

async function musicNow(): Promise<Music | null> {
  const playing = await nativePresence().whatIsPlayingLater(false)
  if (!playing) { artHunt = nothingYet<string>(''); return null }
  const app = String(playing.app ?? '').toLowerCase()
  if (!app.includes('spotify')) return null
  if (playing.playing !== true) return null
  const name = String(playing.title ?? '').trim()
  if (!name) return null
  const out: Music = { kind: 'music', name }
  const artist = String(playing.artist ?? '').trim()
  if (artist) out.detail = artist
  if (typeof playing.at === 'number') out.at = playing.at
  if (typeof playing.length === 'number') out.length = playing.length

  const track = `${name}|${artist}`
  if (wantsRead(artHunt, track)) {
    const withArt = await nativePresence().whatIsPlayingLater(true)
    const art = typeof withArt?.art === 'string' && withArt.art ? withArt.art : null
    artHunt = withRead(artHunt, track, art, (x, y) => x === y)
  }
  /*
   * Full size from here. It is made small in the renderer, which has a canvas
   * to redraw it with and this process does not - and it never leaves the
   * machine at this size.
   */
  /* By name, so a cover never outlives the track it belongs to. */
  const art = gotFor(artHunt, track)
  if (art) out.art = art
  return out
}

/** A game, if one of the ones on the list is running. */
async function gameNow(): Promise<Game | null> {
  /*
   * The list of what is running goes in, one name comes out, and the list is
   * not kept. matchGame is where that actually happens and is tested for it,
   * rather than being a property of how carefully this was written.
   */
  /*
   * The same game as last time, still running: answer without looking at
   * anything else. This is the case that lasts hours.
   */
  if (gamePid && gameExe && gameSince && ticksSinceLook < LOOK_ROUND_EVERY) {
    ticksSinceLook++
    if (nativePresence().stillRunning(gamePid, gameExe)) {
      const still: Game = { kind: 'game', name: gameSince.name, since: gameSince.at }
      /* Here too, and not only on the full look round.
       *
       * The shell can take a moment to extract an icon it has not been asked
       * for lately, and a full look round is only once a minute - so waiting
       * for one would leave the generic icon up for a minute at a time. This
       * asks nothing at all once the answer has settled, which it has for
       * every tick of the hours this path exists for. */
      await keepIconFresh(gameExe, gameSince.name)
      const mine = iconFor(iconHunt, gameSince.name)
      if (mine) still.artPixels = mine
      return still
    }
    // It stopped. Fall through and look properly.
    gamePid = 0
    gameExe = ''
  }
  ticksSinceLook = 0

  const running = nativePresence().runningNames()
  const name = matchGame(running, gamesList())
  if (!name) {
    gameSince = null
    gamePid = 0
    gameExe = ''
    iconHunt = noIconYet('')
    return null
  }
  // The clock starts when it was first seen, not when it was first reported.
  if (!gameSince || gameSince.name !== name) gameSince = { name, at: Date.now() }

  /*
   * The icon out of the game's own executable.
   *
   * Which means every game has one, including any nobody put on a list -
   * somebody installs something obscure and their friends see its real icon.
   * It is the program's icon rather than box art: less pretty than a store
   * banner, and honest about where it came from.
   *
   * The first read warms the shell's image lists and costs about half a
   * second; the ones after are ten milliseconds. It used to be read once, on
   * the grounds that it cannot change while the game is the same game - which
   * is true of the icon and not of the shell's answer about it. See
   * gameIcon.ts.
   */
  const exe = running.find((n) => gamesList()[String(n).toLowerCase()] === name)
  /*
   * Which process it is, so the checks in between can be the cheap kind.
   * Looked up here because the snapshot has just been taken anyway.
   */
  if (exe && (gameExe !== exe || !gamePid)) {
    gameExe = String(exe)
    gamePid = nativePresence().pidForName(gameExe)
  }
  if (exe) await keepIconFresh(String(exe), name)

  const out: Game = { kind: 'game', name, since: gameSince.at }
  const art = iconFor(iconHunt, name)
  if (art) out.artPixels = art
  return out
}

/*
 * One at a time. A check that outlives its own interval - a cold icon read is
 * half a second - would otherwise start a second while the first is still
 * going, and they would race over which answer is the current one.
 */
let ticking = false

async function presenceTick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await runPresenceTick()
  } finally {
    ticking = false
  }
}

async function runPresenceTick(): Promise<void> {
  /*
   * Both, when there are both. People play with music on, and picking one
   * here would decide for every screen that shows it - a profile has room
   * for two cards and the member list takes the more particular of them.
   * Which is which is not this program's business.
   */
  const found: Reported[] = []
  if (watching.game) { const g = await gameNow(); if (g) found.push(g) }
  if (watching.music) { const m = await musicNow(); if (m) found.push(m) }
  /*
   * Compared without the artwork, and without the position.
   *
   * The artwork is a couple of hundred kilobytes of base64 that cannot change
   * unless the title beside it does, so comparing it is work to discover
   * nothing.
   *
   * The position is the one that mattered. It moves every second, so every
   * check counted as a change and pushed a new line to everybody who can see
   * this person - which is exactly the traffic the line below claims to
   * prevent, and the sums get bad quickly: presence goes to everyone, so a
   * hundred people each sending twelve times a minute is a hundred times a
   * hundred messages a minute for a bar that moves on its own anyway. The
   * card carries it forward from when it was last told; it does not need
   * telling again until the track does change.
   */
  const now = Date.now()
  const said = JSON.stringify(found.map((a) => {
    if (!a) return a
    if (a.kind === 'music') {
      /*
       * The position, compared against where it should have got to.
       *
       * Steady play looks the same every time and says nothing; a rewind or a
       * skip is a jump, and that is worth telling people about. Without this
       * the two were indistinguishable, so leaving the position in meant
       * reporting constantly and taking it out meant a rewind never showed at
       * all - which is what was reported.
       */
      const moved = movedDeliberately(a.at ?? 0, toldAt, toldAtTime, now)
      return { ...a, art: a.art ? 'y' : '', at: moved ? a.at ?? 0 : 'steady' }
    }
    // A quarter of a megabyte of icon, which cannot change while the game is
    // the same game. Compared as present or not, like the cover.
    return { ...a, artPixels: a.artPixels ? 'y' : '' }
  }))
  /* A track that is simply still playing is not news. */
  if (said === lastReported) return
  lastReported = said
  /* What was actually sent, so the next check has something to predict from. */
  const music = found.find((a) => a && a.kind === 'music')
  if (music && music.kind === 'music') { toldAt = music.at ?? 0; toldAtTime = now }
  else { toldAt = 0; toldAtTime = 0 }
  toRenderer('presence:update', found)
}

ipcMain.handle('presence:watch', (_e, want: Watching) => {
  watching = { game: want?.game === true, music: want?.music === true }
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
  nativePresence().stopWatchingMedia()
  /*
   * Say it again even if it has not changed.
   *
   * The server forgets what somebody was doing the moment their socket goes,
   * which is right - nobody should be left playing something an hour after
   * closing their laptop. But this only speaks when the answer changes, so
   * after a reconnect the answer was the same and nothing was said, and a
   * dropped connection quietly ended presence until the next track. Asking to
   * watch is the moment to re-announce, and a reconnect asks.
   */
  lastReported = ''
  /*
   * Which player to read, when the machine has several.
   *
   * Windows answers "what is playing" with whichever app last owned the media
   * session, and a browser playing a stream owns it and keeps it - so Spotify
   * went invisible while it was still playing, and came back only if somebody
   * pressed a media key, which moves ownership rather than asking anybody.
   * Naming the player asks the question that was actually meant.
   */
  nativePresence().preferApp(watching.music ? 'spotify' : '')
  if (!watching.game && !watching.music) {
    // Turned off is a thing to say once, so nobody is left showing a game
    // they stopped playing an hour ago.
    gameSince = null
    gamePid = 0
    gameExe = ''
    if (lastReported !== '[]') { lastReported = '[]'; toRenderer('presence:update', []) }
    return false
  }
  void presenceTick()

  /*
   * Music is told, games are asked.
   *
   * Windows raises an event when a track changes, so nothing needs to look -
   * and the track appears the moment it starts rather than up to five seconds
   * later. There is no such event for a program starting, so games keep the
   * timer, and it only runs when games are actually being watched.
   */
  if (watching.music) nativePresence().watchMedia(() => void presenceTick())
  if (watching.game) {
    presenceTimer = setInterval(() => void presenceTick(), PRESENCE_MS)
    presenceTimer.unref()
  }
  return nativePresence().available
})

ipcMain.handle('update:state', () => updateState)

/**
 * What changed, once, on the first launch of the version it describes.
 *
 * Read and deleted in the same breath, so it cannot show twice - and deleted
 * even when the version does not match, since notes for a version this app is
 * not running are notes for an update that never finished installing.
 */
ipcMain.handle('update:whatsNew', () => {
  const file = WHATS_NEW_FILE()
  let saved: Saved = null
  try {
    if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A half-written file, or an older shape. Nothing to show, nothing wrong.
    saved = null
  }
  // Deleted whatever it said, so a card cannot come back on the next launch.
  try { unlinkSync(file) } catch { /* already gone */ }
  return whatsNewFor(saved, app.getVersion())
})

/**
 * Look again, unless we only just did.
 *
 * The floor is what makes it safe to call this from anything that happens
 * often. Nothing to do once an update is downloaded and waiting: the answer
 * cannot change until it has been installed.
 */
let lastChecked = 0
const CHECK_FLOOR_MS = 10 * 60_000

function checkForUpdatesSoon(): void {
  if (updateState.stage === 'downloading' || updateState.stage === 'ready') return
  if (Date.now() - lastChecked < CHECK_FLOOR_MS) return
  lastChecked = Date.now()
  void autoUpdater.checkForUpdates().catch(() => {})
}


/*
 * What the release said, kept until the app has restarted into it.
 *
 * Asked for: a card in the middle of the app on the first launch after an
 * update, saying what the update was for. The words already arrive - the
 * provider sends the release's own body along with the update - and the only
 * thing missing was that they did not survive the restart that installs it.
 *
 * So they are written down, and read back once. That is a couple of kilobytes
 * on disk, overwritten each update: no changelog file to keep in step with
 * the releases, nothing fetched from anywhere, and nothing asked of the
 * server. The alternative was going back to the provider on first launch,
 * which is a network request, a dependency, and a thing to fail offline.
 */
const WHATS_NEW_FILE = () => join(app.getPath('userData'), 'whats-new.json')

/** Held from update-available, which is where the notes arrive. */
let notesForNextVersion = ''

autoUpdater.on('update-available', (info) => {
  saySplash(`Updating to ${info.version}`, Number.NaN)
  updateState = { stage: 'available', version: String(info.version), percent: 0, error: '' }
  notesForNextVersion = String(info.releaseNotes ?? '').slice(0, 4000)
  toRenderer('update:available', { version: info.version, notes: notesForNextVersion.slice(0, 2000) })
})
autoUpdater.on('update-not-available', () => {
  // Only forget an update we were told about; one already downloaded and
  // waiting to install is still waiting, whatever a later check says.
  if (updateState.stage !== 'ready') {
    updateState = { stage: 'idle', version: '', percent: 0, error: '' }
  }
  toRenderer('update:none')
})
autoUpdater.on('download-progress', (p) => {
  saySplash('Downloading update', Math.round(p.percent))
  updateState = { ...updateState, stage: 'downloading', percent: Math.round(p.percent) }
  toRenderer('update:progress', { percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond })
})
autoUpdater.on('update-downloaded', (info) => {
  saySplash('Update ready')
  updateState = { stage: 'ready', version: String(info.version), percent: 100, error: '' }
  toRenderer('update:ready', { version: info.version })

  /*
   * Written now rather than at install time, because there is no install
   * time we get to run code in - the installer replaces the app while it is
   * closed. The version is stored with the notes so the next launch can tell
   * whether it is the one they belong to.
   */
  try {
    writeFileSync(WHATS_NEW_FILE(), JSON.stringify({
      version: String(info.version),
      notes: notesForNextVersion,
    }))
  } catch {
    // A missing card is not worth failing an update over.
  }
})
autoUpdater.on('error', (err) => {
  // A failed update check must never take the app down with it.
  const detail = String(err?.message ?? err).slice(0, 300)
  // An update already downloaded is unaffected by a later check failing, so
  // that state is not thrown away for it.
  if (updateState.stage !== 'ready') {
    updateState = { ...updateState, stage: 'error', error: detail }
  }
  toRenderer('update:error', detail)
})

ipcMain.handle('update:check', async () => {
  if (isDev) return { supported: false, reason: 'updates are disabled in development' }
  try {
    const result = await autoUpdater.checkForUpdates()
    return { supported: true, version: result?.updateInfo?.version ?? null }
  } catch (err) {
    return { supported: true, error: String(err instanceof Error ? err.message : err).slice(0, 300) }
  }
})

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch {
    return false
  }
})

ipcMain.handle('update:install', () => {
  quitting = true

  /*
   * Quietly, with this app's own window doing the talking.
   *
   * It used to run the installer visibly, on the reasoning that pressing a
   * button should visibly do something. It did: it put a grey Windows
   * progress box, in somebody else's typography, in front of the app it was
   * updating. Reported as wanting it to look like the splash instead - which
   * it can, because the splash is already exactly the screen for "wait a
   * moment while this starts".
   *
   * Quiet meaning no installer window of its own - not unattended. This is
   * now the only way an update is applied: the same thing used to happen on
   * every quit, invisibly, and when it failed it left the app reopening
   * itself for ever. Here somebody pressed a button, the splash says what is
   * happening, and a failure is in front of them.
   *
   * isForceRunAfter reopens it when the install finishes, which is what a
   * button saying Restart now promises.
   */
  if (win && !win.isDestroyed()) win.hide()
  const saying = `Installing ${updateState.version || 'the update'}…`
  if (splash) saySplash(saying, Number.NaN)
  else createSplash(saying)

  /*
   * A moment for that to be on screen before the process ends. quitAndInstall
   * quits immediately, so without it the splash is created and destroyed
   * inside the same frame and nobody sees anything at all - which is the
   * complaint, arrived at from the other direction.
   */
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 400)
  return true
})

ipcMain.handle('update:version', () => app.getVersion())

/* ----------------------------------------------------------- credentials --
 * Stored per server address, encrypted by the OS. safeStorage is backed by
 * DPAPI on Windows and the Keychain on macOS, so the ciphertext is useless
 * on another machine or to another account.
 *
 * The file lives in userData, which persists across app updates.
 */
function credsFile(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

type CredStore = Record<string, { username: string; secret: string }>

function readCreds(): CredStore {
  try {
    if (!existsSync(credsFile())) return {}
    return JSON.parse(readFileSync(credsFile(), 'utf8')) as CredStore
  } catch {
    return {}
  }
}


/**
 * System preferences.
 *
 * Three things only the desktop can do. They live in a small JSON file beside
 * the saved credentials rather than in the renderer's localStorage, because
 * two of them have to be read before any window exists - hardware
 * acceleration must be disabled before the app is ready, and launch-on-login
 * is a property of the installed app rather than of a page.
 */
type SystemPrefs = {
  launchOnStartup: boolean
  minimiseToTray: boolean
  hardwareAcceleration: boolean
}

function prefsFile(): string {
  return join(app.getPath('userData'), 'system.json')
}

function readPrefs(): SystemPrefs {
  const defaults: SystemPrefs = {
    launchOnStartup: false,
    minimiseToTray: true,
    hardwareAcceleration: true,
  }
  try {
    if (!existsSync(prefsFile())) return defaults
    return { ...defaults, ...JSON.parse(readFileSync(prefsFile(), 'utf8')) }
  } catch {
    return defaults
  }
}

function writePrefs(next: SystemPrefs): void {
  try {
    writeFileSync(prefsFile(), JSON.stringify(next), { mode: 0o600 })
  } catch {
    // A read-only profile is not worth crashing over; the setting simply
    // will not survive a restart.
  }
}

ipcMain.handle('sys:get', () => readPrefs())

ipcMain.handle('sys:set', (_e, key: string, value: boolean) => {
  const prefs = readPrefs()
  if (key !== 'launchOnStartup' && key !== 'minimiseToTray' && key !== 'hardwareAcceleration') {
    return readPrefs()
  }
  prefs[key] = Boolean(value)
  writePrefs(prefs)

  if (key === 'launchOnStartup') {
    app.setLoginItemSettings({
      openAtLogin: prefs.launchOnStartup,
      // Started with the machine, it should appear in the tray rather than
      // throwing a window at somebody who has just logged in.
      args: ['--hidden'],
    })
  }
  // hardwareAcceleration is read at startup; nothing to apply now.
  return prefs
})

ipcMain.handle('creds:available', () => safeStorage.isEncryptionAvailable())

ipcMain.handle('creds:save', (_e, server: string, username: string, password: string) => {
  // Refuse rather than silently writing a password in the clear.
  if (!safeStorage.isEncryptionAvailable()) return false
  try {
    const store = readCreds()
    store[String(server)] = {
      username: String(username),
      secret: safeStorage.encryptString(String(password)).toString('base64'),
    }
    writeFileSync(credsFile(), JSON.stringify(store), { mode: 0o600 })
    return true
  } catch {
    return false
  }
})

ipcMain.handle('creds:load', (_e, server: string) => {
  try {
    const entry = readCreds()[String(server)]
    if (!entry || !safeStorage.isEncryptionAvailable()) return null
    return {
      username: entry.username,
      password: safeStorage.decryptString(Buffer.from(entry.secret, 'base64')),
    }
  } catch {
    // A machine change or a new OS account makes the ciphertext unreadable.
    return null
  }
})

ipcMain.handle('creds:forget', (_e, server: string) => {
  try {
    const store = readCreds()
    delete store[String(server)]
    if (Object.keys(store).length === 0) {
      if (existsSync(credsFile())) unlinkSync(credsFile())
    } else {
      writeFileSync(credsFile(), JSON.stringify(store), { mode: 0o600 })
    }
    return true
  } catch {
    return false
  }
})

// ----------------------------------------------------------------- boot ----

/**
 * Say again what was already asked for, in case Windows has stopped agreeing.
 *
 * "Start with Windows" was stored here and handed to Windows exactly once -
 * at the moment somebody pressed the switch - and never again. Which is fine
 * until the thing Windows was told about stops existing: this app was called
 * JacksCord, the settings carried over under the new name, and the entry
 * Windows kept still pointed at an executable that had been uninstalled. So
 * the switch read "on", was on as far as this app knew, and started nothing
 * at all for a fortnight.
 *
 * Asked and answered every launch now. Windows is the one that knows whether
 * it will actually do it, so it is the one to ask rather than a file of ours
 * saying what it ought to think.
 */
function reconcileLoginItem(): void {
  try {
    const want = readPrefs().launchOnStartup
    const has = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
    if (want === has) return
    app.setLoginItemSettings({ openAtLogin: want, args: ['--hidden'] })
  } catch {
    /* A locked-down profile can refuse this. Not worth a crash on the way up,
       and the switch still says what it will do the next time it is pressed. */
  }
}

/**
 * And clear away what the old name left behind.
 *
 * The entry Windows kept for JacksCord points at a folder that was removed
 * with it, so it starts nothing and cannot be turned off from inside an app
 * that no longer exists - it simply sits in the startup list looking broken.
 * Only ours, only when it really does point at something that is not there.
 */
function forgetOldLoginItem(): void {
  if (process.platform !== 'win32') return
  try {
    const KEY = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
    const OLD = 'electron.app.JacksCord'
    const read = spawnSync('reg', ['query', KEY, '/v', OLD], { encoding: 'utf8' })
    if (read.status !== 0) return
    const exe = /"([^"]+\.exe)"/.exec(read.stdout ?? '')?.[1]
    if (!exe || existsSync(exe)) return
    spawnSync('reg', ['delete', KEY, '/v', OLD, '/f'])
  } catch {
    /* Tidiness only. Nothing here is worth failing a launch over. */
  }
}

app.whenReady().then(() => {
  if (!isDev) registerAppProtocol()
  reconcileLoginItem()
  forgetOldLoginItem()
  // Before the main window, because the whole point is to fill the time it
  // takes that one to become ready.
  /* No splash for a login start: it is a window, and the whole point is that
     nothing appears on screen until somebody asks for it. */
  if (!openedByLogin) createSplash()
  createWindow()
  createTray()
  // Watched from the shell, because the client's own check ships inside the
  // very thing that goes out of date.
  watchClientVersion()

  /*
   * A splash cannot be the last thing left on screen.
   *
   * ready-to-show closes it in the ordinary case, and an update closes it on
   * the way to restarting. What neither covers is the main window never
   * becoming ready at all - a server that does not answer, a load that hangs -
   * and a spinner that never stops is a worse answer than a window with an
   * error in it. Half a minute is far longer than a cold start and far
   * shorter than somebody's patience.
   */
  setTimeout(() => {
    if (!splash) return
    closeSplash()
    if (openedByLogin) return
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }, 30_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  if (!isDev) {
    /*
     * A little after launch, so the check never competes with startup, then
     * hourly. unref so a pending timer cannot keep the process alive.
     *
     * And at the moments an update is most likely to have appeared since the
     * last look: coming back to the window, and the machine waking up. On the
     * clock alone, an update published a minute after somebody opened the app
     * stayed invisible for an hour, and the only way to find it was to go
     * into settings and press the button - which is the thing the banner
     * exists to save them from. Reported exactly that way round.
     *
     * Floored at ten minutes between checks, because alt-tabbing is not news
     * and the server caches the manifest for that long anyway: asking more
     * often than it can answer differently is traffic for nothing.
     */
    /* Before the first check, so it never verifies what it is about to
       throw away. */
    forgetInstalledUpdate()
    setTimeout(() => checkForUpdatesSoon(), 8000).unref()
    setInterval(() => checkForUpdatesSoon(), 60 * 60_000).unref()
    win?.on('focus', () => checkForUpdatesSoon())
    powerMonitor.on('resume', () => checkForUpdatesSoon())
  }
})

/*
 * The page died, rather than stalled.
 *
 * Nothing is coming back: the window is left showing a picture of whatever
 * was on screen when it went, which is the most confusing state an app can be
 * in because it looks like it is working. Reloaded rather than asked about,
 * since there is nothing to lose by then and nothing to wait for.
 */
app.on('render-process-gone', (_e, _contents, details) => {
  noteToLog('render-process-gone', `${details.reason} (exit ${details.exitCode})`)
  hang = cameBack()
  asking = false

  /*
   * A clean exit is the page being closed on purpose, which is what happens
   * on every quit - and reloading the window then is an app coming back from
   * the dead as it is being shut down.
   */
  if (!worthReloading(String(details.reason), quitting)) return

  /*
   * And not round and round. A page that dies on the way up dies again the
   * moment it is reloaded; after a few goes the honest thing is to stop and
   * leave what is on screen, which at least stays still long enough to read.
   */
  const now = Date.now()
  if (!shouldReload(reloads, now)) {
    noteToLog('gave-up', 'the window died again straight after being brought back')
    return
  }
  reloads = [...reloads, now]
  if (win && !win.isDestroyed()) win.webContents.reload()
})

/*
 * Something else died - most often the GPU, which is the commonest cause of a
 * window that looks frozen and the one thing here somebody can act on.
 *
 * Not reloaded: Chromium brings its own children back, and a reload on top of
 * that is a reload for something that fixed itself.
 */
app.on('child-process-gone', (_e, details) => {
  noteToLog('child-process-gone', whatDied(String(details.type), String(details.reason)))
})

app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
