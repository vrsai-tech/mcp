# AGENTS.md

Repository guidance for AI coding agents working on `@vrsai/mcp`. This is
public engineering policy, not a hidden prompt — keep it concrete and
repository-specific.

## What this repository is

`@vrsai/mcp` is the official TypeScript client and optional local stdio
bridge for the vrsai MCP service (`https://api.vrsai.tech/mcp`). It is a
buyer-side package: it signs payments, enforces spend limits, and verifies
provider trust. It does not implement server capabilities, pricing, or
commercial truth — see [docs/architecture.md](./docs/architecture.md).

## Public architecture boundary

- `src/index.ts` is the public API surface. Treat every export there as a
  compatibility commitment; removing or changing a signature is a breaking
  change.
- This package must never import from, or depend on, any private vrsai
  server/backend repository. `test/boundary-check.ts` enforces that no
  relative import escapes `src/`.
- Do not add speculative protocol support ahead of what the remote service
  actually implements. Documentation must describe the implementation that
  exists, not the other way around — never modify code just to make
  invented documentation true.

## Supported toolchain

- Node.js `>=22` for consumers; Node `24` is the repository/tooling default
  (see [`.nvmrc`](./.nvmrc)).
- pnpm, exactly the version pinned in `package.json`'s `packageManager`.
- Do not upgrade MCP (`@modelcontextprotocol/*`), x402 (`@x402/*`), `viem`,
  TypeScript, or pnpm without an explicit, separate justification — these
  are deliberately pinned.

## Canonical commands

```sh
pnpm install
pnpm run check       # canonical gate: lint, typecheck, tests, boundary, package verification
pnpm run test        # vitest
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsc -p tsconfig.build.json
```

A change is not done until `pnpm run check` passes.

## Safety rules

- Do not weaken spend-policy, trust/DID verification, payment-journal, or
  payment-recovery behavior. These are the core safety properties of this
  package — see [docs/security-model.md](./docs/security-model.md).
- Never make a live paid call, generate a real payment authorization, or use
  a real private key during normal development or testing. Tests use
  deterministic fixtures only.
- Never introduce a real secret, API token, or private key into source,
  tests, fixtures, or committed files.
- Do not publish to npm, push to GitHub, merge, tag, or create a release
  without explicit human instruction — those actions are outside an agent's
  default scope in this repository.
- Normal CI (`ci.yml`) never publishes anything and has no npm publishing
  capability of any kind.
- The release workflow (`.github/workflows/release.yml`) only *stages* a
  package to npm (`npm stage publish`) and only after a human has explicitly
  enabled the `NPM_TRUSTED_PUBLISHING_ENABLED` repository variable and
  configured the `npm-production` environment. It can never run
  `npm publish` or `npm stage approve` — see
  [docs/releasing.md](./docs/releasing.md).
- There is no direct `npm publish` path in this repository except the
  documented, human-only, interactive first-release bootstrap in
  [docs/releasing.md](./docs/releasing.md) — never automate or script that
  bootstrap.
- No automation, workflow, or agent may approve a staged npm release
  (`npm stage approve`); that requires a human with npm 2FA.
- Changes to `.github/workflows/release.yml`, `.github/workflows/ci.yml`, or
  anything else that affects the release/publish path are security-sensitive
  and warrant heightened review — treat them with the same care as
  spend-policy or trust-verification changes.
- Any change touching dependencies, payment logic, or the release/publish
  path requires a full, passing `pnpm run check` before it is considered
  complete.
- Any dependency addition or version change requires explicit justification
  in the PR description.
- Preserve semver discipline and update `CHANGELOG.md` under `[Unreleased]`
  for user-visible changes.
- The `vrsai-mcp` stdio bridge must keep stdout reserved exclusively for MCP
  protocol traffic; all diagnostics go to stderr.

See also [CONTRIBUTING.md](./CONTRIBUTING.md),
[docs/security-model.md](./docs/security-model.md), and
[docs/releasing.md](./docs/releasing.md).
