import { describe, expect, it, vi } from "vitest";
import {
  linuxStartTicks,
  localHost,
  ownerStatus,
  processIdentity,
  type Owner,
} from "../server/process-owner";

const host = { name: "host-a", machine: "machine-a" };
const identity = {
  kind: "linux-proc" as const,
  bootId: "6cbdaea0-30b9-43e4-9b7d-501057ff8df5",
  startTicks: "12345",
};
const owner: Owner = { pid: 123, token: "owner", host, identity };
function probe() {
  return {
    alive: vi.fn((): "alive" | "dead" | "unknown" => "alive"),
    identity: vi.fn(async () => identity as typeof identity | null),
  };
}

describe("PID owner identity", () => {
  it("retains a live owner but detects PID reuse and a previous system boot", async () => {
    const p = probe();
    expect(await ownerStatus(owner, host, p)).toBe("active");
    p.identity.mockResolvedValue({ ...identity, startTicks: "12346" });
    expect(await ownerStatus(owner, host, p)).toBe("stale");
    p.identity.mockResolvedValue({
      ...identity,
      bootId: "234c0634-eafe-43a3-8c1c-ddde95cb742a",
    });
    expect(await ownerStatus(owner, host, p)).toBe("stale");
  });
  it("never probes a foreign host's PID, even if it is absent locally", async () => {
    const p = probe();
    p.alive.mockReturnValue("dead");
    for (const other of [
      { name: "host-b", machine: "machine-a" },
      { name: "host-a", machine: "machine-b" },
    ]) {
      expect(await ownerStatus(owner, other, p)).toBe("foreign");
    }
    expect(p.alive).not.toHaveBeenCalled();
    expect(p.identity).not.toHaveBeenCalled();
  });
  it("keeps an unknown machine or unreadable process identity without treating it as PID reuse", async () => {
    const p = probe();
    expect(await ownerStatus(owner, { name: host.name }, p)).toBe("unknown");
    expect(p.alive).not.toHaveBeenCalled();
    p.alive.mockReturnValue("unknown");
    expect(await ownerStatus(owner, host, p)).toBe("unknown");
    p.alive.mockReturnValue("alive");
    p.identity.mockResolvedValue(null);
    expect(await ownerStatus(owner, host, p)).toBe("unknown");
  });
  it("reclaims a process that exits during identity lookup", async () => {
    const p = probe();
    p.alive.mockReturnValueOnce("alive").mockReturnValueOnce("dead");
    p.identity.mockResolvedValue(null);
    expect(await ownerStatus(owner, host, p)).toBe("stale");
  });
  it("preserves live legacy locks and reclaims dead ones", async () => {
    const p = probe();
    const legacy = { pid: 123, token: "old" };
    expect(await ownerStatus(legacy, host, p)).toBe("active");
    expect(p.identity).not.toHaveBeenCalled();
    p.alive.mockReturnValue("dead");
    expect(await ownerStatus(legacy, host, p)).toBe("stale");
  });
  it("parses Linux start ticks without confusing process names or losing precision", () => {
    const ticks = "9007199254740993";
    const fields = ["S", ...Array(18).fill("0"), ticks, "0"];
    expect(
      linuxStartTicks(`123 (worker ) with ( spaces) ${fields.join(" ")}`, 123),
    ).toBe(ticks);
    expect(linuxStartTicks(`124 (worker) ${fields.join(" ")}`, 123)).toBeNull();
    expect(linuxStartTicks("123 (worker) S 1", 123)).toBeNull();
  });
  it.runIf(process.platform === "linux")(
    "identifies this running process through the real proc filesystem",
    async () => {
      const current = await processIdentity(process.pid);
      expect(current).toMatchObject({
        kind: "linux-proc",
        bootId: expect.any(String),
        startTicks: expect.stringMatching(/^\d+$/),
      });
      expect(
        await ownerStatus(
          {
            pid: process.pid,
            token: "test",
            host: await localHost(),
            identity: current!,
          },
          await localHost(),
        ),
      ).toBe("active");
    },
  );
});
