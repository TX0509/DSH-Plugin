// The only module in the client half that touches the DSH lazy-CJS module
// loader. The build script supplies the outer `load({ id, factory })` wrapper;
// this helper registers the module whose factory the bundle defines.
//
// `factory` receives the loader's `require`, which is how the page's module
// table supplies `react` without bundling a second copy.

import type { ModuleLoader } from '../../shared/dsh'

export interface ClientModuleOptions {
  id: string
  factory(require: (id: string) => unknown): unknown
}

export function loadClientModule(options: ClientModuleOptions): void {
  const loader = (globalThis as { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__
  if (loader === undefined) {
    throw new Error('dsh-video-workbench: the DSH module loader is unavailable')
  }
  loader.load(options)
}
