import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyCall, withoutPerson, withoutStream, withStream,
  type Call, type CallMember, type StreamKey,
} from '../lib/call'
import { Voice, type MicChoice } from '../lib/voice'
import {
  forgetVoice, keepVoiceFresh, rememberShareSource, rememberVoice, shareSource,
} from '../lib/resume'
import { shareQuality, type SharePreset } from '../lib/sharequality'
import { rememberLevel } from '../lib/levels'
import type { Api } from '../lib/api'
import type { Id } from '../lib/wire'

/**
 * Being in a call, from React's side.
 *
 * The adapter reports what the room does; this keeps what the app draws. They
 * are apart on purpose: the room's events arrive whether or not anything is
 * rendered, and a component that unmounts mid-call must not take the call
 * with it.
 */
export type CallControls = {
  call: Call
  /** Null until asked, then whether this server does calls at all. */
  enabled: boolean | null
  error: string
  join: (channelId: Id) => Promise<void>
  leave: () => Promise<void>
  setMuted: (on: boolean) => void
  setDeaf: (on: boolean) => void
  setCam: (on: boolean) => void
  /**
   * Start or stop sharing. Answers whether a share is now running, which is
   * how the caller can tell somebody choosing a screen from somebody opening
   * the picker and changing their mind - the two look identical otherwise.
   */
  setShare: (on: boolean, audio?: boolean) => Promise<boolean>
  setShareAudio: (on: boolean) => void
  setShareQuality: (preset: SharePreset) => void
  /** Ask for something, or stop — which is what decides whether it is sent. */
  setWatching: (key: StreamKey, on: boolean) => void
  setLevel: (key: StreamKey, level: number) => void
  /** Stop showing whatever last went wrong. */
  clearError: () => void
  /** What a share is being sent at, so the menus offering it can say which. */
  quality: SharePreset
  /** What is being sent, so voice activation can measure it. */
  micStream: () => MediaStream | null
  /** Open or shut the published microphone, without republishing it. */
  gate: (open: boolean) => boolean
}

export function useCall(server: Api, mic: MicChoice): CallControls {
  const [call, setCall] = useState<Call>(emptyCall)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  /* Read once on the way in; kept in step by setShareQuality below. */
  const [quality, setQuality] = useState<SharePreset>(() => shareQuality())
  const voice = useRef<Voice | null>(null)
  /* What the adapter calls back into. Held in a ref so the room is built with
     handlers that stay valid for the whole call rather than the ones that
     happened to exist on the render it was started from. */
  const micRef = useRef(mic)
  /* Whether the disconnect about to arrive is one this account asked for. */
  const leaving = useRef(false)
  micRef.current = mic

  /*
   * A microphone chosen while a call is running is taken up straight away.
   *
   * Constraints are settled when the track is acquired, so without this a
   * different microphone - or echo cancellation turned off - did nothing at
   * all until the call was rejoined. The device and its three switches are
   * listed one by one rather than the object holding them, which is rebuilt
   * on every render and would re-acquire the microphone sixty times a second.
   */
  useEffect(() => {
    void voice.current?.refreshMic(micRef.current)
  }, [mic.deviceId, mic.echoCancellation, mic.noiseSuppression, mic.autoGainControl])

  if (!voice.current) {
    voice.current = new Voice(server, {
      stream(key: StreamKey, kind: 'picture' | 'sound', stream: MediaStream | null) {
        /* A share is both, under one name: share:u7 is a picture in `video`
           and a sound in `sounds`. Same key, two maps — because they are two
           things anybody would want to set separately, and one map would mean
           the second track to arrive replaced the first. */
        setCall((c) => {
          const from = kind === 'sound' ? c.sounds : c.video
          const next = stream === null
            ? withoutStream(from, key)
            : withStream(from, key, stream)
          if (next === from) return c
          return kind === 'sound' ? { ...c, sounds: next } : { ...c, video: next }
        })
      },
      roster(who: CallMember[]) {
        setCall((c) => {
          const here = new Set(who.map((m) => m.id))
          let video = c.video
          let sounds = c.sounds
          /* Somebody who has gone takes their pictures and their sounds with
             them. Left behind, a tile keeps a frozen last frame of a person
             who is not in the room. */
          for (const key of [...video.keys()]) {
            const id = key.slice(key.indexOf(':') + 1)
            if (!here.has(id)) video = withoutPerson(video, id)
          }
          for (const key of [...sounds.keys()]) {
            const id = key.slice(key.indexOf(':') + 1)
            if (!here.has(id)) sounds = withoutPerson(sounds, id)
          }
          /* Publishing and unpublishing both arrive here, which is exactly
             when whether there is any share sound can change. */
          return {
            ...c, members: who, video, sounds,
            shareAudio: voice.current?.shareAudio() ?? c.shareAudio,
          }
        })
      },
      speaking(ids: Id[]) {
        setCall((c) => ({ ...c, speaking: new Set(ids) }))
      },
      quality(how) {
        setCall((c) => (c.quality === how ? c : { ...c, quality: how }))
      },
      dropped() {
        setCall(emptyCall)
        /*
         * Leaving is not news.
         *
         * This fires on every disconnect, deliberate ones included, so
         * hanging up put "The call ended — Dismiss" across the top of the
         * screen: the app telling you what you had just done, and asking you
         * to acknowledge it. A call ending under you is worth a word; a call
         * you ended is not.
         */
        if (leaving.current) { leaving.current = false; return }
        setError('The call ended')
      },
    })
  }

  useEffect(() => {
    let alive = true
    void voice.current?.available().then((v) => { if (alive) setEnabled(v.enabled) })
    return () => { alive = false }
  }, [])

  /* Leaving when the app closes, not when a component happens to unmount:
     staying in a room nobody is drawing is how a stale participant sits in a
     channel for ever, and every check about that channel then answers about
     somebody who is not there. */
  useEffect(() => () => { void voice.current?.leave() }, [])

  const join = useCallback(async (channelId: Id) => {
    setError('')
    /*
     * Moving is a leave and a join, and the leave must be silent — the old
     * room's disconnect arrives here as a drop, so changing channel said "The
     * call ended" on the way into the new one.
     */
    leaving.current = true
    /* And the share comes along. Taking a screen into another room used to
       mean stopping and picking it again, which the original build never
       asked for: it held the track and pointed each new connection at it. */
    await voice.current?.leave({ keepShare: true })
    leaving.current = false
    /*
     * Set before joining, not after. The room reports who is in it as soon as
     * it connects, and the roster is filed against the channel it belongs to
     * — with this still null, everybody in the call was filed under nothing
     * and the panel showed an empty room you were standing in.
     */
    setCall({ ...emptyCall(), channel: channelId, since: Date.now() })
    try {
      await voice.current?.join(channelId, micRef.current)
      /* Noted, so a reload puts you back. Updating this app means reloading
         the page, and reloading the page drops you out of the call — which is
         a rotten way to ship an update to somebody mid-conversation. */
      rememberVoice(channelId, false, false)
    } catch (e) {
      /* Cleared again, so a failed attempt does not leave the app believing
         it is in a call it never joined. */
      setCall(emptyCall)
      setError(e instanceof Error ? e.message : 'Could not join the call')
    }
  }, [])

  const leave = useCallback(async () => {
    /* Deliberately leaving, so nothing drags you back in on the next load. */
    forgetVoice()
    leaving.current = true
    await voice.current?.leave()
    setCall(emptyCall)
    /* Cleared here as well as where it is read: a leave that never reaches
       the media server would otherwise silence the next real drop. */
    leaving.current = false
  }, [])

  /**
   * The two of them are one control with two buttons.
   *
   * Deafening mutes you: hearing nobody while they can still hear you is a
   * state people get into by accident and then talk into. Un-deafening puts
   * the microphone back, because taking it away was this doing it and not
   * something you asked for — leaving it muted afterwards is the app keeping
   * a decision it made on your behalf.
   *
   * And unmuting while deafened un-deafens. Somebody reaching for the
   * microphone means to talk to people, and talking to people you cannot
   * hear is the same accident from the other end.
   */
  const setMuted = useCallback((on: boolean) => {
    setCall((c) => ({
      ...c,
      muted: on,
      deaf: on ? c.deaf : false,
    }))
    void voice.current?.setMic(!on, micRef.current)
  }, [])

  const setDeaf = useCallback((on: boolean) => {
    /* Deafening is done in the audio elements rather than at the media
       server — nothing is unsubscribed, so it comes back instantly. The
       microphone is the only half that leaves this machine. */
    setCall((c) => ({ ...c, deaf: on, muted: on }))
    void voice.current?.setMic(!on, micRef.current)
  }, [])

  const setCam = useCallback((on: boolean) => {
    void voice.current?.setCam(on)
  }, [])

  /*
   * Whether a screen is going, as this client knows it rather than as the
   * roster reports it. The roster is a round trip; the note that survives a
   * reload has to be right the instant the share starts, because the reload
   * may be the very next thing that happens.
   */
  const sharing = useRef(false)

  const setShare = useCallback((on: boolean, audio = false) => {
    return (voice.current?.setShare(on, { audio }) ?? Promise.resolve(false))
      .then((went) => {
        sharing.current = on && went
        if (!sharing.current) rememberShareSource(null)
        /*
         * Nothing published and nothing thrown is the picker being dismissed,
         * which is somebody choosing not to share and needs no words.
         */
        if (!on || went) setError('')
        return went
      })
      .catch((e: unknown) => {
        /*
         * Closing the picker is not a failure.
         *
         * Reported as "Invalid capture constraints" in red across the top of
         * the app on pressing share. That sentence is Chromium's, and it is
         * what our own shell's cancel comes back as: the only way to refuse
         * a display-media request is to answer it with no source, and an
         * answer with no source is exactly what an invalid constraint looks
         * like from the page. So the one thing somebody does most often -
         * open the picker, change their mind, close it - was the one thing
         * that produced an error.
         *
         * Every shape below means the same thing: nothing was chosen, so
         * nothing is being shared, so there is nothing to say.
         */
        const why = e instanceof Error ? e.message : ''
        const name = e instanceof Error ? e.name : ''
        if (name === 'AbortError' || name === 'NotAllowedError'
          || /invalid capture constraints|permission denied by system/i.test(why)) {
          setError('')
          return false
        }
        /*
         * Anything else is worth saying. A share that cannot start — no
         * permission from the system, a shell with no picker wired up, a
         * refusal from the media server — looked exactly like the button
         * doing nothing at all, which is the report that came back.
         */
        setError(why || 'That screen would not share.')
        return false
      })
  }, [])

  /**
   * The sound of your own share, without stopping the share.
   *
   * Muted rather than unpublished, so it comes back instantly and the picture
   * never flickers. Nothing to unmute means a share that was started without
   * sound, which cannot be given any now — the button for it is not drawn.
   */
  const setShareAudio = useCallback((on: boolean) => {
    void voice.current?.setShareAudio(on).then((could) => {
      if (!could) return
      setCall((c) => ({ ...c, shareAudio: { has: true, on } }))
    })
  }, [])

  /* Changed while the share runs: the capture stays and the ceiling moves. */
  /*
   * Keep the note current while the call runs.
   *
   * It expires after a couple of minutes on purpose — rejoining a call from
   * an hour ago because a tab was left open is worse than not rejoining at
   * all — so without this a long call would look stale the moment somebody
   * reloaded, which is exactly when it is needed.
   */
  useEffect(() => {
    const channelId = call.channel
    if (!channelId) return
    const note = () => keepVoiceFresh(
      channelId, call.muted, call.deaf,
      /* Undefined rather than null when nothing is being shared: null means
         "was sharing, source unknown", which is a browser, and offering to
         resume a share nobody started is worse than not offering. */
      sharing.current ? shareSource() : undefined,
    )
    note()
    const timer = setInterval(note, 30_000)
    return () => clearInterval(timer)
  }, [call.channel, call.muted, call.deaf])

  /**
   * Which of them is running, as state rather than as a read of storage.
   *
   * The menus that offer these read the stored value while they were being
   * drawn, and nothing redrew them when it changed - so the tick stayed on
   * whatever had been chosen last time and only moved once the menu had been
   * closed and opened again. Reported exactly that way.
   */
  const setShareQuality = useCallback((preset: SharePreset) => {
    setQuality(preset)
    void voice.current?.setShareQuality(preset)
  }, [])

  /*
   * Both kept still between renders.
   *
   * Written inline in the returned object they were a new function every
   * render, so anything that watched one - the voice gate does - threw away
   * its microphone and opened another one on every keystroke in the message
   * box. The room they reach through is a ref, so there is nothing for
   * either of them to depend on.
   */
  const micStream = useCallback(() => voice.current?.micStream() ?? null, [])
  const gate = useCallback((open: boolean) => voice.current?.gate(open) ?? false, [])

  const setWatching = useCallback((key: StreamKey, on: boolean) => {
    setCall((c) => {
      const next = new Set(c.watching)
      if (on) next.add(key)
      else next.delete(key)
      return { ...c, watching: next }
    })
    /* Subscribing is the request. Not watching is not a curtain over a stream
       that is still arriving — the media server stops sending it, and with
       dynacast the sender stops encoding it, so a share nobody is watching
       costs the person sharing nothing at all. */
    void voice.current?.setWatching(key, on)
  }, [])

  const setLevel = useCallback((key: StreamKey, level: number) => {
    setCall((c) => ({ ...c, levels: new Map(c.levels).set(key, level) }))
    /* And kept, so the friend whose game is always twice as loud as everybody
       else does not have to be turned down again every single call. */
    rememberLevel(key, level)
  }, [])

  return {
    call, enabled, error,
    join, leave, setMuted, setDeaf, setCam, setShare, setShareAudio, setShareQuality,
    quality,
    micStream,
    gate,
    setWatching, setLevel,
    clearError: useCallback(() => setError(''), []),
  }
}

