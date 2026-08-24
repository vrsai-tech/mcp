# Releasing

This document describes the intended release architecture and procedures.
Sections below are explicitly marked **documented (not yet executed)** where
they describe steps that require a human, a public repository, or GitHub/npm
state that does not exist at the time of writing. `.github/workflows/release.yml`
exists in this repository, but every gate described below (repository
visibility, branch/tag rulesets, GitHub environments, repository variables,
Trusted Publisher registration, and the first npm bootstrap) is a manual,
human action performed outside of any workflow.

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/).
`0.x` releases are initial development: breaking changes may occur in a
`0.x.0` minor release. Once `1.0.0` ships, normal semver rules apply.

Changes are recorded in [CHANGELOG.md](../CHANGELOG.md) following
[Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/).

## The four release artifacts

These four things are related but distinct, and a release is not "done"
until all four exist and agree on the same version:

1. **Git tag** (`vX.Y.Z`) — an immutable pointer at a commit on `main`.
   Created by a human (`git tag -s` + `git push origin <tag>`), never by a
   workflow. This is the only thing that triggers `release.yml`.
2. **npm staged package** — produced by `release.yml`'s `stage` job via
   `npm stage publish`. Visible only to authorized maintainers via
   `npm stage list` / `npm stage view` until a human approves it.
3. **npm published version** — created only by a human running
   `npm stage approve` (or, for the very first release only, a manual
   `npm publish`, see [Bootstrap](#first-release--bootstrap)). This is the
   only step that makes the version installable by the public.
4. **GitHub Release** — a human-authored release note object attached to
   the tag, created manually in the GitHub UI or via `gh release create`
   after the npm version is already public. GitHub Release **events never
   trigger anything** in this repository — publishing is tag-driven, not
   Release-driven, so there is no risk of a release note edit re-triggering
   a publish.

## Release ordering

```
1.  Release PR opened (version bump + CHANGELOG.md entry)
2.  ci.yml runs and passes on the PR
3.  PR reviewed and merged to main
4.  Human creates a signed tag `vX.Y.Z` on the merged commit
5.  Human pushes the tag (git push origin vX.Y.Z)
6.  release.yml triggers on the tag push
7.  verify job: validates tag syntax + tag == package.json version
8.  verify job: confirms the tagged commit is reachable from origin/main
9.  verify job: runs `pnpm run check` on the exact tagged commit
10. verify job: confirms the version is not already public on npm
11. verify job: builds the tarball once, fully qualifies those exact bytes
    (allowlist, isolated install smoke, CLI stdio handshake, publint, ATTW),
    hashes it, and uploads it as an artifact
12. stage job (gated on the NPM_TRUSTED_PUBLISHING_ENABLED repository
    variable and the npm-production environment): downloads the exact
    artifact, re-verifies its SHA-256, and runs `npm stage publish`
13. Human runs `npm stage list` / `npm stage view` to inspect the staged
    package
14. Human downloads and re-verifies the staged package independently
15. Human runs `npm stage approve` with npm 2FA — this is the only action
    that makes the version public
16. Human confirms the version is public and carries an npm provenance
    attestation
17. Human drafts a GitHub Release against the tag
18. Human publishes the GitHub Release
19. Human enables GitHub Immutable Releases for the release (if not already
    the repository default)
20. Human confirms the tag ruleset still prevents deletion/force-update of
    `vX.Y.Z`
```

Nothing in `release.yml` performs steps 13–20. Those are exclusively human,
off-workflow actions using local `npm`/`gh` CLIs with the maintainer's own
2FA-protected credentials.

## GitHub repository protections (documented, not yet configured)

These are GitHub repository settings, not files in this repository, and are
**not configured by any change described here**:

- **Tag protection ruleset for `v*`**: prevents deletion and force-update
  (non-fast-forward push) of any tag matching `v*`, so a pushed release tag
  can never be silently moved to point at a different commit. Configured
  under Repository Settings → Tags → Rulesets.
- **GitHub Immutable Releases**: once enabled (repository- or
  organization-level setting), a published GitHub Release's assets and tag
  association can no longer be altered after publication. This should be
  enabled before the first public GitHub Release is published, and is a
  one-time, human, UI-driven action.
- **`npm-production` environment**: a GitHub Environment that must exist
  before the `stage` job in `release.yml` can run (the job's
  `environment: npm-production` key references it). This environment should
  have required reviewers and/or a deployment branch/tag policy restricting
  it to `v*` tags, configured manually in Repository Settings →
  Environments.
- **`NPM_TRUSTED_PUBLISHING_ENABLED` repository variable**: a plain
  (non-secret) repository variable that gates the `stage` job with
  `if: vars.NPM_TRUSTED_PUBLISHING_ENABLED == 'true'`. It does not exist by
  default, so the `stage` job is a no-op on every tag push until a human
  explicitly sets it — and only after npm Trusted Publisher configuration
  below is already complete.

## First release / bootstrap (documented, not yet executed)

`npm` Trusted Publishing (OIDC) and `npm` staged publishing both require the
package to already exist on the registry — neither can create a brand-new
package. This means the very first `0.1.0` release of `@vrsai/mcp` requires
a one-time, human-controlled, interactive publish step that bypasses the
`stage` job's OIDC path (which cannot run yet — `NPM_TRUSTED_PUBLISHING_ENABLED`
isn't set, and a Trusted Publisher can't be configured for a package that
doesn't exist on the registry yet). It still goes *through* `release.yml`'s
`verify` job: the artifact a human publishes is the exact tarball that job
produces and qualifies, never a separately/locally rebuilt one. None of the
following steps have been performed as part of any repository-hardening
work in this repository:

1. Confirm the repository is public.
2. Confirm the public source has been reviewed end-to-end (no private
   backend imports, no secrets, no invented protocol support — see
   [AGENTS.md](../AGENTS.md)).
3. Confirm `package.json`'s `version` is `0.1.0` and `CHANGELOG.md` has a
   dated `## [0.1.0]` entry.
4. Confirm the maintainer's npm account has 2FA enabled for both
   authorization and publishing, and confirm ownership/access to the
   `@vrsai` npm scope/organization.
5. Merge the `0.1.0` release commit to `main` (normal PR + `ci.yml` review).
6. Create and push a signed, annotated tag on that commit:
   `git tag -s v0.1.0 -m "v0.1.0" && git push origin v0.1.0`. The tag comes
   first, exactly as it does for every later release — this bootstrap never
   backdates the tag after publishing.
7. `release.yml`'s `verify` job runs automatically on the tag push: runs
   `pnpm run check`, confirms `0.1.0` is not already public, builds the one
   exact candidate tarball, and fully qualifies it (allowlist, install
   smoke, CLI handshake, publint, ATTW).
8. `stage` is skipped (`NPM_TRUSTED_PUBLISHING_ENABLED` is not yet `true`):
   this is expected and correct for the bootstrap, not a failure.
9. A human downloads the exact `npm-release-candidate` workflow artifact
   (the `.tgz` + `SHA256SUMS`) from that `verify` run in the Actions UI.
10. The human independently verifies the downloaded tarball's SHA-256
    against the workflow's `SHA256SUMS`, and inspects its contents (e.g.
    `tar -tzf` or by re-running
    [`test/pack-inspect.ts`](../test/pack-inspect.ts) against it locally).
11. The human runs
    `npm publish ./EXACT-WORKFLOW-TARBALL.tgz --access public`, using that
    exact downloaded tarball path (never a freshly-run local `npm pack`),
    completing the interactive 2FA OTP prompt.
12. Confirm `npm view @vrsai/mcp version` returns `0.1.0`.
13. Draft and publish a GitHub Release for `v0.1.0`.
14. Only now proceed to [Trusted Publisher configuration](#trusted-publisher-configuration-checklist-documented-not-yet-configured)
    for all subsequent releases, which use the normal staged OIDC path.

This bootstrap is never performed by an AI agent, CI, or `release.yml` — it
is manual, interactive, and requires a real npm account with real 2FA. The
one artifact it publishes is always the workflow-verified candidate, never
a tarball rebuilt outside `release.yml`, so the first release has the same
artifact lineage as every release that follows it.

## Trusted Publisher configuration checklist (documented, not yet configured)

Only after the `0.1.0` bootstrap above is complete should a human configure
npm Trusted Publishing:

- Provider: GitHub Actions.
- Organization/user: `vrsai-tech`.
- Repository: `mcp`.
- Workflow: `release.yml`.
- Environment: `npm-production`.
- Allowed action: staged publish only (`npm stage publish`) — the Trusted
  Publisher must never be granted a direct/unstaged publish capability.
- npm account: 2FA required for authorization and publishing; long-lived
  publish tokens (`NPM_TOKEN`) disallowed and not present anywhere in this
  repository or its Actions configuration.
- Only after all of the above is verified should a human set the
  `NPM_TRUSTED_PUBLISHING_ENABLED=true` repository variable. Setting this
  variable before Trusted Publisher configuration is complete would let the
  `stage` job attempt to run with no valid OIDC trust relationship, which
  fails safely (the job errors), but the ordering above should still be
  followed so the first invocation is not a debugging exercise.

## Normal release process (post-bootstrap)

Once `0.1.0` is public and the Trusted Publisher is configured:

1. Open a release PR: bump `package.json`'s `version`, add a dated
   `## [X.Y.Z]` section to `CHANGELOG.md` under `[Unreleased]`.
2. Wait for `ci.yml` to pass on the PR.
3. Get the PR reviewed and merged to `main`.
4. Locally, fetch and check out the merged commit on `main`.
5. Create a signed, annotated tag: `git tag -s vX.Y.Z -m "vX.Y.Z"`.
6. Push the tag: `git push origin vX.Y.Z`.
7. `release.yml`'s `verify` job runs automatically; watch it in the Actions
   UI.
8. Confirm `verify` passed: canonical gate green, version not already
   public, tarball built and hashed, dist-tag resolved correctly.
9. Confirm `stage` ran (only fires if `NPM_TRUSTED_PUBLISHING_ENABLED` is
   `true`) and staged the artifact via OIDC.
10. Run `npm stage list @vrsai/mcp` to see the pending staged version and
    obtain its `<stage-id>`.
11. Run `npm stage view <stage-id>` to inspect its metadata.
12. Run `npm stage download <stage-id>` to download the staged tarball, and
    independently verify its SHA-256 against the `SHA256SUMS` produced by
    the `verify` job (visible in the workflow run's artifacts).
13. Confirm no unexpected files are present (re-run
    [`test/pack-inspect.ts`](../test/pack-inspect.ts) locally against the
    downloaded tarball if in doubt).
14. Run `npm stage approve <stage-id>`, completing the 2FA prompt. This is
    the only action in the entire pipeline that makes the version public.
    (The current npm CLI's `stage` subcommands operate on a `<stage-id>`
    obtained from `npm stage list`/`npm stage view` — not on a
    `<package>@<version>` spec.)
15. Confirm `npm view @vrsai/mcp version` now returns `X.Y.Z`.
16. Confirm the published version carries a provenance attestation
    (`npm view @vrsai/mcp@X.Y.Z --json` should show a `dist.attestations`
    or provenance-related field, generated automatically by Trusted
    Publishing — never set manually via `publishConfig.provenance`).
17. Draft a GitHub Release against tag `vX.Y.Z` with release notes derived
    from the `CHANGELOG.md` entry.
18. Publish the GitHub Release.
19. Confirm the release becomes immutable (GitHub Immutable Releases, if
    enabled) and that the `v*` tag ruleset still rejects deletion/
    force-update.
20. Announce the release if applicable (outside the scope of this
    document).

## Rollback / bad-release policy

npm versions are immutable once approved (`npm stage approve` /
`npm publish`) — a bad release is **never** overwritten, unpublished after
the npm 24-hour unpublish window, or re-tagged to point at a different
commit. Tags are equally immutable once pushed (enforced by the `v*` tag
ruleset once configured). If a released version turns out to be broken:

- fix forward with a new patch version (e.g. a broken `0.1.4` is fixed by
  releasing `0.1.5`, going through the full normal release process above);
- never rewrite, force-push, or delete the `v0.1.4` tag;
- never attempt to republish over `0.1.4`;
- optionally, run `npm deprecate @vrsai/mcp@0.1.4 "<reason, see 0.1.5>"` to
  warn existing installers, once a fixed version is public;
- optionally adjust the `latest` dist-tag to point at the fixed version if
  it was moved backward for any reason.

