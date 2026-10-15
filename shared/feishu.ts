import type { NoticeKind } from "./config";
import type { Notification } from "./contracts";
import { renderNotification, type MessageFormat } from "./templates";

export const feishuColors: Record<
  NoticeKind,
  "green" | "red" | "orange" | "blue"
> = {
  completed: "green",
  recovered: "green",
  failed: "red",
  blocked: "orange",
  permission: "orange",
  test: "blue",
};

// Bound UTF-8 bytes *after JSON escaping*, without Node/DOM APIs (also used
// by Android Hermes previews). Reserve three bytes for the ellipsis.
export function truncateJsonText(text: string, maxBytes: number): string {
  let result = "",
    bytes = 0,
    prefix = "";
  for (const char of text) {
    const escaped = JSON.stringify(char).slice(1, -1);
    let size = 0;
    for (const c of escaped) {
      const point = c.codePointAt(0)!;
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    if (bytes + size > maxBytes) return `${prefix}…`;
    bytes += size;
    result += char;
    if (bytes <= maxBytes - 3) prefix = result;
  }
  return result;
}

export function renderFeishuCard(notice: Notification, format?: MessageFormat) {
  const message = renderNotification(notice, format);
  // The documented classic card's plain_text components preserve template
  // contents without interpreting Markdown or task-provided mention markup.
  // 13 KB combined escaped content leaves ample room under the 20 KB webhook
  // request limit, including the envelope, header and optional signature.
  return {
    config: { wide_screen_mode: true },
    header: {
      template: feishuColors[notice.kind],
      title: {
        tag: "plain_text" as const,
        content: truncateJsonText(
          message.title.replace(/<at\b/gi, "〈at"),
          1000,
        ),
      },
    },
    elements: [
      {
        tag: "div" as const,
        text: {
          tag: "plain_text" as const,
          content: truncateJsonText(
            message.body.replace(/<at\b/gi, "〈at"),
            12000,
          ),
        },
      },
    ],
  };
}
