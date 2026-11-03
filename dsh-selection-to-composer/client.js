/*!
 * dsh-selection-to-composer - client half (browser bundle).
 *
 * Select text in a conversation, then click the floating pill to insert that
 * text at the composer caret.
 *
 * Two slots cooperate:
 *   - shell.overlay (root scope): the frame-wide floating pill and the text
 *     selection listeners. It is click-through by default, so the pill opts
 *     back into pointer events.
 *   - conversation.input.overlay (session scope): a zero-height bridge that
 *     receives the shell's public `inputActions` face
 *     (`captureInsertion()` + `insertText(text, span)`).
 *
 * The bridge is keyed by its conversation root, so a sidebar chat composer
 * never receives text selected in the main conversation, and vice versa.
 */
window.__ModuleLoader__.load({
  id: 'dsh-selection-to-composer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const LOCALE_NS = 'dsh-selection-to-composer';
    const ZH = {
      add: '添加到对话框',
      added: '已添加到对话框',
      failed: '对话框正忙，稍后再试'
    };
    const EN = {
      add: 'Add to composer',
      added: 'Added to composer',
      failed: 'Composer is busy'
    };

    /** Nearest conversation container used both for selection and bridge lookup. */
    const CONVERSATION_SELECTOR = [
      '[data-conversation-session]',
      '[data-conversation-scroll]',
      '[data-chat-flow]',
      '[data-slot="conversation.session"]'
    ].join(', ');
    /** The bridge lives in the composer, so its nearest session wrapper is its owner. */
    const BRIDGE_ROOT_SELECTOR = '[data-conversation-session], [data-slot="conversation.session"]';
    /** Text selected in any of these is a form field, not conversation copy. */
    const EDITABLE_SELECTOR = [
      'input',
      'textarea',
      'select',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]'
    ].join(', ');

    const POPOVER_MAX_WIDTH = 220;
    const POPOVER_HEIGHT = 30;
    const POPOVER_GAP = 8;
    const POPOVER_MARGIN = 8;

    /* ------------------------------------------------------------ selection */

    /**
     * Drop blank lines caught at the selection edges, but keep the first
     * content line's indentation and the inner line breaks. Code snippets are
     * the reason this cannot be a plain `trim()`.
     */
    function normalizeSelectionText(raw) {
      if (typeof raw !== 'string') return '';
      const text = raw.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
      if (text.trim() === '') return '';
      return text.replace(/^[ \t]*\n+/, '').replace(/\n+[ \t]*$/, '');
    }

    /** Element containing a DOM node, even when the node is a text node. */
    function elementOf(node) {
      if (node === null || node === undefined) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement === null || node.parentElement === undefined ? null : node.parentElement;
    }

    function closestOf(node, selector) {
      const element = elementOf(node);
      if (element === null || typeof element.closest !== 'function') return null;
      return element.closest(selector);
    }

    function isEditable(node) {
      return closestOf(node, EDITABLE_SELECTOR) !== null;
    }

    /** The composer card and its tool row are not conversation copy. */
    function inComposerRegion(node) {
      const region = closestOf(node, '[data-conversation-region]');
      return region !== null && region.getAttribute('data-conversation-region') === 'composer';
    }

    /** Last non-empty client rect, which sits at the visual end of the selection. */
    function lastRectOf(range) {
      let rects = [];
      try {
        rects = Array.from(range.getClientRects());
      } catch (error) {
        rects = [];
      }
      for (let index = rects.length - 1; index >= 0; index -= 1) {
        const rect = rects[index];
        if (rect !== null && rect !== undefined && (rect.width > 0 || rect.height > 0)) {
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }
      }
      const fallback = range.getBoundingClientRect();
      if (fallback === null || fallback === undefined) return null;
      if (fallback.width === 0 && fallback.height === 0) return null;
      return { left: fallback.left, right: fallback.right, top: fallback.top, bottom: fallback.bottom };
    }

    /** Read the current selection when it is conversation text, otherwise null. */
    function readSelection() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      if (anchor === null || focus === null) return null;
      if (isEditable(anchor) || isEditable(focus)) return null;
      if (inComposerRegion(anchor) || inComposerRegion(focus)) return null;
      const startScope = closestOf(anchor, CONVERSATION_SELECTOR);
      const endScope = closestOf(focus, CONVERSATION_SELECTOR);
      if (startScope === null || endScope === null || startScope !== endScope) return null;
      const text = normalizeSelectionText(selection.toString());
      if (text === '') return null;
      const rect = lastRectOf(selection.getRangeAt(selection.rangeCount - 1));
      if (rect === null) return null;
      return { text, rect, scope: startScope };
    }

    /* ------------------------------------------------------------- position */

    /**
     * Fixed-position geometry for the pill.
     *
     * The returned `left` is the pill center (the CSS translates it by -50%),
     * and `top` is the pill's top edge. The pill flips above the selection when
     * there is no room below, and stays inside the viewport and the desktop
     * top-chrome clearance.
     */
    function computePopoverPosition(rect, viewport) {
      const width = Math.max(0, Number(viewport.width) || 0);
      const height = Math.max(0, Number(viewport.height) || 0);
      const bottom = Math.max(0, Math.min(height, Number(viewport.bottom) || height));
      const clearance = Math.max(0, Number(viewport.topClearance) || 0);
      const boundsLeft = Math.max(0, Number(viewport.left) || 0);
      const boundsRight = Math.min(width, Number(viewport.right) || width);
      const available = Math.max(0, boundsRight - boundsLeft);
      const half = Math.min(POPOVER_MAX_WIDTH, Math.max(0, available - POPOVER_MARGIN * 2)) / 2;
      const minLeft = boundsLeft + POPOVER_MARGIN + half;
      const maxLeft = boundsRight - POPOVER_MARGIN - half;
      const center = (rect.left + rect.right) / 2;
      const columnLeft = maxLeft < minLeft ? (boundsLeft + boundsRight) / 2 : Math.min(Math.max(center, minLeft), maxLeft);
      const viewportHalf = Math.min(POPOVER_MAX_WIDTH, Math.max(0, width - POPOVER_MARGIN * 2)) / 2;
      const left = width <= POPOVER_MARGIN * 2
        ? width / 2
        : Math.min(Math.max(columnLeft, POPOVER_MARGIN + viewportHalf), width - POPOVER_MARGIN - viewportHalf);

      const belowTop = rect.bottom + POPOVER_GAP;
      const aboveTop = rect.top - POPOVER_GAP - POPOVER_HEIGHT;
      const fitsBelow = belowTop + POPOVER_HEIGHT <= bottom - POPOVER_MARGIN;
      const fitsAbove = aboveTop >= clearance + POPOVER_MARGIN;
      let placement = 'below';
      if (!fitsBelow && fitsAbove) {
        placement = 'above';
      } else if (!fitsBelow && !fitsAbove) {
        placement = rect.top > height - rect.bottom ? 'above' : 'below';
      }

      let top = placement === 'above' ? aboveTop : belowTop;
      top = Math.max(clearance + POPOVER_MARGIN, Math.min(top, bottom - POPOVER_MARGIN - POPOVER_HEIGHT));
      return { left, top, placement, width: POPOVER_MAX_WIDTH, height: POPOVER_HEIGHT };
    }

    function viewportOf() {
      const root = typeof document === 'undefined' ? null : document.documentElement;
      let clearance = 0;
      if (root !== null && typeof getComputedStyle === 'function') {
        const raw = getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance');
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) clearance = parsed;
      }
      return { width: window.innerWidth, height: window.innerHeight, topClearance: clearance };
    }

    /* -------------------------------------------------------------- bridges */

    /**
     * Each mounted session composer publishes one bridge. The registry is
     * module-local and drives a small subscription so the root-level overlay
     * can re-render when a session becomes available or goes away.
     */
    let bridges = [];
    const bridgeListeners = new Set();

    function notifyBridges() {
      for (const listener of Array.from(bridgeListeners)) {
        try {
          listener();
        } catch (error) {
          // A broken subscriber must not take down the slot that notified it.
        }
      }
    }

    function publishBridge(entry) {
      bridges = bridges.concat([entry]);
      notifyBridges();
      let disposed = false;
      return function disposeBridge() {
        if (disposed) return;
        disposed = true;
        bridges = bridges.filter(function (candidate) {
          return candidate !== entry;
        });
        notifyBridges();
      };
    }

    /** Subscribe to the bridge registry; the first render also picks up an early bridge. */
    function useBridges() {
      const [snapshot, setSnapshot] = React.useState(bridges);
      React.useEffect(function () {
        const listener = function () {
          setSnapshot(bridges);
        };
        bridgeListeners.add(listener);
        listener();
        return function () {
          bridgeListeners.delete(listener);
        };
      }, []);
      return snapshot;
    }

    function depthOf(element) {
      let depth = 0;
      let node = element;
      while (node !== null && node !== undefined) {
        depth += 1;
        node = node.parentElement;
      }
      return depth;
    }

    /**
     * Pick the composer bridge that owns the selection. When the bridge root
     * cannot be determined and only one composer exists, that composer is used.
     */
    function resolveBridge(list, scope) {
      if (scope === null || scope === undefined || list.length === 0) return null;
      let best = null;
      let bestDepth = -1;
      for (const entry of list) {
        let root = null;
        try {
          root = entry.rootOf();
        } catch (error) {
          root = null;
        }
        if (root !== null && (root === scope || root.contains(scope))) {
          const depth = depthOf(root);
          if (depth > bestDepth) {
            best = entry;
            bestDepth = depth;
          }
        }
      }
      if (best !== null) return best;
      if (list.length === 1) {
        let root = null;
        try {
          root = list[0].rootOf();
        } catch (error) {
          root = null;
        }
        if (root === null) return list[0];
      }
      return null;
    }

    function createBridge(actions, markerRef) {
      return {
        rootOf() {
          const marker = markerRef.current;
          if (marker === null || marker === undefined) return null;
          return marker.closest(BRIDGE_ROOT_SELECTOR);
        },
        insert(text) {
          try {
            if (actions === null || actions === undefined) return false;
            if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false;
            const span = actions.captureInsertion();
            if (span === null || typeof span !== 'object') return false;
            return actions.insertText(text, span) === true;
          } catch (error) {
            return false;
          }
        }
      };
    }

    /** Session-scoped, zero-height slot entry that exposes the composer actions. */
    function ComposerBridge(props) {
      const actions = props.inputActions;
      const markerRef = React.useRef(null);
      React.useEffect(function () {
        if (actions === null || actions === undefined) return undefined;
        if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return undefined;
        return publishBridge(createBridge(actions, markerRef));
      }, [actions]);
      return h('span', {
        ref: markerRef,
        hidden: true,
        'data-dsh-selection-to-composer': 'bridge'
      });
    }

    /* ----------------------------------------------------------------- icon */

    function PillIcon(props) {
      const common = {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: 'dscc-icon'
      };
      if (props.state === 'added') {
        return h('svg', common, h('path', { d: 'M3 8.4 6.3 11.7 13 5' }));
      }
      if (props.state === 'failed') {
        return h('svg', common, [
          h('circle', { key: 'c', cx: 8, cy: 8, r: 5.7 }),
          h('path', { key: 'l', d: 'M8 5.2v3.4' }),
          h('path', { key: 'd', d: 'M8 10.8h.01' })
        ]);
      }
      return h('svg', common, [
        h('path', { key: 'bubble', d: 'M13.4 8.2a5.2 5.2 0 0 1-5.2 5.2H4.1L2 15V9.9a5.2 5.2 0 0 1 5.2-5.2h1' }),
        h('path', { key: 'arrow', d: 'M11.6 2v5' }),
        h('path', { key: 'head', d: 'M9.7 5.1 11.6 7l1.9-1.9' })
      ]);
    }

    /* --------------------------------------------------------------- overlay */

    function SelectionOverlay(props) {
      const bridgesNow = useBridges();
      const locale = props.locale;
      const [tip, setTip] = React.useState(null);
      const pillRef = React.useRef(null);
      const checkTimer = React.useRef(null);
      const hideTimer = React.useRef(null);
      const ignoreEmptySelectionUntil = React.useRef(0);
      const pointerInPill = React.useRef(false);

      const translate = locale !== null && locale !== undefined && typeof locale.bind === 'function'
        ? locale.bind(LOCALE_NS)
        : function (key) { return key; };

      const localeRevision = React.useReducer(function (value) { return value + 1; }, 0)[1];
      React.useEffect(function () {
        if (locale === null || locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(function () { localeRevision(); });
      }, [locale, localeRevision]);

      function clearCheckTimer() {
        if (checkTimer.current !== null) {
          clearTimeout(checkTimer.current);
          checkTimer.current = null;
        }
      }

      function clearHideTimer() {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      }

      function hideAfter(delay) {
        clearHideTimer();
        hideTimer.current = setTimeout(function () {
          hideTimer.current = null;
          setTip(null);
        }, delay);
      }

      React.useEffect(function () {
        // A bridge appearing or disappearing belongs to a session switch or a
        // composer unmount; a pill anchored to a session with no composer left
        // is stale, while another session's pill may stay.
        setTip(function (current) {
          if (current === null) return null;
          return resolveBridge(bridgesNow, current.scope) === null ? null : current;
        });
        if (bridgesNow.length === 0) {
          return undefined;
        }

        function check() {
          const found = readSelection();
          if (found === null) {
            // Our own successful insertion clears the document selection; do
            // not let that clear the success pill before its timer fires.
            if (Date.now() < ignoreEmptySelectionUntil.current) return;
            setTip(function (current) {
              return current !== null && current.status === 'idle' ? null : current;
            });
            return;
          }
          if (resolveBridge(bridgesNow, found.scope) === null) {
            setTip(null);
            return;
          }
          clearHideTimer();
          const scopeRect = found.scope.getBoundingClientRect();
          const viewport = viewportOf();
          viewport.left = scopeRect.left;
          viewport.right = scopeRect.right;
          // Keep the pill out of the composer card when the selection sits at
          // the bottom of the scroll area.
          const sessionRoot = found.scope.closest('[data-conversation-session]') || found.scope;
          const composerSeat = sessionRoot.querySelector('[data-composer-seat]');
          if (composerSeat !== null) {
            const composerRect = composerSeat.getBoundingClientRect();
            if (composerRect.height > 0) viewport.bottom = Math.min(viewport.height, composerRect.top);
          }
          setTip({
            text: found.text,
            scope: found.scope,
            position: computePopoverPosition(found.rect, viewport),
            status: 'idle'
          });
        }

        function schedule(delay) {
          clearCheckTimer();
          checkTimer.current = setTimeout(function () {
            checkTimer.current = null;
            check();
          }, delay);
        }

        function onSelectionChange() {
          schedule(90);
        }

        function onSettled() {
          if (pointerInPill.current) {
            pointerInPill.current = false;
            return;
          }
          schedule(0);
        }

        function onKeyUp(event) {
          if (event.key === 'Shift' ||
              event.key.indexOf('Arrow') === 0 || event.key === 'Home' || event.key === 'End') {
            schedule(0);
          }
        }

        function onKeyDown(event) {
          if (event.key !== 'Escape') return;
          clearCheckTimer();
          clearHideTimer();
          setTip(null);
        }

        function onPointerDown(event) {
          const pill = pillRef.current;
          if (pill !== null && pill.contains(event.target)) {
            pointerInPill.current = true;
            return;
          }
          clearCheckTimer();
          clearHideTimer();
          pointerInPill.current = false;
          setTip(null);
        }

        function onScroll() {
          clearCheckTimer();
          clearHideTimer();
          setTip(null);
        }

        function onResize() {
          clearCheckTimer();
          clearHideTimer();
          setTip(null);
        }

        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('mouseup', onSettled, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);

        // Pick up a selection that was already present when this session's
        // bridge became available (for example after a session switch).
        schedule(0);

        return function () {
          clearCheckTimer();
          clearHideTimer();
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('mouseup', onSettled, true);
          document.removeEventListener('keyup', onKeyUp, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
        };
      }, [bridgesNow]);

      React.useEffect(function () {
        return function () {
          if (checkTimer.current !== null) clearTimeout(checkTimer.current);
          if (hideTimer.current !== null) clearTimeout(hideTimer.current);
        };
      }, []);

      function activate(event) {
        event.preventDefault();
        event.stopPropagation();
        if (tip === null || tip.status !== 'idle') return;
        const bridge = resolveBridge(bridgesNow, tip.scope);
        if (bridge === null) {
          setTip(Object.assign({}, tip, { status: 'failed' }));
          hideAfter(2600);
          return;
        }
        // The overlay updates on a short debounce; prefer the selection that
        // is still present at click time when it belongs to the same session.
        let text = tip.text;
        const current = readSelection();
        if (current !== null && current.scope === tip.scope) text = current.text;
        const inserted = bridge.insert(text);
        if (inserted) {
          ignoreEmptySelectionUntil.current = Date.now() + 600;
          try {
            const selection = window.getSelection();
            if (selection !== null) selection.removeAllRanges();
          } catch (error) {
            // Selection may already be gone; the insertion already succeeded.
          }
          setTip(Object.assign({}, tip, { status: 'added' }));
          hideAfter(1400);
        } else {
          setTip(Object.assign({}, tip, { status: 'failed' }));
          hideAfter(2800);
        }
      }

      if (tip === null) return null;

      const label = tip.status === 'added'
        ? translate('added')
        : tip.status === 'failed'
          ? translate('failed')
          : translate('add');

      return h('div', {
        className: 'dscc-anchor',
        style: { left: tip.position.left + 'px', top: tip.position.top + 'px' }
      }, [
        h('button', {
          key: 'button',
          ref: pillRef,
          type: 'button',
          className: 'dscc-pill',
          'data-state': tip.status,
          'aria-label': label,
          onMouseDown: function (event) {
            // Keep the conversation selection (and the composer's own caret)
            // while the pointer activates the pill.
            event.preventDefault();
          },
          onClick: activate
        }, [
          h(PillIcon, { key: 'icon', state: tip.status }),
          h('span', { key: 'label', className: 'dscc-label' }, label)
        ]),
        h('span', {
          key: 'live',
          className: 'dscc-sr-only',
          role: 'status'
        }, tip.status === 'idle' ? '' : label)
      ]);
    }

    /* ---------------------------------------------------------------- styles */

    const CSS = [
      '.dscc-anchor{position:fixed;z-index:20;pointer-events:none;transform:translateX(-50%);-webkit-app-region:no-drag}',
      '.dscc-pill{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:30px;min-width:120px;max-width:220px;max-width:min(220px,calc(100vw - 16px));padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2,none);font-family:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-app-region:no-drag;appearance:none;transition:background-color .12s ease,border-color .12s ease}',
      '.dscc-pill:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-border-l2)}',
      '.dscc-pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
      '.dscc-pill:active{transform:translateY(.5px)}',
      '.dscc-pill[data-state="added"] .dscc-icon{color:var(--dsw-alias-state-success-primary)}',
      '.dscc-pill[data-state="failed"] .dscc-icon{color:var(--dsw-alias-state-error-primary)}',
      '.dscc-icon{flex:none;display:block}',
      '.dscc-label{overflow:hidden;text-overflow:ellipsis}',
      '.dscc-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;pointer-events:none}',
      '@media (prefers-reduced-motion: reduce){.dscc-pill{transition:none}.dscc-pill:active{transform:none}}'
    ].join('');

    const STYLE_ATTR = 'data-dsh-selection-to-composer';

    function installStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) {
        return function () {};
      }
      const existing = document.querySelector('style[' + STYLE_ATTR + ']');
      if (existing !== null && existing.parentNode !== null) existing.parentNode.removeChild(existing);
      const style = document.createElement('style');
      style.setAttribute(STYLE_ATTR, '');
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode !== null) style.parentNode.removeChild(style);
      };
    }

    function registerLocale(ctx, locale, dictionary) {
      try {
        return ctx.locale.register(LOCALE_NS, locale, dictionary);
      } catch (error) {
        // A duplicate registration means a previous generation still owns the
        // namespace (for example during HMR); keep the existing dictionaries.
        return function () {};
      }
    }

    /* ----------------------------------------------------------------- apply */

    function apply(ctx) {
      ctx.effect(function () {
        return installStyles();
      }, 'dsh-selection-to-composer: styles');

      ctx.effect(function () {
        return registerLocale(ctx, 'zh', ZH);
      }, 'dsh-selection-to-composer: locale zh');

      ctx.effect(function () {
        return registerLocale(ctx, 'en', EN);
      }, 'dsh-selection-to-composer: locale en');

      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'selection-to-composer',
            order: 30
          }, function OverlaySlot(props) {
            return h(SelectionOverlay, Object.assign({}, props, { locale: ctx.locale }));
          });
        });
      }, 'dsh-selection-to-composer: overlay slot');

      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.overlay', function () {
          return ctx.slots.register({
            name: 'conversation.input.overlay',
            id: 'selection-to-composer-bridge',
            order: 90
          }, ComposerBridge);
        });
      }, 'dsh-selection-to-composer: composer bridge slot');
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      __internals: {
        LOCALE_NS,
        ZH,
        EN,
        POPOVER_MAX_WIDTH,
        POPOVER_HEIGHT,
        POPOVER_GAP,
        POPOVER_MARGIN,
        normalizeSelectionText,
        computePopoverPosition,
        readSelection,
        createBridge,
        resolveBridge
      }
    };
  }
});
