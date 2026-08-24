# Contributing

Thanks for your interest in `@vrsai/mcp`.

## Scope

This repository contains the official TypeScript client and optional local
stdio bridge for the vrsai MCP service. It does not contain, and will not
accept, server-side capability implementations, private infrastructure code,
or speculative protocol support ahead of what the remote service actually
implements. See [docs/architecture.md](./docs/architecture.md) for the exact
boundary.

## Prerequisites

- Node.js `>=22` to run the package (Node `24` is the recommended toolchain
  version — see [`.nvmrc`](./.nvmrc)).
- pnpm, exactly the version pinned in `package.json`'s `packageManager`
  field (currently `pnpm@11.23.0`).

## Setup

```sh
pnpm install
```

## Build, test, and check

```sh
pnpm run build        # compile src/ to dist/
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest
pnpm run check:boundary  # repository-boundary import scan
pnpm run lint         # biome ci
pnpm run format       # biome format --write
```

The canonical gate — the same one required in CI — is:

```sh
pnpm run check
```

This runs lint, typecheck, tests, the repository-boundary check, and package
verification (build, tarball inspection, `publint`, and
`@arethetypeswrong/cli`). A pull request must pass `pnpm run check` before
it can be merged.

### Running focused tests

```sh
pnpm exec vitest run src/spend-policy.test.ts
pnpm exec vitest run -t "some test name"
```

## Pull request expectations

- Include tests for behavior changes.
- Run `pnpm run check` locally before opening a PR.
- Update [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]` for any
  user-visible change.
- Treat `src/index.ts`'s exports as the public API surface — additions are
  usually fine, but removals or signature changes are breaking and must be
  called out explicitly in the PR description.
- Changes touching payment authorization, spend-policy enforcement, signer
  handling, trust/DID verification, or the payment journal receive
  heightened review; explain the security/economic-effect impact in the PR
  description.
- Justify any dependency addition or version change — this package
  deliberately pins protocol-sensitive dependencies (MCP, x402, `viem`);
  do not casually bump them.
- Normal PR CI is fully deterministic and must never require: a private
  repository, npm publishing credentials, Cloudflare credentials, a real
  wallet private key, or a paid network call. Do not add tests or fixtures
  that depend on any of these.
- Never include secrets, real credentials, or real private keys in code,
  tests, or fixtures.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Participation in this repository's spaces is subject to it.

## Releasing

Contributors do not need to think about releases — released versions are
cut by maintainers only. If you're a maintainer, see
[docs/releasing.md](./docs/releasing.md) for the full process; do not
duplicate that process here.

## Licensing

By submitting a contribution, you agree it is licensed under this
repository's [MIT License](./LICENSE). There is no separate CLA.
