import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  __internals as internals,
  isPrivateAddress,
  readImageDimensions,
  sniffImageType
} from '../index.js'

const {
  PROVIDERS,
  providerById,
  sanitizeFilename,
  clampInt,
  filterItems,
  normalizeOrientation,
  resolveInsideRoot,
  validateSearchArgs,
  validateDownloadArgs,
  inferSourceFromUrl,
  assessRights,
  describeRights,
  resolveDownloadPolicy,
  assertRealDirectoryInsideRoot,
  assertNotSymlink,
  workspaceRootFromExec,
  SAVEABLE_EXTENSIONS,
  renderSearchText,
  renderDownloadText,
  renderSourcesText,
  latinQuery,
  providerQueries,
  withUnsplashUtm,
  stripHtml,
  recordAttribution
} = internals

/** Build a PNG header with the given dimensions. */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

test('sanitizeFilename keeps CJK and drops path separators', () => {
  assert.equal(sanitizeFilename('黄仁勋 演讲', 'fallback'), '黄仁勋-演讲')
  assert.equal(sanitizeFilename('../../etc/passwd', 'fallback'), 'etc-passwd')
  assert.equal(sanitizeFilename('  ', 'fallback'), 'fallback')
  assert.equal(sanitizeFilename('.', 'fallback'), 'fallback')
  assert.equal(sanitizeFilename('..', 'fallback'), 'fallback')
  assert.equal(sanitizeFilename('Photo by Jane Doe', 'fallback'), 'Photo-by-Jane-Doe')
})

test('sanitizeFilename avoids Windows reserved device names', () => {
  // "CON.jpg" is the console device on Windows, not a file; the stem before
  // the first dot is what Windows checks, in any case.
  for (const reserved of ['CON', 'con', 'NUL', 'nul.txt', 'COM1', 'lpt9.log', 'CLOCK$']) {
    const stem = sanitizeFilename(reserved, 'image')
    assert.notEqual(stem.toUpperCase().split('.')[0], reserved.toUpperCase().split('.')[0], reserved)
    assert.ok(stem.length > 0, reserved)
    assert.ok(!/[^-\w.\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(stem), reserved)
  }
  // Regular names, including ones starting with the same letters, survive.
  assert.equal(sanitizeFilename('contact-sheet', 'fallback'), 'contact-sheet')
  assert.equal(sanitizeFilename('nullity', 'fallback'), 'nullity')
  assert.equal(sanitizeFilename('console.jpg', 'fallback'), 'console.jpg')
})

test('clampInt clamps, truncates and falls back', () => {
  assert.equal(clampInt(5, 8, 1, 20), 5)
  assert.equal(clampInt(50, 8, 1, 20), 20)
  assert.equal(clampInt(-3, 8, 1, 20), 1)
  assert.equal(clampInt(3.9, 8, 1, 20), 3)
  assert.equal(clampInt(undefined, 8, 1, 20), 8)
  assert.equal(clampInt('nope', 8, 1, 20), 8)
})

test('normalizeOrientation maps provider vocabulary', () => {
  assert.equal(normalizeOrientation('landscape'), 'landscape')
  assert.equal(normalizeOrientation('horizontal'), 'landscape')
  assert.equal(normalizeOrientation('vertical'), 'portrait')
  assert.equal(normalizeOrientation('squarish'), 'square')
  assert.equal(normalizeOrientation('anything'), 'any')
  assert.equal(normalizeOrientation(undefined), 'any')
})

test('filterItems drops small and wrongly oriented photos', () => {
  const items = [
    { width: 1600, height: 900 },
    { width: 600, height: 900 },
    { width: 900, height: 1600 },
    { width: 1000, height: 1000 },
    { width: undefined, height: undefined }
  ]
  const landscape = filterItems(items, { minWidth: 800, orientation: 'landscape' })
  assert.deepEqual(landscape, [{ width: 1600, height: 900 }, { width: undefined, height: undefined }])
  const portrait = filterItems(items, { minWidth: 800, orientation: 'portrait' })
  assert.deepEqual(portrait, [{ width: 900, height: 1600 }, { width: undefined, height: undefined }])
  const square = filterItems(items, { minWidth: 800, orientation: 'square' })
  assert.deepEqual(square, [{ width: 1000, height: 1000 }, { width: undefined, height: undefined }])
})

test('isPrivateAddress rejects private, loopback and mapped ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address)
  }
  assert.equal(isPrivateAddress('not-an-ip'), true)
})

test('resolveInsideRoot keeps writes inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stock-images-'))
  try {
    assert.equal(resolveInsideRoot(root, 'stock-images'), join(root, 'stock-images'))
    assert.equal(resolveInsideRoot(root, './a/b'), join(root, 'a', 'b'))
    assert.throws(() => resolveInsideRoot(root, '../outside'), /outside the Session workspace/)
    assert.throws(() => resolveInsideRoot(root, '/tmp/elsewhere'), /outside the Session workspace/)
    // A sibling with the same prefix must not pass containment.
    assert.throws(() => resolveInsideRoot(root, `${root}-evil`), /outside the Session workspace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sniffImageType recognises supported formats from signatures', () => {
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).mime, 'image/jpeg')
  assert.equal(sniffImageType(pngHeader(10, 10)).mime, 'image/png')
  assert.equal(sniffImageType(Buffer.from('GIF89a0000000000', 'latin1')).mime, 'image/gif')
  const webp = Buffer.alloc(20)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBP', 8, 'latin1')
  assert.equal(sniffImageType(webp).extension, '.webp')
  const avif = Buffer.alloc(20)
  avif.write('0000ftypavif', 0, 'latin1')
  assert.equal(sniffImageType(avif).mime, 'image/avif')
  assert.equal(sniffImageType(Buffer.from('<html>nope</html>')), null)
  assert.equal(sniffImageType(Buffer.alloc(4)), null)
})

test('readImageDimensions reads PNG header', () => {
  assert.deepEqual(readImageDimensions(pngHeader(1920, 1080), 'image/png'), { width: 1920, height: 1080 })
})

test('readImageDimensions reads the GIF logical screen', () => {
  const gif = Buffer.alloc(20)
  gif.write('GIF89a', 0, 'latin1')
  gif.writeUInt16LE(320, 6)
  gif.writeUInt16LE(240, 8)
  assert.deepEqual(readImageDimensions(gif, 'image/gif'), { width: 320, height: 240 })
})

test('readImageDimensions reads an extended WebP canvas', () => {
  const webp = Buffer.alloc(40)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBP', 8, 'latin1')
  webp.write('VP8X', 12, 'latin1')
  const width = 400
  const height = 300
  webp[24] = (width - 1) & 0xff
  webp[25] = ((width - 1) >> 8) & 0xff
  webp[26] = ((width - 1) >> 16) & 0xff
  webp[27] = (height - 1) & 0xff
  webp[28] = ((height - 1) >> 8) & 0xff
  webp[29] = ((height - 1) >> 16) & 0xff
  assert.deepEqual(readImageDimensions(webp, 'image/webp'), { width, height })
})

test('validateSearchArgs normalizes defaults and rejects bad input', () => {
  const args = validateSearchArgs({ query: '  Jensen Huang  ' })
  assert.equal(args.query, 'Jensen Huang')
  assert.equal(args.altQuery, '')
  assert.deepEqual(args.sources, [])
  assert.equal(args.count, 8)
  assert.equal(args.minWidth, 800)
  assert.equal(args.orientation, 'any')

  const restricted = validateSearchArgs({ query: 'x', sources: ['Pexels', 'openverse'], count: 99 })
  assert.deepEqual(restricted.sources, ['pexels', 'openverse'])
  assert.equal(restricted.count, 20)

  assert.throws(() => validateSearchArgs({}), /query must be a non-empty string/)
  assert.throws(() => validateSearchArgs({ query: 'x', sources: ['nope'] }), /unknown source/)
  assert.throws(() => validateSearchArgs({ query: 'x', sources: 'pexels' }), /must be an array/)
})

test('validateDownloadArgs enforces https and known sources', () => {
  const args = validateDownloadArgs({ url: 'https://images.pexels.com/a.jpg' })
  assert.equal(args.directory, 'stock-images')
  assert.equal(args.attribution, true)
  assert.equal(args.source, '')
  assert.throws(() => validateDownloadArgs({ url: 'http://example.com/a.jpg' }), /https/)
  assert.throws(() => validateDownloadArgs({}), /url must be a non-empty string/)
  assert.throws(() => validateDownloadArgs({ url: 'https://example.com/a.jpg', source: 'flickr' }), /unknown source/)
})

test('latinQuery prefers the alternative for CJK queries only', () => {
  assert.equal(latinQuery('黄仁勋', 'Jensen Huang'), 'Jensen Huang')
  assert.equal(latinQuery('Jensen Huang', ''), 'Jensen Huang')
  assert.equal(latinQuery('黄仁勋', ''), '黄仁勋')
})

test('providerQueries plans the query forms each provider index needs', () => {
  const pexels = providerById('pexels')
  const openverse = providerById('openverse')
  // Key-based libraries index English metadata: one form, the Latin one.
  assert.deepEqual(providerQueries(pexels, { query: '黄仁勋', altQuery: 'Jensen Huang' }), ['Jensen Huang'])
  assert.deepEqual(providerQueries(pexels, { query: 'Jensen Huang', altQuery: '' }), ['Jensen Huang'])
  // Key-free libraries take any language but their indexes differ per query form.
  assert.deepEqual(providerQueries(openverse, { query: '黄仁勋', altQuery: 'Jensen Huang' }), [
    '黄仁勋',
    'Jensen Huang'
  ])
  assert.deepEqual(providerQueries(openverse, { query: 'Jensen Huang', altQuery: '' }), ['Jensen Huang'])
  assert.deepEqual(providerQueries(openverse, { query: 'cat', altQuery: 'cat' }), ['cat'])
})

test('withUnsplashUtm adds the required referral parameters', () => {
  assert.equal(
    withUnsplashUtm('https://unsplash.com/photos/abc'),
    'https://unsplash.com/photos/abc?utm_source=dsh_stock_images&utm_medium=referral'
  )
  assert.equal(withUnsplashUtm('not a url'), 'not a url')
})

test('stripHtml converts the HTML snippets from Wikimedia metadata', () => {
  assert.equal(stripHtml('<a href="https://x">Jane&nbsp;Doe</a>'), 'Jane Doe')
  assert.equal(stripHtml('<span>Foo &amp; Bar</span>'), 'Foo & Bar')
  assert.equal(stripHtml(undefined), '')
})

test('inferSourceFromUrl recognizes provider hosts', () => {
  assert.equal(inferSourceFromUrl('https://images.pexels.com/photos/1/a.jpg'), 'pexels')
  assert.equal(inferSourceFromUrl('https://cdn.pixabay.com/photo/a.jpg'), 'pixabay')
  assert.equal(inferSourceFromUrl('https://images.unsplash.com/photo-1'), 'unsplash')
  assert.equal(inferSourceFromUrl('https://upload.wikimedia.org/a.jpg'), 'wikimedia')
  assert.equal(inferSourceFromUrl('https://example.com/a.jpg'), undefined)
})

/** One normalized item as the tools produce it. */
function sampleItem(overrides = {}) {
  return {
    n: 1,
    source: 'pexels',
    id: '1',
    title: 'A speaker on stage',
    creator: 'Jane Doe',
    width: 1920,
    height: 1080,
    license: 'Pexels License',
    license_url: 'https://www.pexels.com/license/',
    attribution: 'Photo by Jane Doe on Pexels — https://www.pexels.com/photo/1/',
    rights: describeRights(assessRights({ source: 'pexels', license: 'Pexels License' })),
    risk: 'medium',
    rights_notes: ['attribution is a license condition: keep the credit line with the image'],
    page_url: 'https://www.pexels.com/photo/1/',
    preview_url: 'https://images.pexels.com/preview.jpg',
    download_url: 'https://images.pexels.com/original.jpg',
    ...overrides
  }
}

test('renderSearchText lists candidates, provider status and the next step', () => {
  const text = renderSearchText({
    query: 'Jensen Huang',
    alt_query: '',
    count: 1,
    policy: 'commercial use and modification allowed; NC, ND, all-rights-reserved and unknown licenses are refused',
    results: [sampleItem()],
    providers: [
      { id: 'pexels', label: 'Pexels', requires_key: true, key_ref: 'PEXELS_API_KEY', status: 'ok', note: '1 match' },
      { id: 'pixabay', label: 'Pixabay', requires_key: true, key_ref: 'PIXABAY_API_KEY', status: 'unconfigured', note: 'set the key' }
    ],
    notes: ['Pexels API terms: show a link to Pexels and credit the photographer when you publish.']
  })
  assert.match(text, /Found 1 image for "Jensen Huang"/)
  assert.match(text, /License policy: commercial use and modification allowed/)
  assert.match(text, /download_url: https:\/\/images\.pexels\.com\/original\.jpg/)
  assert.match(text, /1920×1080/)
  assert.match(text, /Pixabay \[pixabay, key PIXABAY_API_KEY\]: unconfigured/)
  assert.match(text, /Next: call stock_image_download/)
})

test('renderDownloadText reports path, size, credit and the verification step', () => {
  const text = renderDownloadText({
    relative_path: 'stock-images/hopper.jpg',
    bytes: 2048,
    width: 800,
    height: 600,
    mime: 'image/jpeg',
    source: 'pexels',
    license: 'Pexels License',
    rights: 'commercial use OK · modification OK · attribution required · risk: medium',
    risk: 'medium',
    rights_notes: [],
    attribution: 'Photo by Jane Doe on Pexels',
    attribution_forced: false,
    attribution_file: 'stock-images/ATTRIBUTION.md'
  })
  assert.match(text, /Saved stock-images\/hopper\.jpg · 800×600/)
  assert.match(text, /credit recorded in: stock-images\/ATTRIBUTION\.md/)
  assert.match(text, /read_image/)
})

test('renderSourcesText reports key state per provider', () => {
  const text = renderSourcesText({
    checked: false,
    providers: [
      {
        id: 'openverse',
        label: 'Openverse',
        requires_key: false,
        key_ref: null,
        key_state: 'not_required',
        key_source: null,
        status: 'available',
        note: null,
        limits: 'anonymous limit 20 requests/minute',
        license: 'Creative Commons (per result)',
        attribution_rule: 'Keep the license and creator notice'
      }
    ],
    tool_names: ['stock_image_search', 'stock_image_download', 'stock_image_sources'],
    default_directory: 'stock-images',
    max_image_bytes: 1024
  })
  assert.match(text, /Openverse \[openverse\]: available · no key needed/)
  assert.match(text, /Maximum image size: 1\.0 KB/)
})

test('every provider declares the metadata the settings card and the tools rely on', () => {
  assert.equal(PROVIDERS.length, 5)
  for (const provider of PROVIDERS) {
    assert.equal(typeof provider.id, 'string')
    assert.equal(typeof provider.label, 'string')
    assert.equal(typeof provider.homepage, 'string')
    assert.equal(typeof provider.docsUrl, 'string')
    assert.equal(typeof provider.license, 'string')
    assert.equal(typeof provider.attributionRule, 'string')
    assert.equal(typeof provider.buildRequest, 'function')
    assert.equal(typeof provider.normalize, 'function')
    if (provider.requiresKey) {
      assert.match(provider.keyRef, /^[A-Z0-9_]+$/)
    } else {
      assert.equal(provider.keyRef, null)
    }
    assert.equal(providerById(provider.id), provider)
  }
})


test('assessRights allows commercial, modification-friendly licenses', () => {
  for (const license of ['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 4.0', 'GODL-India']) {
    const rights = assessRights({ source: 'wikimedia', license })
    assert.equal(rights.allowed, true, license)
    assert.equal(rights.commercial, true, license)
    assert.equal(rights.derivatives, true, license)
  }
  const cc0 = assessRights({ source: 'openverse', license: 'CC0' })
  assert.equal(cc0.attributionRequired, false)
  assert.equal(cc0.risk, 'low')
  assert.deepEqual(cc0.notes, [])

  const by = assessRights({ source: 'openverse', license: 'CC BY 4.0' })
  assert.equal(by.attributionRequired, true)
  assert.equal(by.risk, 'medium')

  const bySa = assessRights({ source: 'openverse', license: 'CC BY-SA 4.0' })
  assert.equal(bySa.shareAlike, true)
  assert.match(bySa.notes.join(' '), /share-alike/)

  const pd = assessRights({ source: 'wikimedia', license: 'Public domain', attributionRequired: false })
  assert.equal(pd.allowed, true)
  assert.equal(pd.attributionRequired, false)
})

test('assessRights refuses non-commercial, no-derivatives and unknown licenses', () => {
  for (const license of ['CC BY-NC 4.0', 'CC BY-NC-SA 4.0', 'non-commercial']) {
    const rights = assessRights({ source: 'openverse', license })
    assert.equal(rights.allowed, false, license)
    assert.match(rights.reason, /non-commercial/)
  }
  for (const license of ['CC BY-ND 4.0', 'NoDerivs']) {
    const rights = assessRights({ source: 'openverse', license })
    assert.equal(rights.allowed, false, license)
    assert.match(rights.reason, /no-derivatives/)
  }
  for (const license of ['All rights reserved', 'unknown', '', 'see the file page', 'non-free', 'fair use']) {
    const rights = assessRights({ source: 'wikimedia', license })
    assert.equal(rights.allowed, false, license)
    assert.match(rights.reason, /restricted|unrecognized/)
  }
})

test('assessRights trusts platform licenses and flags personality rights', () => {
  const pexels = assessRights({ source: 'pexels', license: 'Pexels License' })
  assert.equal(pexels.allowed, true)
  assert.equal(pexels.attributionRequired, true)

  const pixabay = assessRights({ source: 'pixabay', license: 'Pixabay Content License' })
  assert.equal(pixabay.allowed, true)
  assert.equal(pixabay.attributionRequired, false)

  const unsplash = assessRights({ source: 'unsplash', license: 'Unsplash License' })
  assert.equal(unsplash.attributionRequired, true)

  const person = assessRights({ source: 'wikimedia', license: 'CC BY 4.0', restrictions: ['personality'] })
  assert.equal(person.allowed, true)
  assert.equal(person.risk, 'medium')
  assert.match(person.notes.join(' '), /personality/)

  const trademark = assessRights({ source: 'wikimedia', license: 'CC BY 4.0', restrictions: ['trademark'] })
  assert.match(trademark.notes.join(' '), /trademarks/)
})

test('describeRights renders a compact one-line summary', () => {
  const text = describeRights(assessRights({ source: 'openverse', license: 'CC0' }))
  assert.equal(text, 'commercial use OK · modification OK · no attribution required · risk: low')
})

test('resolveDownloadPolicy only saves images verified by a search in this process', () => {
  const cachedGood = {
    source: 'wikimedia',
    rights: assessRights({ source: 'wikimedia', license: 'CC BY 4.0' }),
    attribution: 'Anders Eidesvik — Wikimedia Commons — CC BY 4.0',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0',
    trackUrl: undefined
  }
  const allowed = resolveDownloadPolicy({
    url: 'https://upload.wikimedia.org/a.jpg',
    source: '',
    cached: cachedGood
  })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.source, 'wikimedia')
  assert.equal(allowed.rights.attributionRequired, true)

  // A result the policy refused cannot be downloaded later.
  const cachedBad = { ...cachedGood, rights: assessRights({ source: 'wikimedia', license: 'CC BY-NC 4.0' }) }
  const refused = resolveDownloadPolicy({ url: 'https://upload.wikimedia.org/a.jpg', source: '', cached: cachedBad })
  assert.equal(refused.allowed, false)
  assert.match(refused.reason, /license policy/)

  // No search behind the URL: refused for every host, platform or not.
  for (const url of [
    'https://example.com/a.jpg',
    'https://upload.wikimedia.org/a.jpg',
    'https://images.pexels.com/photos/1/a.jpg',
    'https://cdn.pixabay.com/photo/a.jpg',
    'https://images.unsplash.com/photo-1'
  ]) {
    const denied = resolveDownloadPolicy({ url, source: '', cached: undefined })
    assert.equal(denied.allowed, false, url)
    assert.match(denied.reason, /stock_image_search/)
  }

  // A provided source must match the search result it came from.
  const mismatch = resolveDownloadPolicy({ url: 'https://upload.wikimedia.org/a.jpg', source: 'pexels', cached: cachedGood })
  assert.equal(mismatch.allowed, false)
  assert.match(mismatch.reason, /belongs to the wikimedia result/)

  // Unsplash+ is a paid subscription CDN, never the free Unsplash License.
  const plus = resolveDownloadPolicy({
    url: 'https://plus.unsplash.com/premium_photo-1.jpg',
    source: '',
    cached: {
      ...cachedGood,
      source: 'unsplash',
      rights: assessRights({ source: 'unsplash', license: 'Unsplash License' })
    }
  })
  assert.equal(plus.allowed, false)
  assert.match(plus.reason, /Unsplash\+/)
})

test('assessRights cannot be bypassed by spacing or punctuation variants', () => {
  const corpus = [
    ['CC BY NC 4.0', 'non-commercial'],
    ['CC BY/NC 4.0', 'non-commercial'],
    ['BY NC', 'non-commercial'],
    ['CC BY-NC 4.0', 'non-commercial'],
    ['Attribution NonCommercial 4.0', 'non-commercial'],
    ['CC BY ND 4.0', 'no-derivatives'],
    ['CC BY 4.0 ND', 'no-derivatives'],
    ['BY ND', 'no-derivatives'],
    ['Attribution-NoDerivatives 4.0', 'no-derivatives'],
    ['All rights reserved', 'restricted'],
    ['fair use', 'restricted'],
    ['editorial use only', 'restricted'],
    ['unknown', 'unrecognized']
  ]
  for (const [license, expected] of corpus) {
    const rights = assessRights({ source: 'wikimedia', license })
    assert.equal(rights.allowed, false, license)
    assert.match(rights.reason, new RegExp(expected, 'i'), license)
  }
  // Public-domain spellings used by Wikimedia must not be mistaken for a risk.
  for (const license of ['CC0', 'Public domain', 'PD-USGov', 'PD-Art (PD-old-100)', 'No restrictions']) {
    const rights = assessRights({ source: 'wikimedia', license })
    assert.equal(rights.allowed, true, license)
    assert.equal(rights.attributionRequired, false, license)
    assert.equal(rights.risk, 'low', license)
  }
})

test('isPrivateAddress covers mapped, NAT64 and 6to4 forms', () => {
  const privateAddresses = [
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '2002:c0a8:0101::1',
    '2001::1'
  ]
  for (const address of privateAddresses) assert.equal(isPrivateAddress(address), true, address)
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2002:0808:0808::1']) {
    assert.equal(isPrivateAddress(address), false, address)
  }
})

test('latinQuery only swaps in the alternative for a CJK primary query', () => {
  assert.equal(latinQuery('黄仁勋', 'Jensen Huang'), 'Jensen Huang')
  assert.equal(latinQuery('Jensen Huang', '黄仁勋'), 'Jensen Huang')
  assert.equal(latinQuery('Jensen Huang', ''), 'Jensen Huang')
  assert.equal(latinQuery('黄仁勋', ''), '黄仁勋')
})

test('path guards refuse symlinked directories and links used as files', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-stock-images-symlink-'))
  try {
    const workspace = join(base, 'workspace')
    const outside = join(base, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    const linked = join(workspace, 'stock-images')
    try {
      await symlink(outside, linked)
    } catch (error) {
      // Windows without admin / developer mode refuses directory symlinks
      // outright; the guards themselves are platform-independent.
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symlinks unavailable on this account (${error.code}); the guard logic is platform-independent`)
        return
      }
      throw error
    }

    await assert.rejects(assertRealDirectoryInsideRoot(workspace, linked), /symlink/)
    const real = join(workspace, 'ok')
    await mkdir(real)
    const resolved = await assertRealDirectoryInsideRoot(workspace, real)
    // macOS resolves /var through /private/var, so compare the real path.
    assert.equal(resolved, await realpath(real))

    try {
      const target = join(workspace, 'ATTRIBUTION.md')
      await writeFile(join(outside, 'attribution-target.md'), 'x')
      await symlink(join(outside, 'attribution-target.md'), target)
      await assert.rejects(assertNotSymlink(target), /symbolic link/)
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('file symlinks unavailable on this account; the guard logic is platform-independent')
        return
      }
      throw error
    }
    await assert.doesNotReject(assertNotSymlink(join(workspace, 'missing.md')))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('workspaceRootFromExec prefers the working-directory service and falls back to the header', async () => {
  // Platform-independent absolute paths: resolve('/') yields "<drive>:\..." on
  // Windows and "/..." on POSIX, so isAbsolute holds on both. Literals like
  // "D:\repo" would fail the isAbsolute check on POSIX.
  const headerRoot = resolve('/', 'dsh-stock-images-test', 'repo')
  const worktreeRoot = resolve('/', 'dsh-stock-images-test', 'repo', 'worktrees', 'fix-x')
  const exec = { agent: { session: { header: { cwd: headerRoot } } } }

  // No service at all: falls back to the header cwd.
  assert.equal(await workspaceRootFromExec(undefined, exec), headerRoot)
  assert.equal(await workspaceRootFromExec({ get: () => undefined }, exec), headerRoot)
  // Service that throws: still falls back instead of failing the download.
  assert.equal(
    await workspaceRootFromExec({ get: () => ({ ensure: () => Promise.reject(new Error('nope')) }) }, exec),
    headerRoot
  )

  // Service with a live answer: wins over the header, so a Session that moved
  // through create_worktree / working_directory writes into the current tree.
  // Like the real service, it only answers for an agent-backed call.
  const withService = {
    get: (name) =>
      name === 'workingDirectory'
        ? { ensure: (agent) => (agent ? Promise.resolve(worktreeRoot) : undefined) }
        : undefined
  }
  assert.equal(await workspaceRootFromExec(withService, exec), worktreeRoot)

  // No session at all: refuses rather than writing to the process directory.
  await assert.rejects(workspaceRootFromExec(withService, {}), /active Session workspace/)
  await assert.rejects(workspaceRootFromExec(undefined, undefined), /active Session workspace/)
  const relativeHeader = { agent: { session: { header: { cwd: 'relative/path' } } } }
  await assert.rejects(workspaceRootFromExec(undefined, relativeHeader), /active Session workspace/)
})

test('only formats read_image can review are saveable', () => {
  assert.deepEqual([...SAVEABLE_EXTENSIONS].sort(), ['.gif', '.jpeg', '.jpg', '.png', '.webp'])
  const avif = Buffer.alloc(20)
  avif.write('0000ftypavif', 0, 'latin1')
  assert.equal(SAVEABLE_EXTENSIONS.has(sniffImageType(avif).extension), false)
  assert.equal(SAVEABLE_EXTENSIONS.has(sniffImageType(pngHeader(10, 10)).extension), true)
  assert.equal(sniffImageType(Buffer.alloc(16, 0xff)), null)
  assert.equal(SAVEABLE_EXTENSIONS.has(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).extension), true)
})

test('concurrent downloads into one folder keep every attribution line', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-stock-images-attr-'))
  try {
    // Fire many writes at once: without per-path serialization the
    // read-modify-write race drops credit lines (the loser's write is
    // overwritten by a stale read).
    const lines = Array.from({ length: 24 }, (_, index) => ({
      date: '2026-11-24',
      file: `stock-images/photo-${index}.jpg`,
      credit: `Photo by photographer-${index}`,
      source: 'wikimedia'
    }))
    await Promise.all(lines.map((entry) => recordAttribution(base, entry)))
    const written = await readFile(join(base, 'ATTRIBUTION.md'), 'utf8')
    for (const entry of lines) {
      assert.ok(written.includes(entry.file), entry.file)
      assert.ok(written.includes(entry.credit), entry.credit)
    }
    // The header the plugin writes on a fresh folder is present exactly once.
    assert.equal(written.split('# Image attribution').length - 1, 1)

    // Re-recording the same line is still a no-op, not a duplicate.
    await recordAttribution(base, lines[0])
    const after = await readFile(join(base, 'ATTRIBUTION.md'), 'utf8')
    assert.equal((after.match(/photo-0\.jpg/g) ?? []).length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
