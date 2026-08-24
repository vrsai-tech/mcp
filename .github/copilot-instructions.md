# Copilot instructions

Follow [`AGENTS.md`](../AGENTS.md) — it is the canonical repository
guidance. See also [`CONTRIBUTING.md`](../CONTRIBUTING.md) and
[`docs/security-model.md`](../docs/security-model.md).

Essentials, repeated here only because they must hold on every change in
this repository:

- `src/index.ts` is the public API boundary; do not casually change or
  remove an export.
- The canonical gate is `pnpm run check`; a change is not done until it
  passes.
- Never weaken spend-policy, trust/DID verification, or payment-journal
  safety.
- Never make a live paid call or use a real private key/secret.
- Do not publish, push, merge, or tag without explicit human instruction.
