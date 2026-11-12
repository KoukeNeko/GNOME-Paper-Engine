Release notes, read by the release workflow.

- `release-notes/vX.Y.Z.md`: the GitHub release's notes for tag `vX.Y.Z`, in English and then in Traditional Chinese
  (a release has one body, so both are in the one file, the same sections in the same order).
  Without one, the release falls back to notes generated from the commits.
  Written before the tag is pushed; a run again on a release that exists puts the file's notes on it as well.

GNOME Paper Engine is published only on GitHub. The `dev` pre-release is rebuilt by `.github/workflows/build.yml` on
every push to `main` and has no notes of its own; a numbered release is made by `.github/workflows/release.yml`.

To release: set `version-name` in `extension/metadata.json`, add `release-notes/vX.Y.Z.md`, commit and push, then
push the tag `vX.Y.Z`, or create the release with
`gh release create vX.Y.Z --notes-file distribution/release-notes/vX.Y.Z.md`: it creates the tag. Either way the
workflow checks that the tag matches `version-name`, runs the tests, builds the package and attaches
`gnome-paper-engine_X.Y.Z_all.deb` to that release.
