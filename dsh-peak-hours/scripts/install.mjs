#!/usr/bin/env node
/**
 * dsh-peak-hours installer.
 *
 * Links this directory into one or more DSH profiles and registers it as a
 * bundle, without pnpm: a profile plugin is just a package under
 * <profile>/node_modules plus its name in `dsh.profile.bundles`.
 *
 * Usage:
 *   node scripts/install.mjs                 # install into every detected profile
 *   node scripts/install.mjs --check         # verify, change nothing
 *   node scripts/install.mjs --uninstall     # remove from every detected profile
 *   node scripts/install.mjs --profile web --profile desktop
 *   node scripts/install.mjs --dry-run
 *   node scripts/install.mjs --force         # replace a stale link after moving the folder
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(SCRIPT_DIR, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));
const PLUGIN_NAME = manifest.name;
const DEP_SPEC = "link:" + PLUGIN_DIR.replace(/\\/g, "/");

function printHelp() {
  console.log(`dsh-peak-hours 安装器

用法:
  node scripts/install.mjs                 安装到 web 和 desktop（没有则退回全部 profile）
  node scripts/install.mjs --check         只检查安装状态
  node scripts/install.mjs --uninstall     从全部 profile 卸载
  node scripts/install.mjs --profile web   只处理指定 profile（可重复）
  node scripts/install.mjs --all           安装到检测到的全部 profile
  node scripts/install.mjs --dry-run       只打印将要做的事
  node scripts/install.mjs --force         插件目录移动后，重建失效的链接

环境变量:
  DSH_HOME   DSH 数据目录，默认 ~/.dsh`);
}

function parseArgs(argv) {
  const options = { profiles: [], check: false, uninstall: false, dryRun: false, force: false, all: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--profile") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--profile 需要一个 profile 名");
      options.profiles.push(value);
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      options.profiles.push(arg.slice("--profile=".length));
    } else if (arg.startsWith("--profiles=")) {
      options.profiles.push(...arg.slice("--profiles=".length).split(",").map((value) => value.trim()).filter(Boolean));
    } else {
      throw new Error("未知参数: " + arg);
    }
  }
  return options;
}

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), ".dsh");
}

function readJson(file) {
  // Some editors on Windows prepend a BOM; JSON.parse rejects it.
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

/** Absolute, case-normalized comparison for link targets. */
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** The real target of an existing link, or null when absent/broken. */
function linkTarget(linkPath) {
  try {
    fs.lstatSync(linkPath);
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(linkPath);
  } catch {
    return "BROKEN";
  }
}

function createLink(linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(PLUGIN_DIR, linkPath, type);
}

function removeLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
    return;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EISDIR" && error.code !== "EACCES") throw error;
  }
  fs.rmdirSync(linkPath);
}

/** Every profile directory that declares a dsh profile manifest. */
function detectProfiles(profilesRoot) {
  const names = [];
  for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const file = path.join(profilesRoot, entry.name, "package.json");
    if (!fs.existsSync(file)) continue;
    try {
      const profile = readJson(file);
      if (profile.dsh !== undefined && typeof profile.dsh.profile === "object" && profile.dsh.profile !== null) {
        names.push(entry.name);
      }
    } catch {
      // A broken profile manifest is not this installer's business.
    }
  }
  return names;
}

function backupManifest(file, dryRun) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  let backup = file + ".bak-peak-hours-" + stamp;
  let counter = 2;
  while (fs.existsSync(backup)) {
    backup = file + ".bak-peak-hours-" + stamp + "-" + counter;
    counter += 1;
  }
  if (!dryRun) fs.copyFileSync(file, backup);
  return backup;
}

function prepareManifest(profileName, profilesRoot) {
  const dir = path.join(profilesRoot, profileName);
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) throw new Error("找不到 " + file + "（先启动一次 DSH 生成 profile）");
  const profile = readJson(file);
  if (profile.dsh === undefined || typeof profile.dsh.profile !== "object" || profile.dsh.profile === null) {
    throw new Error(profileName + " 不是 DSH profile（缺少 dsh.profile）");
  }
  if (!Array.isArray(profile.dsh.profile.bundles)) {
    throw new Error(profileName + " 的 dsh.profile.bundles 不是数组，无法安全安装");
  }
  return { dir, file, profile };
}

function installProfile(profileName, profilesRoot, options) {
  const { dir, file, profile } = prepareManifest(profileName, profilesRoot);
  const linkPath = path.join(dir, "node_modules", PLUGIN_NAME);
  const target = linkTarget(linkPath);
  const linked = target !== null && target !== "BROKEN" && samePath(target, PLUGIN_DIR);
  const bundleListed = profile.dsh.profile.bundles.includes(PLUGIN_NAME);
  const currentDep = profile.dependencies === undefined ? undefined : profile.dependencies[PLUGIN_NAME];

  if (options.check) {
    const problems = [];
    if (!linked) problems.push("node_modules 链接" + (target === null ? "不存在" : target === "BROKEN" ? "已失效" : "指向别处"));
    if (!bundleListed) problems.push("dsh.profile.bundles 未登记");
    if (currentDep !== DEP_SPEC) problems.push("dependencies 未登记 link 依赖");
    if (problems.length > 0) {
      console.log("[FAIL] " + profileName + ": " + problems.join("；"));
      return false;
    }
    console.log("[ok] " + profileName + ": 已安装");
    return true;
  }

  if (options.uninstall) {
    if (!linked && !bundleListed && currentDep === undefined) {
      console.log("[skip] " + profileName + ": 未安装");
      return true;
    }
    if (options.dryRun) {
      console.log("[plan] " + profileName + ": 删除链接并移出 bundles/dependencies");
      return true;
    }
    const backup = backupManifest(file, false);
    if (bundleListed) profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== PLUGIN_NAME);
    if (profile.dependencies !== undefined && currentDep !== undefined) delete profile.dependencies[PLUGIN_NAME];
    fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n", "utf8");
    if (target !== null) removeLink(linkPath);
    console.log("[ok] " + profileName + ": 已卸载（备份 " + path.basename(backup) + "）");
    return true;
  }

  if (linked && bundleListed && currentDep === DEP_SPEC) {
    console.log("[skip] " + profileName + ": 已是最新");
    return true;
  }

  if (options.dryRun) {
    console.log("[plan] " + profileName + ": 链接 " + linkPath + " -> " + PLUGIN_DIR + "，并登记到 bundles/dependencies");
    return true;
  }

  if (!linked) {
    if (target !== null) {
      if (!options.force) {
        throw new Error(profileName + " 已存在指向 " + (target === "BROKEN" ? "（失效目标）" : target) + " 的链接；确认要替换请加 --force");
      }
      removeLink(linkPath);
    }
    createLink(linkPath);
  }

  const backup = backupManifest(file, false);
  if (profile.dependencies === undefined) profile.dependencies = {};
  profile.dependencies[PLUGIN_NAME] = DEP_SPEC;
  if (!bundleListed) profile.dsh.profile.bundles.push(PLUGIN_NAME);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n", "utf8");

  // Read back so a broken write cannot be reported as success.
  const written = readJson(file);
  const ok = written.dsh.profile.bundles.includes(PLUGIN_NAME) &&
    written.dependencies[PLUGIN_NAME] === DEP_SPEC &&
    samePath(fs.realpathSync(linkPath), PLUGIN_DIR);
  if (!ok) throw new Error(profileName + " 写入后校验失败");
  console.log("[ok] " + profileName + ": 已安装（备份 " + path.basename(backup) + "）");
  return true;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const profilesRoot = path.join(dshHome(), "profiles");
  if (!fs.existsSync(profilesRoot)) {
    throw new Error("找不到 " + profilesRoot + "；请先启动一次 DSH 生成 profile，或用 DSH_HOME 指定数据目录");
  }

  let profiles;
  let fallbackNote = "";
  if (options.profiles.length > 0) {
    const missing = options.profiles.filter((name) => !fs.existsSync(path.join(profilesRoot, name, "package.json")));
    if (missing.length > 0) throw new Error("profile 不存在: " + missing.join(", "));
    profiles = options.profiles;
  } else {
    const detected = detectProfiles(profilesRoot);
    if (options.all) {
      profiles = detected;
    } else {
      const preferred = detected.filter((name) => name === "web" || name === "desktop");
      profiles = preferred.length > 0 ? preferred : detected;
      if (preferred.length === 0 && detected.length > 0) {
        fallbackNote = "未找到 web/desktop，已退回全部检测到的 profile；可用 --all 显式选择。";
      }
    }
  }

  if (profiles.length === 0) {
    throw new Error("没有检测到任何 DSH profile；请先启动一次 DSH，或用 --profile 指定");
  }

  console.log("插件目录: " + PLUGIN_DIR);
  console.log("DSH 目录: " + dshHome());
  console.log("目标 profile: " + profiles.join(", "));
  if (fallbackNote !== "") console.log("提示: " + fallbackNote);
  console.log("");

  let failures = 0;
  for (const profileName of profiles) {
    try {
      const ok = installProfile(profileName, profilesRoot, options);
      if (!ok) failures += 1;
    } catch (error) {
      failures += 1;
      console.log("[FAIL] " + profileName + ": " + error.message);
    }
  }

  console.log("");
  if (options.check) {
    console.log(failures === 0 ? "检查完成：全部已安装。" : "检查完成：有 " + failures + " 个 profile 未就绪。");
  } else if (options.uninstall) {
    console.log("卸载完成。重启 DSH 后生效。");
  } else if (options.dryRun) {
    console.log("以上为预演，未修改任何文件。");
  } else if (failures > 0) {
    console.log("安装结束：有 " + failures + " 个 profile 失败，请按上面的提示处理。");
  } else {
    console.log("安装完成。请完全退出并重新打开 DSH（仅刷新页面不够）。");
  }
  if (failures > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error("错误: " + error.message);
  process.exitCode = 1;
}
