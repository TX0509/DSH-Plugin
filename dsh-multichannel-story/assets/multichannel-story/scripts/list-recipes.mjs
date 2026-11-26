#!/usr/bin/env node
// 列出已安装的「歸藏设计」插件当前定义的 skill 与内容工作流（recipes）。
// 用法：node scripts/list-recipes.mjs [--lang zh|en] [--json]
//
// 为什么运行时读取：工作流是插件里演进的提示词模板（lib/recipes.js），
// 版本升级后条目可能增减或改文案，硬编码会过期。
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { readdirSync } from "node:fs";

const args = process.argv.slice(2);
const langIdx = args.indexOf("--lang");
const lang = (langIdx >= 0 ? args[langIdx + 1] : "zh") || "zh";
const asJson = args.includes("--json");

function findPlugin() {
  const roots = [
    process.env.GZ_ROOT,
    path.join(os.homedir(), ".dsh", "profiles"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // GZ_ROOT 直接指向插件目录
    if (existsSync(path.join(root, "lib", "recipes.js"))) return root;
    for (const profile of readdirSync(root)) {
      const cand = path.join(root, profile, "node_modules", "dsh-guizang-design");
      if (existsSync(path.join(cand, "lib", "recipes.js"))) return cand;
    }
  }
  return null;
}

const plugin = findPlugin();
if (!plugin) {
  console.error(
    "找不到 dsh-guizang-design 插件。先安装/启用，或设置 GZ_ROOT 指向插件目录。",
  );
  process.exit(1);
}

const mod = await import(pathToFileURL(path.join(plugin, "lib", "recipes.js")).href);
const skills = (mod.skillsFor ? mod.skillsFor(lang) : mod.SKILLS) || [];
const recipes = (mod.recipesFor ? mod.recipesFor(lang) : mod.RECIPES) || [];

const out = {
  plugin,
  language: lang,
  skills: skills.map((s) => ({ name: s.name, title: s.title, short: s.short, starter: s.starter })),
  recipes: recipes.map((r) => ({ id: r.id, title: r.title, summary: r.summary, steps: r.steps, prompt: r.prompt })),
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`插件：${plugin}\n`);
  console.log("SKILLS");
  for (const s of out.skills) console.log(`  /${s.name.padEnd(28)} ${s.title} — ${s.short}`);
  console.log("\nRECIPES（内容工作流）");
  for (const r of out.recipes) {
    console.log(`\n  [${r.id}] ${r.title}  ·  ${r.steps.join(" → ")}`);
    console.log(`    ${r.summary}`);
  }
  console.log("\n提示：用户点了某个工作流时，消息会以 /skill 名开头；按该条 steps 执行即可。");
}
