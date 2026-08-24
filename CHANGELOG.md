# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Changed

- `SpendPolicy.expectedPublisherDid` now defaults to `DEFAULT_TRUST_DID`
  (`did:web:vrsai.tech`) when omitted, instead of silently skipping
  signed-offer verification. Pass `expectedPublisherDid: false` explicitly
  to opt out and disable signed-offer verification.
- `VrsaiClientOptions.remoteCaller` has been removed from the public API. It
  was only ever intended as an internal test seam for injecting a fake MCP
  transport, and its presence let callers bypass the real MCP connection
  path entirely.
- Errors thrown after a payment authorization has already been journaled are
  now consistently classified by `VrsaiPaymentError.economicEffect`:
  - transport/tool-call failures while resuming or submitting a payment are
    reported as `"unknown"` (the journal entry is retained so the call can
    be safely retried/resumed later);
  - a portable-receipt verification failure discovered *after* settlement
    has already been proven successful is now reported as `"occurred"`
    (`retryable: false`) instead of surfacing as an unrelated
    `VrsaiTrustError`, and the journal entry is cleared since the payment
    definitely went through.
- `resumeAuthorizedEntry` now returns the correct `amountPaid` (previously
  omitted) when resuming a previously journaled authorization.
- The journal claim for a request is now reliably released when the initial
  (unpaid) tool call itself throws, when spend-policy rejects the payment
  requirement, or when signing the payment authorization fails — previously
  a raw error would propagate without releasing the pending claim.
- `createPrivateKeySigner` now throws `VrsaiConfigurationError` instead of a
  generic `Error` for a malformed private key.
- `VrsaiPaymentError` now accepts an optional `cause` in its options,
  forwarded to the underlying `Error`.
- `Logger` is now exported from the package's public API (`src/index.ts`).
- `ensureDirectory` (used by the on-disk journal) now rejects a
  pre-existing, group- or world-accessible journal directory instead of
  silently reusing its permissions (POSIX only; skipped on Windows).
- The settlement response returned with a delivered payment is now
  cross-checked against the network that was actually authorized, and
  rejected as a malformed settlement if they disagree.
