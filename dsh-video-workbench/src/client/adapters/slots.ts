// The only module in the client half that registers slot entries.

import type { ClientSlotContext } from '../../shared/dsh'

/** Slots this plugin occupies. Kept here so business code never names them. */
export const ENTRY_SLOT = 'conversation.input.left'
export const OVERLAY_SLOT = 'shell.overlay'

/** Fixed placement inside both slots. */
const ORDER = 40

/** Entry button in the composer's left toolbar. */
export function registerEntry(ctx: ClientSlotContext, id: string, component: unknown): void {
  mount(ctx, ENTRY_SLOT, id, component)
}

/**
 * Panel on the click-through overlay layer.
 * The overlay swallows nothing by itself; the component re-enables pointer
 * events on its own root.
 */
export function registerOverlay(ctx: ClientSlotContext, id: string, component: unknown): void {
  mount(ctx, OVERLAY_SLOT, id, component)
}

/**
 * Register once the slot exists and let the slot scope unregister when it
 * disappears or the plugin is unloaded.
 */
function mount(ctx: ClientSlotContext, name: string, id: string, component: unknown): void {
  ctx.slots.inject(name, () => ctx.slots.register({ name, id, order: ORDER }, component))
}
