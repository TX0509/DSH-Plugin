/**
 * dsh-selection-to-composer - host half.
 *
 * The feature is entirely browser-side: the floating action is registered in
 * the `shell.overlay` slot, and the insertion bridge is registered in the
 * session-scoped `conversation.input.overlay` slot, where the shell hands the
 * plugin its public `inputActions` face. Nothing needs to run in the Host, so
 * this file only supplies the loader mount point.
 */

/** Plugin identity for cordis rows / diagnostics. */
export const name = 'dsh-selection-to-composer'

/** No host services are required. */
export const inject = []

/** No-op host apply. */
export function apply() {}
