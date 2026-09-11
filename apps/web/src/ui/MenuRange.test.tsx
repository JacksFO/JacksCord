import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu, type MenuItem } from './Menu'

/**
 * A slider in a menu.
 *
 * How loud somebody is has no sensible set of choices - it is a number you
 * nudge while listening to them - so it cannot be a row like the others, and
 * four presets would be answering a different question.
 *
 * Tested here rather than in the browser because the case that matters is
 * somebody *else* in your call, and the panel lists whoever the media server
 * says is connected: a second account joining over the gateway alone does not
 * appear there. The browser spec covers the wiring - that a row opens a menu
 * at all - and this covers what the menu can hold.
 */

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
})

function show(items: MenuItem[], onClose = () => {}) {
  act(() => {
    root?.render(<Menu x={10} y={10} items={items} onClose={onClose} />)
  })
  return document.body
}

const slider = () =>
  document.querySelector('.mrange input[type="range"]') as HTMLInputElement | null

describe('a slider in a menu', () => {
  it('is drawn, with its label and where it is', () => {
    show([{ kind: 'range', label: 'How loud they are', value: 40, note: '40%', onSet: () => {} }])
    expect(slider()).toBeTruthy()
    expect(slider()!.value).toBe('40')
    expect(document.body.textContent).toContain('How loud they are')
    expect(document.body.textContent).toContain('40%')
  })

  it('and says Muted rather than 0%, when that is what it is', () => {
    show([{ kind: 'range', label: 'How loud they are', value: 0, note: 'Muted', onSet: () => {} }])
    expect(document.body.textContent).toContain('Muted')
  })

  it('and hands back what it was moved to', () => {
    const set = vi.fn()
    show([{ kind: 'range', label: 'How loud', value: 40, onSet: set }])
    const el = slider()!
    act(() => {
      const put = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')!.set!
      put.call(el, '12')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(set).toHaveBeenCalledWith(12)
  })

  /*
   * The one that makes it usable. Every other row in a menu does its thing
   * and closes, which is right for them - and would be wrong here, because
   * the whole point is to hear the change and move it again.
   */
  it('and does not close the menu when it is moved', () => {
    const shut = vi.fn()
    const set = vi.fn()
    show([{ kind: 'range', label: 'How loud', value: 40, onSet: set }], shut)
    const el = slider()!
    act(() => {
      const put = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')!.set!
      put.call(el, '70')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      /* And a press on it is not a press past the menu. */
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(set).toHaveBeenCalled()
    expect(shut, 'moving it shut the menu').not.toHaveBeenCalled()
  })

  /* And an ordinary row still closes, or this would have broken every other
     menu in the app on its way past. */
  it('but an ordinary row still closes it', () => {
    const shut = vi.fn()
    show([{ kind: 'item', label: 'Profile', onPick: () => {} }], shut)
    const row = document.querySelector('.mitem') as HTMLButtonElement
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(shut).toHaveBeenCalled()
  })

  it('and sliders sit alongside ordinary rows', () => {
    show([
      { kind: 'item', label: 'Profile', onPick: () => {} },
      { kind: 'rule' },
      { kind: 'range', label: 'How loud', value: 50, onSet: () => {} },
    ])
    expect(document.querySelectorAll('.mitem').length).toBe(1)
    expect(document.querySelectorAll('.mrange').length).toBe(1)
    expect(document.querySelectorAll('.msep').length).toBe(1)
  })
})
