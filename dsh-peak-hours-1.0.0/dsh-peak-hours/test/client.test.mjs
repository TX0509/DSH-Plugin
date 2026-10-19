import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "client.js");

/** Load the shipped bundle the way the DSH shell does, returning its test surface. */
async function loadBundle() {
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        definition = next;
      }
    }
  };
  await import(pathToFileURL(clientPath).href + "?case=" + Date.now() + Math.random());
  assert.ok(definition !== null, "bundle registered with window.__ModuleLoader__");
  assert.equal(definition.id, "dsh-peak-hours");
  const stub = {};
  const factory = definition.factory((specifier) => {
    if (specifier === "react" || specifier === "react-dom") return stub;
    throw new Error("unexpected require: " + specifier);
  });
  assert.equal(typeof factory.apply, "function");
  assert.deepEqual(factory.inject, []);
  return factory.__internals;
}

const api = await loadBundle();

/** UTC instant of a Beijing wall-clock time. */
function beijingInstant(dateKey, hour, minute = 0, second = 0) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

test("reads Beijing civil time regardless of the host time zone", () => {
  const parts = api.beijingParts(beijingInstant("2026-10-19", 10, 44, 26));
  assert.equal(parts.dateKey, "2026-10-19");
  assert.equal(parts.weekday, 1);
  assert.equal(parts.weekdayLabel, "周一");
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 44);
  assert.equal(parts.second, 26);
});

test("Monday morning window is peak, priced at full rate", () => {
  const view = api.evaluate(beijingInstant("2026-10-19", 10, 44));
  assert.equal(view.phase, "peak");
  assert.equal(view.phaseLabel, "波峰");
  assert.equal(view.priceLabel, "全价");
  assert.equal(view.nextLabel, "今日 12:00");
  assert.equal(view.next.phase, "off");
  assert.equal(view.next.durationMs, (12 * 60 - (10 * 60 + 44)) * 60000);
  assert.equal(view.coverageUnknown, false);
});

test("window edges are start-inclusive and end-exclusive", () => {
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 8, 59, 59)).phase, "off");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 9, 0, 0)).phase, "peak");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 11, 59, 59)).phase, "peak");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 12, 0, 0)).phase, "off");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 13, 59, 59)).phase, "off");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 14, 0, 0)).phase, "peak");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 17, 59, 59)).phase, "peak");
  assert.equal(api.evaluate(beijingInstant("2026-10-19", 18, 0, 0)).phase, "off");
});

test("lunch break points at 14:00, evening points at next workday 09:00", () => {
  const lunch = api.evaluate(beijingInstant("2026-10-19", 12, 30));
  assert.equal(lunch.phase, "off");
  assert.equal(lunch.nextLabel, "今日 14:00");
  assert.equal(lunch.next.phase, "peak");

  const evening = api.evaluate(beijingInstant("2026-10-19", 18, 30));
  assert.equal(evening.nextLabel, "明日 09:00");
  assert.equal(evening.next.phase, "peak");

  const fridayNight = api.evaluate(beijingInstant("2026-10-16", 19, 0));
  assert.equal(fridayNight.nextLabel, "周一 09:00");
  assert.equal(fridayNight.next.dateKey, "2026-10-19");
});

test("weekend is off-peak all day", () => {
  const saturday = api.evaluate(beijingInstant("2026-10-17", 10, 0));
  assert.equal(saturday.phase, "off");
  assert.equal(saturday.dayKind, "weekend");
  assert.equal(saturday.nextLabel, "周一 09:00");
  assert.equal(saturday.next.phase, "peak");
});

test("statutory holidays are off-peak even on a weekday", () => {
  const cases = [
    ["2026-01-02", "元旦"],
    ["2026-02-16", "春节"],
    ["2026-04-06", "清明节"],
    ["2026-05-04", "劳动节"],
    ["2026-06-19", "端午节"],
    ["2026-09-25", "中秋节"],
    ["2026-10-06", "国庆节"],
    ["2025-10-01", "国庆节"]
  ];
  for (const [dateKey, name] of cases) {
    const view = api.evaluate(beijingInstant(dateKey, 10, 0));
    assert.equal(view.phase, "off", dateKey + " must be off-peak");
    assert.equal(view.dayKind, "holiday", dateKey + " must be a holiday");
    assert.equal(view.holiday, name);
  }
});

test("holiday boundary: 2026 National Day ends on Oct 8 09:00", () => {
  const view = api.evaluate(beijingInstant("2026-09-30", 18, 30));
  assert.equal(view.phase, "off");
  assert.equal(view.next.dateKey, "2026-10-08");
  assert.equal(view.next.clock, "09:00");
  assert.equal(view.next.phase, "peak");
  assert.equal(view.nextLabel, "10月8日 09:00");
});

test("holiday boundary: Spring Festival 2026 resumes on Feb 24 09:00", () => {
  const view = api.evaluate(beijingInstant("2026-02-20", 10, 0));
  assert.equal(view.phase, "off");
  assert.equal(view.next.dateKey, "2026-02-24");
  assert.equal(view.next.phase, "peak");
});

test("compensatory weekend workdays stay off-peak", () => {
  const view = api.evaluate(beijingInstant("2026-10-10", 10, 0));
  assert.equal(view.phase, "off");
  assert.equal(view.dayKind, "weekend");
  assert.equal(view.next.dateKey, "2026-10-12");
});

test("unknown holiday year is flagged instead of silently guessed", () => {
  const view = api.evaluate(beijingInstant("2027-01-04", 10, 0));
  assert.equal(view.phase, "peak");
  assert.equal(view.coverageUnknown, true);
});

test("every covered holiday date is recognised", () => {
  for (const [dateKey, name] of Object.entries(api.HOLIDAYS)) {
    const view = api.evaluate(beijingInstant(dateKey, 10, 0));
    assert.equal(view.phase, "off", dateKey + " (" + name + ") must be off-peak");
    assert.equal(view.holiday, name);
  }
});

test("duration formatters always include seconds", () => {
  assert.equal(api.formatDuration((60 * 60 + 15 * 60) * 1000), "1 小时 15 分 00 秒");
  assert.equal(api.formatDuration((3 * 3600 + 57 * 60 + 25) * 1000), "3 小时 57 分 25 秒");
  assert.equal(api.formatDuration(2 * 60 * 1000), "2 分 00 秒");
  assert.equal(api.formatDuration(1500), "1 秒");
  assert.equal(api.formatShortCountdown((60 * 60 + 15 * 60) * 1000), "1:15:00");
  assert.equal(api.formatShortCountdown((3 * 3600 + 57 * 60 + 25) * 1000), "3:57:25");
  assert.equal(api.formatShortCountdown(75 * 1000), "1:15");
});
