import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildRequest,
  deliver,
  truncateUtf8,
  validateCredentials,
  type Fetch,
} from "../server/channels";
import { channelSchema, type Channel } from "../shared/config";
import type { Notification } from "../shared/contracts";

const notice: Notification = {
  id: "notice-1",
  kind: "completed",
  agentId: "agent-1",
  workspaceId: null,
  provider: "codex",
  title: "任务完成",
  summary: "你好🌍".repeat(1000),
  createdAt: 1_700_000_000_000,
  attempts: 0,
};
const credentials = {
  url: "https://example.invalid/hook",
  signingSecret: "test-key",
  bearerToken: "test-token",
  headers: {},
};
const channel = (kind: Channel["kind"]) =>
  channelSchema.parse({ id: kind, name: kind, kind });
describe("notification transports", () => {
  it("signs DingTalk with a millisecond timestamp, URL encoding, and no mentions", () => {
    const req = buildRequest(
      channel("dingtalk"),
      {
        ...credentials,
        url: "https://oapi.dingtalk.com/robot/send?access_token=test",
      },
      notice,
      notice.createdAt,
    );
    const url = new URL(req.url);
    expect(url.searchParams.get("timestamp")).toBe(String(notice.createdAt));
    expect(url.searchParams.get("sign")).toBe(
      createHmac("sha256", "test-key")
        .update(`${notice.createdAt}\ntest-key`)
        .digest("base64"),
    );
    expect(JSON.parse(req.body)).toMatchObject({
      msgtype: "text",
      at: { isAtAll: false },
    });
  });
  it("sends Telegram plain text to the configured chat and forum topic", () => {
    const req = buildRequest(
      channel("telegram"),
      {
        ...credentials,
        url: "https://api.telegram.org",
        bearerToken: "123:abc",
        target: "-100123",
        threadId: "42",
      },
      notice,
      notice.createdAt,
    );
    const body = JSON.parse(req.body);
    expect(req.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(req.headers.Authorization).toBeUndefined();
    expect(body).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 42,
      link_preview_options: { is_disabled: true },
    });
    expect(body.parse_mode).toBeUndefined();
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).not.toContain("\ufffd");
  });
  it("disables unintended Slack and Discord mentions", () => {
    const message = { ...notice, summary: "<!everyone> <@123> @everyone" };
    const slack = JSON.parse(
      buildRequest(channel("slack"), credentials, message, 0).body,
    );
    expect(slack.text).toContain("&lt;!everyone&gt;");
    expect(slack.mrkdwn).toBe(false);
    const discord = buildRequest(
      channel("discord"),
      {
        ...credentials,
        url: "https://discord.com/api/webhooks/123/token?thread_id=456",
      },
      message,
      0,
    );
    expect(new URL(discord.url).searchParams.get("wait")).toBe("true");
    expect(new URL(discord.url).searchParams.get("thread_id")).toBe("456");
    expect(JSON.parse(discord.body).allowed_mentions).toEqual({ parse: [] });
  });
  it.each(["ntfy", "bark"] as const)(
    "bounds the complete %s JSON payload including escaping",
    (kind) => {
      const req = buildRequest(
        channel(kind),
        { ...credentials, target: "topic" },
        { ...notice, title: "你".repeat(200), summary: "\u0000".repeat(10000) },
        0,
      );
      expect(Buffer.byteLength(req.body)).toBeLessThanOrEqual(3800);
      expect(
        JSON.parse(req.body)[kind === "ntfy" ? "message" : "body"],
      ).toBeTruthy();
    },
  );
  it.each([
    [
      "telegram",
      "https://api.telegram.org",
      { ok: true, result: { message_id: 1 } },
    ],
    [
      "dingtalk",
      "https://oapi.dingtalk.com/robot/send?access_token=test",
      { errcode: 0 },
    ],
    ["bark", "https://api.day.app/device-key", { code: 200 }],
    ["ntfy", "https://ntfy.sh", { id: "msg-1", event: "message" }],
    ["slack", "https://hooks.slack.com/services/T/B/key", "ok"],
    ["discord", "https://discord.com/api/webhooks/123/token", { id: "456" }],
  ] as const)(
    "confirms a successful %s platform receipt",
    async (kind, url, body) => {
      const fetcher = vi.fn(
        async () =>
          new Response(typeof body === "string" ? body : JSON.stringify(body)),
      ) as unknown as Fetch;
      await expect(
        deliver(
          channel(kind),
          {
            ...credentials,
            url,
            bearerToken: "123:abc",
            target: kind === "telegram" ? "123" : "topic",
          },
          notice,
          new AbortController().signal,
          fetcher,
        ),
      ).resolves.toBeUndefined();
    },
  );
  it("honors Telegram's JSON retry_after on HTTP 429 without exposing the bot token", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 37 },
            description: "secret-token",
          }),
          { status: 429 },
        ),
    ) as unknown as Fetch;
    await expect(
      deliver(
        channel("telegram"),
        {
          ...credentials,
          url: "https://api.telegram.org",
          bearerToken: "123:abc",
          target: "123",
        },
        notice,
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 37000,
      message: "平台错误码 429",
    });
  });
  it("handles Discord fractional retry_after and Bark business errors", async () => {
    const discord = vi.fn(
      async () => new Response('{"retry_after":1.5}', { status: 429 }),
    ) as unknown as Fetch;
    await expect(
      deliver(
        channel("discord"),
        { ...credentials, url: "https://discord.com/api/webhooks/123/token" },
        notice,
        new AbortController().signal,
        discord,
      ),
    ).rejects.toMatchObject({ retryAfterMs: 1500, retryable: true });
    const bark = vi.fn(
      async () => new Response('{"code":400}'),
    ) as unknown as Fetch;
    await expect(
      deliver(
        channel("bark"),
        { ...credentials, url: "https://api.day.app/key" },
        notice,
        new AbortController().signal,
        bark,
      ),
    ).rejects.toMatchObject({ retryable: false });
  });
  it("rejects missing destinations and disguised new platform URLs", () => {
    expect(() => validateCredentials("telegram", credentials)).toThrow(
      "Bot Token",
    );
    expect(() =>
      validateCredentials("ntfy", { ...credentials, target: "bad/topic" }),
    ).toThrow("topic");
    expect(() =>
      validateCredentials("dingtalk", {
        ...credentials,
        url: "https://oapi.dingtalk.com.evil.invalid/robot/send?access_token=test",
      }),
    ).toThrow();
    expect(() =>
      validateCredentials("discord", {
        ...credentials,
        url: "https://discord.com.evil.invalid/api/webhooks/123/token",
      }),
    ).toThrow();
  });
  it("delivers a signed JSON webhook to a local HTTP receiver", async () => {
    let received:
      | { headers: Record<string, unknown>; body: string }
      | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      received = {
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      };
      response.writeHead(204);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      await deliver(
        channel("webhook"),
        { ...credentials, url: `http://127.0.0.1:${address.port}/notify` },
        notice,
        new AbortController().signal,
        undefined,
        notice.createdAt,
      );
      expect(JSON.parse(received!.body)).toMatchObject({
        schema: "paseo-notifier/v1",
        id: notice.id,
      });
      expect(received!.headers["idempotency-key"]).toBe(notice.id);
      expect(received!.headers.authorization).toBe("Bearer test-token");
      const expected = createHmac("sha256", "test-key")
        .update(`1700000000.${received!.body}`)
        .digest("hex");
      expect(received!.headers["x-paseo-signature"]).toBe(`sha256=${expected}`);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("limits WeCom payload by UTF-8 bytes, without breaking characters", () => {
    const body = JSON.parse(
      buildRequest(channel("wecom"), credentials, notice, notice.createdAt)
        .body,
    );
    expect(Buffer.byteLength(body.text.content)).toBeLessThanOrEqual(2048);
    expect(body.text.content).not.toContain("\ufffd");
    expect(truncateUtf8("你好🌍", 9)).toBe("你好…");
  });
  it("uses Feishu's empty-message HMAC and second timestamp", () => {
    const body = JSON.parse(
      buildRequest(channel("feishu"), credentials, notice, notice.createdAt)
        .body,
    );
    expect(body.timestamp).toBe("1700000000");
    expect(body.sign).toBe(
      createHmac("sha256", "1700000000\ntest-key").digest("base64"),
    );
  });
  it.each([
    ["feishu", { code: 11232 }, true],
    ["feishu", { code: 19021 }, false],
    ["wecom", { errcode: 45009 }, true],
    ["wecom", {}, false],
  ] as const)(
    "handles %s business failures even with HTTP 200",
    async (kind, body, retryable) => {
      const url =
        kind === "feishu"
          ? "https://open.feishu.cn/open-apis/bot/v2/hook/test"
          : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test";
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(body)),
      ) as unknown as Fetch;
      await expect(
        deliver(
          channel(kind),
          { ...credentials, url },
          notice,
          new AbortController().signal,
          fetcher,
        ),
      ).rejects.toMatchObject({ retryable });
    },
  );
  it("honors Retry-After and redacts raw transport errors", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("secret response", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    ) as unknown as Fetch;
    await expect(
      deliver(
        channel("webhook"),
        credentials,
        notice,
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toMatchObject({ message: "HTTP 429", retryAfterMs: 120000 });
    const broken = vi.fn(async () => {
      throw new Error("url=secret-token");
    }) as unknown as Fetch;
    await expect(
      deliver(
        channel("webhook"),
        credentials,
        notice,
        new AbortController().signal,
        broken,
      ),
    ).rejects.toMatchObject({ message: "网络连接失败或请求超时" });
  });
  it("rejects invalid protocols, disguised platform hosts, and header injection", () => {
    expect(() =>
      validateCredentials("webhook", {
        ...credentials,
        url: "file:///etc/passwd",
      }),
    ).toThrow();
    expect(() =>
      validateCredentials("feishu", {
        ...credentials,
        url: "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/test",
      }),
    ).toThrow();
    expect(() =>
      validateCredentials("webhook", {
        ...credentials,
        headers: { Authorization: "x\r\nX:y" },
      }),
    ).toThrow();
  });
});
