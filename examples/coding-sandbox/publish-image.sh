#!/usr/bin/env bash
# Builds the sandbox image on this machine and pushes it to GitHub Container Registry, as an alternative to the
# Azure registry: free, and the app pulls it with no identity at all. The image holds the server and public tools,
# nothing secret, so it can be public; it must be, for the app to pull it without credentials.
#
#   examples/coding-sandbox/publish-image.sh            # ghcr.io/<you>/coding-sandbox:1
#   TAG=2 examples/coding-sandbox/publish-image.sh      # a new tag, so the app starts a new revision
#
# On an Apple silicon Mac the image is built for linux/amd64 under emulation, which takes a while, and about 3 GB
# is uploaded. Needs the GitHub CLI signed in with the write:packages scope.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OWNER=$(gh api user --jq .login)
IMAGE="ghcr.io/$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')/coding-sandbox:${TAG:-1}"  # ghcr names are lower case

if ! gh auth status 2>&1 | grep -q "write:packages"; then
  echo "The GitHub CLI's token cannot publish packages. Add the scope, then run this again:"
  echo "  gh auth refresh -h github.com -s write:packages"
  exit 1
fi
echo "Signing Docker in to ghcr.io as $OWNER"
gh auth token | docker login ghcr.io -u "$OWNER" --password-stdin

echo "Building and pushing $IMAGE (linux/amd64)"
docker buildx build --platform linux/amd64 -t "$IMAGE" --push "$HERE"

echo
echo "Pushed $IMAGE."
echo "A new package is private. Make it public once, so the app can pull it without credentials:"
echo "  https://github.com/users/$OWNER/packages/container/coding-sandbox/settings  (Danger Zone > Change visibility > Public)"
echo "Then point the sandbox at it:"
echo "  IMAGE=$IMAGE examples/coding-sandbox/setup-app.sh"
