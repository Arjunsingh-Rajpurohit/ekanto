#!/bin/sh
# Builds the signed Android app on this Mac and attaches it to a GitHub release, so the website's
# "Get the Hush app" button always downloads the newest one. The signing key never leaves this Mac.
#
#   ./release-apk.sh            → builds and publishes hush.apk as the latest release
set -eu

cd "$(dirname "$0")"
OWNER=$(gh api user --jq .login)
REPO=$(basename "$PWD")
export VITE_PUBLIC_URL="https://${OWNER}.github.io/${REPO}/"
export VITE_APP_URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/hush.apk"
# Optional backup relay, same values as the GitHub secrets (kept in a git-ignored file).
[ -f .env.turn ] && . ./.env.turn && export VITE_TURN_URLS VITE_TURN_USERNAME VITE_TURN_CREDENTIAL

npm test
npx tsc --noEmit -p .
npx vite build
npx cap sync android
(cd android && ./gradlew assembleRelease --no-daemon -q)
cp android/app/build/outputs/apk/release/app-release.apk hush.apk

VERSION="v$(date +%Y.%m.%d-%H%M)"
gh release create "$VERSION" hush.apk --title "Hush $VERSION" --notes "Install hush.apk on Android. Blocks screenshots and screen recording." --latest
echo "Published $VERSION — download: $VITE_APP_URL"
