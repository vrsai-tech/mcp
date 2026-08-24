import { privateKeyToAccount } from "viem/accounts";
import { VrsaiConfigurationError } from "./errors.js";

/**
 * Minimal buyer-side EVM signer contract. Deliberately narrower than a full
 * viem `Account` — only what the `exact` EVM scheme's base flow requires
 * (see `@x402/evm`'s `ExactEvmScheme`). Any object satisfying this shape
 * works, so callers may bring a hardware wallet, remote-signing service, or
 * any other custody model instead of an in-process private key.
 */
export interface EvmSigner {
  readonly address: `0x${string}`;
  signTypedData(parameters: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Convenience constructor for a private-key-backed signer. `privateKey` is
 * held only in memory for the lifetime of the process and is never written
 * to the local payment journal, logs, or any other persisted state.
 *
 * This package never generates, stores, or funds a wallet on the caller's
 * behalf — the private key must be supplied deliberately.
 */
export function createPrivateKeySigner(privateKey: `0x${string}`): EvmSigner {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new VrsaiConfigurationError(
      "Signer private key must be a 32-byte 0x-prefixed hex string.",
    );
  }
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: (parameters) => account.signTypedData(parameters as never),
  };
}
