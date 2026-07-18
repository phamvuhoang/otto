import { describe, expect, it } from "vitest";

import {
  ineligibleReason,
  outcomeForFindings,
  revisionKey,
  type PullRequestRevision,
} from "../pr-review.js";
import type { Finding } from "../review-severity.js";

const SHA = "a".repeat(40);
const FINGERPRINT = "b".repeat(64);

function makeRevision(
  overrides: Partial<PullRequestRevision> = {}
): PullRequestRevision {
  return {
    repository: "acme/web",
    number: 42,
    url: "https://github.com/acme/web/pull/42",
    title: "Add feature",
    body: "Some body",
    author: "octocat",
    state: "OPEN",
    isDraft: false,
    labels: ["otto-review"],
    baseRefName: "main",
    baseSha: "c".repeat(40),
    headSha: SHA,
    changedFiles: ["src/foo.ts"],
    ...overrides,
  };
}

const finding: Finding = {
  severity: "nit",
  file: "src/foo.ts",
  claim: "claim",
  why: "why",
};

describe("revisionKey", () => {
  it("builds repo#number@sha:fingerprint", () => {
    expect(
      revisionKey(
        { repository: "acme/web", number: 42, headSha: SHA },
        FINGERPRINT
      )
    ).toBe(`acme/web#42@${SHA}:${FINGERPRINT}`);
  });

  it("rejects a fingerprint that is not 64-char lower-case hex", () => {
    expect(() =>
      revisionKey({ repository: "acme/web", number: 42, headSha: SHA }, "short")
    ).toThrow();
    expect(() =>
      revisionKey(
        { repository: "acme/web", number: 42, headSha: SHA },
        "B".repeat(64) // uppercase not allowed
      )
    ).toThrow();
    expect(() =>
      revisionKey(
        { repository: "acme/web", number: 42, headSha: SHA },
        "g".repeat(64) // not hex
      )
    ).toThrow();
  });
});

describe("ineligibleReason", () => {
  it("returns null for an eligible open, non-draft, labelled PR", () => {
    expect(ineligibleReason(makeRevision(), "otto-review")).toBeNull();
  });

  it("rejects a closed PR", () => {
    expect(
      ineligibleReason(makeRevision({ state: "CLOSED" }), "otto-review")
    ).toBe("closed");
  });

  it("rejects a merged PR (bucketed as closed)", () => {
    expect(
      ineligibleReason(makeRevision({ state: "MERGED" }), "otto-review")
    ).toBe("closed");
  });

  it("rejects a draft PR", () => {
    expect(
      ineligibleReason(makeRevision({ isDraft: true }), "otto-review")
    ).toBe("draft");
  });

  it("rejects a PR missing the required label", () => {
    expect(
      ineligibleReason(makeRevision({ labels: ["other"] }), "otto-review")
    ).toBe("label-missing");
  });

  it("rejects a PR with no labels at all", () => {
    expect(ineligibleReason(makeRevision({ labels: [] }), "otto-review")).toBe(
      "label-missing"
    );
  });
});

describe("outcomeForFindings", () => {
  it("blocker → changes-requested", () => {
    expect(outcomeForFindings([{ ...finding, severity: "blocker" }])).toBe(
      "changes-requested"
    );
  });

  it("major → changes-requested", () => {
    expect(outcomeForFindings([{ ...finding, severity: "major" }])).toBe(
      "changes-requested"
    );
  });

  it("minor only → comment", () => {
    expect(outcomeForFindings([{ ...finding, severity: "minor" }])).toBe(
      "comment"
    );
  });

  it("nit only → comment", () => {
    expect(outcomeForFindings([{ ...finding, severity: "nit" }])).toBe(
      "comment"
    );
  });

  it("no findings → approved", () => {
    expect(outcomeForFindings([])).toBe("approved");
  });

  it("a mix with a blocker present still requests changes", () => {
    expect(
      outcomeForFindings([
        { ...finding, severity: "nit" },
        { ...finding, severity: "blocker" },
      ])
    ).toBe("changes-requested");
  });
});
