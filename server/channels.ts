import { createHmac } from "node:crypto";
import type { Channel } from "../shared/config";
import type { Credentials, Notification } from "../shared/contracts";
import {
  renderNotification,
  visibleNotification,
  type MessageFormat,
} from "../shared/templates";

// A narrow transport port avoids depending on DOM or undici declaration packages
// in a plugin installed without development dependencies.
export type Fetch = (
  url: string,
  options: {
    method: string;
    body: string;
    headers: Record<string, string>;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: null | {
    cancel(): Promise<void>;
    getReader(): {
      read(): Promise<
        { done: true; value?: Uint8Array } | { done: false; value: Uint8Array }
      >;
      cancel(): Promise<void>;
    };
  };
}>;
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function validateCredentials(
  kind: Channel["kind"],
  value: Credentials,
): void {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("渠道地址格式不正确");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("渠道地址必须使用 HTTP(S)，且不能包含用户信息或片段");
  if (
    kind === "feishu" &&
    (url.protocol !== "https:" ||
      !["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) ||
      !/^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(url.pathname))
  )
    throw new Error("请输入飞书或 Lark 自定义机器人的 HTTPS Webhook 地址");
  if (
    kind === "wecom" &&
    (url.protocol !== "https:" ||
      url.hostname !== "qyapi.weixin.qq.com" ||
      url.pathname !== "/cgi-bin/webhook/send" ||
      !url.searchParams.get("key"))
  )
    throw new Error("请输入带 key 的企业微信群机器人 HTTPS Webhook 地址");
  if (
    kind === "dingtalk" &&
    (url.protocol !== "https:" ||
      url.hostname !== "oapi.dingtalk.com" ||
      url.pathname !== "/robot/send" ||
      !url.searchParams.get("access_token"))
  )
    throw new Error("请输入带 access_token 的钉钉群机器人 HTTPS Webhook 地址");
  if (
    kind === "slack" &&
    (url.protocol !== "https:" ||
      !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) ||
      !/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname))
  )
    throw new Error("请输入 Slack Incoming Webhook 地址");
  if (
    kind === "discord" &&
    (url.protocol !== "https:" ||
      ![
        "discord.com",
        "canary.discord.com",
        "ptb.discord.com",
        "discordapp.com",
      ].includes(url.hostname) ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/.test(url.pathname))
  )
    throw new Error("请输入 Discord Webhook 地址，可保留 thread_id 查询参数");
  if (
    kind === "telegram" &&
    (!/^\d+:[A-Za-z0-9_-]+$/.test(value.bearerToken) ||
      !/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(value.target ?? ""))
  )
    throw new Error(
      "Telegram 需要有效的 Bot Token 和 Chat ID（数字或 @频道名）",
    );
  if (kind === "ntfy" && !/^[A-Za-z0-9_-]{1,128}$/.test(value.target ?? ""))
    throw new Error("ntfy 需要 topic，仅支持字母、数字、下划线和短横线");
  if (["telegram", "ntfy"].includes(kind) && url.search)
    throw new Error("服务根地址不能包含查询参数");
  if (value.threadId && !/^[1-9]\d{0,14}$/.test(value.threadId))
    throw new Error("话题 ID 应为正整数");
  if (Object.keys(value.headers).length > 20)
    throw new Error("自定义请求头最多 20 个");
  for (const [key, header] of Object.entries(value.headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      /[\r\n]/.test(header) ||
      /^(?:host|content-length|connection|transfer-encoding|content-type|x-paseo-.*|idempotency-key)$/i.test(
        key,
      )
    )
      throw new Error("自定义请求头包含无效或保留字段");
  }
  if (/[\r\n]/.test(value.bearerToken))
    throw new Error("Bearer Token 不能包含换行");
}
export function truncateUtf8(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let result = "",
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > max - 3) break;
    bytes += size;
    result += char;
  }
  return `${result}…`;
}
export function feishuSignature(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}
export function channelSpacing(kind: Channel["kind"]): number {
  if (["wecom", "dingtalk"].includes(kind)) return 3100;
  if (kind === "telegram") return 3100;
  if (["slack", "discord"].includes(kind)) return 1100;
  return kind === "feishu" ? 650 : 200;
}
function truncateCharacters(text: string, limit: number): string {
  // UTF-16 is conservative for APIs counting Unicode code points. Do not split surrogate pairs.
  if (text.length <= limit) return text;
  return text.slice(0, limit - 2).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
export function renderText(notice: Notification): string {
  return renderNotification(notice).text;
}
export function buildRequest(
  channel: Channel,
  credentials: Credentials,
  notice: Notification,
  now: number,
  format?: MessageFormat,
) {
  notice = visibleNotification(notice, format);
  const message = renderNotification(notice, format);
  const url = new URL(credentials.url);
  const headers: Record<string, string> = {
    ...credentials.headers,
    "Content-Type": "application/json; charset=utf-8",
  };
  const timestamp = String(Math.floor(now / 1000));
  let payload: unknown;
  if (channel.kind === "feishu") {
    payload = {
      msg_type: "text",
      content: {
        text: truncateUtf8(message.text.replace(/<at\b/gi, "〈at"), 12_000),
      },
      ...(credentials.signingSecret
        ? {
            timestamp,
            sign: feishuSignature(timestamp, credentials.signingSecret),
          }
        : {}),
    };
  } else if (channel.kind === "wecom") {
    payload = {
      msgtype: "text",
      text: { content: truncateUtf8(message.text, 2048) },
    };
  } else if (channel.kind === "dingtalk") {
    payload = {
      msgtype: "text",
      text: { content: truncateUtf8(message.text, 4000) },
      at: { isAtAll: false },
    };
    if (credentials.signingSecret) {
      url.searchParams.set("timestamp", String(now));
      url.searchParams.set(
        "sign",
        createHmac("sha256", credentials.signingSecret)
          .update(`${now}\n${credentials.signingSecret}`)
          .digest("base64"),
      );
    }
  } else if (channel.kind === "telegram") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/bot${credentials.bearerToken}/sendMessage`;
    payload = {
      chat_id: credentials.target,
      text: truncateCharacters(message.text, 4096),
      link_preview_options: { is_disabled: true },
      ...(credentials.threadId
        ? { message_thread_id: Number(credentials.threadId) }
        : {}),
    };
  } else if (channel.kind === "bark") {
    payload = {
      title: message.title,
      body: truncateUtf8(message.body, 2500),
      group: "Paseo",
    };
  } else if (channel.kind === "ntfy") {
    payload = {
      topic: credentials.target,
      title: message.title,
      message: truncateUtf8(message.body, 3500),
    };
  } else if (channel.kind === "slack") {
    const text = truncateCharacters(message.text, 2900)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    payload = {
      text,
      mrkdwn: false,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    };
  } else if (channel.kind === "discord") {
    url.searchParams.set("wait", "true");
    payload = {
      content: truncateCharacters(message.text, 2000),
      allowed_mentions: { parse: [] },
      flags: 4,
    };
  } else {
    payload = {
      schema: "paseo-notifier/v1",
      ...notice,
      text: message.text,
      message: { title: message.title, body: message.body },
    };
    headers["Idempotency-Key"] = notice.id;
    headers["X-Paseo-Event-Id"] = notice.id;
    headers["X-Paseo-Timestamp"] = timestamp;
  }
  let body = JSON.stringify(payload);
  if (channel.kind === "ntfy" || channel.kind === "bark") {
    const value = payload as Record<string, string>;
    const field = channel.kind === "ntfy" ? "message" : "body";
    while (
      Buffer.byteLength(body) > 3800 &&
      Buffer.byteLength(value[field]!) > 64
    ) {
      value[field] = truncateUtf8(
        value[field]!,
        Math.max(64, Buffer.byteLength(value[field]!) - 512),
      );
      body = JSON.stringify(value);
    }
  }
  if (channel.kind === "webhook" && credentials.signingSecret)
    headers["X-Paseo-Signature"] =
      `sha256=${createHmac("sha256", credentials.signingSecret).update(`${timestamp}.${body}`).digest("hex")}`;
  if (credentials.bearerToken && channel.kind !== "telegram")
    headers.Authorization = `Bearer ${credentials.bearerToken}`;
  return { url: url.href, body, headers };
}
function retryAfter(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.min(86_400_000, Math.max(0, delay)) : 0;
}
export async function deliver(
  channel: Channel,
  credentials: Credentials,
  notice: Notification,
  signal: AbortSignal,
  options: { fetcher?: Fetch; now?: number; format?: MessageFormat } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? (globalThis.fetch as Fetch);
  const now = options.now ?? Date.now();
  validateCredentials(channel.kind, credentials);
  const { url, ...request } = buildRequest(
    channel,
    credentials,
    notice,
    now,
    options.format,
  );
  try {
    const response = await fetcher(url, {
      method: "POST",
      ...request,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok && !["telegram", "discord"].includes(channel.kind)) {
      await response.body?.cancel();
      throw new DeliveryError(
        `HTTP ${response.status}`,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        retryAfter(response.headers.get("retry-after"), now),
      );
    }
    if (channel.kind === "webhook") {
      await response.body?.cancel();
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DeliveryError("平台响应为空", true);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 64 * 1024)
          throw new DeliveryError("平台响应超过大小限制", false);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (channel.kind === "slack") {
      if (raw.trim() !== "ok")
        throw new DeliveryError("Slack 未确认投递成功", false);
      return;
    }
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(raw);
    } catch {
      if (!response.ok)
        throw new DeliveryError(
          `HTTP ${response.status}`,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          retryAfter(response.headers.get("retry-after"), now),
        );
      throw new DeliveryError("平台未返回有效 JSON", true);
    }
    if (!response.ok || (channel.kind === "telegram" && result?.ok !== true)) {
      const code = response.ok ? result?.error_code : response.status;
      const params = result?.parameters as Record<string, unknown> | undefined;
      const delay =
        channel.kind === "telegram" ? params?.retry_after : result?.retry_after;
      throw new DeliveryError(
        typeof code === "number" ? `平台错误码 ${code}` : "平台未确认投递成功",
        typeof code === "number" &&
          (code === 408 || code === 429 || code >= 500),
        Math.max(
          retryAfter(response.headers.get("retry-after"), now),
          typeof delay === "number" && Number.isFinite(delay)
            ? Math.min(86400000, Math.max(0, delay * 1000))
            : 0,
        ),
      );
    }
    if (channel.kind === "telegram") return;
    if (channel.kind === "discord" || channel.kind === "ntfy") {
      if (
        typeof result?.id !== "string" ||
        !result.id ||
        (channel.kind === "ntfy" && result.event !== "message")
      )
        throw new DeliveryError("平台响应缺少消息确认", false);
      return;
    }
    const code =
      channel.kind === "feishu"
        ? (result?.code ?? result?.StatusCode)
        : channel.kind === "bark"
          ? result?.code
          : result?.errcode;
    if (code !== (channel.kind === "bark" ? 200 : 0)) {
      const retryable =
        code === 11232 || code === 45009 || code === -1 || code === 130101;
      // Do not echo platform messages: they can contain the URL, token, or sent content.
      throw new DeliveryError(
        typeof code === "number"
          ? `平台错误码 ${code}`
          : "平台响应缺少成功状态码",
        retryable,
        retryable ? 60_000 : 0,
      );
    }
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    if (signal.aborted) throw new DeliveryError("发送已取消", false);
    throw new DeliveryError("网络连接失败或请求超时", true);
  }
}
