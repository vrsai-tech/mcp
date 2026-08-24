import type { Tool } from "@modelcontextprotocol/client";
import type { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import type { DecodedOffer, JWSSignedReceipt } from "@x402/extensions/offer-receipt";
import {
  appendPaymentIdentifierToExtensions,
  generatePaymentId,
} from "@x402/extensions/payment-identifier";
import {
  VrsaiConfigurationError,
  VrsaiMcpError,
  VrsaiPaymentError,
  VrsaiProtocolError,
  VrsaiSpendPolicyError,
  VrsaiToolError,
  VrsaiTrustError,
} from "./errors.js";
import {
  computeRequestFingerprint,
  createFileJournal,
  JOURNAL_SCHEMA_VERSION,
  type JournalEntry,
  type PaymentJournal,
} from "./journal.js";
import { type Logger, stderrLogger } from "./logger.js";
import {
  createHttpOfferTrustResolver,
  type OfferTrustResolver,
  verifySignedOffer,
  verifySignedReceipt,
} from "./offer-trust.js";
import { createEvmPaymentClient, signPaymentForRequirement } from "./payment-client.js";
import { MCP_X402_PAYMENT_META_KEY } from "./protocol.js";
import { connectRemoteCaller, type RemoteCaller } from "./remote-caller.js";
import { classifyCallToolResult } from "./result-parsing.js";
import type { EvmSigner } from "./signer.js";
import {
  type ResolvedSpendPolicy,
  resolveSpendPolicy,
  SpendLedger,
  type SpendPolicy,
} from "./spend-policy.js";

export interface VrsaiClientOptions {
  /** Absolute `https://` URL of the remote vrsai MCP endpoint. */
  readonly endpointUrl: string;
  /** Buyer signer. Must be provided together with `spendPolicy`, or both
   * omitted for a discovery-only client (`listTools()` still works; any
   * `call()` that turns out to require payment throws
   * {@link VrsaiConfigurationError}). */
  readonly signer?: EvmSigner;
  readonly spendPolicy?: SpendPolicy;
  /** Overrides the default on-disk crash-safe journal (e.g. an in-memory
   * journal for tests, or a directory scoped per tenant). */
  readonly journal?: PaymentJournal;
  readonly offerTrustResolver?: OfferTrustResolver;
  readonly logger?: Logger;
  readonly fetchImplementation?: typeof fetch;
}

/** {@link VrsaiClientOptions} plus fields that exist only for this
 * package's own tests. Never exported from `index.ts` — the public
 * contract is {@link VrsaiClientOptions} and {@link createVrsaiClient}. */
export interface InternalVrsaiClientOptions extends VrsaiClientOptions {
  /**
   * Overrides the real `connectRemoteCaller()` transport connection.
   * **Test-only escape hatch** — not part of the supported public contract
   * and may change or be removed without notice. Production callers should
   * never set this; use `endpointUrl`/`fetchImplementation` instead.
   */
  readonly remoteCaller?: RemoteCaller;
}

export interface CallOutcome {
  readonly structuredContent: Record<string, unknown>;
  readonly settlement?: SettleResponse & { readonly success: true };
  readonly portableReceipt?: JWSSignedReceipt;
  /** Atomic amount authorized for this specific call, if a payment was made. */
  readonly amountPaid?: bigint;
}

export interface VrsaiClient {
  listTools(): Promise<readonly Tool[]>;
  call(toolName: string, args?: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}

interface PaymentCredentials {
  readonly signer: EvmSigner;
  readonly spendPolicy: ResolvedSpendPolicy;
  readonly ledger: SpendLedger;
  readonly paymentClient: x402Client;
}

/**
 * Creates a client bound to one remote endpoint and, optionally, one signer
 * and spend policy. Every payment this client ever makes is bounded by
 * `spendPolicy` — there is no default-allow behavior, and any requirement
 * outside policy is rejected before anything is signed. A client
 * constructed without `signer`/`spendPolicy` can still discover and call
 * free tools; any call that turns out to require payment throws
 * {@link VrsaiConfigurationError} rather than silently failing later.
 */
export function createVrsaiClient(options: VrsaiClientOptions): VrsaiClient {
  return createVrsaiClientInternal(options);
}

/** Not exported from `index.ts`. See {@link InternalVrsaiClientOptions}. */
export function createVrsaiClientInternal(options: InternalVrsaiClientOptions): VrsaiClient {
  if ((options.signer === undefined) !== (options.spendPolicy === undefined)) {
    throw new VrsaiConfigurationError(
      "VrsaiClientOptions.signer and .spendPolicy must be provided together, or both omitted for a discovery-only client.",
    );
  }
  const logger = options.logger ?? stderrLogger;
  const journal = options.journal ?? createFileJournal();
  const paymentCredentials: PaymentCredentials | undefined =
    options.signer !== undefined && options.spendPolicy !== undefined
      ? (() => {
          const spendPolicy = resolveSpendPolicy(options.spendPolicy as SpendPolicy);
          return {
            signer: options.signer as EvmSigner,
            spendPolicy,
            ledger: new SpendLedger(spendPolicy),
            paymentClient: createEvmPaymentClient(
              options.signer as EvmSigner,
              spendPolicy.allowedNetworks,
            ),
          };
        })()
      : undefined;
  const resolver =
    options.offerTrustResolver ?? createHttpOfferTrustResolver(options.fetchImplementation);

  let remoteCallerPromise: Promise<RemoteCaller> | undefined;
  const remoteCaller = (): Promise<RemoteCaller> => {
    if (options.remoteCaller !== undefined) return Promise.resolve(options.remoteCaller);
    remoteCallerPromise ??= connectRemoteCaller({
      endpointUrl: options.endpointUrl,
      ...(options.fetchImplementation !== undefined
        ? { fetchImplementation: options.fetchImplementation }
        : {}),
    });
    return remoteCallerPromise;
  };

  /** Every raw error this package throws is a {@link VrsaiMcpError}
   * subclass. Boundaries that call into transport/SDK code the package
   * does not control (the MCP client, `fetch`) can throw arbitrary
   * errors; this narrows any such escape into {@link VrsaiProtocolError}
   * (already documented to cover "the remote MCP endpoint, transport, or
   * wire format"), preserving the original as `cause`. Already-typed
   * errors pass through unchanged. */
  function asMcpError(error: unknown, contextMessage: string): VrsaiMcpError {
    if (error instanceof VrsaiMcpError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new VrsaiProtocolError(`${contextMessage}: ${detail}`, { cause: error });
  }

  async function getRemoteCaller(): Promise<RemoteCaller> {
    try {
      return await remoteCaller();
    } catch (error) {
      throw asMcpError(error, "Failed to connect to the remote endpoint");
    }
  }

  /**
   * Selects and signs a payment requirement for `paymentRequired`.
   * Atomically reserves budget against `credentials.ledger` (item 3)
   * immediately before signing, and releases it if signing itself throws —
   * nothing has been journaled or sent to the server yet at that point, so
   * releasing is safe (see {@link SpendLedger.reserve}'s contract). Sets the
   * payment-identifier extension on `paymentRequired.extensions` (the field
   * the `exact` EVM scheme actually copies into the outgoing
   * `PaymentPayload`) rather than on the requirement's own `extra`, which is
   * never inspected for this purpose.
   */
  async function verifyAndSign(
    paymentRequired: PaymentRequired,
    credentials: PaymentCredentials,
  ): Promise<{
    readonly payload: PaymentPayload;
    readonly amount: bigint;
    readonly decodedOffer?: DecodedOffer;
  }> {
    let requirement: PaymentRequired["accepts"][number];
    let decodedOffer: DecodedOffer | undefined;
    if (credentials.spendPolicy.expectedPublisherDid !== undefined) {
      const verified = await verifySignedOffer({
        paymentRequired,
        expectedPublisherDid: credentials.spendPolicy.expectedPublisherDid,
        resolver,
      });
      requirement = verified.requirement;
      decodedOffer = verified.decodedOffer;
    } else {
      const first = paymentRequired.accepts[0];
      if (!first) throw new VrsaiTrustError("PaymentRequired carries no payment requirements.");
      requirement = first;
      logger.warn(
        "expectedPublisherDid is explicitly disabled (false); proceeding without signed-offer verification.",
      );
    }

    const amount = credentials.ledger.reserve(requirement, paymentRequired.resource.url);
    try {
      const extensions = appendPaymentIdentifierToExtensions(
        { ...(paymentRequired.extensions ?? {}) },
        generatePaymentId("vrsai-mcp"),
      );
      const payload = await signPaymentForRequirement(
        credentials.paymentClient,
        { ...paymentRequired, extensions },
        requirement,
      );
      return { payload, amount, ...(decodedOffer !== undefined ? { decodedOffer } : {}) };
    } catch (error) {
      // Nothing has been journaled or sent to the server yet — releasing
      // the reservation is safe (see SpendLedger.reserve's contract). No
      // authorization was created, so this is unambiguously "not_occurred".
      credentials.ledger.release(amount);
      throw error instanceof VrsaiMcpError
        ? error
        : new VrsaiPaymentError(
            `Signing the payment authorization failed: ${error instanceof Error ? error.message : String(error)}`,
            { economicEffect: "not_occurred", retryable: true, cause: error },
          );
    }
  }

  /** Resumes a `"authorized"` entry claimed by a previous (possibly
   * crashed) attempt at this exact fingerprint. Refuses to resume an entry
   * bound to a different signer (item 5) — never silently reuses or
   * replaces another identity's authorization. */
  async function resumeAuthorizedEntry(
    caller: RemoteCaller,
    fingerprint: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    claimed: Extract<JournalEntry, { readonly status: "authorized" }>,
  ): Promise<CallOutcome> {
    if (
      paymentCredentials === undefined ||
      claimed.signerAddress !== paymentCredentials.signer.address.toLowerCase()
    ) {
      throw new VrsaiConfigurationError(
        "A previously journaled payment authorization for this request was created by a different signer than the one configured on this client. Refusing to resume, reuse, or replace it.",
      );
    }
    logger.info("Resuming a previously journaled payment authorization.", { toolName });
    let classified: ReturnType<typeof classifyCallToolResult>;
    try {
      const result = await caller.callTool(toolName, args, {
        [MCP_X402_PAYMENT_META_KEY]: claimed.paymentPayload,
      });
      classified = classifyCallToolResult(result, options.endpointUrl, {
        requireSettlement: true,
        expectedNetwork: claimed.paymentPayload.accepted.network,
      });
    } catch (error) {
      // The journaled payload was already sent to the server; whether it
      // was consumed is unknown. Retain the journal entry so a retry
      // resumes this exact authorization rather than risking a duplicate.
      throw new VrsaiPaymentError(
        `Resuming a journaled payment authorization could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        { economicEffect: "unknown", retryable: true, cause: error },
      );
    }
    if (classified.kind === "delivered") {
      await journal.remove(fingerprint);
      return {
        ...toOutcome(classified),
        amountPaid: BigInt(claimed.paymentPayload.accepted.amount),
      };
    }
    if (classified.kind === "payment-required") {
      // The server definitively did not accept the journaled authorization
      // (e.g. it expired or was already consumed). Safe to clear it and
      // let the caller retry, which will sign a fresh authorization.
      await journal.remove(fingerprint);
      throw new VrsaiPaymentError(
        "The previously journaled payment authorization was not accepted by the server.",
        { economicEffect: "not_occurred", retryable: true },
      );
    }
    // A plain tool-level error on a paid retry is ambiguous: the payment
    // may have already been consumed server-side. Retain the journal
    // entry and report unknown so a retry resumes this exact
    // authorization rather than risking a duplicate one.
    throw new VrsaiPaymentError(
      `Retry of a journaled payment authorization returned an ambiguous error: ${classified.message}`,
      { economicEffect: "unknown", retryable: true },
    );
  }

  /** Submits a freshly signed, freshly journaled payment and, when a
   * signed-offer trust chain was established, cryptographically verifies
   * the server's settlement receipt against the exact offer that was
   * accepted before treating the call as delivered (item 8). Any receipt
   * mismatch or invalid signature throws *before* the journal entry is
   * removed, so a retry resumes this exact authorization rather than
   * risking a duplicate one. */
  async function submitPaidCall(
    caller: RemoteCaller,
    fingerprint: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    payload: PaymentPayload,
    amount: bigint,
    decodedOffer: DecodedOffer | undefined,
    credentials: PaymentCredentials,
  ): Promise<CallOutcome> {
    let classifiedPaid: ReturnType<typeof classifyCallToolResult>;
    try {
      const paid = await caller.callTool(toolName, args, { [MCP_X402_PAYMENT_META_KEY]: payload });
      classifiedPaid = classifyCallToolResult(paid, options.endpointUrl, {
        requireSettlement: true,
        expectedNetwork: payload.accepted.network,
      });
    } catch (error) {
      // The freshly signed payload was already sent to the server; whether
      // it was consumed is unknown. Retain the journal entry so a retry
      // resumes this exact authorization rather than risking a duplicate.
      throw new VrsaiPaymentError(
        `Payment submission could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        { economicEffect: "unknown", retryable: true, cause: error },
      );
    }
    if (classifiedPaid.kind === "delivered") {
      if (
        classifiedPaid.portableReceipt !== undefined &&
        decodedOffer !== undefined &&
        credentials.spendPolicy.expectedPublisherDid !== undefined
      ) {
        try {
          await verifySignedReceipt({
            receipt: classifiedPaid.portableReceipt,
            decodedOffer,
            expectedPublisherDid: credentials.spendPolicy.expectedPublisherDid,
            payerAddresses: [credentials.signer.address],
            resolver,
          });
        } catch (error) {
          // Delivery and settlement are already proven at this point
          // (classifiedPaid.kind === "delivered" with requireSettlement
          // enforced) — only the portable-receipt trust check failed. The
          // payment occurred regardless; nothing is gained by retaining the
          // journal entry, since resuming the same authorization cannot
          // change this outcome.
          await journal.remove(fingerprint);
          throw new VrsaiPaymentError(
            `Payment settled but its portable receipt failed verification: ${error instanceof Error ? error.message : String(error)}`,
            { economicEffect: "occurred", retryable: false, cause: error },
          );
        }
      }
      await journal.remove(fingerprint);
      return { ...toOutcome(classifiedPaid), amountPaid: amount };
    }
    if (classifiedPaid.kind === "payment-required") {
      await journal.remove(fingerprint);
      throw new VrsaiPaymentError("The server did not accept the freshly signed payment.", {
        economicEffect: "not_occurred",
        retryable: true,
      });
    }
    throw new VrsaiPaymentError(
      `Payment submission returned an ambiguous error: ${classifiedPaid.message}`,
      { economicEffect: "unknown", retryable: true },
    );
  }

  async function call(toolName: string, args?: Record<string, unknown>): Promise<CallOutcome> {
    const caller = await getRemoteCaller();
    const fingerprint = computeRequestFingerprint(options.endpointUrl, toolName, args ?? {});
    const claimed = await journal.claim(fingerprint, {
      resourceUrl: options.endpointUrl,
      toolName,
    });

    if (claimed !== undefined) {
      if (claimed.status === "pending") {
        // Never auto-reclaimed: a "pending" entry never contains a signed
        // payload, so reclaiming it could race a genuinely in-flight
        // concurrent attempt into creating two distinct authorizations for
        // the same fingerprint. Conservatively wait/retry instead.
        throw new VrsaiPaymentError(
          "A payment authorization for this exact request is already being created, possibly by a concurrent call or process. Retry shortly.",
          { economicEffect: "unknown", retryable: true },
        );
      }
      return await resumeAuthorizedEntry(caller, fingerprint, toolName, args, claimed);
    }

    // We now exclusively own this fingerprint's "pending" claim. Nothing
    // has been signed or sent with a payment attached yet, so any failure
    // between here and a durably-journaled "authorized" entry must release
    // this claim — otherwise a transient error (network blip, malformed
    // response, a rejected offer/spend-policy check, a signing failure)
    // would permanently poison this fingerprint with an unrecoverable
    // "pending" entry (see PaymentJournal.claim's contract).
    let classifiedFirst: ReturnType<typeof classifyCallToolResult>;
    try {
      const first = await caller.callTool(toolName, args);
      classifiedFirst = classifyCallToolResult(first, options.endpointUrl);
    } catch (error) {
      await journal.remove(fingerprint).catch(() => {});
      throw asMcpError(error, `Calling tool "${toolName}" failed`);
    }
    if (classifiedFirst.kind === "delivered") {
      await journal.remove(fingerprint);
      return toOutcome(classifiedFirst);
    }
    if (classifiedFirst.kind === "error") {
      await journal.remove(fingerprint);
      throw new VrsaiToolError(classifiedFirst.message);
    }

    // classifiedFirst.kind === "payment-required"
    if (paymentCredentials === undefined) {
      await journal.remove(fingerprint);
      throw new VrsaiConfigurationError(
        `Tool "${toolName}" requires payment, but this client was constructed without a signer/spendPolicy.`,
      );
    }

    let signed: Awaited<ReturnType<typeof verifyAndSign>>;
    try {
      signed = await verifyAndSign(classifiedFirst.paymentRequired, paymentCredentials);
    } catch (error) {
      await journal.remove(fingerprint).catch(() => {});
      throw error;
    }
    const { payload, amount, decodedOffer } = signed;

    try {
      await journal.save({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        status: "authorized",
        fingerprint,
        resourceUrl: options.endpointUrl,
        toolName,
        signerAddress: paymentCredentials.signer.address.toLowerCase(),
        paymentPayload: payload,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      // Nothing has been sent to the server yet — safe to release and
      // abandon the claim entirely.
      paymentCredentials.ledger.release(amount);
      await journal.remove(fingerprint).catch(() => {});
      throw error;
    }

    return await submitPaidCall(
      caller,
      fingerprint,
      toolName,
      args,
      payload,
      amount,
      decodedOffer,
      paymentCredentials,
    );
  }

  return {
    async listTools() {
      const caller = await getRemoteCaller();
      try {
        return await caller.listTools();
      } catch (error) {
        throw asMcpError(error, "Failed to list tools from the remote endpoint");
      }
    },
    call,
    async close() {
      if (options.remoteCaller !== undefined) {
        await options.remoteCaller.close();
        return;
      }
      if (remoteCallerPromise) {
        const caller = await remoteCallerPromise;
        await caller.close();
      }
    },
  };
}

function toOutcome(classified: {
  readonly kind: "delivered";
  readonly structuredContent: Record<string, unknown>;
  readonly settlement?: SettleResponse & { readonly success: true };
  readonly portableReceipt?: JWSSignedReceipt;
}): CallOutcome {
  return {
    structuredContent: classified.structuredContent,
    ...(classified.settlement !== undefined ? { settlement: classified.settlement } : {}),
    ...(classified.portableReceipt !== undefined
      ? { portableReceipt: classified.portableReceipt }
      : {}),
  };
}

// Re-export the protocol/policy error surface so a caller only needs one
// import for orchestration + error branching.
export {
  VrsaiConfigurationError,
  VrsaiPaymentError,
  VrsaiProtocolError,
  VrsaiSpendPolicyError,
  VrsaiToolError,
  VrsaiTrustError,
};
