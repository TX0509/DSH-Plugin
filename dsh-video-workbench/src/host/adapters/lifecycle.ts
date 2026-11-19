// The only module in the host half that schedules work on the plugin lifecycle.
// Timers are tied to `ctx.effect`, so unloading the plugin clears them instead
// of leaving a callback running after teardown.

import type { HostContext } from '../../shared/dsh'

/**
 * Run `task` once after `delayMs`, unless the plugin unloads first.
 * `onDispose` runs when the plugin unloads; use it to abort work the task has
 * already started (a cleared timer only stops work that has not begun).
 * A context without `effect` simply skips the schedule.
 */
export function defer(
  ctx: HostContext,
  delayMs: number,
  label: string,
  task: () => void,
  onDispose?: () => void,
): void {
  if (typeof ctx.effect !== 'function') return
  ctx.effect(() => {
    const timer = setTimeout(task, delayMs)
    return () => {
      clearTimeout(timer)
      onDispose?.()
    }
  }, label)
}
