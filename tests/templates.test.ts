import { describe, expect, it } from "vitest";
import { defaultConfig, migrateSettings } from "../shared/config";
import type { Notification } from "../shared/contracts";
import {
  defaultMessageTemplate,
  extractionExamples,
  extractionRuleSchema,
  messageTemplateSchema,
} from "../shared/template-schema";
import { renderNotification, type MessageFormat } from "../shared/templates";
import { parseTransfer } from "../shared/transfer";
import { exportConfiguration, planImport } from "../server/transfer";

const notice: Notification = {
  id: "notice-a",
  kind: "recovered",
  title: "检查构建",
  summary: "任务完成",
  preview: "已处理工单 PROJ-123。\n结果：https://example.com/result/123",
  agentId: "session-a",
  workspaceId: null,
  provider: "codex",
  attempts: 2,
  createdAt: Date.UTC(2026, 0, 1),
  failure: "network",
};
const format = (): MessageFormat => ({
  template: defaultMessageTemplate(),
  includePreview: true,
  previewCharacters: 600,
});

describe("notification message templates", () => {
  it("renders the default message and omits absent optional lines", () => {
    expect(
      renderNotification({ ...notice, preview: undefined, attempts: 0 }).text,
    ).toBe(
      "Paseo · 恢复后完成\n检查构建\n任务完成\n会话：session-a\n提供方：codex\n2026-01-01T00:00:00.000Z",
    );
  });
  it("fills IDs, failure, time, and recovery information", () => {
    const f = format();
    f.template.body =
      "{{notification_id}}|{{ event_type }}|{{provider}}|{{workspace_id}}|{{schedule_id}}|{{failure}}|{{failure_type}}|{{attempts}}|{{recovery}}|{{created_at}}";
    expect(renderNotification(notice, f).body).toBe(
      "notice-a|recovered|codex|||网络故障|network|2|自动恢复尝试：2 次|2026-01-01T00:00:00.000Z",
    );
  });
  it("extracts the first ticket and a capture group from the documented examples", () => {
    const f = format();
    f.template.rules = extractionExamples.map((v) => v.rule);
    f.template.body = "工单：{{custom.ticket}}\n链接：{{custom.link}}";
    const result = renderNotification(
      { ...notice, preview: notice.preview + " PROJ-999" },
      f,
    );
    expect(result.body).toBe(
      "工单：PROJ-123\n链接：https://example.com/result/123",
    );
    expect(result.extractions.every((v) => v.matched)).toBe(true);
  });
  it("supports source selection, Unicode, flags, and unmatched optional groups", () => {
    const f = format();
    f.template.rules = [
      extractionRuleSchema.parse({
        name: "unicode",
        source: "title",
        pattern: "(检查)(构建)",
        group: 2,
      }),
      extractionRuleSchema.parse({
        name: "flags",
        source: "summary",
        pattern: "^ok:(.*)$",
        group: 1,
        flags: "ims",
      }),
      extractionRuleSchema.parse({
        name: "missing",
        source: "title",
        pattern: "检查(结果)?",
        group: 1,
        fallback: "没有结果",
      }),
    ];
    f.template.body = "{{custom.unicode}}|{{custom.flags}}|{{custom.missing}}";
    expect(
      renderNotification({ ...notice, summary: "首行\nOK:one\ntwo" }, f).body,
    ).toBe("构建|one\ntwo|没有结果");
  });
  it("does not extract or interpolate a reply when preview is off, including an empty-matching pattern", () => {
    const f = format();
    f.includePreview = false;
    f.template.rules = [
      extractionRuleSchema.parse({
        name: "reply",
        pattern: ".*",
        fallback: "未开放",
      }),
    ];
    f.template.body = "{{preview}}\n{{custom.reply}}";
    expect(renderNotification(notice, f)).toMatchObject({
      body: "未开放",
      extractions: [{ matched: false }],
    });
  });
  it("applies the current preview limit before extraction", () => {
    const f = format();
    f.previewCharacters = 80;
    f.template.rules = [extractionExamples[0]!.rule];
    f.template.body = "{{custom.ticket}}";
    expect(
      renderNotification(
        { ...notice, preview: "🌍".repeat(80) + "PROJ-999" },
        f,
      ).body,
    ).toBe("未提供工单号");
  });
  it("never interprets placeholder-like text from replies or fallback values a second time", () => {
    const f = format();
    f.template.rules = [
      extractionRuleSchema.parse({
        name: "missing",
        pattern: "not-found",
        fallback: "{{provider}}",
      }),
    ];
    f.template.body = "{{preview}} {{custom.missing}}";
    expect(
      renderNotification({ ...notice, preview: "{{summary}} $&" }, f).body,
    ).toBe("{{summary}} $& {{provider}}");
  });
  it.each([
    { body: "{{unknown}}" },
    { title: "{{title}" },
    { body: "{{title}} }}" },
    { body: " " },
    { body: "{{custom.ticket}}" },
    { rules: [extractionExamples[0]!.rule, extractionExamples[0]!.rule] },
  ])("rejects malformed and ambiguous templates: %j", (value) => {
    expect(messageTemplateSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    { pattern: "(" },
    { pattern: "(?=secret)" },
    { pattern: "(a)\\1" },
    { pattern: "[a-z]+", group: 1 },
    { pattern: "ok", flags: "g" },
    { pattern: "ok", flags: "ii" },
    { pattern: "x".repeat(501) },
  ])("rejects invalid and unsupported extraction rules: %j", (rule) => {
    expect(
      extractionRuleSchema.safeParse({ name: "field", ...rule }).success,
    ).toBe(false);
  });
  it("handles a backtracking trap with bounded source input", () => {
    const f = format();
    f.template.rules = [
      extractionRuleSchema.parse({
        name: "trap",
        source: "summary",
        pattern: "^(a+)+$",
        fallback: "no",
      }),
    ];
    f.template.body = "{{custom.trap}}";
    expect(
      renderNotification({ ...notice, summary: "a".repeat(3999) + "!" }, f)
        .body,
    ).toBe("no");
  });
  it("preserves authored blank lines and keeps completely empty output deliverable", () => {
    const f = format();
    f.template.body = "{{title}}\n\n{{workspace_id}}\n{{summary}}";
    expect(renderNotification(notice, f).body).toBe("检查构建\n\n任务完成");
    f.template.title = "{{workspace_id}}";
    f.template.body = "{{workspace_id}}";
    expect(renderNotification(notice, f)).toMatchObject({
      title: "Paseo · 恢复后完成",
      body: "任务完成",
    });
  });
  it("bounds expanded titles and bodies without splitting surrogate pairs", () => {
    const f = format();
    f.template.title = "{{summary}}";
    f.template.body = "{{summary}}{{summary}}";
    const rendered = renderNotification(
      { ...notice, summary: "🌍".repeat(10_000) },
      f,
    );
    expect(rendered.title.length).toBeLessThanOrEqual(200);
    expect(rendered.body.length).toBeLessThanOrEqual(16_000);
    expect(rendered.title).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(rendered.body).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
  it("migrates old settings without changing routes or opting into reply disclosure", () => {
    const old = defaultConfig();
    const { template: _, ...notifications } = old.notifications;
    for (const version of [2, 3, 4]) {
      const next = migrateSettings({ ...old, notifications }, version);
      expect(next.notifications.template).toEqual(defaultMessageTemplate());
      expect(next.notifications.includePreview).toBe(false);
      expect(next.routing).toEqual(old.routing);
    }
  });
  it("round-trips templates and rules through clipboard export and import", () => {
    const config = defaultConfig();
    config.notifications.template.rules = [extractionExamples[0]!.rule];
    config.notifications.template.body = "{{custom.ticket}}";
    const bundle = parseTransfer(exportConfiguration(config, {}, false));
    expect(
      planImport(defaultConfig(), {}, bundle).config.notifications,
    ).toEqual(config.notifications);
  });
});
