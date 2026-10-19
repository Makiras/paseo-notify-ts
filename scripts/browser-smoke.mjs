import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { promisify } from "node:util";
import { chromium, firefox, expect as baseExpect } from "@playwright/test";

// Install the same source archive users receive into a disposable, real Host.
// Every CLI operation supplies its home explicitly; never use the user's daemon.
const run = promisify(execFile);
const cli = resolve("node_modules/@getpaseo/cli/bin/paseo");
const output = resolve(".build/browser-smoke");
const temporary = await mkdtemp(join(tmpdir(), "paseo-notifier-e2e-"));
let preserveTemporary = false;
const browsers = (process.env.PASEO_TEST_BROWSERS || "chromium,firefox").split(
  ",",
);
const expect = baseExpect.configure({ timeout: 15_000 });

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function checkBrowser(name) {
  assert.ok(["chromium", "firefox"].includes(name), `Unknown browser: ${name}`);
  const artifacts = join(output, name);
  const home = join(temporary, name);
  await mkdir(artifacts, { recursive: true });
  await mkdir(home);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const requests = [];
  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const receiverPort = await listen(receiver);
  const env = {
    ...process.env,
    PATH: `${resolve("node_modules/.bin")}${delimiter}${process.env.PATH || ""}`,
    PASEO_HOME: home,
    PASEO_NOTIFIER_STATE_DIR: join(home, "notifier-state"),
  };
  const invoke = async (...args) =>
    JSON.parse(
      (
        await run(process.execPath, [cli, ...args, "--home", home, "--json"], {
          env,
          timeout: 60_000,
        })
      ).stdout,
    );
  let browser, context, page;
  const errors = [];
  try {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        pluginsEnabled: true,
        daemon: {
          listen: `127.0.0.1:${port}`,
          relay: { enabled: false },
          mcp: { enabled: false, injectIntoAgents: false },
        },
        features: {
          webUi: { enabled: true },
          dictation: { enabled: false },
          voiceMode: { enabled: false },
        },
        agents: {
          providers: {
            codex: { enabled: false },
            claude: { enabled: false },
            opencode: { enabled: false },
          },
        },
      }),
    );
    const settingsFile = join(
      home,
      "plugin-settings/paseo-notifier/notifier.json",
    );
    await mkdir(join(home, "plugin-settings/paseo-notifier"), {
      recursive: true,
    });
    await writeFile(
      settingsFile,
      JSON.stringify({
        version: 4,
        values: {
          updates: { checkAutomatically: false },
          routing: {
            sessions: {
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": [],
              "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": [],
            },
          },
          recoveryOverrides: {
            sessions: {
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": { enabled: false },
              "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": { enabled: false },
            },
          },
        },
      }),
    );
    // Synthetic records only: no provider runtime or user session is created.
    const cleanupIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    await mkdir(join(home, "agents"), { recursive: true });
    for (const [i, id] of cleanupIds.entries())
      await writeFile(
        join(home, "agents", `${id}.json`),
        JSON.stringify({
          id,
          provider: "codex",
          cwd: home,
          title: `CI 删除测试 ${i + 1}`,
          createdAt: "2026-10-16T00:00:00Z",
          updatedAt: "2026-10-16T00:00:00Z",
          lastStatus: "closed",
          archivedAt: "2026-10-16T00:00:00Z",
          labels: {},
        }),
      );
    await invoke("start", "--timeout", "45");
    await invoke("plugin", "install", join(temporary, "package"));
    await expect
      .poll(
        async () =>
          (await invoke("plugin", "ls")).find((p) => p.id === "paseo-notifier")
            ?.status,
      )
      .toBe("running");

    browser = await { chromium, firefox }[name].launch({
      headless: true,
      ...(name === "chromium" && process.env.PASEO_CHROMIUM_EXECUTABLE
        ? {
            executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
          }
        : {}),
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${port}`);
    const openPluginSettings = async (title) => {
      const settingsButton = page.getByRole("button", {
        name: "Settings",
        exact: true,
      });
      await expect
        .poll(
          async () =>
            (await settingsButton.isVisible()) ||
            (await page
              .getByRole("button", { name: "Plugins", exact: true })
              .isVisible()),
        )
        .toBe(true);
      if (await settingsButton.isVisible()) await settingsButton.click();
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      await page
        .getByRole("button", { name: "Actions for paseo-notifier" })
        .click();
      await expect(page.getByText("通知管理", { exact: true })).toBeVisible();
      await expect(
        page.getByText("自动恢复与继续", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("会话清理", { exact: true })).toBeVisible();
      await page.getByText(title, { exact: true }).click();
    };
    await openPluginSettings("通知管理");
    await expect(page.getByText("全局设置", { exact: true })).toBeVisible();
    console.log(
      `${name}: installed archive, opened actual Paseo plugin settings`,
    );
    const section = async (label) =>
      page.getByRole("tab", { name: label, exact: true }).click();
    for (const label of [
      "定时任务",
      "通知管理",
      "导入导出",
      "运行状态",
      "版本更新",
    ])
      await section(label);
    await openPluginSettings("自动恢复与继续");
    await expect(
      page.getByRole("tab", { name: "通知渠道", exact: true }),
    ).toHaveCount(0);
    const retries = page.getByLabel("最大重试次数", { exact: true });
    await retries.fill("1.5");
    await expect(
      page.getByText("自动恢复 · 最大重试次数：请填写整数", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存设置", exact: true }),
    ).toBeDisabled();
    await retries.fill("21");
    await expect(
      page.getByText("自动恢复 · 最大重试次数：最多20", { exact: true }),
    ).toBeVisible();
    await retries.fill("5");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
    await openPluginSettings("通知管理");
    await section("通知管理");
    const preview = page.getByLabel("预览正文内容", { exact: true });
    await expect(page.getByLabel("标题模板", { exact: true })).toBeVisible();
    await expect(preview).toBeVisible();
    await expect(page.getByLabel("示例回复", { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel("匹配规则（Pattern）", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Pattern 如何填写", { exact: true }),
    ).toHaveCount(0);
    const editorBounds = await page
      .getByTestId("template-editor-preview")
      .boundingBox();
    const titleBounds = await page
      .getByLabel("标题模板", { exact: true })
      .boundingBox();
    const previewBounds = await page
      .getByLabel("预览标题内容", { exact: true })
      .boundingBox();
    assert.ok(editorBounds && titleBounds && previewBounds);
    if (editorBounds.width >= 680)
      assert.ok(
        previewBounds.x > titleBounds.x + titleBounds.width,
        "Wide preview must sit beside the editor",
      );
    else
      assert.ok(
        previewBounds.y > titleBounds.y,
        "Narrow preview must follow the editor",
      );
    await page.screenshot({
      path: join(artifacts, "template-desktop.png"),
      fullPage: true,
    });
    await expect(preview).not.toContainText("PROJ-123");
    await page.getByRole("switch", { name: "附带最终回复摘要" }).click();
    await page
      .getByRole("button", { name: "展开填写帮助", exact: true })
      .click();
    await expect(page.getByText("占位符用法", { exact: true })).toBeVisible();
    await expect(
      page.getByText("名称有四个层级", { exact: true }),
    ).toBeVisible();
    for (const field of [
      "hostname",
      "project_name",
      "workspace_name",
      "session_title",
    ])
      await expect(
        page.getByText(`{{${field}}}`, { exact: true }),
      ).toBeVisible();
    await expect(
      page.getByText("Pattern 如何填写", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "收起填写帮助", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开规则说明", exact: true })
      .click();
    await expect(
      page.getByText("Pattern 如何填写", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "添加工单号示例", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "收起规则说明", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开提取规则", exact: true })
      .click();
    await page
      .getByRole("button", { name: "添加工单号示例", exact: true })
      .click();
    await expect(preview).toContainText("工单号：PROJ-123");
    const ruleEditor = page.getByTestId("extraction-rule-editor");
    await expect(
      ruleEditor.getByText("正在编辑：custom.ticket", { exact: true }),
    ).toBeVisible();
    const ticketPattern = await ruleEditor
      .getByLabel("匹配规则（Pattern）", { exact: true })
      .inputValue();
    await page
      .getByRole("button", { name: "添加提取规则", exact: true })
      .click();
    await expect(
      ruleEditor.getByText("正在编辑：custom.field", { exact: true }),
    ).toBeVisible();
    await ruleEditor.getByLabel("变量名", { exact: true }).fill("draft");
    await ruleEditor
      .getByLabel("匹配规则（Pattern）", { exact: true })
      .fill("LOCAL-[0-9]+");
    await ruleEditor.getByRole("button", { name: /^编辑提取规则:/ }).click();
    await page
      .getByRole("menuitem", { name: "custom.ticket", exact: true })
      .click();
    await expect(
      ruleEditor.getByText("正在编辑：custom.ticket", { exact: true }),
    ).toBeVisible();
    await expect(
      ruleEditor.getByLabel("匹配规则（Pattern）", { exact: true }),
    ).toHaveValue(ticketPattern);
    await ruleEditor.getByRole("button", { name: /^编辑提取规则:/ }).click();
    await page
      .getByRole("menuitem", { name: "custom.draft", exact: true })
      .click();
    await expect(
      ruleEditor.getByLabel("匹配规则（Pattern）", { exact: true }),
    ).toHaveValue("LOCAL-[0-9]+");
    await ruleEditor
      .getByRole("button", { name: "删除提取规则", exact: true })
      .click();
    await expect(
      ruleEditor.getByText("正在编辑：custom.ticket", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: join(artifacts, "rule-selection-desktop.png"),
      fullPage: true,
    });

    await page
      .getByRole("button", { name: "编辑示例数据", exact: true })
      .click();
    const sample = page.getByLabel("示例回复", { exact: true });
    const originalSample = await sample.inputValue();
    await sample.fill("LOCAL-456");
    await expect(preview).toContainText("工单号：LOCAL-456");
    await page
      .getByRole("button", { name: "收起示例数据", exact: true })
      .click();
    await page
      .getByRole("button", { name: "收起提取规则", exact: true })
      .click();
    await section("通知渠道");
    await section("通知管理");
    await page
      .getByRole("button", { name: "编辑示例数据", exact: true })
      .click();
    await expect(sample).toHaveValue("LOCAL-456");
    await sample.fill(originalSample);
    await page
      .getByRole("button", { name: "收起示例数据", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开提取规则", exact: true })
      .click();
    const title = `CI ${name} · {{event}} · {{title}}`;
    await page.getByLabel("标题模板", { exact: true }).fill(title);
    const pattern = page.getByLabel("匹配规则（Pattern）", { exact: true });
    const validPattern = await pattern.inputValue();
    await pattern.fill("(");
    await expect(page.getByText("模板需要修改", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存设置", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "收起提取规则", exact: true })
      .click();
    await expect(pattern).toHaveCount(0);
    await page
      .getByRole("button", { name: "展开错误规则", exact: true })
      .click();
    await expect(pattern).toHaveValue("(");
    await pattern.fill(validPattern);
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
    await page.reload();
    await section("通知管理");
    await expect(page.getByLabel("标题模板", { exact: true })).toHaveValue(
      title,
    );
    await expect(preview).toContainText("工单号：PROJ-123");
    await expect(
      page.getByRole("button", { name: "展开提取规则", exact: true }),
    ).toBeVisible();
    const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.equal(persisted.version, 7);
    assert.equal(persisted.values.notifications.template.title, title);

    // Check the previously broken save -> credentials -> immediately test flow.
    // The only notification receiver is an HTTP server on this test machine.
    await section("通知渠道");
    await page.getByRole("button", { name: /^新渠道平台:/ }).click();
    await page.getByRole("menuitem", { name: "ntfy", exact: true }).click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await page
      .getByLabel("服务根地址", { exact: true })
      .fill(`http://127.0.0.1:${receiverPort}`);
    await page.getByLabel("Topic", { exact: true }).fill("browser-smoke");
    const channelEditor = page.getByTestId("notification-channel-editor");
    await expect(
      channelEditor.getByText("正在编辑：ntfy", { exact: true }),
    ).toBeVisible();
    await expect(
      channelEditor.getByRole("button", { name: /^编辑渠道:/ }),
    ).toBeVisible();
    await expect(
      channelEditor.getByRole("button", { name: "添加渠道", exact: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(
      page.getByText("设置和凭据已保存", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送测试", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    assert.equal(requests[0].topic, "browser-smoke");
    assert.ok(requests[0].title.startsWith(`CI ${name} · `));
    assert.equal(typeof requests[0].message, "string");

    // Exercise the real per-channel card selector and preview. No external
    // credentials are configured and no Feishu notification is sent.
    await expect(page.getByRole("button", { name: /^消息类型:/ })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: /^新渠道平台:/ }).click();
    await page
      .getByRole("menuitem", { name: "飞书 / Lark 群机器人", exact: true })
      .click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await page
      .getByRole("textbox", { name: "名称", exact: true })
      .fill("CI 卡片群");
    await expect(
      channelEditor.getByText("正在编辑：CI 卡片群", { exact: true }),
    ).toBeVisible();
    const draftUrl = "https://example.com/unsent-draft";
    await channelEditor
      .getByLabel("Webhook 地址", { exact: true })
      .fill(draftUrl);
    await channelEditor.getByRole("button", { name: /^编辑渠道:/ }).click();
    await page.getByRole("menuitem", { name: "1. ntfy", exact: true }).click();
    await expect(
      channelEditor.getByText("正在编辑：ntfy", { exact: true }),
    ).toBeVisible();
    await channelEditor.getByRole("button", { name: /^编辑渠道:/ }).click();
    await page
      .getByRole("menuitem", {
        name: "2. CI 卡片群（凭据待保存）",
        exact: true,
      })
      .click();
    await expect(
      channelEditor.getByLabel("Webhook 地址", { exact: true }),
    ).toHaveValue(draftUrl);
    await channelEditor.getByLabel("Webhook 地址", { exact: true }).fill("");
    await page
      .getByRole("button", { name: "消息类型: 文本消息", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "卡片消息", exact: true }).click();
    await expect(page.getByText("卡片示例", { exact: true })).toBeVisible();
    await expect(page.getByTestId("feishu-card-preview")).toContainText(
      "工单号：PROJ-123",
    );
    await page
      .getByRole("button", { name: "示例通知类型: 任务完成", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "任务失败", exact: true }).click();
    await expect(page.getByTestId("feishu-card-preview")).toContainText(
      `CI ${name} · 任务失败`,
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
    await page.reload();
    await section("通知渠道");
    await page.getByRole("button", { name: /^编辑渠道:/ }).click();
    await page
      .getByRole("menuitem", { name: "2. CI 卡片群", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "消息类型: 卡片消息", exact: true }),
    ).toBeVisible();
    assert.equal(
      JSON.parse(await readFile(settingsFile, "utf8")).values.channels[1].feishu
        .messageType,
      "card",
    );
    await page.getByRole("button", { name: /^新渠道平台:/ }).click();
    await page
      .getByRole("menuitem", { name: "飞书 / Lark 群机器人", exact: true })
      .click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await page
      .getByRole("textbox", { name: "名称", exact: true })
      .fill("CI 文本群");
    await expect(
      page.getByRole("button", { name: "消息类型: 文本消息", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^编辑渠道:/ }).click();
    await page
      .getByRole("menuitem", { name: "2. CI 卡片群", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "消息类型: 卡片消息", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    // Paseo remounts this surface when switching desktop/mobile layouts.
    // Select the persisted card channel again in the compact surface.
    await expect(
      page.getByRole("button", { name: "设置栏目: 通知渠道", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^编辑渠道:/ }).click();
    await page
      .getByRole("menuitem", { name: "2. CI 卡片群", exact: true })
      .click();
    await page.getByText("卡片示例", { exact: true }).scrollIntoViewIfNeeded();
    const cardBounds = await page
      .getByTestId("feishu-card-preview")
      .boundingBox();
    assert.ok(
      cardBounds && cardBounds.x >= 0 && cardBounds.x + cardBounds.width <= 390,
    );
    await page.screenshot({
      path: join(artifacts, "feishu-card-mobile.png"),
      fullPage: true,
    });

    // The host switches to its compact controls; exercise the real dropdown.
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "设置栏目: 通知渠道", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "通知管理", exact: true }).click();
    await expect(page.getByLabel("标题模板", { exact: true })).toHaveValue(
      title,
    );
    await expect(preview).toContainText("工单号：PROJ-123");
    const compactTitleBounds = await page
      .getByLabel("标题模板", { exact: true })
      .boundingBox();
    const compactPreviewBounds = await page
      .getByLabel("预览标题内容", { exact: true })
      .boundingBox();
    assert.ok(compactTitleBounds && compactPreviewBounds);
    assert.ok(
      compactPreviewBounds.y > compactTitleBounds.y,
      "Compact preview must follow the editor",
    );
    assert.ok(
      compactTitleBounds.x >= 0 &&
        compactTitleBounds.x + compactTitleBounds.width <= 390,
      "Compact editor must fit the viewport",
    );
    await page
      .getByRole("button", { name: "展开提取规则", exact: true })
      .click();
    await expect(pattern).toHaveValue(validPattern);
    await ruleEditor
      .getByRole("button", { name: /^编辑提取规则:/ })
      .scrollIntoViewIfNeeded();
    const ruleBounds = await ruleEditor.boundingBox();
    assert.ok(
      ruleBounds && ruleBounds.x >= 0 && ruleBounds.x + ruleBounds.width <= 390,
    );
    await page.screenshot({
      path: join(artifacts, "rule-selection-mobile.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "收起提取规则", exact: true })
      .click();
    await page.getByLabel("标题模板", { exact: true }).scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await openPluginSettings("会话清理");
    const firstCleanup = page.getByTestId(`cleanup-session-${cleanupIds[0]}`);
    const secondCleanup = page.getByTestId(`cleanup-session-${cleanupIds[1]}`);
    await expect(firstCleanup).toBeVisible();
    await expect(secondCleanup).toBeVisible();
    await firstCleanup
      .getByRole("switch", { name: "CI 删除测试 1", exact: true })
      .click();
    await page.getByRole("button", { name: "删除会话", exact: true }).click();
    await expect(page.getByTestId("session-delete-confirmation")).toContainText(
      cleanupIds[0],
    );
    await page.getByRole("button", { name: "取消删除", exact: true }).click();
    assert.ok(await readFile(join(home, "agents", `${cleanupIds[0]}.json`)));
    await page.getByRole("button", { name: "删除会话", exact: true }).click();
    await page
      .getByRole("button", { name: "确认删除 1 个会话", exact: true })
      .click();
    await expect(firstCleanup).toHaveCount(0);
    await expect(secondCleanup).toBeVisible();
    await expect(
      page.getByText("已删除 1 个会话。", { exact: true }),
    ).toBeVisible();
    await assert.rejects(
      readFile(join(home, "agents", `${cleanupIds[0]}.json`)),
      { code: "ENOENT" },
    );
    assert.ok(await readFile(join(home, "agents", `${cleanupIds[1]}.json`)));
    const cleanedSettings = JSON.parse(
      await readFile(settingsFile, "utf8"),
    ).values;
    assert.equal(
      Object.hasOwn(cleanedSettings.routing.sessions, cleanupIds[0]),
      false,
    );
    assert.equal(
      Object.hasOwn(cleanedSettings.recoveryOverrides.sessions, cleanupIds[0]),
      false,
    );
    assert.equal(
      Object.hasOwn(cleanedSettings.routing.sessions, cleanupIds[1]),
      true,
    );
    assert.equal(
      Object.hasOwn(cleanedSettings.recoveryOverrides.sessions, cleanupIds[1]),
      true,
    );
    await page.getByRole("button", { name: "刷新会话", exact: true }).click();
    await expect(firstCleanup).toHaveCount(0);
    await expect(secondCleanup).toBeVisible();
    await page.screenshot({
      path: join(artifacts, "session-cleanup.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(secondCleanup).toBeVisible();
    await secondCleanup
      .getByRole("switch", { name: "CI 删除测试 2", exact: true })
      .click();
    await page.getByRole("button", { name: "删除会话", exact: true }).click();
    const confirmButton = page.getByRole("button", {
      name: "确认删除 1 个会话",
      exact: true,
    });
    await confirmButton.scrollIntoViewIfNeeded();
    const deleteBounds = await confirmButton.boundingBox();
    assert.ok(
      deleteBounds &&
        deleteBounds.x >= 0 &&
        deleteBounds.x + deleteBounds.width <= 390,
    );
    await page.screenshot({
      path: join(artifacts, "session-delete-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "取消删除", exact: true }).click();
    assert.ok(await readFile(join(home, "agents", `${cleanupIds[1]}.json`)));
    const retainedSettings = JSON.parse(
      await readFile(settingsFile, "utf8"),
    ).values;
    assert.equal(
      Object.hasOwn(retainedSettings.routing.sessions, cleanupIds[0]),
      false,
    );
    assert.equal(
      Object.hasOwn(retainedSettings.recoveryOverrides.sessions, cleanupIds[0]),
      false,
    );
    assert.equal(
      Object.hasOwn(retainedSettings.routing.sessions, cleanupIds[1]),
      true,
    );
    assert.equal(
      Object.hasOwn(retainedSettings.recoveryOverrides.sessions, cleanupIds[1]),
      true,
    );
    assert.deepEqual(errors, [], "Browser errors must fail the smoke test");
    console.log(
      `${name}: compact template layout, folding/drafts/error recovery, save/reload, Feishu card selection/preview, ntfy save/test, separate settings entries and confirmed session deletion passed`,
    );
  } finally {
    if (page)
      await page
        .screenshot({ path: join(artifacts, "settings.png"), fullPage: true })
        .catch(() => {});
    if (context)
      await context.tracing
        .stop({ path: join(artifacts, "trace.zip") })
        .catch(() => {});
    await browser?.close();
    await writeFile(join(artifacts, "browser-errors.log"), errors.join("\n"));
    await invoke("daemon", "stop", "--force").catch((error) => {
      console.error(`Failed to stop test Host at ${home}: ${error.message}`);
      preserveTemporary = true;
      process.exitCode = 1;
    });
    await copyFile(
      join(home, "daemon.log"),
      join(artifacts, "daemon.log"),
    ).catch(() => {});
    await close(receiver);
  }
}

try {
  await mkdir(output, { recursive: true });
  const packed = JSON.parse(
    (
      await run("npm", [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporary,
      ])
    ).stdout,
  )[0];
  await run("tar", ["-xzf", join(temporary, packed.filename), "-C", temporary]);
  for (const name of browsers) await checkBrowser(name);
} finally {
  // Keep the explicit home and PID files available if shutdown needs recovery.
  if (!preserveTemporary) await rm(temporary, { recursive: true, force: true });
}
