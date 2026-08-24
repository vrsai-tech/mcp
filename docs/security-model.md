# Security Model

This document describes how `@vrsai/mcp` is designed: its trust boundaries,
what it protects, and its explicit non-goals. For how to report a
vulnerability, see [SECURITY.md](../SECURITY.md).

This document covers only the public client-side architecture. It does not
describe server-side or infrastructure internals, which are out of scope for
this repository.

## Assets being protected

- The buyer's private key / signing capability (never leaves the caller's
  process or configured signer).
- The buyer's funds, bounded by a configured `SpendPolicy`.
- The integrity of the local payment journal (preventing duplicate
  authorizations after a crash).
- The stdio wire protocol (preventing diagnostic output from corrupting MCP
  traffic).

## Trust boundaries

### Remote server boundary

The client treats the remote MCP endpoint as an untrusted network peer for
transport purposes (bounded response sizes and timeouts on every fetch), but
as the authoritative source for capability discovery, pricing, and
commercial terms. A payment requirement from the server is never accepted
purely because the server sent it — it must also pass the buyer's
`SpendPolicy` and, when configured, publisher trust verification.

### Signer boundary

The client never generates, stores, or requires custody of a private key.
`EvmSigner` is a two-member interface (`address`, `signTypedData`); any
implementation satisfying that shape is accepted, so custody can be a local
key, a hardware wallet, an HSM, or a remote KMS. `createPrivateKeySigner` is
a local/development convenience only — it is not the recommended production
custody architecture.

### Local filesystem / journal boundary

The payment journal persists only already-signed payment payloads, never key
material. Journal files are created with restrictive permissions, opened
with `O_NOFOLLOW` (refusing symlinks), read with a bounded size limit, and
written via atomic create-then-rename so a crash can never leave a torn or
ambiguous entry.

### MCP / x402 boundary

The client pins the exact MCP protocol revision it speaks (no silent
downgrade to a legacy handshake) and validates that a "delivered" result
following a paid retry carries structurally valid settlement evidence. A
successful paid call is never inferred from the absence of an error alone.

## Economic side effects and spend authorization

Every payment requirement is validated against the caller's `SpendPolicy`
before anything is signed: allowed origin, allowed networks, allowed assets,
allowed `payTo` (when configured), per-authorization ceiling, and cumulative
session budget. There is no default-allow behavior — a caller must
deliberately configure `allowedNetworks` and `allowedAssets`. Any requirement
outside policy is rejected with `VrsaiSpendPolicyError` before signing.

Session-budget reservation and policy validation happen atomically (in one
synchronous step) so two concurrent calls can never both observe a budget as
available for amounts that, combined, would exceed it.

## Provider trust

When `expectedPublisherDid` is configured (the default,
`did:web:vrsai.tech`), every payment requirement must carry a signed offer
whose publisher identity resolves to that `did:web` value. Resolution:

- only ever fetches over HTTPS;
- never follows redirects;
- requires the signing key to be an authorized `assertionMethod` in the
  publisher's own `did:web` document;
- caches successful resolutions for a bounded TTL, but never falls back to a
  stale cache entry after a resolution failure.

## Response limits and timeouts

Every network fetch this package makes — both the MCP transport and
`did:web` resolution — is wrapped with a hard response-size cap and timeout.
A misbehaving or hostile endpoint cannot exhaust memory or hang the calling
process indefinitely.

## Crash and retry safety

**The central invariant: an unknown or nonterminal payment outcome is never
treated as success, and never results in a blind replacement
authorization.**

If a process crashes (or the network fails) after a payment is signed but
before delivery is confirmed, the on-disk journal retains the exact
authorization. A retry resumes that same authorization — identified by a
deterministic fingerprint of the resource, tool, and arguments — rather than
creating a second, distinct one. An authorization may only be resumed by the
signer that created it; a mismatched signer is refused rather than silently
reused.

`VrsaiPaymentError.economicEffect` states what is safely knowable:
`"not_occurred"` (rejected before any authorization existed), `"unknown"`
(an authorization may have been submitted but the outcome could not be
confirmed — the journal entry is retained), or the call resolves normally
for a delivered result.

## stdout / stderr separation

The `vrsai-mcp` stdio bridge reserves stdout exclusively for MCP protocol
traffic. All logging and diagnostics go to stderr, so nothing this package
writes can corrupt or inject into the wire stream a host is parsing from
stdout.

## Assumptions

- The caller's Node.js process and filesystem are themselves not
  compromised (this package cannot protect key material from a compromised
  host process).
- The configured signer correctly refuses to sign anything the caller did
  not intend.
- DNS and TLS for `https://api.vrsai.tech` and any configured `did:web` host
  are trustworthy at the network layer this package runs on.

## Non-goals

- This package is not a wallet, and does not provide custody-grade key
  protection on its own — `SpendPolicy` limits are defense-in-depth, not a
  substitute for wallet security.
- This package does not implement or verify server-side settlement /
  facilitator logic; it only validates the evidence the server returns.
- This package makes no "secure by design" absolute guarantee. It documents
  the controls that exist, not a certification.
