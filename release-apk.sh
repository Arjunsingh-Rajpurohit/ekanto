#!/bin/sh
# Builds the signed Android app on this Mac and attaches it to a GitHub release, so the website's
# "Get the Ekanto app" button always downloads the newest one. The signing key never leaves this Mac.
#
#   ./release-apk.sh            → builds and publishes ekanto.apk as the latest release
set -eu

cd "$(dirname "$0")"
OWNER=$(gh api user --jq .login)
REPO=$(gh repo view --json name -q .name)
export VITE_PUBLIC_URL="https://${OWNER}.github.io/${REPO}/"
export VITE_APP_URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/ekanto.apk"
# Optional backup relay, same values as the GitHub secrets (kept in a git-ignored file).
[ -f .env.turn ] && . ./.env.turn && export VITE_TURN_URLS VITE_TURN_USERNAME VITE_TURN_CREDENTIAL

npm test
npx tsc --noEmit -p .
npx vite build
npx cap sync android
(cd android && ./gradlew assembleRelease --no-daemon -q)
cp android/app/build/outputs/apk/release/app-release.apk ekanto.apk

VERSION="v$(date +%Y.%m.%d-%H%M)"
gh release create "$VERSION" ekanto.apk --title "Ekanto $VERSION" --notes "Install ekanto.apk on Android. Blocks screenshots and screen recording." --latest
echo "Published $VERSION — download: $VITE_APP_URL"
