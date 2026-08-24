# Security Policy

`@vrsai/mcp` signs payment authorizations on the caller's behalf. Treat any
report that touches payment/spend behavior as sensitive and report it
privately rather than through a public issue.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report privately using [GitHub Private Vulnerability
Reporting](https://github.com/vrsai-tech/mcp/security/advisories/new) on this
repository ("Security" tab → "Report a vulnerability"). This is the primary
and preferred channel.

If GitHub is not usable for your report, email **security@vrsai.tech** as a
fallback private channel.

If private vulnerability reporting is not yet enabled on this repository,
open a regular issue asking a maintainer to enable it — do not include
vulnerability details in that issue.

## What to report

This package's sensitive surface includes:

- payment authorization / signing logic;
- spend-policy bypass (network, asset, `payTo`, or amount-limit enforcement);
- signer confusion or misuse;
- `did:web` trust/publisher verification;
- payment journal correctness (replay, duplicate authorization, resumption
  by the wrong signer);
- network/asset/`payTo` validation gaps;
- SSRF or other network-boundary issues (e.g. in `did:web` resolution or the
  MCP transport);
- dependency / supply-chain issues affecting this package;
- stdio protocol injection (stdout/stderr separation);
- settlement/payment-response evidence handling.

General bugs with no security impact should go through normal
[GitHub Issues](https://github.com/vrsai-tech/mcp/issues) — see
[SUPPORT.md](./SUPPORT.md).

## What NOT to include in a report

Never include, in a report or in any attached reproduction:

- real private keys or seed phrases;
- live wallet credentials;
- a reusable signed payment authorization;
- any other secret or credential;
- sensitive payment-journal contents beyond the minimum sanitized
  reproduction needed to demonstrate the issue.

If a report is submitted with any of the above, ask the reporter to rotate
the exposed credential immediately; treat it as compromised regardless of
the outcome of the report.

## Supported versions

This project is currently in initial development (`0.x`). Until a `1.0.0`
release, only the latest published `0.x` version is supported with security
fixes.

## No independent audit

This package has not undergone an independent third-party security audit.
Its payment, trust, and spend-policy controls are internally reviewed and
tested, but no external audit claim is made.

## Disclosure

We do not currently commit to a fixed disclosure timeline or SLA. A
maintainer will acknowledge a report and work with the reporter on a fix and
coordinated disclosure appropriate to severity.
