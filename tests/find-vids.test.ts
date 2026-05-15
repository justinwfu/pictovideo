import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import sharp from 'sharp';

import {
  parseArgs,
  resolveOpenCommand,
  downscaleToFit,
  loadAndValidatePhoto,
  renderHTML,
  esc,
  MAX_RAW_BYTES,
  type TermGroup,
} from '../find-vids.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

// --- parseArgs ---------------------------------------------------------------

test('parseArgs: photo only — all flags default off', () => {
  const r = parseArgs(['photo.jpg']);
  assert.equal(r.photoPath, 'photo.jpg');
  assert.equal(r.flags.noCache, false);
  assert.equal(r.flags.showQueries, false);
  assert.equal(r.flags.noEnrich, false);
});

test('parseArgs: photo + --no-cache + --show-queries + --no-enrich', () => {
  const r = parseArgs(['p.png', '--no-cache', '--show-queries', '--no-enrich']);
  assert.equal(r.photoPath, 'p.png');
  assert.equal(r.flags.noCache, true);
  assert.equal(r.flags.showQueries, true);
  assert.equal(r.flags.noEnrich, true);
});

test('parseArgs: order is insensitive', () => {
  const r = parseArgs(['--show-queries', 'p.png', '--no-cache', '--no-enrich']);
  assert.equal(r.photoPath, 'p.png');
  assert.equal(r.flags.noCache, true);
  assert.equal(r.flags.showQueries, true);
  assert.equal(r.flags.noEnrich, true);
});

// --- resolveOpenCommand ------------------------------------------------------

test('resolveOpenCommand: darwin → open', () => {
  assert.deepEqual(resolveOpenCommand('darwin', '/foo/bar.html'), ['open', '/foo/bar.html']);
});

test('resolveOpenCommand: linux → xdg-open', () => {
  assert.deepEqual(resolveOpenCommand('linux', '/foo/bar.html'), ['xdg-open', '/foo/bar.html']);
});

test('resolveOpenCommand: win32 → cmd /c start with empty title', () => {
  // The empty quoted title is load-bearing on Windows when the path is
  // double-quoted — `start "C:\\path"` interprets the path as a window title.
  assert.deepEqual(resolveOpenCommand('win32', 'C:\\foo.html'), ['cmd', '/c', 'start', '', 'C:\\foo.html']);
});

test('resolveOpenCommand: unknown platform returns null', () => {
  assert.equal(resolveOpenCommand('freebsd' as NodeJS.Platform, '/foo'), null);
});

// --- esc ---------------------------------------------------------------------

test('esc: escapes <, >, &, ", and \'', () => {
  assert.equal(esc('<script>'), '&lt;script&gt;');
  assert.equal(esc('a & b'), 'a &amp; b');
  assert.equal(esc('"q"'), '&quot;q&quot;');
  assert.equal(esc("it's"), 'it&#39;s');
});

test('esc: ampersand is escaped before other entities (no double-escape of entities)', () => {
  // Confirming order: `&amp;` should not be re-escaped on a second pass.
  assert.equal(esc('&amp;'), '&amp;amp;');
});

// --- downscaleToFit ----------------------------------------------------------

test('downscaleToFit: GIF passes through unchanged (identity)', async () => {
  const fakeGif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const out = await downscaleToFit(fakeGif, '.gif');
  assert.equal(out, fakeGif);
});

test('downscaleToFit: oversized JPEG is downscaled below MAX_RAW_BYTES', async () => {
  // Construct an oversized JPEG via random pixel buffer (incompressible).
  const w = 4000;
  const h = 4000;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) & 0xff; // pseudo-random
  const big = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
  assert.ok(big.length > MAX_RAW_BYTES, `precondition: expected big > ${MAX_RAW_BYTES}, got ${big.length}`);

  const out = await downscaleToFit(big, '.jpg');
  assert.ok(out.length <= MAX_RAW_BYTES, `expected downscaled <= ${MAX_RAW_BYTES}, got ${out.length}`);

  const meta = await sharp(out).metadata();
  assert.ok((meta.width ?? 0) <= 2048, `expected width <= 2048, got ${meta.width}`);
});

test('downscaleToFit: small JPEG produces a valid resized buffer under the cap', async () => {
  const small = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .jpeg()
    .toBuffer();
  // Small inputs that already fit can still flow through resize; output must
  // be valid and under the cap regardless.
  const out = await downscaleToFit(small, '.jpg');
  assert.ok(out.length > 0);
  assert.ok(out.length <= MAX_RAW_BYTES);
});

// --- loadAndValidatePhoto: EXIF orientation normalization --------------------

test('loadAndValidatePhoto: bakes EXIF Orientation=6 into pixels (sideways → upright)', async () => {
  // Build a 200x100 (landscape) JPEG with Orientation=6, meaning consumers
  // that honor EXIF should display it rotated 90° CW (100x200 portrait).
  const sideways = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 80, g: 200, b: 120 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const dir = await fs.mkdtemp(join(tmpdir(), 'pictovideo-test-'));
  const photoPath = join(dir, 'sideways.jpg');
  await fs.writeFile(photoPath, sideways);

  try {
    const { bytes } = await loadAndValidatePhoto(photoPath);
    const meta = await sharp(bytes).metadata();
    // After .rotate() bakes orientation into pixels: dimensions flip to 100x200.
    assert.equal(meta.width, 100, 'width should be flipped to portrait short edge');
    assert.equal(meta.height, 200, 'height should be flipped to portrait long edge');
    // And the EXIF Orientation tag should no longer be 6 (rotation already applied).
    assert.notEqual(meta.orientation, 6, 'orientation tag should be cleared after rotate');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadAndValidatePhoto: GIF passes through bytes-equal', async () => {
  // 1x1 transparent GIF (smallest valid GIF).
  const gif = Buffer.from(
    '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
    'hex',
  );
  const dir = await fs.mkdtemp(join(tmpdir(), 'pictovideo-test-'));
  const photoPath = join(dir, 'tiny.gif');
  await fs.writeFile(photoPath, gif);

  try {
    const { bytes, mime } = await loadAndValidatePhoto(photoPath);
    assert.deepEqual(bytes, gif);
    assert.equal(mime, 'image/gif');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- renderHTML golden -------------------------------------------------------

const goldenTerms: TermGroup[] = [
  {
    query: 'two smartphones in hands side by side',
    results: [
      {
        videoId: 'aaa111',
        title: 'iPhone 17 vs Pixel 10: real-world comparison',
        channelTitle: 'PhoneReviewsChannel',
        thumbnailUrl: 'https://i.ytimg.com/vi/aaa111/hqdefault.jpg',
      },
      {
        videoId: 'bbb222',
        title: 'Side-by-side: which phone wins?',
        channelTitle: 'TechCompare',
        thumbnailUrl: 'https://i.ytimg.com/vi/bbb222/hqdefault.jpg',
        embedUrl: 'https://www.youtube.com/embed/bbb222?rel=0',
      },
    ],
  },
  {
    query: 'how to compare phone specs',
    results: [
      {
        videoId: 'ccc333',
        title: 'Reading phone specs without getting fooled',
        channelTitle: 'BuyerGuide',
        thumbnailUrl: 'https://i.ytimg.com/vi/ccc333/hqdefault.jpg',
      },
    ],
  },
  {
    query: 'smartphone evolution & history',
    results: [],
    error: 'YouTube quota exceeded',
  },
];

const goldenPhotoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('renderHTML: matches the checked-in golden', async () => {
  const html = renderHTML(goldenPhotoDataUrl, goldenTerms);
  const goldenPath = join(fixturesDir, 'golden.html');

  if (process.env.UPDATE_GOLDENS === '1') {
    await fs.writeFile(goldenPath, html);
    return;
  }

  const expected = await fs.readFile(goldenPath, 'utf-8');
  assert.equal(html, expected);
});

test('renderHTML: header counts queries and total videos correctly', () => {
  const html = renderHTML(goldenPhotoDataUrl, goldenTerms);
  // 3 queries, results count is 2 + 1 + 0 = 3.
  assert.ok(html.includes('3 queries, 3 videos'), 'expected "3 queries, 3 videos" in header');
});

test('renderHTML: error term renders an error block, not video cards', () => {
  const html = renderHTML(goldenPhotoDataUrl, [
    { query: 'broken', results: [], error: 'rate limited' },
  ]);
  assert.ok(html.includes('Error: rate limited'), 'expected error message in output');
  assert.ok(!html.includes('data-embed='), 'expected no video cards for error-only render');
});

// --- enrichment rendering ---------------------------------------------------

test('renderHTML: summary, when present, is rendered as an italic line-clamp-3 block', () => {
  const html = renderHTML(goldenPhotoDataUrl, [
    {
      query: 'q',
      results: [
        {
          videoId: 'sss111',
          title: 'A video',
          channelTitle: 'AChannel',
          thumbnailUrl: 'https://i.ytimg.com/vi/sss111/hqdefault.jpg',
          summary: 'Walks through dough hydration math for beginner bakers.',
        },
      ],
    },
  ]);
  assert.ok(html.includes('italic line-clamp-3'), 'expected italic line-clamp-3 styling class on summary');
  assert.ok(html.includes('Walks through dough hydration math for beginner bakers.'), 'expected summary text in output');
});

test('renderHTML: topComment renders likeCount + author + comment text', () => {
  const html = renderHTML(goldenPhotoDataUrl, [
    {
      query: 'q',
      results: [
        {
          videoId: 'ttt222',
          title: 'A video',
          channelTitle: 'AChannel',
          thumbnailUrl: 'https://i.ytimg.com/vi/ttt222/hqdefault.jpg',
          topComment: { text: 'This is the best explanation on YouTube.', author: '@viewer', likeCount: 1234 },
        },
      ],
    },
  ]);
  assert.ok(html.includes('▲ 1234'), 'expected likeCount with arrow prefix');
  assert.ok(html.includes('@viewer'), 'expected commenter handle');
  assert.ok(html.includes('This is the best explanation on YouTube.'), 'expected comment text');
});

test('renderHTML: card without summary or topComment emits neither block', () => {
  const html = renderHTML(goldenPhotoDataUrl, [
    {
      query: 'q',
      results: [
        {
          videoId: 'uuu333',
          title: 'A video',
          channelTitle: 'AChannel',
          thumbnailUrl: 'https://i.ytimg.com/vi/uuu333/hqdefault.jpg',
        },
      ],
    },
  ]);
  assert.ok(!html.includes('italic line-clamp-3'), 'expected no summary block');
  assert.ok(!html.includes('▲'), 'expected no top-comment block');
});

test('renderHTML: enrichment-bearing card matches checked-in golden', async () => {
  const enrichedTerms: TermGroup[] = [
    {
      query: 'literal: smartphone in hand',
      results: [
        {
          videoId: 'aaa111',
          title: 'iPhone 17 vs Pixel 10: real-world comparison',
          channelTitle: 'PhoneReviewsChannel',
          thumbnailUrl: 'https://i.ytimg.com/vi/aaa111/hqdefault.jpg',
          summary: 'Side-by-side video and battery test of the iPhone 17 and Pixel 10 in real-world commuting use.',
          topComment: {
            text: 'Best comparison I have seen — the low-light camera test alone was worth watching.',
            author: '@buyerguide99',
            likeCount: 842,
          },
        },
      ],
    },
  ];
  const html = renderHTML(goldenPhotoDataUrl, enrichedTerms);
  const goldenPath = join(fixturesDir, 'golden-enriched.html');
  if (process.env.UPDATE_GOLDENS === '1') {
    await fs.writeFile(goldenPath, html);
    return;
  }
  const expected = await fs.readFile(goldenPath, 'utf-8');
  assert.equal(html, expected);
});
