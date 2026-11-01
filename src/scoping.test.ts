import { describe, expect, it } from "vitest";
import {
  assertMintedTokenMatches,
  buildTokenPolicies,
  buildTokenRequest,
  clampTtl,
  R2_BUCKET_RESOURCE,
  toCloudflareTimestamp,
  WORKER_SCRIPT_RESOURCE,
  workerNameFor,
  workerResource,
  r2BucketResource,
} from "./scoping.js";

describe("worker names", () => {
  it("derives a prefixed, valid, attributable name", () => {
    const name = workerNameFor("pct-", "ad2b3405-6641-4d7d-b5eb-47887b4aa36b", "abcdef123");
    expect(name.startsWith("pct-")).toBe(true);
    expect(name).toContain("ad2b3405");
  });

  it("varies with randomness and stays valid", () => {
    const a = workerNameFor("pct-", "ad2b3405-6641-4d7d-b5eb-47887b4aa36b", "aaaaaa");
    const b = workerNameFor("pct-", "ad2b3405-6641-4d7d-b5eb-47887b4aa36b", "bbbbbb");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
  });
});

describe("token policies", () => {
  const policies = buildTokenPolicies({
    accountId: "acct-1",
    workerId: "wid-pct-abc",
    bucketName: "pct-abc",
    workerAdminGroupId: "grp-worker-admin",
    r2ItemWriteGroupId: "grp-r2-item-write",
  });

  it("grants exactly two allowances: one Worker, one bucket", () => {
    expect(policies).toHaveLength(2);
    expect(policies[0]).toEqual({
      effect: "allow",
      resources: { [`${WORKER_SCRIPT_RESOURCE}.wid-pct-abc`]: "*" },
      permission_groups: [{ id: "grp-worker-admin" }],
    });
    expect(policies[1]).toEqual({
      effect: "allow",
      resources: { [`${R2_BUCKET_RESOURCE}.acct-1_default_pct-abc`]: "*" },
      permission_groups: [{ id: "grp-r2-item-write" }],
    });
  });

  it("never references other workers or buckets", () => {
    const serialized = JSON.stringify(policies);
    for (const other of ["prod-worker-alpha", "prod-worker-beta", "shared-bucket"]) {
      expect(serialized).not.toContain(other);
    }
  });

  it("resource builders emit the exact documented shapes", () => {
    expect(workerResource("a", "w")).toEqual({ [`${WORKER_SCRIPT_RESOURCE}.w`]: "*" });
    expect(r2BucketResource("a", "b")).toEqual({ [`${R2_BUCKET_RESOURCE}.a_default_b`]: "*" });
  });
});

describe("token request", () => {
  it("sets expiry, not-before and the egress IP filter", () => {
    const now = Date.parse("2026-11-01T19:30:00.000Z");
    const req = buildTokenRequest({
      name: "pct-x-token",
      policies: buildTokenPolicies({
        accountId: "a",
        workerId: "w",
        bucketName: "b",
        workerAdminGroupId: "g1",
        r2ItemWriteGroupId: "g2",
      }),
      nowMs: now,
      ttlSeconds: 3600,
      egressCidr: "203.0.113.0/24",
    });
    expect(req.expires_on).toBe("2026-11-01T20:30:00Z");
    expect(req.not_before).toBe("2026-11-01T19:30:00Z");
    expect(req.condition).toEqual({ "request.ip": { in: ["203.0.113.0/24"] } });
  });

  it("fails closed without an egress CIDR or policies", () => {
    const policies = buildTokenPolicies({
      accountId: "a",
      workerId: "w",
      bucketName: "b",
      workerAdminGroupId: "g1",
      r2ItemWriteGroupId: "g2",
    });
    expect(() =>
      buildTokenRequest({ name: "t", policies, nowMs: 0, ttlSeconds: 60, egressCidr: "" }),
    ).toThrow(/egress/i);
    expect(() =>
      buildTokenRequest({ name: "t", policies: [], nowMs: 0, ttlSeconds: 60, egressCidr: "10.0.0.0/8" }),
    ).toThrow(/policies/);
  });
});

describe("token timestamps", () => {
  it("strips milliseconds to the documented second precision", () => {
    expect(toCloudflareTimestamp(Date.parse("2026-11-01T19:30:00.000Z"))).toBe("2026-11-01T19:30:00Z");
  });
});

describe("assertMintedTokenMatches", () => {
  const policies = buildTokenPolicies({
    accountId: "a",
    workerId: "w",
    bucketName: "b",
    workerAdminGroupId: "g1",
    r2ItemWriteGroupId: "g2",
  });
  const expected = { policies, expiresOn: "2026-11-01T20:30:00Z", egressCidr: "203.0.113.0/24" };
  const minted = {
    id: "tok-1",
    policies,
    expires_on: "2026-11-01T20:30:00Z",
    condition: { "request.ip": { in: ["203.0.113.0/24"] } },
  };

  it("accepts a token that matches the request exactly", () => {
    expect(() => assertMintedTokenMatches(minted, expected)).not.toThrow();
  });

  it("rejects a dropped IP condition, a later expiry, and shape drift", () => {
    expect(() => assertMintedTokenMatches({ ...minted, condition: {} }, expected)).toThrow(/verification/);
    expect(() =>
      assertMintedTokenMatches({ ...minted, condition: { request_ip: { in: ["203.0.113.0/24"] } } }, expected),
    ).toThrow(/verification/);
    expect(() =>
      assertMintedTokenMatches({ ...minted, expires_on: "2026-11-01T21:30:00Z" }, expected),
    ).toThrow(/verification/);
    expect(() => assertMintedTokenMatches({ ...minted, policies: [policies[0]] }, expected)).toThrow(
      /verification/,
    );
    expect(() =>
      assertMintedTokenMatches(
        { ...minted, policies: [...policies, { effect: "allow", resources: { "*": "*" }, permission_groups: [] }] },
        expected,
      ),
    ).toThrow(/verification/);
    const swapped = [{ ...policies[1] }, { ...policies[0] }] as typeof policies;
    expect(() => assertMintedTokenMatches({ ...minted, policies: swapped }, expected)).not.toThrow();
  });
});

describe("clampTtl", () => {
  it("defaults to the max and enforces the cap", () => {
    expect(clampTtl(undefined, 10800)).toBe(10800);
    expect(clampTtl(60, 10800)).toBe(60);
    expect(() => clampTtl(10801, 10800)).toThrow(/exceeds/);
    expect(() => clampTtl(0, 10800)).toThrow(/positive/);
    expect(() => clampTtl(-5, 10800)).toThrow(/positive/);
  });
});
