/**
 * dsh-selection-actions - host half.
 *
 * The feature is entirely browser-side: the floating action group is registered
 * in the `shell.overlay` slot, and the insertion bridge is registered in the
 * session-scoped `conversation.input.overlay` slot, where the shell hands the
 * plugin its public `inputActions` face. Copying uses the browser clipboard
 * only. Nothing needs to run in the Host, so this file only supplies the loader
 * mount point.
 */

/** Plugin identity for cordis rows / diagnostics. */
export const name = 'dsh-selection-actions'

/** No host services are required. */
export const inject = []

/** No-op host apply. */
export function apply() {}
