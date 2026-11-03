/*!
 * dsh-peak-hours - client half (browser bundle).
 *
 * A always-visible badge in the DSH sidebar footer that answers one question:
 * is DeepSeek API pricing in peak hours right now?
 *
 * Rules (Beijing time, UTC+8):
 *   - peak: Monday to Friday 09:00-12:00 and 14:00-18:00, except Chinese
 *     statutory holidays;
 *   - off-peak: every other minute, including the whole weekend and the whole
 *     statutory holiday period;
 *   - off-peak price = 50% of the peak price.
 *
 * Bundle shape: the official DSH lazy-CJS closure registered on
 * window.__ModuleLoader__. `react` / `react-dom` are externals resolved from
 * the shell module table; no CSS file, the style tag is injected by apply().
 */
window.__ModuleLoader__.load({
  id: "dsh-peak-hours",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");
    var ReactDOM = require("react-dom");

    /** IANA zone the pricing calendar is defined in. */
    var TIME_ZONE = "Asia/Shanghai";
    /** Beijing is a fixed UTC+8 zone (no DST), minutes east of UTC. */
    var ZONE_OFFSET_MINUTES = 8 * 60;
    /** Peak windows as minutes since local midnight: 09:00-12:00, 14:00-18:00. */
    var PEAK_WINDOWS = [[540, 720], [840, 1080]];
    /** Candidate transition minutes of any day (midnight + window edges). */
    var DAY_BOUNDARIES = [0, 540, 720, 840, 1080];
    /** How many days ahead the next transition is searched (longest holiday is 9 days). */
    var SCAN_DAYS = 21;
    var WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

    /**
     * Chinese statutory holidays (all holiday days, including the ones that fall
     * on a weekend, so the badge can name the holiday). Compensatory workdays
     * (调休补班) are irrelevant here: the pricing rule makes every weekend
     * off-peak regardless of the workday schedule.
     *
     * Source: State Council holiday arrangements as mirrored by
     * https://timor.tech/api/holiday/year/<year> (2025 and 2026 are published;
     * 2027 is not yet announced, which the UI surfaces explicitly).
     */
    var HOLIDAYS = {
      "2025-01-01": "元旦",
      "2025-01-28": "春节",
      "2025-01-29": "春节",
      "2025-01-30": "春节",
      "2025-01-31": "春节",
      "2025-02-01": "春节",
      "2025-02-02": "春节",
      "2025-02-03": "春节",
      "2025-02-04": "春节",
      "2025-04-04": "清明节",
      "2025-04-05": "清明节",
      "2025-04-06": "清明节",
      "2025-05-01": "劳动节",
      "2025-05-02": "劳动节",
      "2025-05-03": "劳动节",
      "2025-05-04": "劳动节",
      "2025-05-05": "劳动节",
      "2025-05-31": "端午节",
      "2025-06-01": "端午节",
      "2025-06-02": "端午节",
      "2025-10-01": "国庆节",
      "2025-10-02": "国庆节",
      "2025-10-03": "国庆节",
      "2025-10-04": "国庆节",
      "2025-10-05": "国庆节",
      "2025-10-06": "中秋节",
      "2025-10-07": "国庆节",
      "2025-10-08": "国庆节",
      "2026-01-01": "元旦",
      "2026-01-02": "元旦",
      "2026-01-03": "元旦",
      "2026-02-15": "春节",
      "2026-02-16": "春节",
      "2026-02-17": "春节",
      "2026-02-18": "春节",
      "2026-02-19": "春节",
      "2026-02-20": "春节",
      "2026-02-21": "春节",
      "2026-02-22": "春节",
      "2026-02-23": "春节",
      "2026-04-04": "清明节",
      "2026-04-05": "清明节",
      "2026-04-06": "清明节",
      "2026-05-01": "劳动节",
      "2026-05-02": "劳动节",
      "2026-05-03": "劳动节",
      "2026-05-04": "劳动节",
      "2026-05-05": "劳动节",
      "2026-06-19": "端午节",
      "2026-06-20": "端午节",
      "2026-06-21": "端午节",
      "2026-09-25": "中秋节",
      "2026-09-26": "中秋节",
      "2026-09-27": "中秋节",
      "2026-10-01": "国庆节",
      "2026-10-02": "国庆节",
      "2026-10-03": "国庆节",
      "2026-10-04": "国庆节",
      "2026-10-05": "国庆节",
      "2026-10-06": "国庆节",
      "2026-10-07": "国庆节"
    };

    /** Years fully covered by HOLIDAYS. */
    var COVERAGE_YEARS = [2025, 2026];
    var COVERAGE_LABEL = "2025-2026";

    var formatter = null;

    /** Cached Beijing-wall-clock formatter. */
    function beijingFormatter() {
      if (formatter === null) {
        formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          weekday: "short",
          hourCycle: "h23"
        });
      }
      return formatter;
    }

    function pad2(value) {
      return value < 10 ? "0" + value : String(value);
    }

    /**
     * Beijing civil-time parts of one instant.
     * @param {number|Date} input - epoch milliseconds or Date.
     */
    function beijingParts(input) {
      var date = input instanceof Date ? input : new Date(input);
      var fields = {};
      var parts = beijingFormatter().formatToParts(date);
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].type !== "literal") fields[parts[i].type] = parts[i].value;
      }
      var weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      var year = Number(fields.year);
      var month = Number(fields.month);
      var day = Number(fields.day);
      return {
        year: year,
        month: month,
        day: day,
        hour: Number(fields.hour),
        minute: Number(fields.minute),
        second: Number(fields.second),
        weekday: weekdayIndex[fields.weekday],
        weekdayLabel: WEEKDAY_LABELS[weekdayIndex[fields.weekday]],
        dateKey: year + "-" + pad2(month) + "-" + pad2(day)
      };
    }

    function isWeekend(weekday) {
      return weekday === 0 || weekday === 6;
    }

    function minutesOfDay(parts) {
      return parts.hour * 60 + parts.minute;
    }

    /** Holiday name for a civil date, or null. */
    function holidayOf(dateKey) {
      return Object.prototype.hasOwnProperty.call(HOLIDAYS, dateKey) ? HOLIDAYS[dateKey] : null;
    }

    /** Day classification shared by the clock view and the ahead scan. */
    function dayInfoOf(day) {
      var holiday = holidayOf(day.dateKey);
      var weekend = isWeekend(day.weekday);
      return {
        dateKey: day.dateKey,
        weekday: day.weekday,
        weekend: weekend,
        holiday: holiday,
        offAllDay: weekend || holiday !== null,
        kind: holiday !== null ? "holiday" : weekend ? "weekend" : "workday"
      };
    }

    /** Phase at one minute of a given day (window start inclusive, end exclusive). */
    function phaseAtMinute(info, minute) {
      if (info.offAllDay) return "off";
      for (var i = 0; i < PEAK_WINDOWS.length; i += 1) {
        if (minute >= PEAK_WINDOWS[i][0] && minute < PEAK_WINDOWS[i][1]) return "peak";
      }
      return "off";
    }

    /** Keep the civil date and add whole days (Beijing has no DST). */
    function civilAddDays(parts, offset) {
      var base = Date.UTC(parts.year, parts.month - 1, parts.day);
      var shifted = new Date(base + offset * 86400000);
      var year = shifted.getUTCFullYear();
      var month = shifted.getUTCMonth() + 1;
      var day = shifted.getUTCDate();
      return {
        year: year,
        month: month,
        day: day,
        weekday: shifted.getUTCDay(),
        dateKey: year + "-" + pad2(month) + "-" + pad2(day)
      };
    }

    /** UTC instant of a Beijing wall-clock minute on one civil date. */
    function wallTimeToUtc(day, minute) {
      return Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0) + (minute - ZONE_OFFSET_MINUTES) * 60000;
    }

    /**
     * First phase change strictly after `nowMs`.
     * @returns {{phase:string,minute:number,day:object,ts:number,offset:number}|null}
     */
    function computeNext(nowMs, parts, currentPhase) {
      for (var offset = 0; offset <= SCAN_DAYS; offset += 1) {
        var day = civilAddDays(parts, offset);
        var info = dayInfoOf(day);
        for (var i = 0; i < DAY_BOUNDARIES.length; i += 1) {
          var minute = DAY_BOUNDARIES[i];
          var ts = wallTimeToUtc(day, minute);
          if (ts <= nowMs) continue;
          var phase = phaseAtMinute(info, minute);
          if (phase !== currentPhase) {
            return { phase: phase, minute: minute, day: day, ts: ts, offset: offset };
          }
        }
      }
      return null;
    }

    /** "今日" / "明日" / "周三" / "10月8日" for the next-switch date. */
    function relativeDayLabel(next, parts) {
      if (next.offset === 0) return "今日";
      if (next.offset === 1) return "明日";
      if (next.offset < 7) return WEEKDAY_LABELS[next.day.weekday];
      return next.day.month + "月" + next.day.day + "日";
    }

    function clockOf(minute) {
      return pad2(Math.floor(minute / 60)) + ":" + pad2(minute % 60);
    }

    /** Full duration with seconds, so the popover ticks too: "1 小时 15 分 30 秒", "12 分 30 秒". */
    function formatDuration(ms) {
      var seconds = Math.max(0, Math.floor(ms / 1000));
      var hours = Math.floor(seconds / 3600);
      var minutes = Math.floor((seconds % 3600) / 60);
      var rest = seconds % 60;
      if (hours > 0) return hours + " 小时 " + (minutes > 0 ? minutes + " 分 " : "") + pad2(rest) + " 秒";
      if (minutes > 0) return minutes + " 分 " + pad2(rest) + " 秒";
      return rest + " 秒";
    }

    /** Badge-sized countdown that always shows seconds: "3:57:25" (h:mm:ss) or "12:30" (m:ss). */
    function formatShortCountdown(ms) {
      var seconds = Math.max(0, Math.floor(ms / 1000));
      var hours = Math.floor(seconds / 3600);
      var minutes = Math.floor((seconds % 3600) / 60);
      var rest = seconds % 60;
      if (hours > 0) return hours + ":" + pad2(minutes) + ":" + pad2(rest);
      return minutes + ":" + pad2(rest);
    }

    /**
     * The whole view model of the badge for one instant.
     * @param {number|Date} [input] - instant to evaluate, defaults to now.
     */
    function evaluate(input) {
      var now = input === undefined ? new Date() : input instanceof Date ? input : new Date(input);
      var nowMs = now.getTime();
      var parts = beijingParts(nowMs);
      var info = dayInfoOf(parts);
      var minute = minutesOfDay(parts);
      var phase = phaseAtMinute(info, minute);
      var next = computeNext(nowMs, parts, phase);
      var windows;

      if (info.offAllDay) {
        windows = [{ start: 0, end: 1440, phase: "off" }];
      } else {
        windows = [
          { start: 0, end: 540, phase: "off" },
          { start: 540, end: 720, phase: "peak" },
          { start: 720, end: 840, phase: "off" },
          { start: 840, end: 1080, phase: "peak" },
          { start: 1080, end: 1440, phase: "off" }
        ];
      }

      var view = {
        nowMs: nowMs,
        parts: parts,
        phase: phase,
        phaseLabel: phase === "peak" ? "波峰" : "波谷",
        priceLabel: phase === "peak" ? "全价" : "5 折",
        offPeakRatio: "50%",
        holiday: info.holiday,
        weekend: info.weekend,
        dayKind: info.kind,
        offAllDay: info.offAllDay,
        minuteOfDay: minute,
        windows: windows,
        coverageUnknown: COVERAGE_YEARS.indexOf(parts.year) === -1,
        coverageLabel: COVERAGE_LABEL,
        next: null,
        nextLabel: "—",
        nextDetail: "—"
      };

      if (next !== null) {
        var nextPhaseLabel = next.phase === "peak" ? "波峰" : "波谷";
        var nextPrice = next.phase === "peak" ? "全价" : "5 折";
        var when = relativeDayLabel(next, parts);
        var clock = clockOf(next.minute);
        view.next = {
          phase: next.phase,
          phaseLabel: nextPhaseLabel,
          priceLabel: nextPrice,
          ts: next.ts,
          minute: next.minute,
          dateKey: next.day.dateKey,
          durationMs: next.ts - nowMs,
          clock: clock,
          when: when
        };
        view.nextLabel = when + " " + clock;
        view.nextDetail = "距 " + clock + " 转" + nextPhaseLabel + "（" + nextPrice + "）还有 " + formatDuration(next.ts - nowMs);
      }

      return view;
    }

    function dayKindText(view) {
      if (view.dayKind === "holiday") return "法定节假日 · " + view.holiday;
      if (view.dayKind === "weekend") return "周末";
      return "工作日";
    }

    function beijingClockText(parts) {
      return parts.year + "-" + pad2(parts.month) + "-" + pad2(parts.day) + " " + parts.weekdayLabel + " " +
        pad2(parts.hour) + ":" + pad2(parts.minute) + ":" + pad2(parts.second);
    }

    function titleText(view) {
      var lines = [];
      lines.push("当前为" + view.phaseLabel + "时段（" + view.priceLabel + "）");
      lines.push("北京时间 " + beijingClockText(view.parts) + "（" + dayKindText(view) + "）");
      if (view.next !== null) lines.push(view.nextDetail);
      if (view.phase === "off") lines.push("波谷价格是波峰价格的 50%");
      if (view.coverageUnknown) lines.push(view.parts.year + " 年放假安排尚未收录，法定节假日可能未计入");
      return lines.join("\n");
    }

    /* ---------------------------------------------------------------- styles */

    var CSS = [
      ".dshph-badge{display:flex;align-items:center;justify-content:flex-start;box-sizing:border-box;width:100%;margin:2px 0;padding:2px 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ee);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}",
      ".dshph-pill{display:flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:3px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#8a8f9c) 5%,transparent);transition:background .12s ease,border-color .12s ease}",
      ".dshph-badge:hover .dshph-pill{background:color-mix(in srgb,var(--dsw-alias-label-primary,#8a8f9c) 10%,transparent);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
      ".dshph-badge:focus-visible{outline:none}",
      ".dshph-badge:focus-visible .dshph-pill{outline:2px solid var(--dshph-accent);outline-offset:2px}",
      ".dshph-badge[data-wide='false']{width:34px;height:34px;margin:4px 0;padding:0;justify-content:center;border-radius:9px}",
      ".dshph-badge[data-wide='false'] .dshph-pill{padding:0;border:0;background:transparent;gap:4px}",
      ".dshph-badge[data-wide='false']:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dshph-peak{--dshph-accent:var(--dsw-alias-state-warn-primary,#e8a33d);--dshph-soft:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e8a33d) 16%,transparent)}",
      ".dshph-off{--dshph-accent:var(--dsw-alias-state-success-primary,#34c88a);--dshph-soft:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c88a) 16%,transparent)}",
      ".dshph-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dshph-accent);box-shadow:0 0 0 3px var(--dshph-soft)}",
      ".dshph-badge[data-wide='false'] .dshph-dot{width:6px;height:6px;box-shadow:none}",
      ".dshph-label{flex:none;font-weight:600;letter-spacing:.02em}",
      ".dshph-price{flex:none;padding:0 6px;border-radius:999px;background:var(--dshph-soft);color:var(--dshph-accent);font-size:10px;line-height:16px;font-weight:600}",
      ".dshph-count{flex:none;color:var(--dsw-alias-label-tertiary,#8d93a3);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dshph-rail-label{flex:none;font-size:12px;font-weight:700;color:var(--dshph-accent)}",
      ".dshph-tip{box-sizing:border-box;padding:14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1d1f26);color:var(--dsw-alias-label-primary,#e6e8ee);box-shadow:0 14px 40px rgba(0,0,0,.34);font-size:12px;line-height:1.55;-webkit-font-smoothing:antialiased}",
      ".dshph-tip .dshph-note{margin-top:8px}",
      ".dshph-pop{box-sizing:border-box;max-width:calc(100vw - 16px);padding:14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1d1f26);color:var(--dsw-alias-label-primary,#e6e8ee);box-shadow:0 14px 40px rgba(0,0,0,.34);font-size:12px;line-height:1.55;-webkit-font-smoothing:antialiased}",
      ".dshph-head{display:flex;align-items:center;gap:8px}",
      ".dshph-head .dshph-dot{width:9px;height:9px}",
      ".dshph-title{font-size:13px;font-weight:700}",
      ".dshph-head-price{margin-left:auto}",
      ".dshph-sub{margin-top:4px;color:var(--dsw-alias-label-secondary,#b6bac6);font-variant-numeric:tabular-nums}",
      ".dshph-next{margin-top:8px;padding:7px 9px;border-radius:8px;background:var(--dshph-soft);color:var(--dshph-accent);font-weight:600;font-variant-numeric:tabular-nums}",
      ".dshph-track{position:relative;display:flex;height:8px;margin:12px 0 4px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18))}",
      ".dshph-seg{height:100%}",
      ".dshph-seg[data-phase='peak']{background:var(--dsw-alias-state-warn-primary,#e8a33d)}",
      ".dshph-seg[data-phase='off']{background:var(--dsw-alias-state-success-primary,#34c88a);opacity:.55}",
      ".dshph-now{position:absolute;top:-2px;bottom:-2px;width:2px;border-radius:2px;background:var(--dsw-alias-label-primary,#fff);box-shadow:0 0 0 1px rgba(0,0,0,.18)}",
      ".dshph-scale{position:relative;height:13px;color:var(--dsw-alias-label-tertiary,#8d93a3);font-size:10px;font-variant-numeric:tabular-nums}",
      ".dshph-scale-mark{position:absolute;top:0;white-space:nowrap}",
      ".dshph-scale-mark[data-edge='start']{transform:none}",
      ".dshph-scale-mark[data-edge='mid']{transform:translateX(-50%)}",
      ".dshph-scale-mark[data-edge='end']{transform:translateX(-100%)}",
      ".dshph-rows{margin-top:10px;display:flex;flex-direction:column;gap:2px}",
      ".dshph-row{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:6px;color:var(--dsw-alias-label-secondary,#b6bac6);font-variant-numeric:tabular-nums}",
      ".dshph-row[data-now='true']{background:var(--dshph-soft);color:var(--dsw-alias-label-primary,#e6e8ee)}",
      ".dshph-row-time{min-width:96px}",
      ".dshph-chip{margin-left:auto;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600}",
      ".dshph-chip[data-phase='peak']{color:var(--dsw-alias-state-warn-primary,#e8a33d);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e8a33d) 14%,transparent)}",
      ".dshph-chip[data-phase='off']{color:var(--dsw-alias-state-success-primary,#34c88a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c88a) 14%,transparent)}",
      ".dshph-hr{height:1px;margin:11px 0 9px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
      ".dshph-note{color:var(--dsw-alias-label-tertiary,#8d93a3);font-size:11px;line-height:1.55}",
      ".dshph-note + .dshph-note{margin-top:3px}",
      ".dshph-warn{color:var(--dsw-alias-state-warn-primary,#e8a33d)}"
    ].join("");

    var styleTag = null;

    function installStyles() {
      if (typeof document === "undefined") return;
      if (styleTag !== null && styleTag.parentNode !== null) return;
      styleTag = document.createElement("style");
      styleTag.setAttribute("data-plugin", "dsh-peak-hours");
      styleTag.setAttribute("data-dsh-peak-hours", "");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    function removeStyles() {
      if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
      styleTag = null;
    }

    /* ------------------------------------------------------------------- UI */

    var createElement = React.createElement;

    /** Render into document.body when portals are available (keeps floating UI out of clipping ancestors). */
    function portal(node) {
      return ReactDOM !== undefined && typeof ReactDOM.createPortal === "function"
        ? ReactDOM.createPortal(node, document.body)
        : node;
    }

    /** Re-render once a second (and immediately when the tab becomes visible). */
    function useNow() {
      var state = React.useState(function () {
        return Date.now();
      });
      var setNow = state[1];
      React.useEffect(function () {
        var timer = setInterval(function () {
          setNow(Date.now());
        }, 1000);
        function onVisible() {
          setNow(Date.now());
        }
        document.addEventListener("visibilitychange", onVisible);
        return function () {
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, []);
      return state[0];
    }

    function dot(phase) {
      return createElement("span", { className: "dshph-dot", "data-dsh-part": "phase-dot", "data-phase": phase });
    }

    function pricePill(view, extraClass) {
      return createElement("span", {
        className: "dshph-price" + (extraClass ? " " + extraClass : ""),
        "data-dsh-part": "price"
      }, view.priceLabel);
    }

    /** 24-hour strip with peak/off segments and a now marker. */
    function timeline(view) {
      var segments = view.windows.map(function (window, index) {
        var width = ((window.end - window.start) / 1440) * 100;
        return createElement("span", {
          key: "segment-" + index,
          className: "dshph-seg",
          "data-phase": window.phase,
          style: { width: width + "%" }
        });
      });
      var marker = createElement("span", {
        className: "dshph-now",
        "data-dsh-part": "now-marker",
        style: { left: "calc(" + ((view.minuteOfDay / 1440) * 100) + "% - 1px)" }
      });
      segments.push(marker);
      return createElement("div", {
        className: "dshph-track",
        "data-dsh-part": "timeline",
        role: "img",
        "aria-label": "今日时段分布"
      }, segments);
    }

    /** Window rows; the row containing the current minute is highlighted. */
    function windowRows(view) {
      return createElement("div", { className: "dshph-rows" }, view.windows.map(function (window, index) {
        var isNow = view.minuteOfDay >= window.start && view.minuteOfDay < window.end;
        var phaseLabel = window.phase === "peak" ? "波峰 · 全价" : "波谷 · 5 折";
        return createElement("div", {
          key: "row-" + index,
          className: "dshph-row",
          "data-now": isNow ? "true" : "false"
        }, [
          createElement("span", {
            key: "time",
            className: "dshph-row-time"
          }, clockOf(window.start) + " – " + (window.end === 1440 ? "24:00" : clockOf(window.end))),
          createElement("span", {
            key: "chip",
            className: "dshph-chip",
            "data-phase": window.phase
          }, phaseLabel)
        ]);
      }));
    }

    /** Hour labels pinned to their real position on the 24-hour strip. */
    function timeScale() {
      return createElement("div", { className: "dshph-scale", "data-dsh-part": "scale" }, [0, 720, 1440].map(function (minute) {
        var edge = minute === 0 ? "start" : minute === 1440 ? "end" : "mid";
        return createElement("span", {
          key: "mark-" + minute,
          className: "dshph-scale-mark",
          "data-edge": edge,
          style: { left: (minute / 1440) * 100 + "%" }
        }, clockOf(minute));
      }));
    }

    function popoverBody(view) {
      return createElement("div", {
        className: "dshph-pop " + (view.phase === "peak" ? "dshph-peak" : "dshph-off"),
        role: "dialog",
        "aria-label": "DeepSeek 计费时段详情",
        "data-dsh-plugin": "peak-hours",
        "data-dsh-part": "popover"
      }, [
        createElement("div", { key: "head", className: "dshph-head" }, [
          dot(view.phase),
          createElement("span", { key: "title", className: "dshph-title" },
            "当前：" + view.phaseLabel + (view.phase === "off" ? "（空闲时段）" : "")),
          pricePill(view, "dshph-head-price")
        ]),
        createElement("div", { key: "sub", className: "dshph-sub" },
          "北京时间 " + beijingClockText(view.parts) + " · " + dayKindText(view)),
        createElement("div", { key: "next", className: "dshph-next" }, view.nextDetail),
        createElement("div", { key: "track", className: "dshph-track-wrap" }, [
          timeline(view),
          timeScale()
        ]),
        windowRows(view),
        createElement("div", { key: "hr", className: "dshph-hr" }),
        createElement("div", { key: "rule", className: "dshph-note" },
          "规则：工作日 09:00–12:00、14:00–18:00（北京时间）为波峰、全价；其余时段为波谷，价格为波峰的 50%。周末及中国法定节假日全天空闲。"),
        createElement("div", { key: "data", className: "dshph-note" },
          "节假日数据：" + view.coverageLabel + " 年已收录"),
        view.coverageUnknown ? createElement("div", {
          key: "warn",
          className: "dshph-note dshph-warn"
        }, view.parts.year + " 年放假安排尚未收录，当前仅按周末规则判断，法定节假日可能显示为波峰") : null
      ]);
    }

    /**
     * Persistent hover card: the click panel's header block, reused verbatim
     * (same wording, same typography) so the two surfaces never drift apart.
     */
    function hoverTipBody(view) {
      return createElement("div", {
        className: "dshph-tip " + (view.phase === "peak" ? "dshph-peak" : "dshph-off"),
        role: "tooltip",
        "data-dsh-plugin": "peak-hours",
        "data-dsh-part": "hover-tip"
      }, [
        createElement("div", { key: "head", className: "dshph-head" }, [
          dot(view.phase),
          createElement("span", { key: "title", className: "dshph-title" },
            "当前：" + view.phaseLabel + (view.phase === "off" ? "（空闲时段）" : "")),
          pricePill(view, "dshph-head-price")
        ]),
        createElement("div", { key: "sub", className: "dshph-sub" },
          "北京时间 " + beijingClockText(view.parts) + " · " + dayKindText(view)),
        createElement("div", { key: "next", className: "dshph-next" }, view.nextDetail),
        view.coverageUnknown
          ? createElement("div", { key: "warn", className: "dshph-note dshph-warn" },
            view.parts.year + " 年放假安排尚未收录，当前仅按周末规则判断，法定节假日可能显示为波峰")
          : null
      ]);
    }

    function PeakBadge(props) {
      var wide = props.wide !== false;
      var now = useNow();
      var view = evaluate(now);
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var tipState = React.useState(false);
      var tip = tipState[0];
      var setTip = tipState[1];
      var buttonRef = React.useRef(null);
      var popoverRef = React.useRef(null);
      var tipOpenTimer = React.useRef(null);
      var tipCloseTimer = React.useRef(null);

      function clearTipTimers() {
        if (tipOpenTimer.current !== null) {
          clearTimeout(tipOpenTimer.current);
          tipOpenTimer.current = null;
        }
        if (tipCloseTimer.current !== null) {
          clearTimeout(tipCloseTimer.current);
          tipCloseTimer.current = null;
        }
      }

      /** Open the hover card after a short intent delay. */
      function scheduleTip() {
        clearTipTimers();
        if (open) return;
        tipOpenTimer.current = setTimeout(function () {
          setTip(true);
        }, 140);
      }

      /** Give the pointer time to cross the gap into the card before hiding. */
      function scheduleTipHide() {
        clearTipTimers();
        tipCloseTimer.current = setTimeout(function () {
          setTip(false);
        }, 220);
      }

      function cancelTipHide() {
        if (tipCloseTimer.current !== null) {
          clearTimeout(tipCloseTimer.current);
          tipCloseTimer.current = null;
        }
      }

      React.useEffect(function () {
        return function () {
          clearTipTimers();
        };
      }, []);

      React.useEffect(function () {
        if (open) {
          clearTipTimers();
          setTip(false);
        }
      }, [open]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onPointerDown(event) {
          var button = buttonRef.current;
          var popover = popoverRef.current;
          if (button !== null && button.contains(event.target)) return;
          if (popover !== null && popover.contains(event.target)) return;
          setOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        return function () {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      var className = "dshph-badge " + (view.phase === "peak" ? "dshph-peak" : "dshph-off");
      var children = [
        dot(view.phase),
        createElement("span", {
          key: "label",
          className: wide ? "dshph-label" : "dshph-rail-label"
        }, wide ? view.phaseLabel : view.phase === "peak" ? "峰" : "谷")
      ];
      if (wide) {
        children.push(pricePill(view));
        if (view.next !== null) {
          children.push(createElement("span", {
            key: "count",
            className: "dshph-count",
            "data-dsh-part": "countdown"
          }, "转" + (view.next.phase === "peak" ? "峰" : "谷") + " " + formatShortCountdown(view.next.durationMs)));
        }
      }

      var pill = createElement("span", {
        className: "dshph-pill",
        "data-dsh-part": "pill"
      }, children);

      var button = createElement("button", {
        ref: buttonRef,
        type: "button",
        className: className,
        "data-dsh-plugin": "peak-hours",
        "data-dsh-part": "badge",
        "data-wide": wide ? "true" : "false",
        "data-phase": view.phase,
        "aria-label": titleText(view),
        "aria-expanded": open ? "true" : "false",
        onMouseEnter: scheduleTip,
        onMouseLeave: scheduleTipHide,
        onFocus: scheduleTip,
        onBlur: scheduleTipHide,
        onClick: function () {
          clearTipTimers();
          setTip(false);
          setOpen(!open);
        }
      }, pill);

      var hoverTip = null;
      if (tip && !open && buttonRef.current !== null) {
        var tipRect = buttonRef.current.getBoundingClientRect();
        var tipWidth = Math.min(320, Math.max(240, window.innerWidth - 24));
        var tipLeft = Math.min(Math.max(8, tipRect.left), Math.max(8, window.innerWidth - tipWidth - 8));
        var tipBottom = window.innerHeight - tipRect.top + 8;
        hoverTip = portal(createElement("div", {
          className: "dshph-anchor",
          style: {
            position: "fixed",
            left: tipLeft + "px",
            bottom: tipBottom + "px",
            width: tipWidth + "px",
            zIndex: 2147482000
          },
          onMouseEnter: cancelTipHide,
          onMouseLeave: scheduleTipHide
        }, hoverTipBody(view)));
      }

      var popover = null;
      if (open && buttonRef.current !== null) {
        var rect = buttonRef.current.getBoundingClientRect();
        var width = Math.min(320, Math.max(240, window.innerWidth - 24));
        var left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
        var bottom = window.innerHeight - rect.top + 8;
        var node = createElement("div", {
          ref: popoverRef,
          className: "dshph-anchor",
          style: { position: "fixed", left: left + "px", bottom: bottom + "px", width: width + "px", zIndex: 2147482000 }
        }, popoverBody(view));
        popover = portal(node);
      }

      return createElement(React.Fragment, null, button, hoverTip, popover);
    }

    /* ---------------------------------------------------------------- apply */

    function apply(ctx) {
      ctx.effect(function () {
        installStyles();
        return removeStyles;
      }, "dsh-peak-hours: styles");

      var installed = false;

      function mount() {
        if (installed) return;
        var slots = typeof ctx.get === "function" ? ctx.get("slots") : undefined;
        if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
        installed = true;
        ctx.effect(function () {
          return slots.inject("sidebar.footer.action", function () {
            return slots.register({
              name: "sidebar.footer.action",
              id: "dsh-peak-hours",
              order: 20,
              label: function () {
                return "DeepSeek 计费时段";
              },
              registrant: "dsh-peak-hours"
            }, PeakBadge);
          });
        }, "dsh-peak-hours: footer badge");
      }

      ctx.effect(function () {
        var off = null;
        if (typeof ctx.on === "function") off = ctx.on("internal/service", mount);
        mount();
        return function () {
          if (typeof off === "function") off();
        };
      }, "dsh-peak-hours: slot watch");
    }

    exports.inject = [];
    exports.apply = apply;
    exports.__internals = {
      TIME_ZONE: TIME_ZONE,
      PEAK_WINDOWS: PEAK_WINDOWS,
      HOLIDAYS: HOLIDAYS,
      COVERAGE_YEARS: COVERAGE_YEARS,
      beijingParts: beijingParts,
      dayInfoOf: dayInfoOf,
      computeNext: computeNext,
      evaluate: evaluate,
      formatDuration: formatDuration,
      formatShortCountdown: formatShortCountdown
    };
    return module.exports;
  }
});
