import { describe, expect, it } from "vitest";
import {
  checkProvisionAllowed,
  isValidNamePrefix,
  resolveConfig,
  DEFAULT_MAX_TTL_SECONDS,
} from "./config.js";

const base = {
  tokenSecretRef: { type: "secret_ref", secretId: "s-1" },
  accountId: "acct-1",
  allowedProjectIds: ["proj-kofra"],
  egressCidrs: ["203.0.113.10/32", "2001:db8:8:cb76::/64"],
  workerAdminGroupId: "grp-worker-admin",
  r2ItemWriteGroupId: "grp-r2-item-write",
};

describe("resolveConfig", () => {
  it("applies documented defaults and drops unknown keys", () => {
    const config = resolveConfig({ ...base, extra: true });
    expect(config.maxTtlSeconds).toBe(DEFAULT_MAX_TTL_SECONDS);
    expect(config.namePrefix).toBe("pct-");
    expect(config.maxConcurrentEnvs).toBe(10);
  });

  it("treats a legacy string secret as unconfigured", () => {
    expect(resolveConfig({ ...base, tokenSecretRef: "s-1" }).tokenSecretRef).toBeNull();
  });

  it("clamps an oversized maxTtlSeconds to 3 h", () => {
    expect(resolveConfig({ ...base, maxTtlSeconds: 99999 }).maxTtlSeconds).toBe(10800);
    expect(resolveConfig({ ...base, maxTtlSeconds: 3600 }).maxTtlSeconds).toBe(3600);
  });

  it("validates name prefixes", () => {
    expect(isValidNamePrefix("pct-")).toBe(true);
    expect(isValidNamePrefix("t-")).toBe(false);
    expect(isValidNamePrefix("PCT-")).toBe(false);
    expect(isValidNamePrefix("pct")).toBe(false);
    expect(isValidNamePrefix("prod-app-")).toBe(false);
    expect(isValidNamePrefix("")).toBe(false);
  });
});

describe("checkProvisionAllowed", () => {
  it("fails closed without credential, account, CIDRs or allow-list", () => {
    const config = resolveConfig(base);
    expect(checkProvisionAllowed({ ...config, tokenSecretRef: null }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed({ ...config, accountId: "" }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed({ ...config, egressCidrs: [] }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed(resolveConfig({ ...base, allowedProjectIds: [] }), { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("project_not_allowed");
  });

  it("rejects a blank egress entry instead of minting a single-family token", () => {
    // ["v4", " "] must fail closed: silently dropping the blank would mint a
    // token missing an egress family.
    const blank = resolveConfig({ ...base, egressCidrs: ["203.0.113.10/32", " "] });
    expect(blank.egressCidrs).toEqual(["203.0.113.10/32", ""]);
    expect(
      checkProvisionAllowed(blank, { projectId: "proj-kofra", liveCount: 0 })?.code,
    ).toBe("not_configured");
    expect(checkProvisionAllowed(resolveConfig(base), { projectId: "proj-kofra", liveCount: 0 })).toBeNull();
  });

  it("merges a legacy single egressCidr into the list and dedupes", () => {
    expect(resolveConfig(base).egressCidrs).toEqual([
      "203.0.113.10/32",
      "2001:db8:8:cb76::/64",
    ]);
    const { egressCidrs, ...noCidrs } = base;
    void egressCidrs;
    expect(resolveConfig({ ...noCidrs, egressCidr: "203.0.113.10/32" }).egressCidrs).toEqual([
      "203.0.113.10/32",
    ]);
    expect(
      resolveConfig({ ...base, egressCidr: "203.0.113.10/32" }).egressCidrs,
    ).toEqual(["203.0.113.10/32", "2001:db8:8:cb76::/64"]);
    expect(resolveConfig({ ...noCidrs, egressCidr: "" }).egressCidrs).toEqual([]);
  });

  it("rejects non-allow-listed projects and full caps", () => {
    const config = resolveConfig(base);
    expect(checkProvisionAllowed(config, { projectId: "proj-other", liveCount: 0 })?.code).toBe("project_not_allowed");
    expect(checkProvisionAllowed(config, { projectId: "proj-kofra", liveCount: 10 })?.code).toBe("concurrency_cap");
  });

  it("allows an allow-listed project under the cap", () => {
    expect(checkProvisionAllowed(resolveConfig(base), { projectId: "proj-kofra", liveCount: 9 })).toBeNull();
  });

  it("fails closed without permission-group ids or with a bad prefix", () => {
    const full = {
      ...base,
      workerAdminGroupId: "grp-worker-admin",
      r2ItemWriteGroupId: "grp-r2-item-write",
    };
    expect(
      checkProvisionAllowed(resolveConfig({ ...base, workerAdminGroupId: "", r2ItemWriteGroupId: "" }), {
        projectId: "proj-kofra",
        liveCount: 0,
      })?.code,
    ).toBe("not_configured");
    expect(
      checkProvisionAllowed(resolveConfig({ ...full, namePrefix: "prod-app-" }), {
        projectId: "proj-kofra",
        liveCount: 0,
      })?.code,
    ).toBe("bad_prefix");
    expect(
      checkProvisionAllowed(resolveConfig(full), { projectId: "proj-kofra", liveCount: 0 }),
    ).toBeNull();
  });
});
