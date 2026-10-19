/**
 * dsh-peak-hours - host half.
 *
 * The plugin is display-only: the peak/off-peak decision and the GUI badge live
 * entirely in the browser half (`client.js`), which reads the clock with the
 * IANA `Asia/Shanghai` zone, so the host process contributes no behavior. The
 * row still exists so the loader has a mount point and the bundle patch is a
 * normal DSH plugin.
 */

/** Plugin identity for cordis rows / diagnostics. */
export const name = 'dsh-peak-hours'

/** No host services are required. */
export const inject = []

/** No-op host apply. */
export function apply() {}
