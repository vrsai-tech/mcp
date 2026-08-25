<p align="center">
  <img
    src="https://api.vrsai.tech/brand/mark-512.png"
    width="56"
    height="56"
    alt="vrsai mark"
  />
</p>

# @vrsai/mcp

[![CI](https://github.com/vrsai-tech/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vrsai-tech/mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM only](https://img.shields.io/badge/module-ESM%20only-yellow)](https://nodejs.org/api/esm.html)
[![Code style: Biome](https://img.shields.io/badge/code%20style-biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-6E56CF)](https://modelcontextprotocol.io)
[![x402](https://img.shields.io/badge/x402-v2-0BA5A4)](https://www.x402.org/)

Official TypeScript client and optional local stdio bridge for vrsai.

Connect autonomous callers to the vrsai MCP service with native MCP and x402
payment support, explicit buyer-side spending controls, provider trust
verification, and crash-safe payment recovery.

Machine-native capabilities with explicit contracts and machine-readable commerce.

This package speaks native MCP (`2026-07-28`) and x402 v2 directly against the
remote vrsai MCP service (`https://api.vrsai.tech/mcp`). It does not
implement, cache, or duplicate the server's product catalog, pricing,
schemas, or commercial truth — that remains authoritative on the server. This
package only adds the buyer-side concerns an autonomous caller needs on top
of the wire protocol: spend limits, signed-offer/trust verification, and
crash-safe payment recovery.

`@vrsai/mcp` has no source dependency on any private vrsai server
implementation. It talks to the remote service exclusively over HTTPS, the
same way any other external MCP client would — see
[`test/boundary-check.ts`](./test/boundary-check.ts).

## Status

`0.1.0` is initial-development, pre-release software (see
[Semantic Versioning 2.0.0](https://semver.org/#spec-item-4)): the public API
may still change between `0.x` releases. See [`docs/releasing.md`](./docs/releasing.md)
for the release plan.

## Installation

```sh
npm install @vrsai/mcp
```

Requires Node.js `>=22`.

## Direct remote MCP

Any MCP host that speaks Streamable HTTP can connect directly to the
canonical remote endpoint without this package:

```
https://api.vrsai.tech/mcp
```

`@vrsai/mcp` exists for callers that want buyer-side spend control, provider
trust verification, and crash-safe payment recovery handled for them, and/or
that need a local stdio bridge.

## Quick start

```ts
import { createVrsaiClient, createPrivateKeySigner } from "@vrsai/mcp";

const client = createVrsaiClient({
  endpointUrl: "https://api.vrsai.tech/mcp",
  signer: createPrivateKeySigner(process.env.SIGNER_PRIVATE_KEY as `0x${string}`),
  spendPolicy: {
    allowedOrigin: "https://api.vrsai.tech",
    allowedNetworks: ["eip155:8453"],
    allowedAssets: ["0x..."], // USDC (or other) contract address(es)
    maxAmountPerAuthorization: 1_000_000n, // atomic units; never floating point
    maxSessionSpend: 10_000_000n, // optional cumulative cap
    expectedPublisherDid: "did:web:vrsai.tech", // strongly recommended; this is the default
  },
});

const tools = await client.listTools();
const outcome = await client.call("some-capability", { input: "..." });
console.log(outcome.structuredContent);

await client.close();
```

## Programmatic TypeScript client

`createVrsaiClient()` returns a `VrsaiClient` with three methods:
`listTools()`, `call(toolName, args?)`, and `close()`.

### Discovery-only mode

`signer` and `spendPolicy` are optional, but only together: provide both or
neither. Omitting both gives a discovery-only client — `listTools()` and any
free tool call still work with no wallet configured at all. Calling a tool
that turns out to require payment throws `VrsaiConfigurationError` instead of
failing silently or prompting for credentials mid-call.

### Client options

| Option | Required | Description |
| --- | --- | --- |
| `endpointUrl` | yes | Absolute `https://` URL of the remote vrsai MCP endpoint. |
| `signer` | no* | Buyer signer. See [Signer model](#signer-model). |
| `spendPolicy` | no* | See [Buyer-side spending controls](#buyer-side-spending-controls). |
| `journal` | no | Overrides the default on-disk crash-safe journal (e.g. for tests, or a directory scoped per tenant). |
| `offerTrustResolver` | no | Overrides `did:web` resolution used for signed-offer verification. |
| `logger` | no | Overrides the default stderr logger. |
| `fetchImplementation` | no | Overrides the `fetch` implementation used for network calls. |

\* `signer` and `spendPolicy` must be provided together, or both omitted.

## Local stdio bridge

For MCP hosts that only speak local stdio (e.g. desktop AI assistants),
`@vrsai/mcp` ships a `vrsai-mcp` binary that proxies `tools/list` and
`tools/call` to the remote service, handling payment transparently:

```sh
npx @vrsai/mcp
```

The bridge is configured entirely through environment variables — see
[Configuration](#configuration). It reserves stdout exclusively for MCP wire
traffic; all diagnostics go to stderr, so nothing ever corrupts the protocol
stream.

## Payment flow

When a tool call requires payment, the server responds with an x402
`PaymentRequired` challenge. The client:

1. verifies the challenge carries a signed offer from the expected
   `did:web:` publisher identity, when `expectedPublisherDid` is configured
   (see [Trust model](#trust-model));
2. validates the payment requirement against the configured `SpendPolicy`
   (see [Buyer-side spending controls](#buyer-side-spending-controls)) —
   nothing is ever signed before this passes;
3. signs and submits the payment authorization;
4. retries the call with the payment attached, and requires structurally
   valid settlement evidence before treating the result as delivered.

A successful paid call never resolves on unproven "success" — see
[docs/security-model.md](./docs/security-model.md).

## Buyer-side spending controls

Every payment is bounded by a caller-supplied `SpendPolicy`. There is no
default-allow behavior — a caller must deliberately configure
`allowedNetworks` and `allowedAssets`. Any requirement outside policy is
rejected with `VrsaiSpendPolicyError` before anything is signed.

| Field | Description |
| --- | --- |
| `allowedOrigin` | Exact expected origin of the remote resource (e.g. `"https://api.vrsai.tech"`). |
| `allowedNetworks` | CAIP-2 network identifiers the client will pay on (e.g. `"eip155:8453"` for Base mainnet). |
| `allowedAssets` | Asset contract addresses the client will pay with. |
| `maxAmountPerAuthorization` | Maximum atomic amount for a single payment authorization. |
| `maxSessionSpend` | Optional cumulative cap across every authorization for one client instance. |
| `allowedPayTo` | Optional allow-list of recipient (`payTo`) addresses. |
| `expectedPublisherDid` | Expected `did:web:` publisher identity for signed-offer verification. Defaults to `did:web:vrsai.tech` when omitted; pass `false` explicitly to opt out and disable signed-offer verification. |

Amounts are always atomic integer `bigint` values — this package never uses
floating-point arithmetic for money.

## Trust model

`expectedPublisherDid` defaults to `did:web:vrsai.tech` when omitted from
`SpendPolicy`, and every payment requirement must then carry a signed offer
whose publisher identity resolves to that `did:web:` value. The client
resolves the publisher's `did:web` document over HTTPS, requires the signing
key to be an authorized `assertionMethod`, and never follows redirects during
resolution. Pass `expectedPublisherDid: false` explicitly to opt out and
skip signed-offer verification entirely. See
[docs/security-model.md](./docs/security-model.md) for the full trust
boundary.

## Crash-safe payment recovery

A crash-safe, on-disk journal persists in-flight payment authorizations. If a
process crashes between "payment signed" and "server confirmed delivery," a
retry resumes the *same* authorization instead of risking a duplicate charge.
An authorization may only be resumed by the same signer that created it.
Journal entries never contain private key material — only an
already-signed payment payload.

The default journal location is `~/.vrsai/mcp/journal`. Provide a custom
`journal` (e.g. `createFileJournal(directory)` or `createInMemoryJournal()`)
to override it.

## Signer model

`EvmSigner` is a minimal two-member interface: an `address` and
`signTypedData`. `createPrivateKeySigner` is a convenience for a local hex
private key — held only in memory for the process lifetime, and never
written to the journal, logs, or any other persisted state. It is a
development/local convenience, not the recommended production custody model.

Production callers should provide any `EvmSigner`-compatible adapter backed
by a hardware wallet, HSM, or remote KMS/signing service — the client never
needs to see raw key material.

Never commit or share a real private key. Examples in this document use
placeholder values only.

## Configuration

Environment variables consumed by the `vrsai-mcp` stdio bridge:

| Variable | Required | Description |
| --- | --- | --- |
| `VRSAI_MCP_ENDPOINT` | no | Remote MCP endpoint URL. Defaults to `https://api.vrsai.tech/mcp`. |
| `VRSAI_MCP_SIGNER_PRIVATE_KEY` | no | `0x`-prefixed EVM private key used to sign payments. Never logged or journaled. Omit for discovery-only mode. |
| `VRSAI_MCP_ALLOWED_NETWORKS` | no | Comma-separated CAIP-2 network IDs. Defaults to `eip155:8453` (Base mainnet). |
| `VRSAI_MCP_ALLOWED_ASSETS` | yes, if `VRSAI_MCP_SIGNER_PRIVATE_KEY` is set | Comma-separated allow-listed asset (token contract) addresses. No default. |
| `VRSAI_MCP_MAX_AMOUNT_PER_AUTHORIZATION` | yes, if `VRSAI_MCP_SIGNER_PRIVATE_KEY` is set | Positive integer atomic amount ceiling for any single payment. |
| `VRSAI_MCP_MAX_SESSION_SPEND` | no | Optional cumulative cap across the process lifetime. |
| `VRSAI_MCP_ALLOWED_PAY_TO` | no | Optional comma-separated allow-list of recipient addresses. |
| `VRSAI_MCP_TRUST_DID` | no | Expected `did:web:` publisher identity for signed-offer verification. Defaults to `did:web:vrsai.tech`. |

Once `VRSAI_MCP_SIGNER_PRIVATE_KEY` is set, `VRSAI_MCP_ALLOWED_ASSETS` and
`VRSAI_MCP_MAX_AMOUNT_PER_AUTHORIZATION` become required — the bridge fails
closed rather than falling back to a default-allow spend policy.

## Error model

`client.call()` throws a typed error on anything other than success. Every
error this package itself throws extends `VrsaiMcpError` and carries a
stable, machine-readable `code` so callers can branch on `instanceof` or
`error.code` rather than parsing free-text messages. (This guarantee covers
errors raised by `@vrsai/mcp`'s own code; a caller-supplied override such as
a custom `journal`, `offerTrustResolver`, `logger`, or `fetchImplementation`
implementation could in principle throw something else.)

| Error | Code | Meaning |
| --- | --- | --- |
| `VrsaiSpendPolicyError` | `vrsai/spend_policy_error` | The payment requirement is outside the configured `SpendPolicy`, or payment was required but no signer/policy was configured. Nothing was signed. |
| `VrsaiTrustError` | `vrsai/trust_error` | The signed offer failed `did:web` verification, or none was present, while `expectedPublisherDid` was in effect (the default, unless explicitly set to `false`). |
| `VrsaiPaymentError` | `vrsai/payment_error` | Carries `economicEffect: "occurred" \| "not_occurred" \| "unknown"` and `retryable`. `"unknown"` means the outcome could not be proven — the journal entry is retained and a retry resumes the same authorization rather than risking a duplicate. |
| `VrsaiToolError` | `vrsai/tool_error` | The remote tool returned an application-level error. No payment was involved. |
| `VrsaiProtocolError` | `vrsai/protocol_error` | The remote endpoint's wire response did not match the expected native MCP/x402 contract. |
| `VrsaiJournalError` | `vrsai/journal_error` | The local on-disk payment journal is unavailable, corrupt, or unsafe to use. |
| `VrsaiConfigurationError` | `vrsai/configuration_error` | The client was asked to do something it is not configured for (e.g. a paid call on a discovery-only client). |

## Compatibility

- MCP protocol revision: `2026-07-28`.
- x402 protocol: v2.
- Node.js: `>=22` (see [`package.json`](./package.json) `engines.node`).
- Module system: ESM only (`"type": "module"`).

## Security

`@vrsai/mcp` signs payment authorizations on the caller's behalf. See
[SECURITY.md](./SECURITY.md) to report a vulnerability, and
[docs/security-model.md](./docs/security-model.md) for how the client is
designed: trust boundaries, spend authorization, journal/replay safety, and
explicit non-goals.

Buyer-side limits configured through `SpendPolicy` are defense-in-depth, not
a substitute for wallet custody and key security.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run check:boundary
pnpm run build
```

`pnpm check` runs the full local gate (lint, typecheck, tests, repository
boundary, and package verification) and is the same gate required in CI.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to propose changes,
[GOVERNANCE.md](./GOVERNANCE.md) for how the project is maintained,
[docs/architecture.md](./docs/architecture.md) for the public architecture
boundary, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community
standards.

## License

[MIT](./LICENSE)
