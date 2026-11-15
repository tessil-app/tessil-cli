# Releasing

A release is a tag. Everything else is done by `.github/workflows/release.yml`.

```bash
# 1. Set the version in packages/cli/package.json, merge that to main.
# 2. Tag the merged commit and push the tag.
git tag v0.1.0 && git push origin v0.1.0
```

The workflow then:

1. Runs the tests and checks that the tag matches the package version.
2. Builds the program for macOS (Apple silicon and Intel), Linux (x64 and arm64) and Windows.
3. Tries the install script against what it built, and checks that a tampered download is refused.
4. Creates the GitHub release with the downloads, `SHA256SUMS` and `install.sh`.
5. Publishes `tessil` to npm, with provenance.
6. Updates the Homebrew formula in `tessil-app/homebrew-tap`.

Steps 5 and 6 and proper macOS signing each need secrets. Without them the step is skipped
with a warning and the rest still runs, so a release can be made before all of them exist.

## Secrets (repository settings, Secrets and variables, Actions)

| Secret | What it is | Needed for |
|---|---|---|
| `NPM_TOKEN` | An npm "granular access token" with read and write on the `tessil` package | npm |
| `HOMEBREW_TAP_TOKEN` | A GitHub fine-grained token with contents read and write on `tessil-app/homebrew-tap` | Homebrew |
| `APPLE_CERTIFICATE_P12` | The "Developer ID Application" certificate with its private key, exported as .p12 and base64-encoded | macOS signing |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the .p12 | macOS signing |
| `APPLE_SIGNING_IDENTITY` | The certificate's full name, e.g. `Developer ID Application: Name (TEAMID)` | macOS signing |
| `APPLE_ID` | The Apple account's email address | notarisation |
| `APPLE_TEAM_ID` | The ten-character team ID | notarisation |
| `APPLE_APP_PASSWORD` | An app-specific password from appleid.apple.com | notarisation |

The Homebrew tap is a separate repository, `tessil-app/homebrew-tap`, which must exist
(empty is fine) before the first release that updates it.

## Without the Apple secrets

The macOS programs get an ad-hoc signature. That is enough for Homebrew and for the install
script, neither of which marks the file as downloaded from the internet. A copy downloaded
in a browser is blocked by macOS until the user allows it by hand.

## Trying a change to the release

A pull request that touches the workflow, `install.sh`, `scripts/release/` or the package
file runs every build and the install-script check, and publishes nothing.
