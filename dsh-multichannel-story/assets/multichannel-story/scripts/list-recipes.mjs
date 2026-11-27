#!/usr/bin/env node
// 列出已安装的「歸藏设计」插件当前定义的 skill 与内容工作流（recipes）。
// 用法：node scripts/list-recipes.mjs [--lang zh|en] [--json]
//
// 为什么运行时读取：工作流是插件里演进的提示词模板（lib/recipes.js），
// 版本升级后条目可能增减或改文案，硬编码会过期。
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.log([
    "用法：node scripts/list-recipes.mjs [--lang zh|en] [--json]",
    "  --lang  选择文案语言（默认 zh）",
    "  --json  输出机器可读的 JSON",
    "",
    "插件查找顺序：GZ_ROOT（直接指向插件目录）→ $DSH_HOME/profiles/*/node_modules/dsh-guizang-design",
    "  DSH_HOME 默认 ~/.dsh。",
  ].join("\n"));
}

if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const langIdx = args.indexOf("--lang");
if (langIdx >= 0 && args[langIdx + 1] === undefined) {
  console.error("--lang 需要一个值（zh|en）");
  process.exit(2);
}
const lang = (langIdx >= 0 ? args[langIdx + 1] : "zh") || "zh";
const asJson = args.includes("--json");

/** DSH_HOME 默认 ~/.dsh；显式设置时以它为准（Web / Desktop 两个 profile 分开）。 */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

function findPlugin() {
  const roots = [
    process.env.GZ_ROOT,
    path.join(dshHome(), "profiles"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // GZ_ROOT 直接指向插件目录
    if (existsSync(path.join(root, "lib", "recipes.js"))) return root;
    let profiles = [];
    try {
      profiles = readdirSync(root);
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const cand = path.join(root, profile, "node_modules", "dsh-guizang-design");
      if (existsSync(path.join(cand, "lib", "recipes.js"))) return cand;
    }
  }
  return null;
}

const plugin = findPlugin();
if (!plugin) {
  console.error(
    `找不到 dsh-guizang-design 插件。先安装/启用，或设置 GZ_ROOT 指向插件目录（DSH_HOME=${dshHome()}）。`,
  );
  process.exit(1);
}

const mod = await import(pathToFileURL(path.join(plugin, "lib", "recipes.js")).href);
// 兼容 `export default { SKILLS, RECIPES }` 和具名导出两种写法。
const source = mod.default !== undefined && typeof mod.default === "object" ? mod.default : mod;
const sourceSkills = source.SKILLS ?? mod.SKILLS;
const sourceRecipes = source.RECIPES ?? mod.RECIPES;
const skillsFor = source.skillsFor ?? mod.skillsFor;
const recipesFor = source.recipesFor ?? mod.recipesFor;
const skills = (typeof skillsFor === "function" ? skillsFor(lang) : sourceSkills) || [];
const recipes = (typeof recipesFor === "function" ? recipesFor(lang) : sourceRecipes) || [];

// 两个列表都空只可能是版本不匹配（或 lang 传错）：直接报错，别输出一份“空结果”当成功。
if (skills.length === 0 && recipes.length === 0) {
  console.error(
    `dsh-guizang-design 里没有可用的 skill / recipe（lang=${lang}，插件：${plugin}）：插件版本可能不匹配，升级插件或换 --lang。`,
  );
  process.exit(1);
}

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
