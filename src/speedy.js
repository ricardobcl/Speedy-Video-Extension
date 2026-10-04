/* global defaultSettings, readSettings, isAllowed */

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
 * picked up when they start playing. The shortcuts and speeds come from the
 * options page (settings.js has the defaults). The background script runs it
 * on the sites that are on (sites.js), and stops it when they are turned off.
 * make joins sites.js, settings.js and this file into the content.js that
 * runs in pages.
 */

// -------------------------------------------------------------- configuration

const config = {
  ...defaultSettings, // replaced by the ones changed on the options page
  applyInterval: 1000, // ms between checks that the playing video has the chosen speed
  pollInterval: 250, // ms between checks for a URL change, without the Navigation API
  debug: false // enables console.log debug info
}

// ------------------------------------------------------------------- helpers

const log = message => {
  if (config.debug) console.log(`Speedy Extension: ${message}`)
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// where the remembered speed is kept in storage.local: one per site (its host
// without "www."), or one for all
const speedKey = () =>
  config.rememberSpeed === "all" ? "speed" : `speed:${location.hostname.replace(/^www\./, "")}`

// "1.25" and "2" instead of "1.2500000000000002" and "2.00"
const formatSpeed = speed => `${Math.round(speed * 100) / 100}`

// Whether keystrokes belong to a text field and should never be hijacked. A
// key typed in a field inside an (open) shadow root reaches the document with
// the shadow host as its target, so look at where it really started.
const isTyping = event => {
  const target = event.composedPath()[0]
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

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
  #listeners = undefined // aborts the page's event listeners; set while running

  get running() {
    return this.#listeners !== undefined
  }

  start() {
    if (this.running) return
    log("Starting Speedy Video")
    this.#listeners = new AbortController()
    this.#watchUrlChanges()
    this.#watchPlayback()
    this.#setupShortcuts()
    this.#keepSpeedApplied() // in case a video is already playing
  }

  // leaves the page alone again (its site was turned off, or the extension
  // updated or removed): no more listeners, timers or overlay; the video keeps
  // the speed it has
  stop() {
    if (!this.running) return
    log("Stopping Speedy Video")
    this.#listeners.abort()
    this.#listeners = undefined
    for (const name of [...this.#timers.keys()]) this.#stopTimer(name)
    clearTimeout(this.#overlayTimeout)
    document.getElementById("speedy-overlay")?.remove()
  }

  // sets a new playback speed, clamped to [minSpeed, maxSpeed] and rounded to
  // two decimals so that repeated +/- steps don't accumulate float error
  setSpeed(speed) {
    this.speed = Math.round(clamp(speed, config.minSpeed, config.maxSpeed) * 100) / 100
    log(`Speed set to ${this.speed}`)
    this.#keepSpeedApplied() // applies it now and keeps it applied from here on
    this.showOverlay()
    if (config.rememberSpeed !== "off") {
      chrome.storage.local
        .set({ [speedKey()]: this.speed })
        .catch(error => log(`Could not remember the speed: ${error}`))
    }
  }

  // takes on a speed chosen elsewhere (the remembered one, or one just chosen
  // in another tab) quietly: without the overlay, and without remembering it
  adoptSpeed(speed) {
    const adopted = clamp(speed, config.minSpeed, config.maxSpeed)
    if (adopted === this.speed) return
    log(`Speed adopted: ${adopted}`)
    this.speed = adopted
    if (this.running) this.#keepSpeedApplied()
  }

  // one speedDelta faster (+1) or slower (-1), landing on a multiple of it, so
  // that the speeds stay 0.25, 0.5, 0.75... even after being clamped to a
  // minSpeed that isn't one (0.2 -> 0.25, not 0.45) or set off-grid by a preset
  changeSpeed(direction) {
    const steps = this.speed / config.speedDelta
    const epsilon = 1e-6 // 0.6 / 0.2 is 2.9999999999999996
    const next =
      direction > 0 ? Math.floor(steps + epsilon) + 1 : Math.ceil(steps - epsilon) - 1
    this.setSpeed(next * config.speedDelta)
  }

  // (re)applies the chosen speed to the video playing now; also runs every
  // second, because the playing video changes without a page change in feeds
  // and stories, and some players reset the rate on their own
  applySpeed = () => {
    if (this.#orphaned()) return
    this.video = findVideo()
    if (!this.video) {
      // the video is gone (e.g. whatsapp's viewer was closed): stop checking,
      // since with no video findVideo walks the whole page every time, until
      // another video plays or a speed is chosen
      this.#stopTimer("applySpeed")
      return
    }
    if (this.video.playbackRate !== this.speed) this.video.playbackRate = this.speed
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

  // After the extension is updated, reloaded or removed, this copy stays in
  // the page, cut off from it, and an update injects a new copy. So it bows
  // out the first time it notices, before it handles anything.
  #orphaned() {
    if (chrome.runtime?.id) return false
    this.stop()
    return true
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
      window.navigation.addEventListener("currententrychange", onChange, {
        signal: this.#listeners.signal
      })
    } else {
      this.#startTimer("watchUrl", onChange, config.pollInterval) // e.g. safari < 18.2
    }
  }

  // some sites have no video until one is opened, long after the page loaded
  // and without a URL change (e.g. whatsapp, where videos play in a viewer),
  // so a video starting to play is the other cue to set up; `play` does not
  // bubble, but the capture phase still sees it here
  #watchPlayback() {
    document.addEventListener("play", () => this.#keepSpeedApplied(), {
      capture: true,
      signal: this.#listeners.signal
    })
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
    document.addEventListener("keydown", this.#onKeydown, {
      capture: true,
      signal: this.#listeners.signal
    })
  }

  #onKeydown = event => {
    if (this.#orphaned() || isTyping(event) || event.altKey || event.metaKey) return
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
    if (key === config.fasterKey) return () => this.changeSpeed(+1)
    if (key === config.slowerKey) return () => this.changeSpeed(-1)
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

// ------------------------------------------------------------------- starting

// The settings changed on the options page replace the defaults as soon as
// they are read, and again whenever they change, so that open tabs pick up the
// changes without a reload. Until then (a few ms) the defaults apply.
const watchSettings = () => {
  readSettings()
    .then(settings => {
      Object.assign(config, settings)
      restoreSpeed()
    })
    .catch(error => log(`Could not read the settings: ${error}`))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return
    for (const [name, { newValue }] of Object.entries(changes)) {
      // no newValue means it was reset to the default
      if (name in defaultSettings) config[name] = newValue ?? defaultSettings[name]
    }
  })
}

// With "remember the speed" on, a page starts at the speed chosen last (on its
// site, or anywhere), and a speed chosen in one tab carries over to the open
// tabs that share it
const restoreSpeed = () => {
  if (config.rememberSpeed === "off") return
  const key = speedKey()
  chrome.storage.local
    .get(key)
    .then(stored => stored[key] !== undefined && speedy.adoptSpeed(stored[key]))
    .catch(error => log(`Could not read the remembered speed: ${error}`))
}

const watchRememberedSpeed = () => {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || config.rememberSpeed === "off") return
    const speed = changes[speedKey()]?.newValue
    if (speed !== undefined) speedy.adoptSpeed(speed)
  })
}

// The background script injects the content script into the open tabs of a
// site that is turned on, but only into frames that don't have it yet, which
// is what globalThis.speedyVideo tells it. It can still arrive twice (Safari
// injects it into open tabs too), so the content.js that make builds only
// runs when globalThis.speedyVideo isn't there yet.
const speedy = new SpeedyVideo()
globalThis.speedyVideo = speedy
watchSettings()
watchRememberedSpeed()
// the background script tells every tab when the sites that are on change
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== "sites") return
  if (isAllowed(location.href, message)) speedy.start()
  else speedy.stop()
})
speedy.start()
