import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGACY_V2_GOLDEN_FINGERPRINT,
  PORTFOLIO_PROPOSAL_ONLY_CODE,
  appendM2ToolReceipt,
  canonicalDecisionFingerprintV3,
  canonicalInformationSnapshotHash,
  canonicalIntentFingerprint,
  decisionIntentSchema,
  decisionLedgerV3Schema,
  deterministicExecutionRecordSchema,
  informationSnapshotSchema,
  initialExecutionAdmission,
  m2ToolReceiptSchema,
  riskEnvelopeSchema,
  selectProtection,
  validateDecisionSnapshotBinding,
  validateExecutionRecordLinkage,
  validateSnapshotTemporalIntegrity,
  validateThesisDispositionCoverage,
  type DecisionIntent,
  type M2ToolReceipt,
} from "../../../tools/steward-contract-proof/d2-contracts.js";

/**
 * AUTH-CP-D2 Wave 0.5 only. These tests freeze candidate contracts and golden
 * vectors without wiring them into the steward runtime, generated validator,
 * template, prompt, UTA, or campaign harness.
 */

const fixtureDir = fileURLToPath(
  new URL(
    "../../../tools/steward-contract-proof/fixtures/d2/",
    import.meta.url,
  ),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as T;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

const ledgerV2Raw = fixture<Record<string, unknown>>("ledger-v2-golden.json");
const singleLedgerRaw = fixture<Record<string, unknown>>(
  "ledger-v3-single.json",
);
const portfolioLedgerRaw = fixture<Record<string, unknown>>(
  "ledger-v3-portfolio.json",
);
const singleSnapshotRaw = fixture<Record<string, unknown>>(
  "information-snapshot-single.json",
);
const portfolioSnapshotRaw = fixture<Record<string, unknown>>(
  "information-snapshot-portfolio.json",
);
const riskEnvelopeRaw = fixture<Record<string, unknown>>(
  "risk-envelope-v3.json",
);
const executionRecordRaw = fixture<Record<string, unknown>>(
  "execution-record-single.json",
);
const m2ToolReceiptFixture = fixture<{
  responseUtf8: string;
  receipt: Record<string, unknown>;
}>("m2-tool-receipt.json");
const m2ToolReceiptRaw = m2ToolReceiptFixture.receipt;
const m2AppendContext = {
  wakeId: "wake-v3-single",
  snapshotId: "snap:wake-v3-single",
  accountId: "mock-simulator-1",
  toolCallId: "tool-call:risk:001",
  toolName: "getAccountRisk",
  responseBytes: Buffer.from(m2ToolReceiptFixture.responseUtf8, "utf8"),
};
const brokerProtectionCases = fixture<{
  cases: Array<{
    name: string;
    capabilities: unknown;
    request: unknown;
    expected: unknown;
  }>;
}>("broker-protection-cases.json");
const fingerprints = fixture<Record<string, string>>(
  "fingerprint-goldens.json",
);

const singleLedger = decisionLedgerV3Schema.parse(singleLedgerRaw);
const portfolioLedger = decisionLedgerV3Schema.parse(portfolioLedgerRaw);
const singleSnapshot = informationSnapshotSchema.parse(singleSnapshotRaw);
const portfolioSnapshot = informationSnapshotSchema.parse(portfolioSnapshotRaw);
const riskEnvelope = riskEnvelopeSchema.parse(riskEnvelopeRaw);
const executionRecord =
  deterministicExecutionRecordSchema.parse(executionRecordRaw);

describe("AUTH-CP-D2 Decision Intent and ledger v3 proof", () => {
  it("accepts explicit single and portfolio fixtures with the v3 decision enum", () => {
    expect(singleLedger.decision).toBe("propose_change");
    expect(singleLedger.intent?.kind).toBe("single");
    expect(portfolioLedger.decision).toBe("propose_change");
    expect(portfolioLedger.intent?.kind).toBe("portfolio");

    const decisions = [
      { decision: "no_trade", intent: null },
      { decision: "blocked", intent: null },
      { decision: "reduce_risk", intent: singleLedger.intent },
    ] as const;
    for (const variant of decisions) {
      expect(
        decisionLedgerV3Schema.safeParse({
          ...singleLedgerRaw,
          ...variant,
        }).success,
      ).toBe(true);
    }
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        decision: "propose_trade",
      }).success,
    ).toBe(false);
  });

  it("enforces intent presence for change/risk decisions and null for no-trade/blocked", () => {
    for (const decision of ["propose_change", "reduce_risk"] as const) {
      expect(
        decisionLedgerV3Schema.safeParse({
          ...singleLedgerRaw,
          decision,
          intent: null,
        }).success,
      ).toBe(false);
    }
    for (const decision of ["no_trade", "blocked"] as const) {
      expect(
        decisionLedgerV3Schema.safeParse({
          ...singleLedgerRaw,
          decision,
          intent: singleLedger.intent,
        }).success,
      ).toBe(false);
    }
  });

  it("requires every thesis disposition to address an instrument", () => {
    const missingInstrument = cloneJson(singleLedgerRaw);
    const dispositions = missingInstrument["thesisDispositions"] as Array<
      Record<string, unknown>
    >;
    delete dispositions[0]!["instrument"];

    expect(decisionLedgerV3Schema.safeParse(missingInstrument).success).toBe(
      false,
    );
  });

  it("inherits the v2 typed-action and strict-pending invariants", () => {
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        actions: ["placed a market buy"],
      }).success,
    ).toBe(false);

    const executedAction = {
      kind: "order_place",
      aliceId: "mock-simulator-1/ASSET-A",
      params: { action: "BUY", totalQuantity: "12" },
      commitHash: "deadbeef",
      outcome: "executed",
    };
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        actions: [executedAction],
        pendingHash: null,
      }).success,
    ).toBe(true);
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        actions: [executedAction],
        pendingHash: "deadbeef",
      }).success,
    ).toBe(false);
  });

  it("requires exactly one wake:self reference and no contradictory wake reference", () => {
    const completion = singleLedgerRaw["completion"] as Record<string, unknown>;
    const withoutSelf = {
      ...singleLedgerRaw,
      completion: { ...completion, evidenceRefs: ["tool:risk"] },
    };
    expect(decisionLedgerV3Schema.safeParse(withoutSelf).success).toBe(false);

    const duplicateSelf = {
      ...singleLedgerRaw,
      completion: {
        ...completion,
        evidenceRefs: [
          "wake:wake-v3-single",
          "wake:wake-v3-single",
          "tool:risk",
        ],
      },
    };
    expect(decisionLedgerV3Schema.safeParse(duplicateSelf).success).toBe(false);

    const contradictory = {
      ...singleLedgerRaw,
      completion: {
        ...completion,
        evidenceRefs: ["wake:wake-v3-single", "wake:wake-other"],
      },
    };
    expect(decisionLedgerV3Schema.safeParse(contradictory).success).toBe(false);
  });

  it("requires a price invalidation for every propose_change target but not reduce_risk", () => {
    const invalidSingle = cloneJson(singleLedgerRaw);
    const singleIntent = invalidSingle["intent"] as Record<string, unknown>;
    singleIntent["invalidation"] = [
      { kind: "time_expiry", note: "No breakout before expiry." },
    ];
    expect(decisionLedgerV3Schema.safeParse(invalidSingle).success).toBe(false);

    const invalidPortfolio = cloneJson(portfolioLedgerRaw);
    const portfolioIntent = invalidPortfolio["intent"] as Record<
      string,
      unknown
    >;
    const targets = portfolioIntent["targets"] as Array<
      Record<string, unknown>
    >;
    targets[1]!["invalidation"] = [
      { kind: "thesis", note: "The relative-value thesis changes." },
    ];
    expect(decisionLedgerV3Schema.safeParse(invalidPortfolio).success).toBe(
      false,
    );

    expect(
      decisionLedgerV3Schema.safeParse({
        ...invalidSingle,
        decision: "reduce_risk",
      }).success,
    ).toBe(true);
  });

  it("accepts only finite positive decimal-string price invalidations", () => {
    for (const value of ["0", "-1", "Infinity", "NaN", "1e3", ""] as const) {
      const invalid = cloneJson(singleLedgerRaw);
      const intent = invalid["intent"] as Record<string, unknown>;
      const invalidations = intent["invalidation"] as Array<
        Record<string, unknown>
      >;
      invalidations[0]!["value"] = value;
      expect(decisionLedgerV3Schema.safeParse(invalid).success, value).toBe(
        false,
      );
    }
    expect(decisionLedgerV3Schema.safeParse(singleLedgerRaw).success).toBe(
      true,
    );
  });

  it("allows zero aggregate loss budget for a flat reduce-risk intent", () => {
    const candidate = cloneJson(singleLedgerRaw);
    candidate["decision"] = "reduce_risk";
    const intent = candidate["intent"] as Record<string, unknown>;
    intent["direction"] = "flat";
    intent["targetExposure"] = { minPct: 0, maxPct: 0 };
    intent["maxAcceptableLossPct"] = 0;
    intent["invalidation"] = [
      { kind: "thesis", note: "Risk reduction is immediate." },
    ];
    expect(decisionLedgerV3Schema.safeParse(candidate).success).toBe(true);
  });

  it("rejects non-ISO ledger timestamps", () => {
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        at: "July 12, 2026 10am",
      }).success,
    ).toBe(false);
    expect(
      decisionLedgerV3Schema.safeParse({
        ...singleLedgerRaw,
        at: "2026-02-30T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("freezes exactly three confidence buckets", () => {
    for (const confidence of ["low", "medium", "high"]) {
      const candidate = cloneJson(singleLedgerRaw);
      (candidate["intent"] as Record<string, unknown>)["confidence"] =
        confidence;
      expect(decisionLedgerV3Schema.safeParse(candidate).success).toBe(true);
    }
    const invalid = cloneJson(singleLedgerRaw);
    (invalid["intent"] as Record<string, unknown>)["confidence"] = "very_high";
    expect(decisionLedgerV3Schema.safeParse(invalid).success).toBe(false);
  });

  it("requires at least two unique portfolio targets", () => {
    const oneTarget = cloneJson(portfolioLedgerRaw);
    const oneTargetIntent = oneTarget["intent"] as Record<string, unknown>;
    oneTargetIntent["targets"] = (
      oneTargetIntent["targets"] as Array<Record<string, unknown>>
    ).slice(0, 1);
    expect(decisionLedgerV3Schema.safeParse(oneTarget).success).toBe(false);

    const duplicate = cloneJson(portfolioLedgerRaw);
    const duplicateTargets = (duplicate["intent"] as Record<string, unknown>)[
      "targets"
    ] as Array<Record<string, unknown>>;
    duplicateTargets[1]!["instrument"] = duplicateTargets[0]!["instrument"];
    expect(decisionLedgerV3Schema.safeParse(duplicate).success).toBe(false);
  });

  it("keeps quantities out of agent-authored intent objects", () => {
    const invalidSingle = cloneJson(singleLedgerRaw);
    (invalidSingle["intent"] as Record<string, unknown>)["totalQuantity"] =
      "12";
    expect(decisionLedgerV3Schema.safeParse(invalidSingle).success).toBe(false);

    const invalidPortfolio = cloneJson(portfolioLedgerRaw);
    const targets = (invalidPortfolio["intent"] as Record<string, unknown>)[
      "targets"
    ] as Array<Record<string, unknown>>;
    targets[0]!["totalQuantity"] = "12";
    expect(decisionLedgerV3Schema.safeParse(invalidPortfolio).success).toBe(
      false,
    );
  });

  it("admits only single intent and returns a stable proposal-only code for portfolio", () => {
    expect(
      initialExecutionAdmission(singleLedger.intent as DecisionIntent),
    ).toEqual({
      kind: "admitted",
    });
    expect(
      initialExecutionAdmission(portfolioLedger.intent as DecisionIntent),
    ).toEqual({
      kind: "proposal_only",
      code: PORTFOLIO_PROPOSAL_ONLY_CODE,
    });
    expect(PORTFOLIO_PROPOSAL_ONLY_CODE).toBe("portfolio_proposal_only");
  });
});

describe("AUTH-CP-D2 Information Snapshot and thesis proof", () => {
  it("requires all five snapshot categories and explicit unavailable notes", () => {
    expect(informationSnapshotSchema.safeParse(singleSnapshotRaw).success).toBe(
      true,
    );
    expect(
      informationSnapshotSchema.safeParse(portfolioSnapshotRaw).success,
    ).toBe(true);

    const missingEvents = cloneJson(singleSnapshotRaw);
    delete missingEvents["events"];
    expect(informationSnapshotSchema.safeParse(missingEvents).success).toBe(
      false,
    );

    const silentUnavailable = cloneJson(singleSnapshotRaw);
    silentUnavailable["events"] = { provided: false };
    expect(informationSnapshotSchema.safeParse(silentUnavailable).success).toBe(
      false,
    );

    const missingRiskEnvelopeIdentity = cloneJson(singleSnapshotRaw);
    missingRiskEnvelopeIdentity["risk"] = {
      provided: false,
      note: "No risk envelope was supplied.",
    };
    expect(
      informationSnapshotSchema.safeParse(missingRiskEnvelopeIdentity).success,
    ).toBe(false);
  });

  it("rejects duplicate open-thesis addresses and duplicate account instruments", () => {
    const duplicateAddress = cloneJson(singleSnapshotRaw);
    const duplicateAddressHistory = duplicateAddress["history"] as Record<
      string,
      unknown
    >;
    const duplicateAddressTheses = duplicateAddressHistory[
      "openTheses"
    ] as Array<Record<string, unknown>>;
    duplicateAddressTheses.push({
      ...duplicateAddressTheses[0]!,
      fingerprint:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    const duplicateAddressResult =
      informationSnapshotSchema.safeParse(duplicateAddress);
    expect(duplicateAddressResult.success).toBe(false);
    if (duplicateAddressResult.success) {
      throw new Error("duplicate open-thesis address unexpectedly parsed");
    }
    const duplicateAddressMessages = duplicateAddressResult.error.issues.map(
      (issue) => issue.message,
    );
    expect(duplicateAddressMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate open thesis address"),
        expect.stringContaining(
          "account-bound snapshot has more than one open thesis for instrument",
        ),
      ]),
    );

    const duplicateInstrument = cloneJson(singleSnapshotRaw);
    const duplicateInstrumentHistory = duplicateInstrument[
      "history"
    ] as Record<string, unknown>;
    const duplicateInstrumentTheses = duplicateInstrumentHistory[
      "openTheses"
    ] as Array<Record<string, unknown>>;
    duplicateInstrumentTheses.push({
      ...duplicateInstrumentTheses[0]!,
      wakeId: "wake-thesis-a-reissued",
      fingerprint:
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    const duplicateInstrumentResult =
      informationSnapshotSchema.safeParse(duplicateInstrument);
    expect(duplicateInstrumentResult.success).toBe(false);
    if (duplicateInstrumentResult.success) {
      throw new Error("duplicate account instrument unexpectedly parsed");
    }
    const duplicateInstrumentMessages =
      duplicateInstrumentResult.error.issues.map((issue) => issue.message);
    expect(duplicateInstrumentMessages).toContainEqual(
      expect.stringContaining(
        "account-bound snapshot has more than one open thesis for instrument",
      ),
    );
    expect(
      duplicateInstrumentMessages.some((message) =>
        message.includes("duplicate open thesis address"),
      ),
    ).toBe(false);
  });

  it("binds snapshot id, wake, and account to the decision", () => {
    expect(
      validateDecisionSnapshotBinding(singleLedger, singleSnapshot),
    ).toEqual([]);
    expect(
      validateDecisionSnapshotBinding(portfolioLedger, portfolioSnapshot),
    ).toEqual([]);

    expect(
      validateDecisionSnapshotBinding(singleLedger, {
        ...singleSnapshot,
        wakeId: "wake-other",
        accountId: "mock-simulator-2",
        snapshotId: "snap:wake-other",
      }),
    ).toEqual([
      "wake_id_mismatch",
      "account_id_mismatch",
      "snapshot_id_mismatch",
      "snapshot_hash_mismatch",
    ]);
  });

  it("pins canonical snapshot hashes and makes every fragment hash semantic", () => {
    expect(canonicalInformationSnapshotHash(singleSnapshotRaw)).toBe(
      fingerprints["informationSnapshotSingle"],
    );
    expect(canonicalInformationSnapshotHash(portfolioSnapshotRaw)).toBe(
      fingerprints["informationSnapshotPortfolio"],
    );

    const changedFragment = cloneJson(singleSnapshotRaw);
    const refs = (changedFragment["market"] as Record<string, unknown>)[
      "refs"
    ] as Array<Record<string, unknown>>;
    refs[0]!["sha256"] =
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    expect(canonicalInformationSnapshotHash(changedFragment)).not.toBe(
      fingerprints["informationSnapshotSingle"],
    );
  });

  it("rejects invalid timestamps and refs from the future of the snapshot", () => {
    expect(
      informationSnapshotSchema.safeParse({
        ...singleSnapshotRaw,
        asOf: "not-an-iso-timestamp",
      }).success,
    ).toBe(false);

    const invalidRefTimestamp = cloneJson(singleSnapshotRaw);
    const invalidRefs = (
      invalidRefTimestamp["portfolio"] as Record<string, unknown>
    )["refs"] as Array<Record<string, unknown>>;
    invalidRefs[0]!["asOf"] = "2026-13-40T99:99:99Z";
    expect(
      informationSnapshotSchema.safeParse(invalidRefTimestamp).success,
    ).toBe(false);

    const futureRef = cloneJson(singleSnapshot);
    if (!futureRef.market.provided)
      throw new Error("fixture market is missing");
    futureRef.market.refs[0]!.asOf = "2026-07-12T10:00:01.000Z";
    expect(validateSnapshotTemporalIntegrity(futureRef)).toEqual([
      "future_ref:market:bar:asset-a:1d:through-2026-07-12",
    ]);
    expect(validateSnapshotTemporalIntegrity(singleSnapshot)).toEqual([]);
  });

  it("requires exactly one disposition for expired or touched open theses", () => {
    expect(
      validateThesisDispositionCoverage(singleLedger, singleSnapshot),
    ).toEqual([]);

    const missing = {
      ...singleLedger,
      thesisDispositions: singleLedger.thesisDispositions.filter(
        (item) => item.wakeId !== "wake-thesis-b",
      ),
    };
    expect(
      validateThesisDispositionCoverage(missing, singleSnapshot),
    ).toContain(
      "required_disposition_count:wake-thesis-b:mock-simulator-1/ASSET-B:0",
    );

    const duplicate = {
      ...singleLedger,
      thesisDispositions: [
        ...singleLedger.thesisDispositions,
        singleLedger.thesisDispositions[0]!,
      ],
    };
    expect(
      validateThesisDispositionCoverage(duplicate, singleSnapshot),
    ).toContain(
      "required_disposition_count:wake-thesis-a:mock-simulator-1/ASSET-A:2",
    );
  });

  it("keeps portfolio sibling theses distinct when they share one wakeId", () => {
    if (!portfolioSnapshot.history.provided) {
      throw new Error("portfolio fixture history is missing");
    }
    expect(portfolioSnapshot.history.openTheses).toHaveLength(2);
    expect(
      new Set(
        portfolioSnapshot.history.openTheses.map((thesis) => thesis.wakeId),
      ).size,
    ).toBe(1);
    const wakeIdOnlyIndex = new Map(
      portfolioSnapshot.history.openTheses.map((thesis) => [
        thesis.wakeId,
        thesis,
      ]),
    );
    expect(wakeIdOnlyIndex.size).toBe(1);
    expect(
      new Set(
        portfolioSnapshot.history.openTheses.map((thesis) =>
          JSON.stringify([thesis.wakeId, thesis.instrument]),
        ),
      ).size,
    ).toBe(2);
    expect(
      validateThesisDispositionCoverage(portfolioLedger, portfolioSnapshot),
    ).toEqual([]);

    for (const missingInstrument of [
      "mock-simulator-1/ASSET-A",
      "mock-simulator-1/ASSET-B",
    ]) {
      const missing = {
        ...portfolioLedger,
        thesisDispositions: portfolioLedger.thesisDispositions.filter(
          (item) => item.instrument !== missingInstrument,
        ),
      };
      expect(
        validateThesisDispositionCoverage(missing, portfolioSnapshot),
      ).toContain(
        `required_disposition_count:wake-thesis-portfolio:${missingInstrument}:0`,
      );
    }

    const collapsed = {
      ...portfolioLedger,
      thesisDispositions: portfolioLedger.thesisDispositions.map((item) =>
        item.instrument === "mock-simulator-1/ASSET-B"
          ? { ...item, instrument: "mock-simulator-1/ASSET-A" }
          : item,
      ),
    };
    expect(
      validateThesisDispositionCoverage(collapsed, portfolioSnapshot),
    ).toEqual(
      expect.arrayContaining([
        "required_disposition_count:wake-thesis-portfolio:mock-simulator-1/ASSET-A:2",
        "required_disposition_count:wake-thesis-portfolio:mock-simulator-1/ASSET-B:0",
      ]),
    );
  });

  it("rejects contradictory duplicate dispositions even for an optional thesis", () => {
    const optionalSnapshotRaw = cloneJson(singleSnapshotRaw);
    const optionalHistory = optionalSnapshotRaw["history"] as Record<
      string,
      unknown
    >;
    const optionalOpenTheses = optionalHistory["openTheses"] as Array<
      Record<string, unknown>
    >;
    optionalOpenTheses.push({
      wakeId: "wake-thesis-optional",
      fingerprint:
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      instrument: "mock-simulator-1/ASSET-C",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    const optionalSnapshot =
      informationSnapshotSchema.parse(optionalSnapshotRaw);
    const duplicateOptional = {
      ...singleLedger,
      thesisDispositions: [
        ...singleLedger.thesisDispositions,
        {
          wakeId: "wake-thesis-optional",
          instrument: "mock-simulator-1/ASSET-C",
          disposition: "keep" as const,
          note: "Keep the untouched optional thesis open.",
        },
        {
          wakeId: "wake-thesis-optional",
          instrument: "mock-simulator-1/ASSET-C",
          disposition: "invalidate" as const,
          note: "Contradict the prior disposition for the same thesis.",
        },
      ],
    };

    const schemaResult = decisionLedgerV3Schema.safeParse(duplicateOptional);
    expect(schemaResult.success).toBe(false);
    if (schemaResult.success) {
      throw new Error("duplicate thesis dispositions unexpectedly parsed");
    }
    expect(schemaResult.error.issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining("duplicate thesis disposition identity"),
    );

    const coverageErrors = validateThesisDispositionCoverage(
      duplicateOptional,
      optionalSnapshot,
    );
    expect(coverageErrors).toContain(
      "duplicate_thesis_disposition:wake-thesis-optional:mock-simulator-1/ASSET-C",
    );
    expect(
      coverageErrors.some((error) =>
        error.startsWith(
          "required_disposition_count:wake-thesis-optional:mock-simulator-1/ASSET-C:",
        ),
      ),
    ).toBe(false);
  });

  it("rejects supersede when the replacement intent does not touch that instrument", () => {
    const invalid = {
      ...singleLedger,
      thesisDispositions: singleLedger.thesisDispositions.map((item) =>
        item.wakeId === "wake-thesis-b"
          ? { ...item, disposition: "supersede" as const }
          : item,
      ),
    };
    expect(
      validateThesisDispositionCoverage(invalid, singleSnapshot),
    ).toContain(
      "supersede_without_replacement:wake-thesis-b:mock-simulator-1/ASSET-B",
    );
  });

  it("rejects keep for an already expired thesis", () => {
    const invalid = {
      ...singleLedger,
      thesisDispositions: singleLedger.thesisDispositions.map((item) =>
        item.wakeId === "wake-thesis-b"
          ? { ...item, disposition: "keep" as const }
          : item,
      ),
    };
    expect(
      validateThesisDispositionCoverage(invalid, singleSnapshot),
    ).toContain(
      "expired_thesis_cannot_keep:wake-thesis-b:mock-simulator-1/ASSET-B",
    );
  });
});

describe("AUTH-CP-D2 Risk Envelope proof", () => {
  it("accepts one complete strict envelope and fails closed for missing/null/partial input", () => {
    expect(riskEnvelopeSchema.safeParse(riskEnvelopeRaw).success).toBe(true);
    expect(
      riskEnvelopeSchema.safeParse({
        ...riskEnvelopeRaw,
        maxPositionPctOfEquity: 0,
        maxSingleOrderPctOfEquity: 0,
        maxDailyLossPct: 0,
        maxDrawdownPct: 0,
      }).success,
    ).toBe(true);
    expect(riskEnvelopeSchema.safeParse(undefined).success).toBe(false);
    expect(riskEnvelopeSchema.safeParse(null).success).toBe(false);

    const partial = cloneJson(riskEnvelopeRaw);
    delete partial["maxDrawdownPct"];
    expect(riskEnvelopeSchema.safeParse(partial).success).toBe(false);

    expect(
      riskEnvelopeSchema.safeParse({ ...riskEnvelopeRaw, unexpectedLimit: 99 })
        .success,
    ).toBe(false);
    expect(
      riskEnvelopeSchema.safeParse({
        ...riskEnvelopeRaw,
        scope: { kind: "asset_class", assetClasses: ["future-class-id"] },
      }).success,
    ).toBe(true);
  });

  it("makes revoke state and reason structurally consistent", () => {
    expect(
      riskEnvelopeSchema.safeParse({
        ...riskEnvelopeRaw,
        revoked: true,
        revokedReason: "Human emergency stop.",
      }).success,
    ).toBe(true);
    expect(
      riskEnvelopeSchema.safeParse({
        ...riskEnvelopeRaw,
        revoked: true,
        revokedReason: null,
      }).success,
    ).toBe(false);
    expect(
      riskEnvelopeSchema.safeParse({
        ...riskEnvelopeRaw,
        revoked: false,
        revokedReason: "stale reason",
      }).success,
    ).toBe(false);
  });
});

describe("AUTH-CP-D2 M2 tool-receipt proof", () => {
  it("accepts only authoritative, identity-bound tool-surface receipts", () => {
    expect(m2ToolReceiptSchema.safeParse(m2ToolReceiptRaw).success).toBe(true);
    expect(
      m2ToolReceiptSchema.safeParse({
        ...m2ToolReceiptRaw,
        producer: "supervisor",
      }).success,
    ).toBe(false);
    expect(
      m2ToolReceiptSchema.safeParse({
        ...m2ToolReceiptRaw,
        snapshotId: "snap:wake-other",
      }).success,
    ).toBe(false);
    expect(
      m2ToolReceiptSchema.safeParse({
        ...m2ToolReceiptRaw,
        completedAt: "not-an-iso-timestamp",
      }).success,
    ).toBe(false);
    expect(
      m2ToolReceiptSchema.safeParse({
        ...m2ToolReceiptRaw,
        completedAt: "2026-07-12T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("is idempotent for identical append and rejects a conflicting duplicate", () => {
    const receipt = m2ToolReceiptSchema.parse(m2ToolReceiptRaw);
    const once = appendM2ToolReceipt([], receipt, m2AppendContext);
    const twice = appendM2ToolReceipt(
      once,
      cloneJson(receipt),
      m2AppendContext,
    );
    expect(twice).toEqual([receipt]);

    const conflicting = cloneJson(receipt);
    conflicting.response.ref = "tool-response:conflicting-copy";
    expect(() =>
      appendM2ToolReceipt(once, conflicting, m2AppendContext),
    ).toThrow(/m2_tool_receipt_conflict/);
  });

  it("rejects first append when actual wake/account/snapshot/tool/response bytes differ", () => {
    const receipt = m2ToolReceiptSchema.parse(m2ToolReceiptRaw);
    for (const context of [
      { ...m2AppendContext, wakeId: "wake-other" },
      { ...m2AppendContext, accountId: "mock-simulator-2" },
      { ...m2AppendContext, snapshotId: "snap:wake-other" },
      { ...m2AppendContext, toolCallId: "tool-call:other" },
      { ...m2AppendContext, toolName: "getPositions" },
      {
        ...m2AppendContext,
        responseBytes: Buffer.from('{"risk":"HALTED"}', "utf8"),
      },
    ]) {
      expect(() => appendM2ToolReceipt([], receipt, context)).toThrow(
        /m2_tool_receipt_context/,
      );
    }
  });
});

describe("AUTH-CP-D2 broker-capability protection proof", () => {
  it.each(brokerProtectionCases.cases)(
    "$name",
    ({ capabilities, request, expected }) => {
      expect(selectProtection(capabilities, request)).toEqual(expected);
    },
  );

  it("requires an explicit deterministic offset for STP_LMT capability", () => {
    expect(() =>
      selectProtection(
        {
          market: true,
          stop: false,
          stopLimit: { supported: true },
        },
        {
          kind: "future_protective_entry",
          operationId: "operation:entry:asset-a",
          instrument: "mock-simulator-1/ASSET-A",
          entrySide: "BUY",
          triggerPrice: "94.2",
        },
      ),
    ).toThrow();
  });

  it("forbids proposal/clipped SizingOutcome from representing naked exposure", () => {
    const naked = cloneJson(executionRecordRaw);
    const sizingOutcome = naked["sizingOutcome"] as Record<string, unknown>;
    sizingOutcome["protections"] = [];
    expect(deterministicExecutionRecordSchema.safeParse(naked).success).toBe(
      false,
    );

    const nakedClipped = cloneJson(executionRecordRaw);
    const clippedOutcome = nakedClipped["sizingOutcome"] as Record<
      string,
      unknown
    >;
    clippedOutcome["kind"] = "clipped";
    clippedOutcome["clippedFrom"] = { minPct: 20, maxPct: 30 };
    clippedOutcome["protections"] = [];
    expect(
      deterministicExecutionRecordSchema.safeParse(nakedClipped).success,
    ).toBe(false);
  });

  it("rejects duplicate/unknown/wrong-instrument/wrong-side operation bindings", () => {
    expect(
      deterministicExecutionRecordSchema.safeParse(executionRecordRaw).success,
    ).toBe(true);

    const sizing = (value: Record<string, unknown>) =>
      value["sizingOutcome"] as Record<string, unknown>;
    const protections = (value: Record<string, unknown>) =>
      sizing(value)["protections"] as Array<Record<string, unknown>>;

    const duplicate = cloneJson(executionRecordRaw);
    protections(duplicate).push(cloneJson(protections(duplicate)[0]!));
    expect(
      deterministicExecutionRecordSchema.safeParse(duplicate).success,
    ).toBe(false);

    const duplicateOperation = cloneJson(executionRecordRaw);
    const operations = sizing(duplicateOperation)["operations"] as Array<
      Record<string, unknown>
    >;
    operations.push(cloneJson(operations[0]!));
    expect(
      deterministicExecutionRecordSchema.safeParse(duplicateOperation).success,
    ).toBe(false);

    for (const [field, value] of [
      ["operationId", "operation:unknown"],
      ["instrument", "mock-simulator-1/ASSET-B"],
      ["exitSide", "BUY"],
    ] as const) {
      const invalid = cloneJson(executionRecordRaw);
      protections(invalid)[0]![field] = value;
      expect(
        deterministicExecutionRecordSchema.safeParse(invalid).success,
        field,
      ).toBe(false);
    }
  });

  it("requires no protection for reduce-only operations", () => {
    const reduceOnly = cloneJson(executionRecordRaw);
    const sizingOutcome = reduceOnly["sizingOutcome"] as Record<
      string,
      unknown
    >;
    sizingOutcome["operations"] = [
      {
        operationId: "operation:reduce:asset-a",
        kind: "position_close",
        effect: "reduce",
        instrument: "mock-simulator-1/ASSET-A",
        side: "SELL",
        totalQuantity: "12",
      },
    ];
    sizingOutcome["protections"] = [];
    expect(
      deterministicExecutionRecordSchema.safeParse(reduceOnly).success,
    ).toBe(true);

    const wronglyProtected = cloneJson(reduceOnly);
    (wronglyProtected["sizingOutcome"] as Record<string, unknown>)[
      "protections"
    ] = [
      {
        kind: "selected",
        operationId: "operation:reduce:asset-a",
        instrument: "mock-simulator-1/ASSET-A",
        exitSide: "BUY",
        orderType: "STP",
        triggerPrice: "94.2",
      },
    ];
    expect(
      deterministicExecutionRecordSchema.safeParse(wronglyProtected).success,
    ).toBe(false);
  });
});

describe("AUTH-CP-D2 fingerprint and audit-linkage goldens", () => {
  it("preserves the exact legacy v2 golden after appending v3 semantic keys", () => {
    expect(canonicalDecisionFingerprintV3(ledgerV2Raw)).toBe(
      LEGACY_V2_GOLDEN_FINGERPRINT,
    );
    expect(fingerprints["legacyLedgerV2"]).toBe(LEGACY_V2_GOLDEN_FINGERPRINT);
  });

  it("pins v3 ledger and raw intent fingerprints", () => {
    expect(canonicalDecisionFingerprintV3(singleLedgerRaw)).toBe(
      fingerprints["ledgerV3Single"],
    );
    expect(canonicalDecisionFingerprintV3(portfolioLedgerRaw)).toBe(
      fingerprints["ledgerV3Portfolio"],
    );
    expect(canonicalIntentFingerprint(singleLedgerRaw["intent"])).toBe(
      fingerprints["singleIntent"],
    );
    expect(canonicalIntentFingerprint(portfolioLedgerRaw["intent"])).toBe(
      fingerprints["portfolioIntent"],
    );
  });

  it("treats decision, intent, and thesisDispositions as raw semantic data", () => {
    const normalizedRawDecision = {
      ...ledgerV2Raw,
      decision: "propose_trade",
    };
    const forbiddenNormalization = {
      ...normalizedRawDecision,
      decision: "propose_change",
    };
    expect(canonicalDecisionFingerprintV3(normalizedRawDecision)).not.toBe(
      canonicalDecisionFingerprintV3(forbiddenNormalization),
    );

    const changedIntent = cloneJson(singleLedgerRaw);
    const targetExposure = (changedIntent["intent"] as Record<string, unknown>)[
      "targetExposure"
    ] as Record<string, unknown>;
    targetExposure["maxPct"] = 16;
    expect(canonicalDecisionFingerprintV3(changedIntent)).not.toBe(
      fingerprints["ledgerV3Single"],
    );

    const changedDisposition = cloneJson(singleLedgerRaw);
    const dispositions = changedDisposition["thesisDispositions"] as Array<
      Record<string, unknown>
    >;
    dispositions[0]!["disposition"] = "keep";
    expect(canonicalDecisionFingerprintV3(changedDisposition)).not.toBe(
      fingerprints["ledgerV3Single"],
    );
  });

  it("keeps deterministic sizing/execution separate and links it by intent fingerprint", () => {
    expect(executionRecord.intentFingerprint).toBe(
      canonicalIntentFingerprint(singleLedger.intent),
    );
    expect(executionRecord.decisionWakeId).toBe(singleLedger.wakeId);
    expect(executionRecord.snapshotId).toBe(singleLedger.intent?.snapshotId);
    expect(executionRecord.snapshotSha256).toBe(
      singleLedger.intent?.snapshotSha256,
    );
    expect(executionRecord.sizingOutcome.kind).toBe("proposal");
    expect(singleLedgerRaw).not.toHaveProperty("sizingOutcome");
    expect(JSON.stringify(singleLedgerRaw["intent"])).not.toContain(
      "totalQuantity",
    );
    expect(JSON.stringify(executionRecord.sizingOutcome)).toContain(
      "totalQuantity",
    );
    const ledgerBefore = JSON.stringify(singleLedger);
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        singleSnapshot,
        riskEnvelope,
        executionRecord,
      ),
    ).toEqual([]);
    expect(JSON.stringify(singleLedger)).toBe(ledgerBefore);
  });

  it("rejects every ledger-to-execution identity mismatch", () => {
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        singleSnapshot,
        riskEnvelope,
        { ...executionRecord, intentFingerprint: "f".repeat(64) },
      ),
    ).toContain("intent_fingerprint_mismatch");
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        singleSnapshot,
        riskEnvelope,
        {
          ...executionRecord,
          decisionWakeId: "wake-other",
          accountId: "mock-simulator-2",
          snapshotId: "snap:wake-other",
          envelopeVersion: 4,
        },
      ),
    ).toEqual([
      "record_wake_id_mismatch",
      "record_account_id_mismatch",
      "record_snapshot_id_mismatch",
      "envelope_version_mismatch",
    ]);
  });

  it("fails closed for same-id mutation, substituted snapshot, missing risk, and temporal drift", () => {
    const sameIdMutationRaw = cloneJson(singleSnapshotRaw);
    const marketRefs = (sameIdMutationRaw["market"] as Record<string, unknown>)[
      "refs"
    ] as Array<Record<string, unknown>>;
    marketRefs[0]!["sha256"] =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const sameIdMutation = informationSnapshotSchema.parse(sameIdMutationRaw);
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        sameIdMutation,
        riskEnvelope,
        executionRecord,
      ),
    ).toEqual(["snapshot_hash_mismatch", "record_snapshot_hash_mismatch"]);

    const substituted = validateExecutionRecordLinkage(
      singleLedger,
      portfolioSnapshot,
      riskEnvelope,
      executionRecord,
    );
    expect(substituted).toContain("wake_id_mismatch");
    expect(substituted).toContain("snapshot_id_mismatch");
    expect(substituted).toContain("snapshot_hash_mismatch");
    expect(substituted).toContain("record_snapshot_id_mismatch");
    expect(substituted).toContain("record_snapshot_hash_mismatch");

    const missingRiskRaw = cloneJson(singleSnapshotRaw);
    missingRiskRaw["risk"] = {
      provided: false,
      envelopeVersion: null,
      note: "Risk input is absent.",
    };
    const missingRisk = informationSnapshotSchema.parse(missingRiskRaw);
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        missingRisk,
        riskEnvelope,
        executionRecord,
      ),
    ).toContain("snapshot_risk_missing");

    const futureRef = cloneJson(singleSnapshot);
    if (!futureRef.market.provided)
      throw new Error("fixture market is missing");
    futureRef.market.refs[0]!.asOf = "2026-07-12T10:00:01.000Z";
    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        futureRef,
        riskEnvelope,
        executionRecord,
      ),
    ).toContain("future_ref:market:bar:asset-a:1d:through-2026-07-12");

    expect(
      validateExecutionRecordLinkage(
        singleLedger,
        singleSnapshot,
        { ...riskEnvelope, version: 4 },
        executionRecord,
      ),
    ).toEqual([
      "envelope_version_mismatch",
      "snapshot_envelope_version_mismatch",
    ]);
  });
});

describe("AUTH-CP-D2 production isolation", () => {
  function productionFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...productionFiles(path));
        continue;
      }
      if (![".ts", ".mjs"].includes(extname(entry.name))) continue;
      if (entry.name.includes(".spec.")) continue;
      files.push(path);
    }
    return files;
  }

  it("has no production import or export of the contract-proof oracle", () => {
    const offenders = ["src", "services", "packages"]
      .flatMap((dir) => productionFiles(join(repoRoot, dir)))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (
          source.includes("steward-contract-proof") ||
          source.includes("contract-proof-d2")
        );
      });
    expect(offenders).toEqual([]);
  });
});
