// Standalone OpenCode plugin: no imports, credentials, persistent state or core patches.
// Keep detection scoped to provider error fields, never the conversation transcript.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

const cyberCode = (value: unknown) =>
  typeof value === "string" && /^cyber_(?:policy|safety)$/i.test(value);
const cyberMessage = (value: unknown) =>
  typeof value === "string" &&
  /\bcyber_(?:policy|safety)\b|\bthis content was flagged for possible cybersecurity risk\b/i.test(
    value.slice(0, 32_000),
  );

export function isCyberRejection(value: unknown): boolean {
  const error = record(value);
  if (!error) return false;
  if (
    cyberCode(error.code) ||
    cyberCode(error.type) ||
    cyberMessage(error.message)
  )
    return true;
  const body = record(error.response)?.body;
  if (typeof body !== "string" || body.length > 256_000) return false;
  try {
    const decoded = record(JSON.parse(body));
    // Responses failures nest error under response; other providers use error.
    // Do not scan arbitrary body strings, which can include quoted user content.
    const providerError =
      record(record(decoded?.response)?.error) ?? record(decoded?.error);
    return (
      !!providerError &&
      (cyberCode(providerError.code) || cyberMessage(providerError.message))
    );
  } catch {
    return false;
  }
}

export interface RetryEvent {
  readonly error: unknown;
  decision: { retry: false } | { retry: true; delay: number };
}

interface Context {
  session: {
    hook(
      name: "retry",
      callback: (event: RetryEvent) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
}

export default {
  id: "paseo-notify.cyber-retry-guard",
  async setup(ctx: Context) {
    if (typeof ctx.session?.hook !== "function")
      throw new Error(
        "Cyber retry guard requires OpenCode session.retry hooks",
      );
    const registration = await ctx.session.hook("retry", (event) => {
      if (isCyberRejection(event.error)) event.decision = { retry: false };
    });
    return () => registration.dispose();
  },
};
