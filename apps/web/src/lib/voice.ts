import type { CallQuality } from './call'
import type { Room, RemoteParticipant, Track } from 'livekit-client'
import type { Api } from './api'
import { setShareQuality, shareQuality, type SharePreset } from './sharequality'
import type { Id } from './wire'
import { keyOf, type CallMember, type Source, type StreamKey } from './call'

/**
 * Voice and screen sharing, through the media server.
 *
 * Everybody sends one copy up and receives one copy down, and the server
 * decides who needs what — so a call costs each person one connection rather
 * than one per other person, and a screen share travels the same path.
 *
 * The library is about 550KB, and most sessions never open a call. It is
 * imported when somebody joins one, which in this build means a chunk of its
 * own that the main bundle never mentions — the old client had to inject a
 * script tag to get the same effect, because it had no build step to split.
 */

export type VoiceConfig = { enabled: boolean; url: string }

/** What the room says has happened, in the app's own words. */
export type VoiceEvents = {
  /**
   * Somebody's picture or sound arrived, or went.
   *
   * `kind` because a share is both — a picture to look at and a sound to
   * listen to, arriving as two tracks under one name. They are held apart, so
   * the thing being taken away has to say which of the two it is. Working it
   * out from the stream is not possible on the way out: by then there is no
   * stream to ask.
   */
  stream: (key: StreamKey, kind: 'picture' | 'sound', stream: MediaStream | null) => void
  /** Who is in the room, and what they are sending. */
  roster: (who: CallMember[]) => void
  /** Who is making noise, as the media server hears it. */
  speaking: (ids: Id[]) => void
  /** The call ended without being left. */
  dropped: () => void
  /**
   * How well this connection is holding up, as the room sees it.
   *
   * The client before this one drew four bars from it in the call bar, and
   * the rewrite dropped the event entirely - so a call that had gone bad
   * looked exactly like one that had not, and the only clue was people asking
   * you to repeat yourself.
   */
  quality: (how: CallQuality) => void
}

export type MicChoice = {
  deviceId?: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

/**
 * LiveKit's own name for what a track is, mapped to ours.
 *
 * `screen_share_audio` is the one that matters: it is a *share*, not a voice.
 * Filed as a voice — or filed under the person rather than the thing — the
 * sound of somebody's game and the sound of somebody talking end up in the
 * same slot, and the second to arrive replaces the first. Which is what made
 * stopping a screen share silence the person who had been sharing it.
 */
export function sourceOf(s: string): Source | null {
  if (s === 'microphone') return 'voice'
  if (s === 'screen_share' || s === 'screen_share_audio') return 'share'
  if (s === 'camera') return 'cam'
  return null
}

/**
 * Who a participant is, as this app names them.
 *
 * The media server knows an identity, which is the user id the token was
 * minted for. Kept as a string throughout: the old client turned identities
 * into numbers by hand in four places, and a uuid does not survive that.
 */
const idOf = (identity: string): Id => String(identity)

/**
 * Which codec a screen goes out as. Change this one word to switch.
 *
 * VP9 is a third to a half more efficient than VP8 on the content a screen is
 * made of - text, flat areas, hard edges - and that gain applies to every
 * frame. At the default preset, 720p30 inside 900 kbps, that is the most
 * bitrate-starved case in the app and the one where it is worth most.
 *
 * It is not free, and the price is worth knowing before anybody changes it
 * back:
 *
 *   livekit-client forces `contentHint = 'motion'` on a screen share with an
 *   SVC codec, which overrides the 'detail' the slower presets ask for. That
 *   is not a preference to override in turn - their comment says Chrome caps
 *   L1T3 screenshare at five frames a second without it. VP9 with motion, or
 *   VP8 with detail; there is no third door.
 *
 *   and it drops to a single spatial layer, so a viewer on a poor connection
 *   gets fewer frames at full size rather than a smaller picture. Which is
 *   what a preset named for its resolution is supposed to promise anyway.
 *
 *   and it costs the sender roughly half again to twice the CPU. That shows
 *   up as dropped frames on an older machine, not as a broken share.
 *
 * The bet is that on a mostly still screen the motion hint has little to
 * spend itself on, while the efficiency applies regardless - so text should
 * come out ahead. It is a bet: the two are told apart by looking at them, not
 * by reasoning about them.
 *
 * To go back: 'vp8'. Nothing else has to change.
 */
const SCREEN_CODEC: 'vp9' | 'vp8' = 'vp9'

export class Voice {
  private room: Room | null = null
  private joining: Promise<void> | null = null
  /** A capture held between two rooms, so a move does not end a share. */
  private carried:
    { video: MediaStreamTrack; audio: MediaStreamTrack | null; quiet: boolean } | null = null
  private lk: typeof import('livekit-client') | null = null
  /*
   * What this client has asked to watch.
   *
   * Kept here as well as in the call state because the decision has to be
   * made again for a track that does not exist yet. Watching subscribes what
   * is published at the moment it is pressed, and a screen that is stopped
   * and started again - or one shared without sound, then with it - arrives
   * afterwards as a new publication. Nothing was subscribing those, so the
   * picture came back and the sound did not, depending entirely on the order
   * somebody happened to do things in.
   */
  private watched = new Set<StreamKey>()
  /** Who the room says it can hear, and whether the gate has us open. */
  private speakers: Id[] = []
  private selfSpeaking = false
  private configured: VoiceConfig | null = null

  constructor(private server: Api, private on: VoiceEvents) {}

  /** Whether this server does calls at all. Asked once, then remembered. */
  async available(): Promise<VoiceConfig> {
    if (this.configured) return this.configured
    try {
      const r = await this.server.get<Partial<VoiceConfig>>('/api/voice/config')
      this.configured = { enabled: !!r.enabled, url: r.url ?? '' }
    } catch {
      /* A server with no media server configured is not an error — it is a
         server without calls, and the button should simply not be there. */
      this.configured = { enabled: false, url: '' }
    }
    return this.configured
  }

  get inCall(): boolean {
    return !!this.room
  }

  /**
   * Join, having asked the server for a token first.
   *
   * The token names the room and the person, and carries what they may do in
   * it — somebody who is server muted is handed one that cannot publish at
   * all, so the mute holds whatever the client does with its buttons. That is
   * also why a mute has to be followed by rejoining: the grant is in the
   * token, and the token was minted before it.
   */
  async join(channelId: Id, mic: MicChoice): Promise<void> {
    if (this.joining) return this.joining
    this.joining = this.connect(channelId, mic).finally(() => { this.joining = null })
    return this.joining
  }

  /**
   * The relays this server offers, or nothing.
   *
   * Nothing is a working answer: the SFU is directly reachable for most
   * people, and a relay that cannot be asked for must not stop a call.
   */
  private async iceServers(): Promise<RTCIceServer[]> {
    try {
      const got = await this.server.get<{ iceServers?: RTCIceServer[] }>('/api/rtc/ice')
      return Array.isArray(got?.iceServers) ? got.iceServers : []
    } catch {
      return []
    }
  }

  private async connect(channelId: Id, mic: MicChoice): Promise<void> {
    const lk = this.lk ?? (this.lk = await import('livekit-client'))
    const t = await this.server.post<{ token?: string; url?: string; error?: string }>(
      '/api/voice/token', { channelId },
    )
    if (!t?.token) throw new Error(t?.error || 'this server would not give out a voice token')

    /*
     * Somewhere to bounce off, for the people who cannot connect directly.
     *
     * The SFU is reachable over UDP and, failing that, TCP - which covers
     * most networks and not all of them. Symmetric NAT and blocked ports need
     * a relay, and the server already mints short-lived credentials for one:
     * /api/rtc/ice, which the client this replaces called from its own
     * peer-to-peer paths.
     *
     * Those paths are gone - everything goes through the SFU now - and
     * nothing inherited the call, so the relay was configured, working and
     * reaching nobody. Anyone who needed it simply failed to get audio, which
     * looks like the app being broken rather than like a network it cannot
     * cross.
     *
     * Never a reason not to join. A relay is what makes a hard network work;
     * having no relay is how it worked a moment ago.
     */
    const ice = await this.iceServers()

    const room = new lk.Room({
      ...(ice.length ? { rtcConfig: { iceServers: ice } } : {}),
      /* Decode only what is on screen, and drop quality rather than stutter
         when somebody's connection dips. */
      adaptiveStream: true,
      /* Stop encoding anything nobody is subscribed to — which is what makes
         hiding a screen a saving rather than a curtain. */
      dynacast: true,
      publishDefaults: {
        audioPreset: lk.AudioPresets.speech,
        /* Send nothing at all while somebody is not talking. */
        dtx: true,
        /* Cheap redundancy. Packet loss on a home connection is normal, and
           this is what stops it sounding like it. */
        red: true,
      },
    })
    this.room = room

    room
      .on(lk.RoomEvent.TrackSubscribed, (track, pub, who) => {
        const source = sourceOf(String(pub.source))
        if (!source) return
        /* Audio that came with a screen is the *share's* sound, not the
           person's voice, and the two have to stay apart: they are two things
           anybody would want to set separately, and conflating them is what
           made stopping a share silence the person who was sharing. */
        this.on.stream(
          keyOf(source, idOf(who.identity)),
          track.kind === 'audio' ? 'sound' : 'picture',
          new MediaStream([track.mediaStreamTrack]),
        )
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track, pub, who) => {
        const source = sourceOf(String(pub.source))
        if (!source) return
        this.on.stream(
          keyOf(source, idOf(who.identity)),
          track.kind === 'audio' ? 'sound' : 'picture',
          null,
        )
      })
      /* Everything that changes who is in the room, or what they are sending.
         Publishing and muting count as much as arriving does: without them a
         share published perfectly and nothing on screen ever said so, which is
         indistinguishable from it not working. */
      /* Nothing is subscribed automatically, so every publication has to be
         decided about — a voice is taken, a picture is left until somebody
         asks for it. Without this, "not watching" would be a curtain over a
         stream still being sent, and the saving it exists for would be
         imaginary. */
      .on(lk.RoomEvent.TrackPublished, (pub, who) => {
        const source = sourceOf(String(pub.source))
        if (source === 'voice') { pub.setSubscribed(true); return }
        /* And a screen, or the sound of one, belonging to somebody already
           being watched. Both share a key, so the sound of a share is
           subscribed by the same answer that subscribes the picture. */
        if (!source) return
        if (this.watched.has(keyOf(source, idOf(who.identity)))) pub.setSubscribed(true)
      })
      .on(lk.RoomEvent.ParticipantConnected, (who) => {
        this.takeVoices(who)
        this.tellRoster()
      })
      .on(lk.RoomEvent.ParticipantDisconnected, () => this.tellRoster())
      .on(lk.RoomEvent.TrackPublished, () => this.tellRoster())
      .on(lk.RoomEvent.TrackUnpublished, () => this.tellRoster())
      /*
       * Your own picture, which never arrives any other way.
       *
       * TrackSubscribed is about what other people are sending — nothing
       * subscribes to itself. Without these, your own screen and your own
       * camera have a tile and no picture in it: it says "Connecting…" and
       * goes on saying it for as long as you share, because the thing that
       * would end the wait is a stream that is never coming.
       */
      .on(lk.RoomEvent.LocalTrackPublished, (pub) => {
        const source = sourceOf(String(pub.source))
        const track = pub.track
        if (!source || !track) return
        this.on.stream(
          keyOf(source, idOf(room.localParticipant.identity)),
          pub.kind === 'audio' ? 'sound' : 'picture',
          new MediaStream([track.mediaStreamTrack]),
        )
        this.tellRoster()
      })
      .on(lk.RoomEvent.LocalTrackUnpublished, (pub) => {
        const source = sourceOf(String(pub.source))
        if (!source) return
        this.on.stream(
          keyOf(source, idOf(room.localParticipant.identity)),
          pub.kind === 'audio' ? 'sound' : 'picture',
          null,
        )
        this.tellRoster()
      })
      .on(lk.RoomEvent.TrackMuted, () => this.tellRoster())
      .on(lk.RoomEvent.TrackUnmuted, () => this.tellRoster())
      /* Only your own: everybody else's is their business, and a bar that
         moves for somebody else's wifi is a bar nobody can act on. */
      .on(lk.RoomEvent.ConnectionQualityChanged, (how, who) => {
        if (who?.identity !== room.localParticipant.identity) return
        this.on.quality(
          how === lk.ConnectionQuality.Excellent ? 'excellent'
            : how === lk.ConnectionQuality.Good ? 'good'
              : how === lk.ConnectionQuality.Poor ? 'poor'
                : how === lk.ConnectionQuality.Lost ? 'lost'
                  : 'unknown',
        )
      })
      .on(lk.RoomEvent.ActiveSpeakersChanged, (who) => {
        this.speakers = who.map((p) => idOf(p.identity))
        this.emitSpeaking()
      })
      .on(lk.RoomEvent.Disconnected, () => {
        this.room = null
        this.on.dropped()
      })

    /*
     * Nothing arrives unasked.
     *
     * A room of eight where one person is sharing is one stream or seven,
     * depending only on this — and it is the sharer's upload either way,
     * because dynacast stops them encoding a layer nobody wants. The app has
     * always let people choose what they are looking at; this is what makes
     * that choice cost something rather than merely hide something.
     */
    await room.connect(t.url ?? '', t.token, { autoSubscribe: false })
    /* Whoever was already here when we arrived — ParticipantConnected only
       fires for people who turn up after. */
    for (const who of room.remoteParticipants.values()) this.takeVoices(who)
    await room.localParticipant.setMicrophoneEnabled(true, constraints(mic))
    await this.cleanUpMic(mic)

    /* My own microphone, so the level meter has something to read before
       anybody else has said a word. */
    const mine = this.myTrack('voice')
    if (mine) {
      this.on.stream(keyOf('voice', idOf(room.localParticipant.identity)), 'sound', mine)
    }
    /* Whatever was being shared in the room just left, put back here. */
    await this.layShare()
    this.tellRoster()
  }

  /**
   * Leave, optionally keeping hold of what is being shared.
   *
   * Moving rooms is a leave and a join, and a leave takes the capture down
   * with it — so changing channel while sharing stopped the share and asked
   * for the picker again. The original build never had this problem: it held
   * the track itself and pointed each new connection at it, so a move was
   * invisible to whatever was being shared.
   */
  /** Nothing is being watched once we are not in the room. */
  private forgetWatched(): void { this.watched.clear() }

  async leave(opts: { keepShare?: boolean } = {}): Promise<void> {
    if (opts.keepShare) await this.liftShare()
    /* Nothing here is being watched any more, and a name carried into the
       next room would subscribe somebody nobody asked about. */
    this.forgetWatched()
    const room = this.room
    this.room = null
    if (!room) return
    try { await room.disconnect() } catch { /* already gone, which is the aim */ }
  }

  /**
   * Take the share off this room without stopping the capture.
   *
   * `stopOnUnpublish` false is the whole thing: unpublishing normally ends
   * the track, which is the browser taking its "you are sharing" bar down and
   * the picture going black. What is kept is the raw MediaStreamTrack, which
   * belongs to the page rather than to any room.
   */
  private async liftShare(): Promise<void> {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return
    const vp = me.getTrackPublication(lk.Track.Source.ScreenShare)
    if (!vp?.track) return
    const ap = me.getTrackPublication(lk.Track.Source.ScreenShareAudio)
    const video = vp.track.mediaStreamTrack
    const audio = ap?.track?.mediaStreamTrack ?? null
    /* Muted counts as carried, so it comes back muted rather than coming back
       loud in the room somebody has just walked into. */
    const quiet = !!ap?.isMuted
    try {
      await me.unpublishTrack(vp.track, false)
      if (ap?.track) await me.unpublishTrack(ap.track, false)
    } catch { /* the room went first, and the tracks are still ours */ }
    this.carried = { video, audio, quiet }
  }

  /** And put it back, in whichever room we are in now. */
  private async layShare(): Promise<void> {
    const lk = this.lk
    const me = this.room?.localParticipant
    const held = this.carried
    this.carried = null
    if (!lk || !me || !held) return
    /* Stopped mid-move — from the browser's own "stop sharing" bar, which
       nothing here is told about. Then there is nothing to put back, and
       publishing an ended track draws a black rectangle. */
    if (held.video.readyState !== 'live') return
    try {
      await me.publishTrack(held.video, { source: lk.Track.Source.ScreenShare })
      if (held.audio && held.audio.readyState === 'live') {
        const pub = await me.publishTrack(held.audio, {
          source: lk.Track.Source.ScreenShareAudio,
        })
        if (held.quiet) await pub.track?.mute()
      }
    } catch { /* the new room would not take it; the call itself is fine */ }
  }

  async setMic(on: boolean, mic: MicChoice): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(on, constraints(mic))
    if (on) await this.cleanUpMic(mic)
  }

  /**
   * Take up a different microphone, or the same one cleaned up differently,
   * without leaving the call.
   *
   * Constraints are chosen when a track is acquired and never afterwards, so
   * choosing another microphone in settings, or turning echo cancellation off
   * while a call was running, changed nothing at all - the old device carried
   * on being sent and the setting appeared to do nothing until the call was
   * rejoined, or muted and unmuted, which nobody would think to try.
   *
   * Off and on again, because that is what re-acquires the device. Skipped
   * entirely while muted: there is nothing published to replace, and turning
   * the microphone on to change its settings would un-mute somebody who had
   * deliberately muted themselves.
   */
  async refreshMic(mic: MicChoice): Promise<void> {
    const me = this.room?.localParticipant
    if (!me || !me.isMicrophoneEnabled) return
    try {
      await me.setMicrophoneEnabled(false)
      await me.setMicrophoneEnabled(true, constraints(mic))
      await this.cleanUpMic(mic)
    } catch { /* the device went away; the call itself is fine */ }
  }

  /**
   * Open or shut the microphone that is already published.
   *
   * Not setMicrophoneEnabled, which acquires the device and republishes the
   * track - fine once when somebody presses mute, and ruinous several times
   * a second, which is what voice activation asks for. Muting the
   * publication stops the audio leaving and keeps everything else in place.
   *
   * Answers whether anything was done, so a caller can tell "shut" from
   * "there is no microphone published to shut".
   */
  /** What is being sent, to measure - not a second capture of the device. */
  micStream(): MediaStream | null {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return null
    const track = me.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack
    return track ? new MediaStream([track]) : null
  }

  /**
   * Open or shut the microphone that is already published.
   *
   * Silenced at the track rather than muted at the publication, and the
   * difference between those two is the whole of this method.
   *
   * Muting a publication *is* the muted state: LiveKit tells the room, every
   * other person's copy of you flips to Muted, and the word under your own
   * name flickers between Muted and Listening several times a second. Voice
   * activation is not a mute - it is not a decision somebody made - and
   * nothing about it belongs in the state that says whether they muted
   * themselves.
   *
   * Setting `enabled` on the media track sends silence instead: it tells
   * nobody, and it leaves mute exactly where it was. Not
   * setMicrophoneEnabled either, which acquires the device and republishes -
   * fine once when somebody presses mute, ruinous fifty times a second.
   */
  gate(open: boolean): boolean {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return false
    const pub = me.getTrackPublication(lk.Track.Source.Microphone)
    const track = pub?.track?.mediaStreamTrack
    if (!track) return false
    /*
     * Never against a mute.
     *
     * The gate opens a microphone back up whenever it stops running - the
     * call ending, the setting turned off, somebody muting - because a
     * microphone left shut by a watcher that is no longer watching is the
     * worst way to lose a conversation. Muting is the one case where being
     * shut is the point, so it is the one case that is not undone here.
     */
    if (pub?.isMuted && open) return false
    if (track.enabled !== open) track.enabled = open
    /*
     * And say so at once, rather than waiting to be told.
     *
     * The ring round somebody's picture came from ActiveSpeakersChanged,
     * which is the room reporting who it can hear - a periodic thing, and
     * about half a second behind. For everybody else that is the only source
     * there is. For yourself it is not: this line is the decision, so the
     * ring can light on the same tick that the microphone opens instead of
     * after a round trip that has already happened.
     */
    if (open !== this.selfSpeaking) {
      this.selfSpeaking = open
      this.emitSpeaking()
    }
    return true
  }

  /**
   * Who is talking: what the room reported, with yourself decided here.
   *
   * Yours is the one answer that does not have to be waited for, and it is
   * also the one somebody is looking straight at while they speak.
   */
  private emitSpeaking(): void {
    const me = this.room?.localParticipant
    const mine = me ? idOf(me.identity) : ''
    const others = this.speakers.filter((id) => id !== mine)
    this.on.speaking(this.selfSpeaking && mine ? [...others, mine] : others)
  }

  async setCam(on: boolean): Promise<void> {
    await this.room?.localParticipant.setCameraEnabled(on)
  }

  /**
   * Share a screen, or stop.
   *
   * The picker is the browser's or the shell's; this publishes what came
   * back. What is returned says whether anything was published, not what —
   * asking for the track here comes back null often enough to matter, because
   * the publication exists a moment before its track does, and reading that
   * as "they cancelled the picker" is how sharing silently did nothing after
   * somebody had already chosen a window.
   */
  async setShare(on: boolean, opts: { audio?: boolean } = {}): Promise<boolean> {
    const me = this.room?.localParticipant
    if (!me) return false
    if (!on) {
      await me.setScreenShareEnabled(false)
      return false
    }
    const preset = shareQuality()
    const published = await me.setScreenShareEnabled(true, {
      audio: !!opts.audio,
      resolution: {
        width: preset.width,
        height: preset.height,
        frameRate: preset.fps,
      },
      contentHint: preset.contentHint,
    }, {
      /* Which codec, and why, is one constant above. */
      videoCodec: SCREEN_CODEC,
      /* A VP8 stream alongside, for a browser that cannot decode the above.
         Only *encoded* once somebody subscribes to it - multi-codec
         simulcast requires dynacast, which is on - so a room where everybody
         can take VP9 never pays for it. */
      backupCodec: true,
    })
    if (published) this.tellEncoder(preset)
    return !!published
  }

  /**
   * Change what the share is worth sending, while it is being sent.
   *
   * The capture stays exactly as it is — what changes is the ceiling it is
   * encoded to and how many frames of it get through.
   *
   * What is never given up is the size. A preset is named for a resolution
   * and that name has to be true: a share chosen as 720p that quietly becomes
   * less than 720p the moment the upload tightens is the difference between
   * readable text and a smear, and it is a difference nobody asked for or was
   * told about.
   */
  async setShareQuality(preset: SharePreset): Promise<boolean> {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return false
    const pub = me.getTrackPublication(lk.Track.Source.ScreenShare)
    const track = pub?.videoTrack
    if (!track) return false
    /* The hint travels with the track itself, and the browser reads it when
       deciding what to throw away. */
    try { track.mediaStreamTrack.contentHint = preset.contentHint } catch { /* older */ }

    /*
     * Constrained, never restarted.
     *
     * restartTrack re-acquires the capture, and re-acquiring a screen means
     * asking the operating system for a screen again — which does not happen
     * silently, so the old track ended and no new one arrived and the share
     * went black. Reported exactly that way.
     *
     * applyConstraints changes the capture that is already running, and a
     * browser that will not honour part of it keeps sending what it was.
     */
    try {
      /* A ceiling, not a preference. `ideal` is a wish a browser may decline,
         so choosing 720p on a 1440p monitor left the capture where it was and
         the change did nothing anybody could see. */
      await track.mediaStreamTrack.applyConstraints({
        width: { max: preset.width },
        height: { max: preset.height },
        frameRate: { max: preset.fps },
      })
    } catch { /* would not take the size; the ceiling below still applies,
                 which is most of what a preset is */ }
    this.tellEncoder(preset)
    setShareQuality(preset.id)
    return true
  }

  /** The ceiling, and what to give up first when the line cannot carry it. */
  private tellEncoder(preset: SharePreset): void {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return
    const pub = me.getTrackPublication(lk.Track.Source.ScreenShare)
    const sender = pub?.videoTrack?.sender
    if (!sender) return
    try {
      const params = sender.getParameters()
      params.degradationPreference = preset.degradation
      for (const e of params.encodings ?? []) e.maxBitrate = preset.maxBitrate
      void sender.setParameters(params)
    } catch { /* a browser that will not be told; the capture size still is */ }
  }

  /**
   * The sound of your share, on or off, without stopping the share.
   *
   * Muted rather than unpublished: what was captured stays captured, so it
   * comes back instantly and the picture never flickers. Turning it back ON
   * is only possible where there is something to unmute — a share started
   * without sound never captured any, and no amount of asking the media
   * server will conjure it. That is why this answers whether it could.
   */
  async setShareAudio(on: boolean): Promise<boolean> {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return false
    const pub = me.getTrackPublication(lk.Track.Source.ScreenShareAudio)
    if (!pub) return false
    if (on) await pub.unmute()
    else await pub.mute()
    return true
  }

  /** Whether there is any share sound at all, and whether it is going out. */
  shareAudio(): { has: boolean; on: boolean } {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return { has: false, on: false }
    const pub = me.getTrackPublication(lk.Track.Source.ScreenShareAudio)
    return { has: !!pub, on: !!pub && !pub.isMuted }
  }

  /**
   * Watch something, or stop.
   *
   * Unsubscribing rather than not drawing: the media server then stops
   * sending it, and with dynacast the sender stops encoding it too — so
   * somebody sharing to a room where everybody has hidden it is not spending
   * anything on it. The same decision the app has always offered, with the
   * saving happening two hops earlier.
   */
  async setWatching(key: StreamKey, on: boolean): Promise<void> {
    /* Written down first, and regardless of whether there is anything to
       subscribe yet: the case this exists for is somebody pressing watch on a
       share that has not been published again yet. */
    this.remember(key, on)
    const lk = this.lk
    if (!this.room || !lk) return
    const cut = key.indexOf(':')
    const source = key.slice(0, cut) as Source
    const id = key.slice(cut + 1)
    const who = [...this.room.remoteParticipants.values()]
      .find((p) => idOf(p.identity) === id)
    if (!who) return
    for (const track of tracksFor(lk, source)) {
      who.getTrackPublication(track)?.setSubscribed(on)
    }
  }

  /** Written down before the asking, so anything arriving later is answered
      for too - see `watched`. */
  private remember(key: StreamKey, on: boolean): void {
    if (on) this.watched.add(key)
    else this.watched.delete(key)
  }

  /** One of my own streams, asked for rather than remembered — see setShare. */
  /**
   * Put the denoiser on the microphone that was just published.
   *
   * Separate from publishing it because the microphone is published from
   * three places - joining, unmuting, and changing device - and a cleaner
   * that only ran on one of them would be a setting that worked depending on
   * how you got here. That is the shape of half the faults in this app.
   *
   * Every failure here is swallowed on purpose, and the failure is always the
   * same one: the plain microphone stays published. A denoiser that will not
   * load costs somebody a keyboard in the background; a denoiser that throws
   * on the way in and takes the track with it costs them their voice.
   */
  private async cleanUpMic(mic: MicChoice): Promise<void> {
    if (!mic.noiseSuppression) return
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return
    try {
      const track = me.getTrackPublication(lk.Track.Source.Microphone)?.audioTrack
      if (!track) return
      /* Already wearing one - unmuting republishes the same processed track
         rather than a fresh one, and setting a second would be a graph on a
         graph. */
      if (track.getProcessor()) return
      /*
       * Fetched here rather than imported at the top, and this is the whole
       * of what makes the promise above true.
       *
       * The denoiser's own package declares a class that extends
       * AudioWorkletNode at the moment it is loaded, so on anything without
       * audio worklets merely importing it throws - and an import at the top
       * of this file throws while *this* file is loading, which would take
       * voice with it. Not "no denoiser" but "no calls at all", from a
       * feature nobody asked to depend on.
       *
       * Inside the try, so that stays a shrug.
       */
      const { rnnoise } = await import('./denoise')
      await track.setProcessor(rnnoise())
    } catch {
      /* No worklet, no WebAssembly, a context at the wrong rate, or a browser
         that has never heard of any of it. The call carries on unprocessed,
         which is exactly where it was before this existed. */
    }
  }

  myTrack(source: Source): MediaStream | null {
    const lk = this.lk
    const me = this.room?.localParticipant
    if (!lk || !me) return null
    for (const track of tracksFor(lk, source)) {
      const pub = me.getTrackPublication(track)
      if (pub?.track) return new MediaStream([pub.track.mediaStreamTrack])
    }
    return null
  }

  /**
   * Take somebody's voice, and only their voice.
   *
   * Voices are the call. A picture is a request, and stays one until it is
   * made — see connect().
   */
  private takeVoices(who: RemoteParticipant): void {
    for (const pub of who.trackPublications.values()) {
      if (sourceOf(String(pub.source)) === 'voice') pub.setSubscribed(true)
    }
  }

  private tellRoster(): void {
    const lk = this.lk
    const room = this.room
    if (!lk || !room) return
    /* Me first, so a call has somebody in it the moment it connects — which
       is the difference between "nobody is here" and "the room has not
       answered yet". */
    const all = [room.localParticipant, ...room.remoteParticipants.values()]
    this.on.roster(all.map((p): CallMember => {
      const screen = p.getTrackPublication(lk.Track.Source.ScreenShare)
      const cam = p.getTrackPublication(lk.Track.Source.Camera)
      return {
        id: idOf(p.identity),
        identity: p.identity,
        name: p.name || p.identity,
        muted: !p.isMicrophoneEnabled,
        /* Published *and* not muted. A muted publication is a share somebody
           has paused, and a tile drawn for it is a black rectangle with a
           name under it. */
        sharing: !!screen && !screen.isMuted,
        cam: !!cam && !cam.isMuted,
      }
    }))
  }
}

/** The LiveKit sources one of our own names covers. */
function tracksFor(lk: typeof import('livekit-client'), source: Source): Track.Source[] {
  if (source === 'cam') return [lk.Track.Source.Camera]
  if (source === 'voice') return [lk.Track.Source.Microphone]
  /* A screen and the sound coming out of it are one thing to a person
     watching, so hiding one hides both. */
  return [lk.Track.Source.ScreenShare, lk.Track.Source.ScreenShareAudio]
}

function constraints(mic: MicChoice): MediaTrackConstraints {
  return {
    echoCancellation: mic.echoCancellation,
    noiseSuppression: mic.noiseSuppression,
    autoGainControl: mic.autoGainControl,
    ...(mic.deviceId ? { deviceId: { exact: mic.deviceId } } : {}),
  }
}

/** What a participant is called, so the roster and the member list agree. */
export const identityToId = idOf

