import { x402Client } from "@x402/core/client";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { EvmSigner } from "./signer.js";

/**
 * Builds an `x402Client` wired with the `exact` EVM scheme for `signer`,
 * scoped to `networks`. Scoping to an explicit allow-list (rather than the
 * library's wildcard `eip155:*` default) keeps buyer-side network exposure
 * aligned with {@link SpendPolicy.allowedNetworks}.
 */
export function createEvmPaymentClient(signer: EvmSigner, networks: readonly string[]): x402Client {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer, networks: networks as Network[] });
  return client;
}

/**
 * Signs a payment payload for exactly `requirement` — never re-derived from
 * the full `accepts[]` array, so there is no ambiguity between what the
 * caller's trust/spend checks verified and what gets signed.
 */
export async function signPaymentForRequirement(
  client: x402Client,
  paymentRequired: PaymentRequired,
  requirement: PaymentRequirements,
): Promise<PaymentPayload> {
  const narrowed: PaymentRequired = { ...paymentRequired, accepts: [requirement] };
  return client.createPaymentPayload(narrowed);
}
