import { describe, expect, it } from "vitest";
import { checkProvisionAllowed, resolveConfig, DEFAULT_MAX_TTL_SECONDS } from "./config.js";

const base = {
  tokenSecretRef: { type: "secret_ref", secretId: "s-1" },
  accountId: "acct-1",
  allowedProjectIds: ["proj-kofra"],
  egressCidr: "203.0.113.0/24",
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
});

describe("checkProvisionAllowed", () => {
  it("fails closed without credential, account, CIDR or allow-list", () => {
    const config = resolveConfig(base);
    expect(checkProvisionAllowed({ ...config, tokenSecretRef: null }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed({ ...config, accountId: "" }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed({ ...config, egressCidr: "" }, { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("not_configured");
    expect(checkProvisionAllowed(resolveConfig({ ...base, allowedProjectIds: [] }), { projectId: "proj-kofra", liveCount: 0 })?.code).toBe("project_not_allowed");
  });

  it("rejects non-allow-listed projects and full caps", () => {
    const config = resolveConfig(base);
    expect(checkProvisionAllowed(config, { projectId: "proj-other", liveCount: 0 })?.code).toBe("project_not_allowed");
    expect(checkProvisionAllowed(config, { projectId: "proj-kofra", liveCount: 10 })?.code).toBe("concurrency_cap");
  });

  it("allows an allow-listed project under the cap", () => {
    expect(checkProvisionAllowed(resolveConfig(base), { projectId: "proj-kofra", liveCount: 9 })).toBeNull();
  });
});
