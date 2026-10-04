/* global defaultSettings, readSettings */

// The options page: shows the settings, checks every change and saves it in
// chrome.storage.sync, where the content script in every open tab picks it up
// right away. Only valid values are saved; an invalid one shows an error next
// to its field and leaves the saved setting as it was.

// speeds the options can be set to; Chrome refuses playback rates outside
// [0.0625, 16]
const SLOWEST = 0.1
const FASTEST = 16

// the number fields, by setting name; overlayDuration is kept in ms but shown
// in seconds
const numberFields = {
  minSpeed: { min: SLOWEST, max: FASTEST },
  maxSpeed: { min: SLOWEST, max: FASTEST },
  skipSmall: { min: 1, max: 600 },
  skipBig: { min: 1, max: 600 },
  overlayDuration: { min: 0.2, max: 10, scale: 1000 }
}

// the single-key shortcuts, by setting name, as they are called in errors
const shortcuts = {
  fasterKey: "speed up",
  slowerKey: "slow down",
  overlayKey: "show the speed"
}

let settings = structuredClone(defaultSettings)
let presets = [] // [{ key, speed }]; a preset just added has no key yet

const round2 = number => Math.round(number * 100) / 100
const element = id => document.getElementById(id)

// --------------------------------------------------------------- saving

let statusTimeout = undefined

const showStatus = message => {
  const status = element("status")
  status.textContent = message
  status.classList.add("visible")
  clearTimeout(statusTimeout)
  statusTimeout = setTimeout(() => status.classList.remove("visible"), 1500)
}

const save = async changes => {
  Object.assign(settings, changes)
  try {
    await chrome.storage.sync.set(changes)
    showStatus("Saved")
  } catch (error) {
    showStatus(`Not saved: ${error.message}`)
  }
}

// presets without a key yet are only kept on the page, until they get one
const savePresets = () =>
  save({
    speedPresets: Object.fromEntries(
      presets.filter(preset => preset.key).map(({ key, speed }) => [key, speed])
    )
  })

// shows `message` under the field (a missing one clears the error)
const setError = (field, errorElement, message) => {
  field.setAttribute("aria-invalid", message ? "true" : "false")
  errorElement.textContent = message ?? ""
}

// --------------------------------------------------------------- numbers

const numberError = (name, value) => {
  const { min, max } = numberFields[name]
  if (!(value >= min && value <= max)) return `Pick a number from ${min} to ${max}`
  if (name === "minSpeed" && value >= settings.maxSpeed)
    return `Must be slower than the fastest speed (${settings.maxSpeed}x)`
  if (name === "maxSpeed" && value <= settings.minSpeed)
    return `Must be faster than the slowest speed (${settings.minSpeed}x)`
  return undefined
}

const onNumberChange = input => {
  const name = input.id
  const value = round2(input.valueAsNumber)
  const error = numberError(name, value)
  setError(input, element(`${name}-error`), error)
  if (error) return
  input.value = value
  const { scale } = numberFields[name]
  save({ [name]: scale ? Math.round(value * scale) : value })
  // a slowest speed refused for being too fast may be fine now, and so on
  const other = { minSpeed: "maxSpeed", maxSpeed: "minSpeed" }[name]
  if (other && element(other).getAttribute("aria-invalid") === "true") {
    onNumberChange(element(other))
  }
}

// ------------------------------------------------------------------ keys

// what already uses `key`, other than `self` (a shortcut's setting name or a
// preset), for the error that refuses it
const keyUse = (key, self) => {
  for (const [name, action] of Object.entries(shortcuts)) {
    if (name !== self && settings[name] === key) return action
  }
  const preset = presets.find(preset => preset !== self && preset.key === key)
  return preset && `the ${preset.speed}x preset`
}

const keyError = (event, self) => {
  const key = event.key.toLowerCase()
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
    return "Pick a key without shift, control, option or command"
  if (key.length !== 1 || key === " ") return "Pick a letter, digit or symbol key"
  const use = keyUse(key, self)
  return use && `${key.toUpperCase()} is already used to ${use}`
}

const showKey = (button, key) => {
  button.classList.remove("listening")
  button.textContent = key ? key.toUpperCase() : "Choose"
}

// Turns `button` into a key picker: click it (or press enter), then press the
// new key, which goes to `onKey` once it is checked. Escape, tab or clicking
// elsewhere cancels.
const makeKeyPicker = (button, errorElement, self, currentKey, onKey) => {
  button.addEventListener("click", () => {
    button.focus() // safari doesn't focus buttons on click, so keys wouldn't reach it
    button.classList.add("listening")
    button.textContent = "Press a key"
  })
  button.addEventListener("blur", () => showKey(button, currentKey()))
  button.addEventListener("keydown", event => {
    if (!button.classList.contains("listening")) return
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return
    if (event.key === "Tab") return showKey(button, currentKey())
    event.preventDefault()
    if (event.key === "Escape") return showKey(button, currentKey())
    const error = keyError(event, self)
    setError(button, errorElement, error)
    if (!error) onKey(event.key.toLowerCase())
    showKey(button, currentKey())
  })
}

// --------------------------------------------------------------- presets

const presetRow = preset => {
  const row = document.createElement("div")
  row.className = "row preset"

  const button = Object.assign(document.createElement("button"), {
    type: "button",
    className: "key"
  })
  button.setAttribute("aria-label", "Preset key")
  const speed = Object.assign(document.createElement("input"), {
    type: "number",
    min: SLOWEST,
    max: FASTEST,
    step: 0.05,
    value: preset.speed
  })
  speed.setAttribute("aria-label", "Preset speed")
  const remove = Object.assign(document.createElement("button"), {
    type: "button",
    className: "text-button",
    textContent: "Remove"
  })
  const error = Object.assign(document.createElement("span"), { className: "error" })

  makeKeyPicker(button, error, preset, () => preset.key, key => {
    preset.key = key
    savePresets()
  })
  showKey(button, preset.key)
  speed.addEventListener("change", () => {
    const value = round2(speed.valueAsNumber)
    const valid = value >= SLOWEST && value <= FASTEST
    setError(speed, error, valid ? undefined : `Pick a speed from ${SLOWEST} to ${FASTEST}`)
    if (!valid) return
    speed.value = preset.speed = value
    if (preset.key) savePresets()
  })
  remove.addEventListener("click", () => {
    presets = presets.filter(other => other !== preset)
    renderPresets()
    if (preset.key) savePresets()
  })

  const key = document.createElement("span")
  key.className = "field"
  key.append(button, "sets the speed to")
  const value = document.createElement("span")
  value.className = "field"
  value.append(speed, "x", remove)
  row.append(key, value, error)
  return row
}

const renderPresets = () => element("presets").replaceChildren(...presets.map(presetRow))

// ------------------------------------------------------------------ page

const render = () => {
  const step = element("speedDelta")
  if (![...step.options].some(option => Number(option.value) === settings.speedDelta)) {
    step.add(new Option(settings.speedDelta, settings.speedDelta))
  }
  step.value = settings.speedDelta
  for (const [name, { scale = 1 }] of Object.entries(numberFields)) {
    element(name).value = settings[name] / scale
    setError(element(name), element(`${name}-error`), undefined)
  }
  for (const name of Object.keys(shortcuts)) {
    showKey(element(name), settings[name])
    setError(element(name), element(`${name}-error`), undefined)
  }
  presets = Object.entries(settings.speedPresets)
    .map(([key, speed]) => ({ key, speed }))
    .sort((a, b) => a.speed - b.speed) // storage keeps them sorted by key
  renderPresets()
}

const start = async () => {
  settings = await readSettings()
  render()

  element("speedDelta").addEventListener("change", event =>
    save({ speedDelta: Number(event.target.value) })
  )
  for (const name of Object.keys(numberFields)) {
    element(name).addEventListener("change", event => onNumberChange(event.target))
  }
  for (const name of Object.keys(shortcuts)) {
    makeKeyPicker(element(name), element(`${name}-error`), name, () => settings[name], key =>
      save({ [name]: key })
    )
  }
  element("addPreset").addEventListener("click", () => {
    const preset = { key: undefined, speed: 1.5 }
    presets.push(preset)
    renderPresets()
    element("presets").lastElementChild.querySelector(".key").click() // pick its key
  })
  element("reset").addEventListener("click", async () => {
    await chrome.storage.sync.remove(Object.keys(defaultSettings))
    settings = structuredClone(defaultSettings)
    render()
    showStatus("Reset to defaults")
  })
}

start()
