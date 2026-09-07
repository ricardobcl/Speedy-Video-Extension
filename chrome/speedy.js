/**
 * Speedy Video: fine-grained playback speed control for HTML5 videos.
 *
 * A content script with no external dependencies. It keeps the playback speed
 * you chose applied to whatever video is playing on the page, installs
 * keyboard shortcuts and shows the current speed in an overlay near the top
 * of the video whenever it changes. The overlay is the only thing it adds to
 * the page. It runs in every frame, so embedded players (e.g. a Youtube video
 * on another site) work too, once they have the keyboard focus. Videos that
 * appear later, without a page change (e.g. the viewer on Whatsapp), are
 * picked up when they start playing.
 */

// -------------------------------------------------------------- configuration

const config = {
  speedDelta: 0.25, // smallest increment or decrement of playback speed
  minSpeed: 0.2, // lowest playback speed allowed
  maxSpeed: 4.0, // highest playback speed allowed
  speedPresets: { a: 1.0, s: 2.0, d: 3.0 }, // key -> playback speed
  skipSmall: 2, // seconds seeked by shift + left/right
  skipBig: 10, // seconds seeked by shift + up/down
  fasterKey: "w", // key that speeds up by speedDelta
  slowerKey: "q", // key that slows down by speedDelta
  overlayKey: "z", // key that shows the current speed on top of the video
  overlayDuration: 1000, // ms the speed overlay stays visible
  applyInterval: 1000, // ms between checks that the playing video has the chosen speed
  pollInterval: 250, // ms between checks for a URL change, without the Navigation API
  debug: false // enables console.log debug info
}

// ------------------------------------------------------------------- helpers

const log = message => {
  if (config.debug) console.log(`Speedy Extension: ${message}`)
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// "1.25" and "2" instead of "1.2500000000000002" and "2.00"
const formatSpeed = speed => `${Math.round(speed * 100) / 100}`

// whether keystrokes belong to a text field and should never be hijacked
const isTyping = target =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))

// seeking by setting currentTime breaks the netflix player, so its own seek
// shortcuts are left alone
const atNetflix = () => location.hostname.endsWith("netflix.com")

const area = element => {
  const rect = element.getBoundingClientRect()
  return rect.width * rect.height
}

// <video> elements inside (open) shadow roots, where some players keep them
// (e.g. web-component players such as mux-player). Reaching them means walking
// every element on the page looking for shadow roots, which is why this is a
// fallback and not how we look first.
const shadowVideos = (root = document) => {
  const videos = []
  for (const element of root.querySelectorAll("*")) {
    const shadow = element.shadowRoot
    if (shadow) videos.push(...shadow.querySelectorAll("video"), ...shadowVideos(shadow))
  }
  return videos
}

// the ones on screen, largest first; hidden videos don't count
const visibleVideos = videos =>
  videos.filter(video => area(video) > 0).sort((a, b) => area(b) - area(a))

// The video to control: the largest one playing, else the largest one on
// screen. Sites keep hidden or paused players around (youtube keeps its
// regular player on shorts pages) and feeds and stories show several videos in
// turn, so this is decided again every time it matters -- often enough that it
// is worth looking in the light DOM, which is a cheap query and where almost
// every player keeps its video, and only walking the page for shadow roots
// when that comes up empty.
const findVideo = () => {
  const visible = visibleVideos([...document.querySelectorAll("video")])
  const candidates = visible.length > 0 ? visible : visibleVideos(shadowVideos())
  return candidates.find(video => !video.paused) ?? candidates[0]
}

// -------------------------------------------------------------- the extension

class SpeedyVideo {
  speed = 1.0 // current playback speed
  video = undefined // the <video> element being controlled

  #currentUrl = location.href
  #timers = new Map() // active setInterval handles, keyed by name
  #overlayTimeout = undefined

  start() {
    log("Starting Speedy Video")
    this.#watchUrlChanges()
    this.#watchPlayback()
    this.#setupShortcuts()
    this.#keepSpeedApplied() // in case a video is already playing
  }

  // sets a new playback speed, clamped to [minSpeed, maxSpeed] and rounded to
  // two decimals so that repeated +/- steps don't accumulate float error
  setSpeed(speed) {
    this.speed = Math.round(clamp(speed, config.minSpeed, config.maxSpeed) * 100) / 100
    log(`Speed set to ${this.speed}`)
    this.#keepSpeedApplied() // applies it now and keeps it applied from here on
    this.showOverlay()
  }

  changeSpeed(delta) {
    this.setSpeed(this.speed + delta)
  }

  // (re)applies the chosen speed to the video playing now; also runs every
  // second, because the playing video changes without a page change in feeds
  // and stories, and some players reset the rate on their own
  applySpeed = () => {
    this.video = findVideo()
    if (this.video && this.video.playbackRate !== this.speed) {
      this.video.playbackRate = this.speed
    }
  }

  seek(seconds) {
    this.video = findVideo()
    if (this.video) this.video.currentTime += seconds
  }

  // shows the current speed in an overlay near the top of the video for a moment
  showOverlay() {
    this.video = findVideo()
    const rect = this.video?.getBoundingClientRect()
    if (!rect?.width || !rect?.height) return // no video, or not visible
    const overlay =
      document.getElementById("speedy-overlay") ?? document.createElement("div")
    overlay.id = "speedy-overlay"
    // in fullscreen only descendants of the fullscreen element are visible, so
    // (re)attach the overlay to it; otherwise to the body
    const container = document.fullscreenElement ?? document.body
    if (overlay.parentElement !== container) container.append(overlay)
    overlay.style.left = `${rect.left + rect.width / 2}px`
    // near the top of the video, where it covers less of the action
    overlay.style.top = `${rect.top + rect.height * 0.1}px`
    overlay.style.fontSize = `${Math.max(12, Math.round(rect.height * 0.025))}px`
    overlay.textContent = `${formatSpeed(this.speed)}x`
    overlay.classList.add("speedy-visible")
    clearTimeout(this.#overlayTimeout)
    this.#overlayTimeout = setTimeout(
      () => overlay.classList.remove("speedy-visible"),
      config.overlayDuration
    )
  }

  // ------------------------------------------------ keeping the speed applied

  // single-page sites (e.g. youtube) load a new video without a page load, so
  // look again for the video whenever the URL changes
  #watchUrlChanges() {
    const onChange = () => {
      if (location.href === this.#currentUrl) return
      log(`URL changed to ${location.href}`)
      this.#currentUrl = location.href
      this.#keepSpeedApplied()
    }
    if (window.navigation) {
      window.navigation.addEventListener("currententrychange", onChange)
    } else {
      setInterval(onChange, config.pollInterval) // e.g. safari < 18.2
    }
  }

  // some sites have no video until one is opened, long after the page loaded
  // and without a URL change (e.g. whatsapp, where videos play in a viewer),
  // so a video starting to play is the other cue to set up; `play` does not
  // bubble, but the capture phase still sees it here
  #watchPlayback() {
    document.addEventListener("play", () => this.#keepSpeedApplied(), true)
  }

  // Keeps the chosen speed applied to whatever is playing. Nothing needs
  // keeping until a video plays or a speed is chosen, so those two moments are
  // what call this, rather than the page being polled for a video. Running it
  // again (e.g. when another video starts playing) is harmless; it returns
  // true when there was a video to apply the speed to.
  #keepSpeedApplied() {
    if (!findVideo()) return false
    log(`Keeping ${this.speed}x applied`)
    this.#startTimer("applySpeed", this.applySpeed, config.applyInterval)
    this.applySpeed() // right away, so a new video does not start at 1x
    return true
  }

  // ---------------------------------------------------------------- shortcuts

  // capture phase, so that we run before the site's own handlers
  #setupShortcuts() {
    document.addEventListener("keydown", this.#onKeydown, true)
  }

  #onKeydown = event => {
    if (isTyping(event.target) || event.altKey || event.metaKey) return
    const action = this.#actionFor(event)
    if (!action) return
    // with no video on screen (e.g. a chat with the video viewer closed) the
    // keys are left to the site, so that typing keeps working
    if (!findVideo()) return
    log(`Shortcut: ${event.key}`)
    // also stop the site's own handler for the same key (e.g. youtube seeks
    // 5s on the arrows), otherwise both actions would run
    event.preventDefault()
    event.stopImmediatePropagation()
    action()
  }

  // Speed shortcuts are plain single letters (safe because keystrokes in
  // text fields are ignored); seek shortcuts are prefixed with shift.
  #actionFor({ key, ctrlKey, shiftKey }) {
    if (shiftKey) return atNetflix() ? undefined : this.#seekActionFor(key)
    if (ctrlKey) return undefined // never steal combos like control+a
    return this.#speedActionFor(key.toLowerCase())
  }

  #speedActionFor(key) {
    if (key === config.fasterKey) return () => this.changeSpeed(+config.speedDelta)
    if (key === config.slowerKey) return () => this.changeSpeed(-config.speedDelta)
    if (key === config.overlayKey) return () => this.showOverlay()
    const preset = config.speedPresets[key]
    return preset === undefined ? undefined : () => this.setSpeed(preset)
  }

  #seekActionFor(key) {
    const seconds = {
      ArrowRight: config.skipSmall,
      ArrowLeft: -config.skipSmall,
      ArrowUp: config.skipBig,
      ArrowDown: -config.skipBig
    }[key]
    return seconds === undefined ? undefined : () => this.seek(seconds)
  }

  // ------------------------------------------------------------------- timers

  #startTimer(name, fn, ms) {
    this.#stopTimer(name)
    this.#timers.set(name, setInterval(fn, ms))
  }

  #stopTimer(name) {
    clearInterval(this.#timers.get(name))
    this.#timers.delete(name)
  }
}

new SpeedyVideo().start()
