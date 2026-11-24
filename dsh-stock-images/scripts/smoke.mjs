#!/usr/bin/env node
/**
 * Live smoke check for the key-free providers.
 *
 *   node scripts/smoke.mjs            # Openverse + Wikimedia Commons
 *   node scripts/smoke.mjs --query "Taylor Swift"
 *
 * It exercises the plugin's real guarded HTTP client, provider normalizers,
 * and the search/download path, without a DSH runtime. API-key providers are
 * reported as skipped unless the matching credential ref is exported.
 * Downloads land in a temporary directory that is removed afterwards.
 */
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __internals as internals, KEY_REFS, readImageDimensions, sniffImageType } from '../index.js'

const { PROVIDERS, runProvider, fetchBuffer, resolveDownloadPolicy } = internals

function parseArgs(argv) {
  const options = { query: 'Jensen Huang', count: 4, download: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--query' || arg === '-q') options.query = argv[(index += 1)]
    else if (arg === '--count' || arg === '-n') options.count = Number(argv[(index += 1)])
    else if (arg === '--no-download') options.download = false
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const searchArgs = {
  query: options.query,
  altQuery: '',
  orientation: 'any',
  count: options.count,
  minWidth: 400,
  commercialOnly: true,
  perSource: options.count
}

console.log(`query: ${options.query}\n`)

const failures = []
const chosen = []
for (const provider of PROVIDERS) {
  let key
  if (provider.requiresKey) {
    key = process.env[KEY_REFS[provider.id]]?.trim()
    if (key === undefined || key === '') {
      console.log(`- ${provider.id}: skipped (${provider.keyRef} not set)`)
      continue
    }
  }
  const startedAt = Date.now()
  try {
    const { items, excluded } = await runProvider(provider, searchArgs, key, undefined)
    console.log(`- ${provider.id}: ${items.length} result(s) in ${Date.now() - startedAt}ms`)
    for (const item of items.slice(0, 3)) {
      console.log(`    ${item.width}×${item.height} · ${item.creator || 'unknown'} · ${item.license} · ${internals.describeRights(item.rights)}`)
      console.log(`    ${item.downloadUrl}`)
    }
    if (excluded.length > 0) {
      console.log(`    refused on license grounds: ${excluded.map((group) => `${group.count} ${group.reason}`).join('; ')}`)
    }
    if (items.length > 0) chosen.push(items[0])
  } catch (error) {
    failures.push(`${provider.id}: ${error.message}`)
    console.log(`- ${provider.id}: FAILED — ${error.message}`)
  }
}

if (options.download && chosen.length > 0) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stock-images-smoke-'))
  try {
    for (const item of chosen) {
      // Exercise the real license gate: the item stands in for a cached search
      // result, so the downloaded bytes are the bytes it describes.
      const policy = resolveDownloadPolicy({ url: item.downloadUrl, source: '', cached: item })
      if (!policy.allowed) {
        failures.push(`${item.source}: license gate refused a search result: ${policy.reason}`)
        continue
      }
      const response = await fetchBuffer(item.downloadUrl, {
        maxBytes: 12 * 1024 * 1024,
        timeoutMs: 30000,
        accept: 'image/*'
      })
      const type = sniffImageType(response.bytes)
      const size = readImageDimensions(response.bytes, type?.mime)
      console.log(
        `- download ${item.source}: HTTP ${response.status}, ${type?.mime ?? 'unknown'}, ${response.bytes.length} bytes${
          size === undefined ? '' : `, ${size.width}×${size.height}`
        }`
      )
      if (type === null) failures.push(`${item.source}: downloaded bytes are not an image`)
    }
    console.log(`- temp directory: ${directory} (${(await readdir(directory)).length} files)`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('\nAll live checks passed.')
}
