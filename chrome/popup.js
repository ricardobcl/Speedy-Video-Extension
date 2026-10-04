/* global ALL_SITES, patternMatches, readSites, siteName, sitePattern, turnBackOn, turnOff */

// The toolbar popup: turns Speedy Video on or off for the site of the current
// tab, or for all sites. Turning a site on asks the browser for access to it,
// and the background script then starts the content script in its open tabs;
// turning it off gives the access back, or (with all sites on) puts the site
// in the list of sites turned off.

const element = id => document.getElementById(id)

const button = (label, onClick, { primary = false } = {}) => {
  const result = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: label,
    className: primary ? "primary" : ""
  })
  result.addEventListener("click", onClick)
  return result
}

const render = async tab => {
  const url = tab?.url
  const site = url && sitePattern(url)
  const status = element("status")
  status.className = ""
  if (!site) {
    element("site").textContent = "This page"
    element("status-text").textContent = "Speedy Video can't run on this page."
    status.classList.add("unsupported")
    element("actions").replaceChildren()
    return
  }

  const { origins, excluded } = await readSites()
  const allSites = origins.includes(ALL_SITES)
  // a permission for the site itself, or a wider one, other than all sites
  const covering = origins.find(origin => origin !== ALL_SITES && patternMatches(origin, url))
  const isExcluded = excluded.some(pattern => patternMatches(pattern, url))
  const on = (allSites || covering !== undefined) && !isExcluded
  const name = siteName(covering ?? site)
  element("site").textContent = name

  // asking for a permission must be the first thing a click does, since the
  // browser only allows it while handling the click
  const request = pattern => () =>
    chrome.permissions.request({ origins: [pattern] }).then(() => render(tab))
  const andRender = action => () => action().then(() => render(tab))

  let text
  let actions
  if (on) {
    text = allSites ? "On, like on every site" : "On"
    actions = [button(`Turn off for ${name}`, andRender(() => turnOff(url)))]
    if (allSites) {
      const removeAllSites = () => chrome.permissions.remove({ origins: [ALL_SITES] })
      actions.push(button("Turn off for all sites", andRender(removeAllSites)))
    }
  } else if (isExcluded && (allSites || covering)) {
    text = "Turned off here, on everywhere else"
    actions = [
      button(`Turn back on for ${name}`, andRender(() => turnBackOn(url)), { primary: true })
    ]
  } else {
    text = "Off"
    actions = [
      button(`Turn on for ${name}`, request(site), { primary: true }),
      button("Turn on for all sites", request(ALL_SITES))
    ]
  }
  status.classList.toggle("on", on)
  element("status-text").textContent = text
  element("actions").replaceChildren(...actions)
}

element("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => render(tab))
