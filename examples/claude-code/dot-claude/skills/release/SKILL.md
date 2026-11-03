---
description: Cut a release of this package. Bumps the version, updates the changelog, tags and pushes. Only run when the user explicitly asks for a release.
argument-hint: "[patch|minor|major]"
disable-model-invocation: true
---

Release a new $ARGUMENTS version of this package.

1. Confirm the working tree is clean with `git status`. Stop and report if it is not.
2. Run `npm test`. Stop and report if anything fails.
3. Run `npm version $ARGUMENTS` to bump the version and create the tag.
4. Add the changes since the last tag to the top of `CHANGELOG.md`, grouped as Added, Changed and Fixed.
5. Commit the changelog, then run `git push --follow-tags`.
6. Report the new version number and the tag.
