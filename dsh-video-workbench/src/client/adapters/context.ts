// The only module in the client half that reads the DSH-provided page context:
// the injected token, the Host base URL and the style-sheet lifecycle.

import type { ClientSlotContext } from '../../shared/dsh'
import { TOKEN_GLOBAL } from '../../shared/routes'

/** Read the media token DSH injected into the page; '' while it is missing. */
export function readToken(): string {
  const value = (globalThis as Record<string, unknown>)[TOKEN_GLOBAL]
  if (value !== null && typeof value === 'object' && 'token' in value) {
    const token = (value as { token?: unknown }).token
    return typeof token === 'string' ? token : ''
  }
  return ''
}

// The app is served at its page root on both surfaces (`dsh-app://app/` and
// `http://host/`), so `document.baseURI` is the right base: it keeps a reverse
// proxy prefix and never guesses an origin. Captured once because later SPA
// navigation may change baseURI.
const APP_BASE = new URL('.', document.baseURI)

/** Build an absolute URL for a Host path below the app base. */
export function hostUrl(
  pathname: string,
  params: Record<string, string | undefined> = {},
): string {
  const url = new URL(pathname.replace(/^\//u, ''), APP_BASE)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value)
  }
  return url.href
}

/** Add the plugin style sheet for the lifetime of the client run. */
export function installStyles(ctx: ClientSlotContext, css: string, label: string): void {
  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = css
    document.head.appendChild(element)
    return () => element.remove()
  }, label)
}
