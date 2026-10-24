import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";

const hostSchema = z.object({
  name: z.string().min(1),
  machine: z.string().min(1).optional(),
});
const identitySchema = z.object({
  kind: z.literal("linux-proc"),
  bootId: z.string().uuid(),
  startTicks: z.string().regex(/^\d+$/),
});
export const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string(),
  // Optional for locks written before v0.4.7.
  host: hostSchema.optional(),
  identity: identitySchema.optional(),
});
export type Owner = z.infer<typeof ownerSchema>;
type Host = z.infer<typeof hostSchema>;
type Identity = z.infer<typeof identitySchema>;

export async function localHost(): Promise<Host> {
  const machine =
    process.platform === "linux"
      ? await readFile("/etc/machine-id", "utf8").catch(() => "")
      : "";
  return {
    name: hostname(),
    ...(machine.trim()
      ? { machine: createHash("sha256").update(machine.trim()).digest("hex") }
      : {}),
  };
}

// Field 2 (comm) may contain spaces and parentheses. Field 22 is the process
// start time in ticks since boot; keep it as a string to avoid precision loss.
export function linuxStartTicks(stat: string, pid: number): string | null {
  if (!stat.startsWith(`${pid} (`)) return null;
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const value = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return value && /^\d+$/.test(value) ? value : null;
}
export async function processIdentity(pid: number): Promise<Identity | null> {
  if (process.platform !== "linux") return null;
  try {
    const [boot, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const startTicks = linuxStartTicks(stat, pid);
    const value = identitySchema.safeParse({
      kind: "linux-proc",
      bootId: boot.trim(),
      startTicks,
    });
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}

export type OwnerStatus = "active" | "stale" | "foreign" | "unknown";
type Probe = {
  alive(pid: number): "alive" | "dead" | "unknown";
  identity(pid: number): Promise<Identity | null>;
};
const systemProbe: Probe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "dead"
        : "unknown";
    }
  },
  identity: processIdentity,
};

export async function ownerStatus(
  owner: Owner,
  host: Host,
  probe: Probe = systemProbe,
): Promise<OwnerStatus> {
  // Never interpret a foreign host's PID using this machine's process table.
  if (owner.host) {
    if (owner.host.name !== host.name) return "foreign";
    if (owner.host.machine) {
      if (!host.machine) return "unknown";
      if (owner.host.machine !== host.machine) return "foreign";
    }
  }
  const alive = probe.alive(owner.pid);
  if (alive === "dead") return "stale";
  if (alive === "unknown") return "unknown";
  // Old locks lack the evidence needed to prove PID reuse. Preserve them when
  // the PID is alive. Unsupported platforms likewise retain PID-only locking.
  if (!owner.identity) return "active";
  if (!owner.host) return "unknown";
  const current = await probe.identity(owner.pid);
  if (!current) return probe.alive(owner.pid) === "dead" ? "stale" : "unknown";
  return current.bootId === owner.identity.bootId &&
    current.startTicks === owner.identity.startTicks
    ? "active"
    : "stale";
}
