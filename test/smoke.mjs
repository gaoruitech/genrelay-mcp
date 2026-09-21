/**
 * Boot the server over real stdio and speak MCP to it.
 *
 * Compiling proves the types line up; it does not prove the server starts,
 * advertises its tools, or answers a call. This does — it is the same
 * handshake Claude Desktop performs.
 *
 * No API key is set, so the generation tools should refuse politely rather
 * than crash; list_models must work regardless.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GENRELAY_API_KEY: "" },
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

const pending = new Map();
let buffer = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

try {
  // 1. handshake
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  });
  check("initialize 握手", init.result?.serverInfo?.name === "genrelay",
        `server=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  notify("notifications/initialized", {});

  // 2. tools are advertised
  const list = await call("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ["check_job", "generate_image", "generate_video", "list_models"];
  check("tools/list 列出 4 个工具", JSON.stringify(names) === JSON.stringify(expected),
        names.join(", "));

  // every tool needs a description — that text is what the model reads to
  // decide whether to call it
  const undescribed = (list.result?.tools ?? []).filter((t) => !t.description);
  check("每个工具都有描述", undescribed.length === 0,
        undescribed.length ? undescribed.map((t) => t.name).join(",") : "");

  // input schemas must be real JSON Schema objects
  const badSchema = (list.result?.tools ?? []).filter(
    (t) => !t.inputSchema || t.inputSchema.type !== "object",
  );
  check("inputSchema 都是合法 JSON Schema", badSchema.length === 0,
        badSchema.map((t) => t.name).join(","));

  // 3. a tool that needs no key must work
  const models = await call("tools/call", { name: "list_models", arguments: {} });
  const modelsText = models.result?.content?.[0]?.text ?? "";
  check("list_models 可调用", modelsText.includes("veo_3_1") && modelsText.includes("nano-banana-pro"),
        `${modelsText.split("\n").length} 行`);

  // 4. without a key, generation must refuse cleanly — not crash
  const noKey = await call("tools/call", {
    name: "generate_video",
    arguments: { prompt: "a fox", model: "veo_3_1" },
  });
  const noKeyText = noKey.result?.content?.[0]?.text ?? "";
  check("缺 API key 时优雅拒绝", noKey.result?.isError === true && noKeyText.includes("GENRELAY_API_KEY"),
        noKeyText.slice(0, 60));

  // 5. schema validation rejects bad input instead of passing it upstream
  const bad = await call("tools/call", {
    name: "generate_video",
    arguments: { prompt: "x", model: "not-a-real-model" },
  });
  check("非法模型名被 schema 拦下", bad.error != null || bad.result?.isError === true,
        (bad.error?.message ?? bad.result?.content?.[0]?.text ?? "").slice(0, 60));

  check("启动横幅写到 stderr（不污染协议）", stderr.includes("genrelay-mcp"),
        stderr.trim().split("\n")[0] ?? "");
} catch (err) {
  check("协议交互", false, String(err));
} finally {
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
