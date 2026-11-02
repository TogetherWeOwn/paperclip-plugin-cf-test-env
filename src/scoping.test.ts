import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RESOURCE,
  assertMintedTokenMatches,
  buildTokenPolicies,
  buildTokenRequest,
  clampTtl,
  normalizeCidr,
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
    workerTag: "tag-pct-abc",
    bucketName: "pct-abc",
    workerAdminGroupId: "grp-worker-admin",
    r2ItemWriteGroupId: "grp-r2-item-write",
  });

  it("grants exactly two allowances: one Worker, one bucket", () => {
    expect(policies).toHaveLength(2);
    expect(policies[0]).toEqual({
      effect: "allow",
      resources: { [`${ACCOUNT_RESOURCE}.acct-1`]: { [`${WORKER_SCRIPT_RESOURCE}.tag-pct-abc`]: "*" } },
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

  it("resource builders emit the exact canary-verified shapes", () => {
    // Canary 2026-11-01: the Worker allowance MUST nest under the account key
    // and key on the script tag — a flat key fails token creation (500 1004).
    // The R2 allowance stays flat (nested is rejected with 400 1001).
    expect(workerResource("a", "tag-w")).toEqual({
      [`${ACCOUNT_RESOURCE}.a`]: { [`${WORKER_SCRIPT_RESOURCE}.tag-w`]: "*" },
    });
    expect(r2BucketResource("a", "b")).toEqual({ [`${R2_BUCKET_RESOURCE}.a_default_b`]: "*" });
  });

  it("scopes the Worker to the script tag, never the script name", () => {
    const serialized = JSON.stringify(workerResource("acct-1", "tag-pct-abc"));
    expect(serialized).toContain("tag-pct-abc");
    expect(serialized).not.toMatch(/script\.pct-/);
  });
});

describe("token request", () => {
  it("sets expiry, not-before and the egress IP filter list", () => {
    const now = Date.parse("2026-11-01T19:30:00.000Z");
    const req = buildTokenRequest({
      name: "pct-x-token",
      policies: buildTokenPolicies({
        accountId: "a",
        workerTag: "tag-w",
        bucketName: "b",
        workerAdminGroupId: "g1",
        r2ItemWriteGroupId: "g2",
      }),
      nowMs: now,
      ttlSeconds: 3600,
      egressCidrs: ["203.0.113.10/32", "2001:db8:8:cb76::/64"],
    });
    expect(req.expires_on).toBe("2026-11-01T20:30:00Z");
    expect(req.not_before).toBe("2026-11-01T19:30:00Z");
    expect(req.condition).toEqual({ "request.ip": { in: ["203.0.113.10/32", "2001:db8:8:cb76::/64"] } });
  });

  it("fails closed without egress CIDRs, with empty entries, or without policies", () => {
    const policies = buildTokenPolicies({
      accountId: "a",
      workerTag: "tag-w",
      bucketName: "b",
      workerAdminGroupId: "g1",
      r2ItemWriteGroupId: "g2",
    });
    expect(() =>
      buildTokenRequest({ name: "t", policies, nowMs: 0, ttlSeconds: 60, egressCidrs: [] }),
    ).toThrow(/egress/i);
    expect(() =>
      buildTokenRequest({ name: "t", policies, nowMs: 0, ttlSeconds: 60, egressCidrs: ["10.0.0.0/8", " "] }),
    ).toThrow(/egress/i);
    expect(() =>
      buildTokenRequest({ name: "t", policies: [], nowMs: 0, ttlSeconds: 60, egressCidrs: ["10.0.0.0/8"] }),
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
    workerTag: "tag-w",
    bucketName: "b",
    workerAdminGroupId: "g1",
    r2ItemWriteGroupId: "g2",
  });
  const expected = {
    policies,
    expiresOn: "2026-11-01T20:30:00Z",
    egressCidrs: ["203.0.113.10/32", "2001:db8:8:cb76::/64"],
  };
  const minted = {
    id: "tok-1",
    policies,
    expires_on: "2026-11-01T20:30:00Z",
    condition: { "request.ip": { in: ["203.0.113.10/32", "2001:db8:8:cb76::/64"] } },
  };

  it("accepts a token that matches the request exactly", () => {
    expect(() => assertMintedTokenMatches(minted, expected)).not.toThrow();
  });

  it("accepts the CIDR list in any order but rejects a missing entry", () => {
    const reordered = {
      ...minted,
      condition: { "request.ip": { in: ["2001:db8:8:cb76::/64", "203.0.113.10/32"] } },
    };
    expect(() => assertMintedTokenMatches(reordered, expected)).not.toThrow();
    // A token filtered to only one family would 401 on the other, so a
    // stored token missing a requested CIDR must fail verification.
    const partial = {
      ...minted,
      condition: { "request.ip": { in: ["203.0.113.10/32"] } },
    };
    expect(() => assertMintedTokenMatches(partial, expected)).toThrow(/verification/);
  });

  it("accepts CIDRs Cloudflare spells differently but means the same", () => {
    // Cloudflare may store the IPv6 /64 expanded, upper-cased or
    // zero-padded. The raw-string comparison revoked such tokens even
    // though the granted networks were exactly those requested.
    const respelt: string[][] = [
      ["203.0.113.10/32", "2001:0db8:0008:cb76:0000:0000:0000:0000/64"],
      ["203.0.113.10/32", "2001:DB8:8:CB76::/64"],
      ["203.0.113.10/32", "2001:db8:0008:cb76:0:0:0:0/64"],
      // Host bits set within the prefix still name the same network.
      ["203.0.113.10/32", "2001:db8:8:cb76:dead:beef:0:1/64"],
      // A bare host address is the full-length prefix.
      ["203.0.113.10", "2001:db8:8:cb76::/64"],
    ];
    for (const list of respelt) {
      const actual = { ...minted, condition: { "request.ip": { in: list } } };
      expect(() => assertMintedTokenMatches(actual, expected), JSON.stringify(list)).not.toThrow();
    }
  });

  it("rejects genuinely different CIDR lists however they are spelled", () => {
    const different: string[][] = [
      // Different IPv6 network.
      ["203.0.113.10/32", "2001:db8:8:cb77::/64"],
      // Different IPv4 network.
      ["203.0.113.11/32", "2001:db8:8:cb76::/64"],
      // Wider and narrower prefixes are different grants.
      ["203.0.113.0/24", "2001:db8:8:cb76::/64"],
      ["203.0.113.10/32", "2001:db8:8::/48"],
      ["203.0.113.10/32", "2001:db8:8:cb76::/128"],
      // Extra entry, and a duplicate masking a missing entry.
      ["203.0.113.10/32", "2001:db8:8:cb76::/64", "10.0.0.0/8"],
      ["203.0.113.10/32", "203.0.113.10/32"],
      // Unparsable entries never match, on either side of the comparison.
      ["203.0.113.10/32", "not-a-cidr"],
      ["203.0.113.10/32", "2001:db8:8:cb76::/129"],
    ];
    for (const list of different) {
      const actual = { ...minted, condition: { "request.ip": { in: list } } };
      expect(() => assertMintedTokenMatches(actual, expected), JSON.stringify(list)).toThrow(/CIDR list/);
    }
  });

  it("rejects matching unparsable entries on both sides", () => {
    // Without the `v !== null` guard in assertMintedTokenMatches, the same
    // unparsable entry on both sides would normalize to null === null in
    // the sorted comparison and pass. Pin the fail-closed behaviour.
    const badExpected = { ...expected, egressCidrs: ["203.0.113.10/32", "not-a-cidr"] };
    const badActual = { ...minted, condition: { "request.ip": { in: ["203.0.113.10/32", "not-a-cidr"] } } };
    expect(() => assertMintedTokenMatches(badActual, badExpected)).toThrow(/CIDR list/);
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

  it("rejects a widened resource value even when the resource key matches", () => {
    // Same top-level account key as the legit nested Worker policy, but the
    // string value covers the whole account instead of one script tag.
    const broadened = policies.map((p) => ({ ...p }));
    broadened[0] = {
      ...broadened[0]!,
      resources: { "com.cloudflare.api.account.a": "*" },
    };
    expect(() => assertMintedTokenMatches({ ...minted, policies: broadened }, expected)).toThrow(
      /policies differ/,
    );
    // Same key, different leaf value.
    const changedValue = policies.map((p) => ({ ...p }));
    changedValue[1] = {
      ...changedValue[1]!,
      resources: { [`${R2_BUCKET_RESOURCE}.a_default_b`]: "partial" },
    };
    expect(() => assertMintedTokenMatches({ ...minted, policies: changedValue }, expected)).toThrow(
      /policies differ/,
    );
  });

  it("rejects a swapped permission group and a changed effect", () => {
    const regrouped = policies.map((p) => ({ ...p }));
    regrouped[0] = { ...regrouped[0]!, permission_groups: [{ id: "grp-something-broader" }] };
    expect(() => assertMintedTokenMatches({ ...minted, policies: regrouped }, expected)).toThrow(
      /policies differ/,
    );
    const deffect = policies.map((p) => ({ ...p }));
    deffect[1] = { ...deffect[1]!, effect: "deny" } as unknown as typeof policies[number];
    expect(() => assertMintedTokenMatches({ ...minted, policies: deffect }, expected)).toThrow(
      /policies differ/,
    );
  });
});

describe("normalizeCidr", () => {
  it("canonicalizes case, compression, leading zeros and host bits", () => {
    expect(normalizeCidr("2001:DB8:8:CB76::/64")).toBe("2001:db8:8:cb76::/64");
    expect(normalizeCidr("2001:0db8:0008:cb76:0000:0000:0000:0000/64")).toBe("2001:db8:8:cb76::/64");
    expect(normalizeCidr("2001:db8:8:cb76:dead:beef:0:1/64")).toBe("2001:db8:8:cb76::/64");
    expect(normalizeCidr("203.0.113.10/24")).toBe("203.0.113.0/24");
    expect(normalizeCidr("203.0.113.10")).toBe("203.0.113.10/32");
    expect(normalizeCidr("::1")).toBe("::1/128");
    expect(normalizeCidr("::/0")).toBe("::/0");
    expect(normalizeCidr("::ffff:192.0.2.1/128")).toBe("::ffff:c000:201/128");
    // Only the longest zero run compresses; a single zero group does not.
    expect(normalizeCidr("2001:db8:0:1:2:3:4:5/128")).toBe("2001:db8:0:1:2:3:4:5/128");
  });

  it("returns null for anything that is not a CIDR", () => {
    for (const bad of [
      "",
      " ",
      "example.com",
      "203.0.113.10/33",
      "203.0.113.10/-1",
      "203.0.113.256/32",
      "203.0.113/24",
      "010.0.0.0/8", // leading-zero octet: octal in some parsers
      "2001:db8:8:cb76::/129",
      "2001:db8:::1/64",
      "2001:db8:8:cb76:0:0:0:0:0/64",
      "fe80::1%eth0/64",
      "2001:db8::1/64/extra",
      42,
      null,
      undefined,
    ]) {
      expect(normalizeCidr(bad), JSON.stringify(bad)).toBeNull();
    }
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
