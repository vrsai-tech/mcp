import type { JsonWebKey } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import type { PaymentPayload } from "@x402/core/types";
import { createOfferJWS, createReceiptJWS } from "@x402/extensions/offer-receipt";
import { declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";
import { describe, expect, it } from "vitest";
import { createVrsaiClientInternal } from "./client.js";
import {
  VrsaiConfigurationError,
  VrsaiPaymentError,
  VrsaiProtocolError,
  VrsaiSpendPolicyError,
  VrsaiTrustError,
} from "./errors.js";
import { computeRequestFingerprint, createInMemoryJournal, type JournalEntry } from "./journal.js";
import type { OfferTrustResolver } from "./offer-trust.js";
import { MCP_X402_PAYMENT_META_KEY, MCP_X402_PAYMENT_RESPONSE_META_KEY } from "./protocol.js";
import type { EvmSigner } from "./signer.js";
import type { SpendPolicy } from "./spend-policy.js";

const ENDPOINT_URL = "https://api.vrsai.tech/mcp";
const PUBLISHER_DID = "did:web:vrsai.tech";
const KEY_ID = `${PUBLISHER_DID}#key-1`;

const REQUIREMENT = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "500000",
  payTo: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: ENDPOINT_URL },
  accepts: [REQUIREMENT],
  // The server opts into the payment-identifier extension; the client only
  // fills in `.info.id` when the server has already declared this shape.
  extensions: { "payment-identifier": declarePaymentIdentifierExtension(false) },
};

const SPEND_POLICY: SpendPolicy = {
  allowedOrigin: "https://api.vrsai.tech",
  allowedNetworks: ["eip155:8453"],
  allowedAssets: [REQUIREMENT.asset],
  maxAmountPerAuthorization: 1_000_000n,
  // Every test in this file exercises payment/journal orchestration, not
  // signed-offer trust verification — that is covered separately (see
  // "defaults expectedPublisherDid..." below and offer-trust.test.ts).
  // Explicitly opting out keeps these fixtures focused on one concern.
  expectedPublisherDid: false,
};

const SIGNER: EvmSigner = {
  address: "0x1111111111111111111111111111111111111111",
  async signTypedData() {
    return `0x${"11".repeat(65)}` as `0x${string}`;
  },
};

async function generateSigner(): Promise<{
  sign: (payload: Uint8Array) => Promise<string>;
  publicJwk: JsonWebKey;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  return {
    publicJwk,
    async sign(payload: Uint8Array) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        payload,
      );
      return Buffer.from(signature).toString("base64url");
    },
  };
}

function resolverFor(publicJwk: JsonWebKey): OfferTrustResolver {
  return {
    async resolveDidDocument() {
      return {
        id: PUBLISHER_DID,
        assertionMethod: [KEY_ID],
        verificationMethod: [{ id: KEY_ID, publicKeyJwk: publicJwk }],
      };
    },
  };
}

function jsonResult(structuredContent: unknown, meta?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent: structuredContent as Record<string, unknown>,
    isError: false,
    ...(meta !== undefined ? { _meta: meta } : {}),
  } as CallToolResult;
}

function paymentRequiredResult(): CallToolResult {
  // Deep-clone: `appendPaymentIdentifierToExtensions` mutates the shared
  // extension object in place (sets `.info.id`), so every scripted response
  // must get its own copy or a signing side effect from one call would leak
  // into another response's fixture and desync its text/structured pair.
  const structuredContent = structuredClone(PAYMENT_REQUIRED);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  } as CallToolResult;
}

function toolErrorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  } as CallToolResult;
}

const SETTLEMENT = { success: true, transaction: "0xdeadbeef", network: "eip155:8453" };

/** A scriptable fake `RemoteCaller` — each test supplies the exact sequence
 * of `callTool` responses and can inspect every call it received. */
function fakeRemoteCaller(responses: readonly CallToolResult[]) {
  const calls: {
    readonly name: string;
    readonly args: Record<string, unknown> | undefined;
    readonly meta: Record<string, unknown> | undefined;
  }[] = [];
  let index = 0;
  return {
    calls,
    remoteCaller: {
      async listTools(): Promise<readonly Tool[]> {
        return [];
      },
      async callTool(name: string, args?: Record<string, unknown>, meta?: Record<string, unknown>) {
        calls.push({ name, args, meta });
        const response = responses[index];
        index += 1;
        if (!response) throw new Error("fakeRemoteCaller: no scripted response left");
        return response;
      },
      async close() {},
    },
  };
}

describe("createVrsaiClient / call", () => {
  it("delivers a free call and never touches the journal", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([jsonResult({ ok: true })]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      journal,
      remoteCaller,
    });
    const outcome = await client.call("free-tool", { a: 1 });
    expect(outcome.structuredContent).toEqual({ ok: true });
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "free-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("signs, journals, and submits a payment; sets the payment-identifier on paymentRequired.extensions (not requirement.extra)", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller, calls } = fakeRemoteCaller([
      paymentRequiredResult(),
      jsonResult({ ok: true }, { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: SETTLEMENT }),
    ]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const outcome = await client.call("paid-tool", { a: 1 });
    expect(outcome.structuredContent).toEqual({ ok: true });
    expect(outcome.amountPaid).toBe(500_000n);
    expect(outcome.settlement).toEqual(SETTLEMENT);

    // The freshly signed payload was submitted on the second call.
    const paidCall = calls[1];
    const payload = paidCall?.meta?.[MCP_X402_PAYMENT_META_KEY] as PaymentPayload;
    const paymentIdExtension = (payload.extensions as Record<string, { info?: { id?: string } }>)[
      "payment-identifier"
    ];
    expect(paymentIdExtension?.info?.id).toBeTruthy();
    // The narrowed `accepted` requirement itself must not carry the
    // payment-identifier extension — it belongs on the payload's top level.
    expect((payload.accepted as unknown as { extra?: unknown }).extra).toEqual(REQUIREMENT.extra);

    // The journal entry was removed after a fully delivered paid call.
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("throws VrsaiConfigurationError when payment is required but no signer/spendPolicy is configured, and releases the claim", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([paymentRequiredResult()]);
    const client = createVrsaiClientInternal({ endpointUrl: ENDPOINT_URL, journal, remoteCaller });
    await expect(client.call("paid-tool", { a: 1 })).rejects.toThrow(VrsaiConfigurationError);
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("rejects signer and spendPolicy being configured independently of one another", () => {
    expect(() =>
      createVrsaiClientInternal({
        endpointUrl: ENDPOINT_URL,
        signer: SIGNER,
        journal: createInMemoryJournal(),
      }),
    ).toThrow(VrsaiConfigurationError);
  });

  it("refuses to resume a journaled authorization created by a different signer", async () => {
    const journal = createInMemoryJournal();
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    const foreignEntry: JournalEntry = {
      schemaVersion: 1,
      status: "authorized",
      fingerprint,
      resourceUrl: ENDPOINT_URL,
      toolName: "paid-tool",
      signerAddress: "0x2222222222222222222222222222222222222222",
      paymentPayload: {
        x402Version: 2,
        accepted: REQUIREMENT,
        payload: {},
      } as PaymentPayload,
      createdAt: new Date().toISOString(),
    };
    await journal.save(foreignEntry);
    const { remoteCaller } = fakeRemoteCaller([]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    await expect(client.call("paid-tool", { a: 1 })).rejects.toThrow(VrsaiConfigurationError);
    // The foreign entry must not have been touched/removed.
    expect(await journal.load(fingerprint)).toEqual(foreignEntry);
  });

  it("treats an ambiguous tool-level error after paying as unknown economic effect and retains the journal entry", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([
      paymentRequiredResult(),
      toolErrorResult("downstream blew up"),
    ]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiPaymentError);
    expect((error as VrsaiPaymentError).economicEffect).toBe("unknown");

    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    const entry = await journal.load(fingerprint);
    expect(entry?.status).toBe("authorized");
  });

  it("removes the journal entry (but conservatively never releases reserved budget) when the server rejects the freshly signed payment", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([paymentRequiredResult(), paymentRequiredResult()]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiPaymentError);
    expect((error as VrsaiPaymentError).economicEffect).toBe("not_occurred");
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("releases the pending journal claim when the initial tool call throws a transport error, wrapping it as VrsaiProtocolError", async () => {
    const journal = createInMemoryJournal();
    const transportError = new Error("socket hang up");
    const remoteCaller = {
      async listTools(): Promise<readonly Tool[]> {
        return [];
      },
      async callTool(): Promise<CallToolResult> {
        throw transportError;
      },
      async close() {},
    };
    const client = createVrsaiClientInternal({ endpointUrl: ENDPOINT_URL, journal, remoteCaller });
    const error = await client.call("free-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiProtocolError);
    expect((error as Error).cause).toBe(transportError);
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "free-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("releases the pending journal claim when a payment requirement is rejected by spend policy", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([paymentRequiredResult()]);
    const strictPolicy: SpendPolicy = { ...SPEND_POLICY, maxAmountPerAuthorization: 1n };
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: strictPolicy,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiSpendPolicyError);
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("releases the pending journal claim when signing the payment authorization itself fails", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([paymentRequiredResult()]);
    const brokenSigner: EvmSigner = {
      address: SIGNER.address,
      async signTypedData(): Promise<`0x${string}`> {
        throw new Error("hardware wallet disconnected");
      },
    };
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: brokenSigner,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiPaymentError);
    expect((error as VrsaiPaymentError).economicEffect).toBe("not_occurred");
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("preserves amountPaid when resuming a previously journaled authorization", async () => {
    const journal = createInMemoryJournal();
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    const authorizedEntry: JournalEntry = {
      schemaVersion: 1,
      status: "authorized",
      fingerprint,
      resourceUrl: ENDPOINT_URL,
      toolName: "paid-tool",
      signerAddress: SIGNER.address.toLowerCase(),
      paymentPayload: { x402Version: 2, accepted: REQUIREMENT, payload: {} } as PaymentPayload,
      createdAt: new Date().toISOString(),
    };
    await journal.save(authorizedEntry);
    const { remoteCaller } = fakeRemoteCaller([
      jsonResult({ ok: true }, { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: SETTLEMENT }),
    ]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const outcome = await client.call("paid-tool", { a: 1 });
    expect(outcome.amountPaid).toBe(500_000n);
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("treats a transport failure while resuming a journaled authorization as unknown economic effect and retains the journal entry", async () => {
    const journal = createInMemoryJournal();
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    const authorizedEntry: JournalEntry = {
      schemaVersion: 1,
      status: "authorized",
      fingerprint,
      resourceUrl: ENDPOINT_URL,
      toolName: "paid-tool",
      signerAddress: SIGNER.address.toLowerCase(),
      paymentPayload: { x402Version: 2, accepted: REQUIREMENT, payload: {} } as PaymentPayload,
      createdAt: new Date().toISOString(),
    };
    await journal.save(authorizedEntry);
    const transportError = new Error("socket hang up");
    const remoteCaller = {
      async listTools(): Promise<readonly Tool[]> {
        return [];
      },
      async callTool(): Promise<CallToolResult> {
        throw transportError;
      },
      async close() {},
    };
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: SPEND_POLICY,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiPaymentError);
    expect((error as VrsaiPaymentError).economicEffect).toBe("unknown");
    expect((error as Error).cause).toBe(transportError);
    const entry = await journal.load(fingerprint);
    expect(entry?.status).toBe("authorized");
  });

  it("defaults expectedPublisherDid to did:web:vrsai.tech and rejects a payment requirement with no signed offer", async () => {
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([paymentRequiredResult()]);
    const policyWithoutOverride: SpendPolicy = {
      allowedOrigin: SPEND_POLICY.allowedOrigin,
      allowedNetworks: SPEND_POLICY.allowedNetworks,
      allowedAssets: SPEND_POLICY.allowedAssets,
      maxAmountPerAuthorization: SPEND_POLICY.maxAmountPerAuthorization,
      // expectedPublisherDid intentionally omitted: must default to
      // DEFAULT_TRUST_DID ("did:web:vrsai.tech") rather than silently
      // skipping signed-offer verification.
    };
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: policyWithoutOverride,
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiTrustError);
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });

  it("treats a portable-receipt verification failure after proven settlement as economicEffect occurred and clears the journal", async () => {
    const { sign, publicJwk } = await generateSigner();
    const { sign: wrongSign } = await generateSigner();
    const offer = await createOfferJWS(
      ENDPOINT_URL,
      {
        acceptIndex: 0,
        scheme: REQUIREMENT.scheme,
        network: REQUIREMENT.network,
        asset: REQUIREMENT.asset,
        payTo: REQUIREMENT.payTo,
        amount: REQUIREMENT.amount,
        offerValiditySeconds: 300,
      },
      { sign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
    );
    const paymentRequiredWithOffer = {
      x402Version: 2,
      resource: { url: ENDPOINT_URL },
      accepts: [REQUIREMENT],
      extensions: { "offer-receipt": { info: { offers: [offer] } } },
    };
    // Signed with a *different* private key than the one the mock resolver
    // reports as authorized for KEY_ID: structurally a valid JWS receipt,
    // but it must fail cryptographic verification.
    const badReceipt = await createReceiptJWS(
      {
        resourceUrl: ENDPOINT_URL,
        payer: SIGNER.address,
        network: REQUIREMENT.network,
        transaction: "0xdeadbeef",
      },
      { sign: wrongSign, algorithm: "ES256", kid: KEY_ID, format: "jws" },
    );
    const settlementWithBadReceipt = {
      success: true,
      transaction: "0xdeadbeef",
      network: REQUIREMENT.network,
      extensions: { "offer-receipt": { info: { receipt: badReceipt } } },
    };
    const journal = createInMemoryJournal();
    const { remoteCaller } = fakeRemoteCaller([
      {
        content: [{ type: "text", text: JSON.stringify(paymentRequiredWithOffer) }],
        structuredContent: paymentRequiredWithOffer,
        isError: true,
      } as CallToolResult,
      jsonResult({ ok: true }, { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: settlementWithBadReceipt }),
    ]);
    const client = createVrsaiClientInternal({
      endpointUrl: ENDPOINT_URL,
      signer: SIGNER,
      spendPolicy: { ...SPEND_POLICY, expectedPublisherDid: PUBLISHER_DID },
      offerTrustResolver: resolverFor(publicJwk),
      journal,
      remoteCaller,
    });
    const error = await client.call("paid-tool", { a: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VrsaiPaymentError);
    expect((error as VrsaiPaymentError).economicEffect).toBe("occurred");
    expect((error as VrsaiPaymentError).retryable).toBe(false);
    const fingerprint = computeRequestFingerprint(ENDPOINT_URL, "paid-tool", { a: 1 });
    expect(await journal.load(fingerprint)).toBeUndefined();
  });
});
