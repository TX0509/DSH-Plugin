// The only module in the client half that registers slot entries.

import type { ClientSlotContext } from '../../shared/dsh'

/**
 * Panel id: one stable key shared by the sidebar entry and the main panel.
 * The sidebar's panel list calls `layout.selectPanel(id)` with it.
 */
export const PANEL_ID = 'video-workbench'

/** Sidebar panel list: shell renders the row (icon + label) and selection. */
export const ENTRY_SLOT = 'sidebar.panellist'

/** Main panel selected by the sidebar entry. */
export const MAIN_SLOT = 'main'

/** Fixed placement among the sidebar panels. */
const ORDER = 40

export interface EntryOptions {
  /** Sidebar row label; the shell owns the accessible name. */
  label: string | (() => string)
}

/** Register the sidebar icon; `component` receives `{ size }` like every panel icon. */
export function registerEntry(
  ctx: ClientSlotContext,
  id: string,
  options: EntryOptions,
  component: unknown,
): void {
  mount(ctx, ENTRY_SLOT, { id, order: ORDER, label: options.label }, component)
}

/** Register the workbench page for `key`, rendered when that panel is selected. */
export function registerPage(ctx: ClientSlotContext, key: string, component: unknown): void {
  mount(ctx, MAIN_SLOT, { key }, component)
}

/**
 * Register once the slot exists and let the slot scope unregister when it
 * disappears or the plugin is unloaded.
 */
function mount(ctx: ClientSlotContext, name: string, options: Record<string, unknown>, component: unknown): void {
  // The slot registry types each slot's options separately; this helper builds
  // them per call site, so one cast at the shared boundary is unavoidable.
  ctx.slots.inject(name, () => ctx.slots.register(
    { name, ...options } as Parameters<ClientSlotContext['slots']['register']>[0],
    component,
  ))
}
