import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  channelSchema,
  defaultConfig,
  migrateSettings,
} from "../shared/config";
import { renderFeishuCard } from "../shared/feishu";
import { notificationExample } from "../shared/notification-example";
import { extractionExamples } from "../shared/template-schema";
import { buildRequest, deliver, type Fetch } from "../server/channels";
import { exportConfiguration, planImport } from "../server/transfer";
import { parseTransfer } from "../shared/transfer";

const channel = channelSchema.parse({
  id: "team",
  name: "开发群",
  kind: "feishu",
  feishu: { messageType: "card" },
});
const credentials = {
  url: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  signingSecret: "test-secret",
  bearerToken: "",
  headers: {},
};

describe("Feishu message types", () => {
  it("keeps legacy channels in text mode through settings migration", () => {
    const old = defaultConfig();
    old.channels = [
      channelSchema.parse({ id: "team", name: "开发群", kind: "feishu" }),
    ];
    old.routing.host = ["team"];
    for (const version of [1, 2, 3, 4, 5]) {
      const next = migrateSettings(old, version);
      expect(next.routing.host).toEqual(["team"]);
      expect(
        JSON.parse(
          buildRequest(next.channels[0]!, credentials, notificationExample(), 0)
            .body,
        ).msg_type,
      ).toBe("text");
      expect(next.notifications.includePreview).toBe(false);
    }
    expect(
      channelSchema.safeParse({
        ...channel,
        feishu: { messageType: "invalid" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["completed", "green"],
    ["recovered", "green"],
    ["failed", "red"],
    ["blocked", "orange"],
    ["permission", "orange"],
    ["test", "blue"],
  ] as const)(
    "renders %s with a %s header and signed plain-text components",
    (kind, color) => {
      const format = defaultConfig().notifications;
      format.includePreview = true;
      format.template.title = "通知 · {{event}}";
      format.template.body = "工单：{{custom.ticket}}\n{{summary}}";
      format.template.rules = [extractionExamples[0]!.rule];
      const notice = notificationExample(kind);
      notice.summary = '<at user_id="all">全体</at> **literal**';
      const payload = JSON.parse(
        buildRequest(channel, credentials, notice, 1700000000000, format).body,
      );
      expect(payload.msg_type).toBe("interactive");
      expect(payload.content).toBeUndefined();
      expect(payload.card.header).toMatchObject({
        template: color,
        title: { tag: "plain_text" },
      });
      expect(payload.card.elements).toEqual([
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: '工单：PROJ-123\n〈at user_id="all">全体</at> **literal**',
          },
        },
      ]);
      expect(payload.timestamp).toBe("1700000000");
      expect(payload.sign).toBe(
        createHmac("sha256", "1700000000\ntest-secret")
          .update("")
          .digest("base64"),
      );
    },
  );

  it("applies privacy before both card rendering and extraction", () => {
    const format = defaultConfig().notifications;
    format.template.body = "{{preview}}\n{{custom.ticket}}";
    format.template.rules = [extractionExamples[0]!.rule];
    const notice = notificationExample();
    expect(JSON.stringify(renderFeishuCard(notice, format))).not.toContain(
      "PROJ-123",
    );
    format.includePreview = true;
    notice.preview = "x".repeat(80) + "SECRET-123";
    format.previewCharacters = 80;
    const card = renderFeishuCard(notice, format);
    expect(card.elements[0]!.text.content).toContain("x".repeat(80));
    expect(JSON.stringify(card)).not.toContain("SECRET");
  });

  it.each(["text", "card"] as const)(
    "bounds the complete signed %s request after JSON escaping",
    (messageType) => {
      const format = defaultConfig().notifications;
      format.template.title = "{{summary}}";
      format.template.body = "{{summary}}{{summary}}";
      for (const content of ["\u0000", '"\\\n', "中文🌍", "\ud800"]) {
        const request = buildRequest(
          { ...channel, feishu: { messageType } },
          credentials,
          { ...notificationExample(), summary: content.repeat(10000) },
          1700000000000,
          format,
        );
        expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(20000);
        const payload = JSON.parse(request.body);
        const text =
          messageType === "card"
            ? payload.card.elements[0].text.content
            : payload.content.text;
        expect(text).toBeTruthy();
        expect(text).toMatch(/…$/);
        if (content === "中文🌍") expect(text).not.toMatch(/[\uD800-\uDBFF]…$/);
      }
    },
  );

  it("sends a card through the existing transport and checks the platform receipt", async () => {
    let body = "";
    const fetcher: Fetch = async (_url, request) => {
      body = request.body;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    };
    await deliver(
      channel,
      { ...credentials, signingSecret: "" },
      notificationExample(),
      new AbortController().signal,
      { fetcher, format: defaultConfig().notifications },
    );
    expect(JSON.parse(body)).toMatchObject({ msg_type: "interactive" });
    expect(JSON.parse(body)).not.toHaveProperty("sign");
  });

  it("round-trips card settings and prevents older plugins silently importing them as text", () => {
    const config = defaultConfig();
    config.channels = [channel];
    config.routing.host = [channel.id];
    const secrets = { team: { kind: "feishu" as const, values: credentials } };
    const bundle = parseTransfer(exportConfiguration(config, secrets, true));
    expect(bundle.version).toBe(2);
    const first = planImport(defaultConfig(), {}, bundle, () => "import-team");
    expect(first.config.channels[0]!.feishu?.messageType).toBe("card");
    expect(first.staged["import-team"]!.values).toMatchObject(credentials);
    expect(planImport(first.config, first.staged, bundle).reused).toBe(1);
    first.config.channels[0]!.feishu = { messageType: "text" };
    expect(
      planImport(first.config, first.staged, bundle, () => "import-card").added,
    ).toBe(1);
    config.channels[0] = { ...channel, feishu: undefined };
    const legacy = parseTransfer(exportConfiguration(config, {}, false));
    expect(legacy.version).toBe(1);
    const imported = planImport(
      defaultConfig(),
      {},
      legacy,
      () => "import-text",
    );
    imported.config.channels[0]!.feishu = { messageType: "text" };
    expect(planImport(imported.config, {}, legacy).reused).toBe(1);
  });
});
