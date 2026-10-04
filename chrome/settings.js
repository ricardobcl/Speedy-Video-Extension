/* exported defaultSettings, readSettings */

// The settings that can be changed on the options page, and their defaults.
// Loaded both before the content script and by the options page, which keeps
// the changed ones in chrome.storage.sync (validated before they are saved).
const defaultSettings = Object.freeze({
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
  // "site": a page starts at the last speed on its site, "all": at the last
  // speed anywhere, "off": at 1x
  rememberSpeed: "off"
})

// The settings in effect: the saved ones, and the defaults for the rest. Not
// chrome.storage.sync.get(defaultSettings), because Chrome merges nested
// defaults into the saved value, which would bring back removed presets.
const readSettings = async () => ({
  ...structuredClone(defaultSettings),
  ...(await chrome.storage.sync.get(Object.keys(defaultSettings)))
})
