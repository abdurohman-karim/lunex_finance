#!/usr/bin/env bash
# Builds Lunex for the App Store and uploads it to TestFlight.
#
#   LUNEX_TEAM_ID=ABCDE12345 LUNEX_API_BASE_URL=https://api.example.uz/v1 ios/scripts/beta.sh
#
# Needs the app record uz.lunex.finance in App Store Connect and either Xcode signed in to an
# account of the team (Xcode → Settings → Accounts) or an App Store Connect API key in
# ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID (for CI). Optional: LUNEX_SENTRY_DSN,
# LUNEX_GOOGLE_CLIENT_ID. The build number is the number of commits, so each upload from a
# newer commit is accepted; set BUILD_NUMBER to override it.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${LUNEX_TEAM_ID:?Set LUNEX_TEAM_ID to the Apple developer team id}"
: "${LUNEX_API_BASE_URL:?Set LUNEX_API_BASE_URL to the production API, e.g. https://api.example.uz/v1}"

build_number="${BUILD_NUMBER:-$(git rev-list --count HEAD)}"
archive=build/Lunex.xcarchive
export_dir=build/export
options=build/ExportOptions.plist

auth=()
if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "${ASC_KEY_ID:?}" -authenticationKeyIssuerID "${ASC_ISSUER_ID:?}")
fi

xcodegen generate
rm -rf "$archive" "$export_dir"
mkdir -p build

echo "▸ Archiving build $build_number for $LUNEX_API_BASE_URL"
xcodebuild archive \
  -project Lunex.xcodeproj -scheme Lunex -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
  DEVELOPMENT_TEAM="$LUNEX_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$build_number" \
  LUNEX_API_BASE_URL="$LUNEX_API_BASE_URL" \
  LUNEX_SENTRY_DSN="${LUNEX_SENTRY_DSN:-}" \
  LUNEX_GOOGLE_CLIENT_ID="${LUNEX_GOOGLE_CLIENT_ID:-}"

# Straight to App Store Connect: the build appears in TestFlight once Apple has processed it.
cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$LUNEX_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "▸ Uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$archive" -exportPath "$export_dir" -exportOptionsPlist "$options" \
  -allowProvisioningUpdates ${auth[@]+"${auth[@]}"}

echo "✓ Build $build_number uploaded. Add it to the beta group in App Store Connect → TestFlight."
