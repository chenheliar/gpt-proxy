import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cwd = process.cwd();
const args = parseArgs(process.argv.slice(2));
const projectName = args.project || args.p;
const databaseName = args.database || args.db || (projectName ? `${projectName}-db` : null);
const skipDeploy = Boolean(args["skip-deploy"]);

if (!projectName) {
  fail(
    [
      "缺少项目名。",
      "用法：npm run setup -- --project my-gateway",
      "可选：--database my-gateway-db --skip-deploy",
    ].join("\n"),
  );
}

if (!databaseName) {
  fail("缺少数据库名。");
}

log(`检查 Wrangler 登录状态`);
run("npx", ["wrangler", "whoami"]);

log(`创建 D1 数据库: ${databaseName}`);
const createResult = run("npx", ["wrangler", "d1", "create", databaseName], { capture: true });
const bindings = extractD1Bindings(createResult.combined);
if (!bindings.databaseId) {
  fail(`未能从 Wrangler 输出中提取 database_id。\n\n${createResult.combined}`);
}

log(`更新 wrangler.toml`);
patchWranglerToml({
  projectName,
  databaseName: bindings.databaseName || databaseName,
  databaseId: bindings.databaseId,
});

log(`执行本地 D1 迁移`);
run("npx", ["wrangler", "d1", "migrations", "apply", bindings.databaseName || databaseName, "--local"]);

log(`执行远端 D1 迁移`);
run("npx", ["wrangler", "d1", "migrations", "apply", bindings.databaseName || databaseName, "--remote"]);

if (!skipDeploy) {
  log(`部署到 Cloudflare Pages: ${projectName}`);
  run("npx", ["wrangler", "pages", "deploy", "public", "--project-name", projectName]);
}

const summary = [
  "",
  "模板初始化完成。",
  `Pages 项目名: ${projectName}`,
  `D1 数据库名: ${bindings.databaseName || databaseName}`,
  `D1 数据库 ID: ${bindings.databaseId}`,
  skipDeploy ? "已跳过首次部署，可稍后运行 npm run deploy" : "首次部署已执行，请查看上方 Wrangler 输出中的部署地址。",
  "",
  "后续常用命令：",
  "  npm install",
  "  npm run dev",
  "  npm run deploy -- --project-name <your-project>",
];
  console.log(summary.join("\n"));

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const part = rawArgs[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function extractD1Bindings(output) {
  const databaseNameMatch = output.match(/database_name\s*=\s*"([^"]+)"/);
  const databaseIdMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
  return {
    databaseName: databaseNameMatch?.[1] || null,
    databaseId: databaseIdMatch?.[1] || null,
  };
}

function patchWranglerToml({ projectName, databaseName, databaseId }) {
  const filePath = resolve(cwd, "wrangler.toml");
  const source = readFileSync(filePath, "utf8");
  const updated = source
    .replace(/^name\s*=\s*"[^"]+"$/m, `name = "${projectName}"`)
    .replace(/^database_name\s*=\s*"[^"]+"$/m, `database_name = "${databaseName}"`)
    .replace(/^database_id\s*=\s*"[^"]+"$/m, `database_id = "${databaseId}"`);

  writeFileSync(filePath, updated, "utf8");
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    fail(combined || `${command} ${commandArgs.join(" ")} 执行失败。`);
  }
  return {
    ...result,
    combined,
  };
}

function log(message) {
  console.log(`\n==> ${message}`);
}

function fail(message) {
  console.error(`\n[setup failed]\n${message}`);
  process.exit(1);
}
