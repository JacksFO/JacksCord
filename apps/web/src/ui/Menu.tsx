import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Over } from './Over'
import { Icon, type IconName } from './Icon'

export type MenuItem =
  | {
      kind: 'item'
      label: string
      icon?: IconName
      danger?: boolean
      /** Sits in a row with its neighbours rather than on a line of its own —
       *  for the handful of reactions offered at the top of a menu. */
      wide?: boolean
      /** What it is called when the label is a glyph and says nothing. */
      hint?: string
      /**
       * There but not pressable.
       *
       * Kept for the few items whose absence would be a worse answer than
       * their being grey: "Mark as read" on a channel with nothing unread is
       * one of them, because somebody looking for it wants to know it is
       * there and that there is nothing to do. Permissions are still absent
       * rather than disabled - that rule is about what somebody may do, and
       * this is about whether there is anything to do it to.
       */
      disabled?: boolean
      onPick: () => void
    }
  | { kind: 'rule' }
  /**
   * A slider, for the one thing a menu cannot say with a row.
   *
   * How loud somebody is has no sensible set of choices - it is a number
   * anybody wants to nudge while listening - so offering four presets would
   * be answering a different question. It lives in the menu because that is
   * where somebody is already looking when they think "they are too loud".
   *
   * Unlike every other row, moving it does not close the menu: the whole
   * point is to hear the change and move it again.
   */
  | {
      kind: 'range'
      label: string
      icon?: IconName
      /** 0 to 100. */
      value: number
      /** What to say beside the label - the number, or "Muted". */
      note?: string
      onSet: (value: number) => void
    }

/**
 * A menu, where the pointer was.
 *
 * Placed by measuring it after it is drawn rather than by guessing its height
 * beforehand. The old client worked that out from the number of rows at 36
 * pixels each, and a menu is not made of equal rows — separators are thin, a
 * danger row is not — so the guess drifted further the longer the menu was,
 * and right-clicking a message near the bottom of a conversation put Delete
 * off the end of the screen.
 *
 * Nothing under it redraws while it is open. A background event rebuilding
 * the page replaced the menu with an identical one and replayed the little
 * animation it appears with, which looked exactly like it opening twice —
 * reported as the box flashing when a server icon was right-clicked.
 */
export function Menu({ x, y, items, onClose }: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const pad = 8
    const { width, height } = el.getBoundingClientRect()
    setAt({
      left: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    })
  }, [x, y])

  /*
   * Escape closes it.
   *
   * Clicking past it worked and Escape did nothing, so the one key everybody
   * presses to make something go away was the one thing that did not. Worse
   * than an annoyance: the scrim covers the window while a menu is open, so
   * with no way to close it by keyboard, a right-click on a second message
   * landed on the scrim and only closed the first menu. You had to right-click
   * the same message twice.
   *
   * On `document`, not on `window`. A keydown from a keyboard reaches both,
   * but one dispatched straight at the document without `bubbles` reaches only
   * the document - which is what a test does, and what any other code in the
   * page dispatching a synthetic key would do. Listening one level further out
   * looked identical and heard nothing.
   */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <Over>
      <div className="ctxscrim" onClick={onClose} onContextMenu={(e) => {
        /* A second right-click closes it rather than opening the browser's
           own menu on top of ours. */
        e.preventDefault()
        onClose()
      }} />
      <div className="ctx" ref={ref} style={{ left: at.left, top: at.top }}>
        {rows(items).map((row, i) => row.wide
          ? (
            <div className="mquick" key={i}>
              {row.items.map((item, j) => (
                <button
                  key={j}
                  className="mq"
                  title={item.hint ?? item.label}
                  onClick={() => { item.onPick(); onClose() }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )
          : row.items.map((item, j) => item.kind === 'rule'
            ? <div className="msep" key={`${i}-${j}`} />
            : item.kind === 'range'
            ? (
              <div className="mrange" key={`${i}-${j}`}>
                <span className="mrl">
                  {item.icon && <Icon name={item.icon} size={15} />}
                  {item.label}
                  {item.note && <span className="cm-key">{item.note}</span>}
                </span>
                <input
                  type="range" className="rng" min={0} max={100} value={item.value}
                  onChange={(e) => item.onSet(Number(e.target.value))}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              </div>
            )
            : (
              <button
                key={`${i}-${j}`}
                className={item.danger ? 'mitem danger' : 'mitem'}
                disabled={item.disabled ?? false}
                onClick={() => { item.onPick(); onClose() }}
              >
                {item.icon && <Icon name={item.icon} size={15} />}
                {item.label}
                {/* The key that does the same thing, at the end of the row.
                    A menu is where somebody finds out there is a shortcut at
                    all, and one that keeps it to itself is a menu they go on
                    using for ever. */}
                {item.hint && <span className="cm-key">{item.hint}</span>}
              </button>
            )))}
      </div>
    </Over>
  )
}

type Wide = Extract<MenuItem, { kind: 'item' }>
type Row = { wide: true; items: Wide[] } | { wide: false; items: MenuItem[] }

/**
 * The items, with the side-by-side ones gathered into their own row.
 *
 * Grouped here rather than by asking the caller for a nested list, because
 * every caller then has to know the shape of a menu to build one — and the
 * only thing that is actually nested is a run of quick reactions.
 */
export function rows(items: readonly MenuItem[]): Row[] {
  const out: Row[] = []
  for (const item of items) {
    const wide = item.kind === 'item' && !!item.wide
    const last = out[out.length - 1]
    if (last && last.wide === wide) {
      /* Narrowed by the flag they were sorted on, which is the same test. */
      if (last.wide) last.items.push(item as Wide)
      else last.items.push(item)
      continue
    }
    out.push(wide ? { wide: true, items: [item as Wide] } : { wide: false, items: [item] })
  }
  return out
}
