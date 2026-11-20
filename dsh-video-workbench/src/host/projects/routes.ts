// Project routes used by the render UI:
//   GET  /api/video-workbench/projects-list    newest-first list (+ total duration)
//   POST /api/video-workbench/projects-create  create a 10 s demo project (M2 UI)

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, readToken, rejectRequest, sendJson } from '../http'
import { tokenEquals } from '../index-internal'
import type { ProjectsConfig } from './root'
import type { ProjectScene, ProjectV1 } from './schema'
import { createProject, listProjects, readProject } from './store'

export interface ProjectsRouteOptions {
  token: string
  requireToken: boolean
  projects: ProjectsConfig
}

/** Two scenes summing to 10 s: "render a 10 s clip from the UI" works on a fresh install. */
function demoScenes(): ProjectScene[] {
  return [
    { id: 's1', text: '第一段画面', durationSec: 4, media: { kind: 'none' }, voice: { speed: 1 }, captions: { enabled: true } },
    { id: 's2', text: '第二段画面', durationSec: 6, media: { kind: 'none' }, voice: { speed: 1 }, captions: { enabled: true } },
  ]
}

function sumDuration(project: Pick<ProjectV1, 'scenes'>): number {
  return Number(project.scenes.reduce((total, scene) => total + scene.durationSec, 0).toFixed(3))
}

export function createProjectsListHandler(
  options: ProjectsRouteOptions,
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
    const root = projects.root
    const listed = listProjects(root)
    const withDuration = listed.projects.map((entry) => {
      // `listProjects` keeps only id/title/count; the UI also shows the duration.
      const detail = readProject(root, entry.id)
      return { ...entry, durationSec: detail.ok ? sumDuration(detail.project) : 0 }
    })
    sendJson(response, 200, {
      state: 'ready',
      projects: withDuration,
      invalid: listed.invalid.map((entry) => ({ id: entry.id, errors: entry.errors.slice(0, 5) })),
    })
  }
}

export function createProjectCreateHandler(
  options: ProjectsRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (rejectRequest(request, response, {
      requireToken: options.requireToken,
      tokenMatches: tokenEquals(readToken(request), options.token),
      allow: ['POST'],
    })) return
    const { projects } = options
    if (projects.state !== 'ready' || projects.root === undefined) {
      sendJson(response, 409, { error: 'projects-unset' })
      return
    }
    const root = projects.root
    void readJsonBody(request, 4 * 1024).then((body) => {
      const title = typeof body?.title === 'string' && body.title.trim() !== ''
        ? body.title.trim()
        : '示例项目'
      const created = createProject(root, { title, scenes: demoScenes() })
      if (!created.ok) {
        sendJson(response, 400, { error: 'invalid-project', errors: created.errors })
        return
      }
      sendJson(response, 201, {
        project: {
          id: created.project.id,
          title: created.project.title,
          scenes: created.project.scenes.length,
          durationSec: sumDuration(created.project),
        },
      })
    }).catch(() => {
      // A closed connection or an unexpected error must not surface as an
      // unhandled rejection in the DSH host process.
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' })
    })
  }
}
