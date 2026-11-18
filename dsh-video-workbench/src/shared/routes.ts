// Wire names shared by the host and client halves of the plugin.
//
// Both bundles are built from these constants, so a rename cannot drift
// between them. Business modules import from here instead of spelling the
// route paths or the page-global name themselves.

/** Page global that carries the media token; filled in by index injection. */
export const TOKEN_GLOBAL = '__DSH_VIDEO_WORKBENCH__'

/** Header alternative to `?t=` for callers that cannot build a query string. */
export const TOKEN_HEADER = 'x-dsh-video-workbench-token'

/** Exact route reporting plugin readiness. */
export const PING_PATH = '/api/video-workbench/ping'

/** Prefix route serving read-only media files. */
export const MEDIA_PATH = '/api/video-workbench/media'

/** Prefix route serving read-only project files (same token as media). */
export const PROJECTS_PATH = '/api/video-workbench/projects'

/** Exact route running the plugin self-check over real HTTP. */
export const SELFCHECK_PATH = '/api/video-workbench/selfcheck'
