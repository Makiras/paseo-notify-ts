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
import { join, resolve } from "node:path";
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
        values: { updates: { checkAutomatically: false } },
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page
      .getByRole("button", { name: "Actions for paseo-notifier" })
      .click();
    await page.getByText("通知与自动恢复", { exact: true }).click();
    await expect(page.getByText("全局设置", { exact: true })).toBeVisible();
    console.log(
      `${name}: installed archive, opened actual Paseo plugin settings`,
    );
    const section = async (label) =>
      page.getByRole("tab", { name: label, exact: true }).click();
    for (const label of [
      "定时任务",
      "自动恢复",
      "通知管理",
      "导入导出",
      "运行状态",
      "版本更新",
    ])
      await section(label);
    await section("自动恢复");
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
    await expect(
      page.getByText("Pattern 如何填写", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "收起填写帮助", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开提取规则", exact: true })
      .click();
    await page
      .getByRole("button", { name: "添加工单号示例", exact: true })
      .click();
    await expect(preview).toContainText("工单号：PROJ-123");
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
    assert.equal(persisted.version, 5);
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
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(
      page.getByText("设置和凭据已保存", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "发送测试", exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    assert.equal(requests[0].topic, "browser-smoke");
    assert.ok(requests[0].title.startsWith(`CI ${name} · `));
    assert.equal(typeof requests[0].message, "string");

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
    await page
      .getByRole("button", { name: "收起提取规则", exact: true })
      .click();
    await page.getByLabel("标题模板", { exact: true }).scrollIntoViewIfNeeded();
    assert.deepEqual(errors, [], "Browser errors must fail the smoke test");
    console.log(
      `${name}: compact template layout, folding/drafts/error recovery, save/reload and ntfy save/test passed`,
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
