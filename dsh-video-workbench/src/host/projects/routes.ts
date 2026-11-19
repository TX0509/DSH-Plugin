// `GET /api/video-workbench/projects-list` — the newest-first project list the
// render UI needs. Read-only and token-authenticated like every other route.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readToken, rejectRequest, sendJson } from '../http'
import { tokenEquals } from '../index-internal'
import type { ProjectsConfig } from './root'
import { listProjects } from './store'

export interface ProjectsListRouteOptions {
  token: string
  requireToken: boolean
  projects: ProjectsConfig
}

export function createProjectsListHandler(
  options: ProjectsListRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (rejectRequest(request, response, {
      requireToken: options.requireToken,
      tokenMatches: tokenEquals(readToken(request), options.token),
      allow: ['GET', 'HEAD'],
    })) return
    const { projects } = options
    if (projects.state !== 'ready' || projects.root === undefined) {
      sendJson(response, 200, { state: projects.state, projects: [], invalid: [] })
      return
    }
    const listed = listProjects(projects.root)
    sendJson(response, 200, {
      state: 'ready',
      projects: listed.projects,
      invalid: listed.invalid.map((entry) => ({ id: entry.id, errors: entry.errors.slice(0, 5) })),
    })
  }
}
