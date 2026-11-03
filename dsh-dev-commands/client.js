/*!
 * dsh-dev-commands - client half.
 *
 * The Host half owns the slash commands and their execution. Third-party Host
 * command rows do not carry a first-party row face, so the Web command menu
 * renders them without a glyph. This module decorates the menu candidate
 * builder just enough to attach a line icon to /review and /ship; command
 * execution still goes through the public Host command registry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-commands',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ICON_NAMES = new Set(['review', 'ship']);

    function iconSize(props) {
      return props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0
        ? props.size
        : 16;
    }

    function iconCommon(props) {
      const size = iconSize(props);
      return {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props !== null && props !== undefined ? props.className : undefined
      };
    }

    /** Document + magnifier: code review. */
    function ReviewIcon(props) {
      return h('svg', iconCommon(props), [
        h('path', { key: 'doc', d: 'M3 2.5h7.5L13 5v3.6' }),
        h('path', { key: 'edge', d: 'M3 2.5v11h4.4' }),
        h('path', { key: 'lines', d: 'M5.5 6h5M5.5 8.5h3' }),
        h('circle', { key: 'lens', cx: 11.2, cy: 10.8, r: 2.6 }),
        h('path', { key: 'check', d: 'm10.2 10.8.9.9 1.8-1.8' })
      ]);
    }

    /** Arrow into a tray: commit and push. */
    function ShipIcon(props) {
      return h('svg', iconCommon(props), [
        h('path', { key: 'arrow', d: 'M8 10.5V2.8' }),
        h('path', { key: 'head', d: 'M5 5.8 8 2.8l3 3' }),
        h('path', { key: 'tray', d: 'M3 13h10' })
      ]);
    }

    const ICONS = {
      review: ReviewIcon,
      ship: ShipIcon
    };

    function apply(ctx) {
      const ui = ctx.commandUi;
      if (ui === null || ui === undefined || typeof ui.candidates !== 'function') return;

      const original = ui.candidates;
      const wrapped = async function (session, request) {
        const rows = await original.call(this, session, request);
        if (!Array.isArray(rows)) return rows;
        return rows.map(function (row) {
          if (row === null || row === undefined || row.icon !== undefined) return row;
          if (!ICON_NAMES.has(row.name)) return row;
          return Object.assign({}, row, { icon: ICONS[row.name] });
        });
      };

      try {
        ui.candidates = wrapped;
      } catch (error) {
        return;
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            if (ui.candidates === wrapped) ui.candidates = original;
          };
        }, 'dsh-dev-commands: menu icons');
      }
    }

    return {
      inject: ['commandUi'],
      apply,
      __internals: {
        ICON_NAMES,
        ReviewIcon,
        ShipIcon,
        apply
      }
    };
  }
});
