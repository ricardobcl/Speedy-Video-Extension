/* exported ALL_SITES, usualSites, sitePattern, siteName, patternMatches, isAllowed */
/* exported readSites, turnBackOn, turnOff */

// Where Speedy Video runs. A site is on when the user granted the extension
// access to it (an optional host permission, asked for from the toolbar popup
// or the options page) and it isn't in the list of sites turned off while
// "all sites" is granted, which is kept in storage.local, since a single site
// can't be taken out of an all-sites permission. Chrome and Safari keep the
// granted permissions, so the user's list of sites is chrome.permissions
// itself. Loaded by the background script, the popup, the options page and,
// before the content script, every page it runs in.

const ALL_SITES = "*://*/*"

// a few popular video sites, which the options page offers to turn on in one go
const usualSites = [
  "*://*.youtube.com/*",
  "*://*.youtube-nocookie.com/*",
  "*://*.netflix.com/*",
  "*://*.nostv.pt/*",
  "*://*.disneyplus.com/*",
  "*://*.hbomax.com/*",
  "*://*.primevideo.com/*",
  "*://*.instagram.com/*",
  "*://*.x.com/*",
  "*://*.twitter.com/*",
  "*://*.patreon.com/*",
  "*://*.web.whatsapp.com/*"
]

// The match pattern for the site of `url` (its host without "www.", and its
// subdomains: https://www.youtube.com/watch -> *://*.youtube.com/*), or
// undefined for pages that aren't websites (chrome://, file://...)
const sitePattern = url => {
  const { protocol, hostname } = new URL(url)
  if (protocol !== "http:" && protocol !== "https:") return undefined
  const isIp = /^[\d.]+$/.test(hostname) || hostname.startsWith("[")
  return isIp ? `*://${hostname}/*` : `*://*.${hostname.replace(/^www\./, "")}/*`
}

// "youtube.com" for *://*.youtube.com/*, "all sites" for *://*/*
const siteName = pattern => {
  const host = /^[^:]+:\/\/([^/]*)/.exec(pattern)?.[1] ?? pattern
  return host === "*" || pattern === "<all_urls>" ? "all sites" : host.replace(/^\*\./, "")
}

const escapeRegExp = text => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

// Whether `url` matches a match pattern (developer.chrome.com/docs/extensions/
// develop/concepts/match-patterns): ours, and whatever else the browser may
// have granted, e.g. from Safari's own "Always Allow on This Website"
const patternMatches = (pattern, url) => {
  if (pattern === "<all_urls>") return /^(https?|wss?|ftp|file):/.test(url)
  const [, scheme, host, path] = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(pattern) ?? []
  if (!scheme) return false
  const schemes = scheme === "*" ? "https?" : escapeRegExp(scheme)
  const hosts =
    host === "*"
      ? "[^/]*"
      : host.startsWith("*.")
        ? `([^/]*\\.)?${escapeRegExp(host.slice(2))}`
        : escapeRegExp(host)
  const paths = escapeRegExp(path).replaceAll("*", ".*")
  return new RegExp(`^${schemes}://${hosts}(:\\d+)?${paths}$`).test(url.split("#")[0])
}

// whether Speedy Video should run on `url`, given the granted `origins` and
// the sites turned off
const isAllowed = (url, { origins, excluded }) =>
  origins.some(origin => patternMatches(origin, url)) &&
  !excluded.some(pattern => patternMatches(pattern, url))

// { origins, excluded }: the granted sites and the ones turned off
const readSites = async () => {
  const [{ origins = [] }, { excludedSites = [] }] = await Promise.all([
    chrome.permissions.getAll(),
    chrome.storage.local.get("excludedSites")
  ])
  return { origins, excluded: excludedSites }
}

const setExcluded = excludedSites => chrome.storage.local.set({ excludedSites })

// turns a site turned off while "all sites" is granted back on
const turnBackOn = async url => {
  const { excluded } = await readSites()
  await setExcluded(excluded.filter(pattern => !patternMatches(pattern, url)))
}

// Turns Speedy Video off on the site of `url`: gives back the permissions that
// cover it (other than all sites), and with all sites granted, also turns the
// site off in the list
const turnOff = async url => {
  const { origins, excluded } = await readSites()
  const covering = origins.filter(
    origin => origin !== ALL_SITES && patternMatches(origin, url)
  )
  if (covering.length > 0) await chrome.permissions.remove({ origins: covering })
  const stillCovered = origins.some(
    origin => !covering.includes(origin) && patternMatches(origin, url)
  )
  const pattern = sitePattern(url)
  if (stillCovered && !excluded.includes(pattern)) await setExcluded([...excluded, pattern])
}
