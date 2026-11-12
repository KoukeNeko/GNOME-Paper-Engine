Release notes, used when a GitHub release is created.

- `release-notes/vX.Y.Z.md`: the GitHub release's notes for tag `vX.Y.Z`, in English and then in Traditional Chinese
  (a release has one body, so both are in the one file, the same sections in the same order).
  Written before the release is created.

GNOME Paper Engine is published only on GitHub. The `dev` pre-release is rebuilt by `.github/workflows/build.yml` on
every push to `main` and has no notes of its own; a numbered release is made by hand.

To release: set `version-name` in `extension/metadata.json`, add `release-notes/vX.Y.Z.md`, commit and push, then
build the package without a version suffix and create the release with it:

```bash
DEB_VERSION_SUFFIX= ./build-deb.sh
gh release create vX.Y.Z dist/gnome-paper-engine_X.Y.Z_all.deb --notes-file distribution/release-notes/vX.Y.Z.md
```

`gh release create` also creates the tag.
