CHROME = chrome
ZIP = SpeedyChrome.zip
SAFARI = safari
APP = Speedy Video
# from the old name (HTML5 Speedy Video), kept so Safari still sees the same
# extension: a new id would have to be turned on and allowed on websites again
BUNDLE_ID = com.ricardobcl.html5speedyvideo
# Apple team used to sign the Safari app: the first (preferably free/personal)
# team of the Apple IDs added in Xcode > Settings > Accounts. Without one the
# app is ad-hoc signed and Safari needs "Allow unsigned extensions" on every
# launch. Override with `make safari TEAM_ID=XXXXXXXXXX`.
TEAM_ID ?= $(shell defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -c 'import plistlib,sys; d=plistlib.loads(sys.stdin.buffer.read()); ts=[t for k in ("IDEProvisioningTeamByIdentifier","IDEProvisioningTeams") for l in d.get(k,{}).values() for t in l]; ts.sort(key=lambda t: not t.get("isFreeProvisioningTeam")); print(ts[0]["teamID"] if ts else "")' 2>/dev/null)
ifneq ($(TEAM_ID),)
SIGNING = CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=$(TEAM_ID) CODE_SIGN_IDENTITY="Apple Development" -allowProvisioningUpdates
endif
CYAN = \033[0;36m
GREEN = \033[0;32m
BOLD = \033[1m
PLAIN = \033[0m

.PHONY: all install chrome safari clean clean_chrome release clean_release

all: chrome

# builds the Chrome extension and walks you through loading it in Chrome
install: chrome
	@ open -R "$(CHROME)/manifest.json" >/dev/null 2>&1 || true
	@ osascript >/dev/null 2>&1 \
	  -e 'tell application "Google Chrome"' \
	  -e 'activate' \
	  -e 'if (count of windows) = 0 then make new window' \
	  -e 'tell front window to make new tab with properties {URL:"chrome://extensions/"}' \
	  -e 'end tell' \
	  || echo "(could not open Chrome automatically -- go to chrome://extensions yourself)"
	@ echo ""
	@ echo "$(BOLD)Finish in the Chrome tab that just opened:$(PLAIN)"
	@ echo "  1. turn on $(BOLD)Developer mode$(PLAIN) (top right corner)"
	@ echo "  2. click $(BOLD)Load unpacked$(PLAIN) and choose the folder highlighted in Finder:"
	@ echo "     $(CYAN)$(CURDIR)/$(CHROME)$(PLAIN)"
	@ echo ""
	@ echo "To update later: git pull && make install, then click reload on the extension card."

# The content script is these files joined into content.js, inside a block
# that only runs if the page has no copy running yet: a page can get it twice
# (Safari also injects it into open tabs on its own), and the second copy
# would fail on its redeclared constants, or run alongside the first.
CONTENT_SCRIPT = sites.js settings.js speedy.js

# the Chrome extension folder is src/ plus the icons, rebuilt from scratch so
# that nothing deleted from src/ lingers in it
chrome: clean_chrome
	@ echo "> Building the Chrome extension folder..."
	@ mkdir -p "$(CHROME)/icons"
	@ cp src/* "$(CHROME)"
	@ rm "$(CHROME)/speedy.js"
	@ { echo "// built by make from $(CONTENT_SCRIPT); edit those"; \
	    echo "if (!globalThis.speedyVideo) {"; \
	    for file in $(CONTENT_SCRIPT); do cat "src/$$file"; done; \
	    echo "}"; } > "$(CHROME)/content.js"
	@ cp icons/*.png "$(CHROME)/icons"
	@ echo "$(GREEN)Chrome extension is ready!$(PLAIN)"

# Converts the Chrome extension into a Safari Web Extension Xcode project,
# builds the wrapper app and opens it, which registers the extension with
# Safari. Requires the full Xcode app (free on the App Store).
# (The perl step fixes a converter bug: it derives the app's bundle id from
# the app name instead of using the given one, so the extension's id is not
# prefixed by the app's and Xcode refuses to run it.)
safari: chrome
	@ xcrun --find safari-web-extension-converter >/dev/null 2>&1 || { \
	  echo "$(BOLD)Xcode is required to build the Safari extension:$(PLAIN)"; \
	  echo "  1. install Xcode from the App Store (free)"; \
	  echo "  2. open Xcode once, so it finishes setting up"; \
	  echo "  3. run: $(CYAN)sudo xcode-select -s /Applications/Xcode.app/Contents/Developer$(PLAIN)"; \
	  echo "  4. run $(BOLD)make safari$(PLAIN) again"; \
	  exit 1; }
	@ echo "> Converting the Chrome extension into a Safari Xcode project..."
	@ xcrun safari-web-extension-converter "$(CHROME)" \
	    --project-location "$(SAFARI)" --app-name "$(APP)" \
	    --bundle-identifier $(BUNDLE_ID) \
	    --macos-only --no-open --no-prompt --force >/dev/null
	@ perl -pi -e 's/PRODUCT_BUNDLE_IDENTIFIER = .*;/PRODUCT_BUNDLE_IDENTIFIER = $(BUNDLE_ID);/ unless /\.Extension;/' \
	    "$(SAFARI)/$(APP)/$(APP).xcodeproj/project.pbxproj"
	@ echo "> Building the Safari extension app (takes a minute the first time)..."
	@ xcodebuild -project "$(SAFARI)/$(APP)/$(APP).xcodeproj" -scheme "$(APP)" \
	    -configuration Debug -destination "generic/platform=macOS" -derivedDataPath "$(SAFARI)/build" \
	    $(SIGNING) build -quiet
	@ open "$(SAFARI)/build/Build/Products/Debug/$(APP).app"
	@ echo "$(GREEN)Safari extension is built and registered!$(PLAIN) $(if $(TEAM_ID),(signed with team $(TEAM_ID)),(ad-hoc signed))"
	@ echo ""
	@ echo "$(BOLD)Finish in Safari$(PLAIN) (the app that just opened has a button that takes you there):"
ifeq ($(TEAM_ID),)
	@ echo "  1. Settings > Advanced > turn on $(BOLD)Show features for web developers$(PLAIN)"
	@ echo "  2. Settings > Developer > turn on $(BOLD)Allow unsigned extensions$(PLAIN) (resets when Safari quits)"
	@ echo "  3. Settings > Extensions > turn on $(BOLD)$(APP)$(PLAIN)"
	@ echo "  4. open a Youtube video, click the extension's toolbar icon and choose $(BOLD)Always Allow on Every Website$(PLAIN)"
	@ echo ""
	@ echo "Tip: add your Apple ID in Xcode > Settings > Accounts (free) and run 'make safari' again to get rid of step 2 for good."
else
	@ echo "  1. Settings > Extensions > turn on $(BOLD)$(APP)$(PLAIN)"
	@ echo "  2. open a Youtube video, click the extension's toolbar icon and choose $(BOLD)Always Allow on Every Website$(PLAIN)"
endif

clean: clean_chrome clean_release
	@ rm -f .DS_Store
	@ rm -rf "$(SAFARI)"

clean_chrome:
	@ rm -rf "$(CHROME)"

# zip for the Chrome Web Store, which wants the manifest at the root of the
# archive, not inside a folder
release: clean_release chrome
	@ cd "$(CHROME)" && zip -rq "../$(ZIP)" . -x ".*" "*/.*"
	@ echo "$(GREEN)Release zip is ready: $(ZIP)$(PLAIN)"

clean_release:
	@ rm -f "$(ZIP)"
