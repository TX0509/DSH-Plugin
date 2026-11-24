import assert from 'node:assert/strict'
import test from 'node:test'

import { __internals as internals } from '../index.js'

const { PROVIDERS } = internals

/** Look up a provider by id from the plugin's own catalog. */
function provider(id) {
  const found = PROVIDERS.find((entry) => entry.id === id)
  assert.ok(found, `provider ${id} must exist`)
  return found
}

/** Arguments accepted by every `buildRequest`. */
const baseArgs = {
  query: 'Jensen Huang',
  altQuery: '',
  orientation: 'landscape',
  count: 6,
  minWidth: 800,
  commercialOnly: true,
  perSource: 4
}

function urlOf(built) {
  return new URL(built.url)
}

test('pexels builds an authorized search with the documented parameters', () => {
  const built = provider('pexels').buildRequest({ ...baseArgs, altQuery: 'Jensen Huang' }, 'KEY123')
  const url = urlOf(built)
  assert.equal(url.origin + url.pathname, 'https://api.pexels.com/v1/search')
  assert.equal(url.searchParams.get('query'), 'Jensen Huang')
  assert.equal(url.searchParams.get('per_page'), '4')
  assert.equal(url.searchParams.get('orientation'), 'landscape')
  assert.deepEqual(built.headers, { authorization: 'KEY123' })
})

test('pexels normalize maps photo, credit and original URL', () => {
  const payload = {
    photos: [
      {
        id: 5764154,
        width: 4000,
        height: 2250,
        url: 'https://www.pexels.com/photo/5764154/',
        photographer: 'Jane Doe',
        photographer_url: 'https://www.pexels.com/@jane',
        alt: 'Man speaking on a stage',
        src: {
          original: 'https://images.pexels.com/photos/5764154/original.jpeg',
          large2x: 'https://images.pexels.com/photos/5764154/large2x.jpeg',
          large: 'https://images.pexels.com/photos/5764154/large.jpeg',
          medium: 'https://images.pexels.com/photos/5764154/medium.jpeg'
        }
      }
    ]
  }
  const [item] = provider('pexels').normalize(payload)
  assert.equal(item.source, 'pexels')
  assert.equal(item.id, '5764154')
  assert.equal(item.title, 'Man speaking on a stage')
  assert.equal(item.creator, 'Jane Doe')
  assert.equal(item.width, 4000)
  assert.equal(item.license, 'Pexels License')
  assert.equal(item.downloadUrl, 'https://images.pexels.com/photos/5764154/original.jpeg')
  assert.equal(item.previewUrl, 'https://images.pexels.com/photos/5764154/large.jpeg')
  assert.match(item.attribution, /Photo by Jane Doe on Pexels/)
})

test('pixabay builds the keyed request and prefers the largest usable image', () => {
  const built = provider('pixabay').buildRequest(baseArgs, 'PIXKEY')
  const url = urlOf(built)
  assert.equal(url.origin + url.pathname, 'https://pixabay.com/api/')
  assert.equal(url.searchParams.get('key'), 'PIXKEY')
  assert.equal(url.searchParams.get('image_type'), 'photo')
  assert.equal(url.searchParams.get('orientation'), 'horizontal')
  assert.equal(url.searchParams.get('per_page'), '4')

  const [item] = provider('pixabay').normalize({
    hits: [
      {
        id: 42,
        pageURL: 'https://pixabay.com/photos/42/',
        tags: 'stage, keynote, conference',
        imageWidth: 1920,
        imageHeight: 1280,
        webformatURL: 'https://cdn.pixabay.com/photo/42_640.jpg',
        largeImageURL: 'https://cdn.pixabay.com/photo/42_1280.jpg',
        user: 'jane',
        user_id: 7
      }
    ]
  })
  assert.equal(item.title, 'stage, keynote, conference')
  assert.equal(item.downloadUrl, 'https://cdn.pixabay.com/photo/42_1280.jpg')
  assert.match(item.creatorUrl, /pixabay\.com\/users\/jane-7/)
})

test('unsplash builds a Client-ID request and keeps the download callback', () => {
  const built = provider('unsplash').buildRequest(baseArgs, 'UNSPLASH')
  const url = urlOf(built)
  assert.equal(url.origin + url.pathname, 'https://api.unsplash.com/search/photos')
  assert.equal(url.searchParams.get('per_page'), '4')
  assert.equal(url.searchParams.get('orientation'), 'landscape')
  assert.deepEqual(built.headers, { authorization: 'Client-ID UNSPLASH' })

  const [item] = provider('unsplash').normalize({
    results: [
      {
        id: 'abc',
        width: 5000,
        height: 3333,
        alt_description: 'A keynote stage',
        description: '',
        user: { name: 'Annie Spratt', links: { html: 'https://unsplash.com/@annie' } },
        links: {
          html: 'https://unsplash.com/photos/abc',
          download_location: 'https://api.unsplash.com/photos/abc/download?ixid=xyz'
        },
        urls: {
          full: 'https://images.unsplash.com/photo-abc?ixid=xyz&fm=jpg',
          regular: 'https://images.unsplash.com/photo-abc?ixid=xyz&w=1080',
          small: 'https://images.unsplash.com/photo-abc?ixid=xyz&w=400'
        }
      }
    ]
  })
  assert.equal(item.title, 'A keynote stage')
  assert.equal(item.trackUrl, 'https://api.unsplash.com/photos/abc/download?ixid=xyz')
  assert.equal(item.downloadUrl, 'https://images.unsplash.com/photo-abc?ixid=xyz&fm=jpg')
  assert.match(item.pageUrl, /utm_source=dsh_stock_images/)
  assert.match(item.attribution, /Photo by Annie Spratt on Unsplash/)
  assert.match(item.attribution, /utm_medium=referral/)
})

test('unsplash drops premium Unsplash+ results, which are not the free license', () => {
  const items = provider('unsplash').normalize({
    results: [
      {
        id: 'free-1',
        width: 4000,
        height: 3000,
        user: { name: 'Free Photographer', links: { html: 'https://unsplash.com/@free' } },
        links: { html: 'https://unsplash.com/photos/free-1', download_location: 'https://api.unsplash.com/photos/free-1/download' },
        urls: {
          full: 'https://images.unsplash.com/photo-free-1?fm=jpg',
          regular: 'https://images.unsplash.com/photo-free-1?w=1080',
          small: 'https://images.unsplash.com/photo-free-1?w=400'
        }
      },
      {
        id: 'premium-1',
        width: 4000,
        height: 3000,
        user: { name: 'Premium Photographer', links: { html: 'https://unsplash.com/@premium' } },
        links: { html: 'https://unsplash.com/photos/premium-1', download_location: 'https://api.unsplash.com/photos/premium-1/download' },
        urls: {
          full: 'https://plus.unsplash.com/premium_photo-1?fm=jpg',
          regular: 'https://plus.unsplash.com/premium_photo-1?w=1080',
          small: 'https://plus.unsplash.com/premium_photo-1?w=400'
        }
      }
    ]
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'free-1')
  assert.match(items[0].rights === undefined ? items[0].downloadUrl : items[0].downloadUrl, /images\.unsplash\.com/)
})

test('openverse builds an anonymous, commercial-license query', () => {
  const built = provider('openverse').buildRequest(baseArgs)
  const url = urlOf(built)
  assert.equal(url.origin + url.pathname, 'https://api.openverse.org/v1/images/')
  assert.equal(url.searchParams.get('license_type'), 'commercial')
  assert.equal(url.searchParams.get('license'), 'by,by-sa,cc0,pdm')
  assert.equal(url.searchParams.get('mature'), 'false')
  assert.equal(url.searchParams.get('aspect_ratio'), 'wide')
  assert.deepEqual(built.headers, {})

  const [item] = provider('openverse').normalize({
    results: [
      {
        id: '8a1c',
        title: 'Jensen Huang at GTC',
        creator: 'NVIDIA Corporation',
        creator_url: 'https://www.flickr.com/nvidia',
        width: 4000,
        height: 2667,
        license: 'by',
        license_version: '2.0',
        license_url: 'https://creativecommons.org/licenses/by/2.0/',
        attribution: '"Jensen Huang at GTC" by NVIDIA Corporation is licensed under CC BY 2.0.',
        foreign_landing_url: 'https://www.flickr.com/photos/7549192',
        thumbnail: 'https://api.openverse.org/v1/images/8a1c/thumb/',
        url: 'https://live.staticflickr.com/1/2/3.jpg'
      }
    ]
  })
  assert.equal(item.license, 'CC BY 2.0')
  assert.equal(item.attribution, '"Jensen Huang at GTC" by NVIDIA Corporation is licensed under CC BY 2.0.')
  assert.equal(item.downloadUrl, 'https://live.staticflickr.com/1/2/3.jpg')
  assert.equal(item.previewUrl, 'https://api.openverse.org/v1/images/8a1c/thumb/')
})

test('wikimedia builds a Commons file search and skips non-bitmap files', () => {
  const built = provider('wikimedia').buildRequest(baseArgs)
  const url = urlOf(built)
  assert.equal(url.origin + url.pathname, 'https://commons.wikimedia.org/w/api.php')
  assert.equal(url.searchParams.get('generator'), 'search')
  assert.match(url.searchParams.get('gsrsearch'), /Jensen Huang filetype:bitmap/)
  assert.equal(url.searchParams.get('gsrnamespace'), '6')

  const items = provider('wikimedia').normalize({
    query: {
      pages: [
        {
          pageid: 123,
          title: 'File:Jensen Huang (cropped).jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/a/b/Jensen_Huang.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Jensen_Huang.jpg',
              thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/b/Jensen_Huang.jpg/640px.jpg',
              width: 3000,
              height: 4000,
              mime: 'image/jpeg',
              extmetadata: {
                Artist: { value: '<a href="https://x">GODL-India</a>' },
                LicenseShortName: { value: 'GODL-India' },
                LicenseUrl: { value: 'https://example.org/license' },
                AttributionRequired: { value: 'true' },
                Restrictions: { value: 'personality, trademark' }
              }
            }
          ]
        },
        {
          pageid: 456,
          title: 'File:Diagram.svg',
          imageinfo: [{ url: 'https://upload.wikimedia.org/x.svg', mime: 'image/svg+xml', width: 10, height: 10 }]
        }
      ]
    }
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Jensen Huang (cropped)')
  assert.equal(items[0].creator, 'GODL-India')
  assert.equal(items[0].license, 'GODL-India')
  assert.equal(items[0].downloadUrl, 'https://upload.wikimedia.org/wikipedia/commons/a/b/Jensen_Huang.jpg')
  assert.match(items[0].attribution, /Wikimedia Commons — GODL-India/)
  assert.equal(items[0].attributionRequired, true)
  assert.deepEqual(items[0].restrictions, ['personality', 'trademark'])
})
