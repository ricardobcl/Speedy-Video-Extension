/* global ALL_SITES, isAllowed, patternMatches, readSites, siteName */

// The background service worker. It keeps the content script registered for
// the sites that are on (see sites.js), starts and stops it in the open tabs
// when they change, and shows on the toolbar icon whether it runs in a tab and
// at what speed. It keeps no state of its own, since the browser stops it
// whenever it is idle.

importScripts("sites.js")

const CONTENT_SCRIPT = {
  id: "speedy",
  js: ["content.js"], // sites.js, settings.js and speedy.js (see the makefile)
  css: ["style.css"],
  allFrames: true,
  runAt: "document_idle"
}

// the icon of a tab it runs in, and of the others (the manifest's default)
const ON_ICON = { 16: "icons/Icon-16.png", 32: "icons/Icon-32.png" }
const OFF_ICON = { 16: "icons/Icon-16-off.png", 32: "icons/Icon-32-off.png" }

// ------------------------------------------------------ the content script

// Registers the content script for the sites that are on, if that changed.
// This runs every time the worker starts, since an update (or Safari, on
// every update) may drop the registration. What was registered is compared
// with what was asked for last time, kept in storage.local, rather than with
// what the browser reports back, which Safari may word differently: a
// registration made for nothing would also inject it into the open tabs again.
const registerContentScript = async ({ origins, excluded }) => {
  const wanted = origins.length === 0 ? undefined : { ...CONTENT_SCRIPT, matches: origins }
  if (wanted && excluded.length > 0) wanted.excludeMatches = excluded
  const signature = wanted ? JSON.stringify(wanted) : "none"
  const [[current], { registered }] = await Promise.all([
    chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT.id] }),
    chrome.storage.local.get("registered")
  ])
  if (Boolean(current) === Boolean(wanted) && registered === signature) return
  if (current) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT.id] })
  if (wanted) await chrome.scripting.registerContentScripts([wanted])
  await chrome.storage.local.set({ registered: signature })
}

// starts the content script in the frames of a tab that should have it and
// don't (a second copy would do nothing, see the makefile)
const startInTab = async (tabId, sites) => {
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ running: Boolean(globalThis.speedyVideo), url: location.href })
  })
  const frameIds = frames
    .filter(({ result }) => result && !result.running && isAllowed(result.url, sites))
    .map(({ frameId }) => frameId)
  if (frameIds.length === 0) return
  const target = { tabId, frameIds }
  await chrome.scripting.insertCSS({ target, files: CONTENT_SCRIPT.css })
  await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPT.js })
}

// Makes the open tabs follow the sites that are on. The registered content
// script only comes with the next page load, so pages of a site just turned on
// get it now, and the copies running on a site just turned off are told to
// stop (they check whether their own page is still on).
const updateOpenTabs = async sites => {
  const tabs = await chrome.tabs.query({})
  await Promise.all(
    tabs.map(async tab => {
      // (fails where no copy runs)
      chrome.tabs.sendMessage(tab.id, { type: "sites", ...sites }).catch(() => {})
      // a tab still loading gets the registered script
      if (tab.status !== "complete" || !tab.url || !isAllowed(tab.url, sites)) return
      // (fails where scripts can't run, e.g. the web store)
      await startInTab(tab.id, sites).catch(() => {})
    })
  )
}

// all of the above, one run at a time, since the events come in bursts
let queue = Promise.resolve()
const refresh = ({ openTabs }) => {
  queue = queue
    .then(async () => {
      const sites = await readSites()
      await registerContentScript(sites)
      if (openTabs) await updateOpenTabs(sites)
    })
    .catch(error => console.error("Speedy Video:", error))
  return queue
}

// ------------------------------------------------------------------ events

refresh({ openTabs: false })

// A site turned on is no longer in the list of sites turned off, and turning
// on all sites empties the list. This happens here rather than in the popup,
// which may close while the browser asks for the permission.
chrome.permissions.onAdded.addListener(async ({ origins = [] }) => {
  const { excluded } = await readSites()
  const turnedOn = pattern =>
    ["https", "http"].some(scheme =>
      origins.some(origin => patternMatches(origin, `${scheme}://${siteName(pattern)}/`))
    )
  const stillExcluded = excluded.filter(pattern => !turnedOn(pattern))
  if (stillExcluded.length < excluded.length) {
    await chrome.storage.local.set({ excludedSites: stillExcluded })
  }
  refresh({ openTabs: true })
})

// the list of sites turned off only means something while all sites are on
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  if (origins.includes(ALL_SITES)) await chrome.storage.local.set({ excludedSites: [] })
  refresh({ openTabs: true })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.excludedSites) refresh({ openTabs: true })
})

// After an update the copies already in pages are cut off from the extension
// (they notice and stop), so new ones start in the open tabs. The first time,
// the options page opens to choose the sites; only once, since Safari 26.0
// and 26.1 report an install on every launch.
chrome.runtime.onInstalled.addListener(async () => {
  refresh({ openTabs: true })
  const { welcomed } = await chrome.storage.local.get("welcomed")
  if (welcomed) return
  await chrome.storage.local.set({ welcomed: true })
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html?welcome") })
})

// ------------------------------------------------------------ toolbar icon

// "2x", "1.5x", "1.25": badges fit about four characters
const badgeText = speed => {
  const text = `${Math.round(speed * 100) / 100}`
  return text.length < 4 ? `${text}x` : text
}

chrome.action.setBadgeBackgroundColor({ color: "#d93a1a" }) // safari ignores it

// The content script reports when it starts or changes the speed, and when it
// stops; the icon is in color where it runs, with the speed unless it is 1x.
// Any frame counts (e.g. an embedded Youtube player), but only the page itself
// stopping turns the icon off.
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  if (message.type === "speed") {
    chrome.action.setIcon({ tabId, path: ON_ICON }).catch(() => {}) // the tab may be gone
    const text = message.speed === 1 ? "" : badgeText(message.speed)
    chrome.action.setBadgeText({ tabId, text }).catch(() => {})
  } else if (message.type === "stopped" && sender.frameId === 0) {
    chrome.action.setIcon({ tabId, path: OFF_ICON }).catch(() => {})
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {})
  }
})
