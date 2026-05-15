import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extname, basename, join } from 'node:path';

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import sharp from 'sharp';

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const VISION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Anthropic rejects images whose base64 payload exceeds 5 MB. Base64 inflates
// raw bytes by ~33%, so the safe raw ceiling is ~3.75 MB. Subtract a small
// buffer to leave room for the JSON envelope around the payload.
const MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 8 * 1024;

const SYSTEM_PROMPT = `You generate 3 YouTube search queries for a photo. Each query MUST target a different intent — the queries are not synonyms of each other.

1. Literal/descriptive: name what is visibly shown (subject, scene, object)
2. Instructional: how to do, make, learn, or fix what is shown
3. Broader topical: the wider domain, theme, history, or context

Each query: 3 to 7 words, plain language as a real YouTube user would type. No quotes, no "YouTube" in the query itself. Return them in the order above.`;

type Flags = { noCache: boolean; showQueries: boolean };

type Video = {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  publishedAt?: string;
  thumbnailUrl: string;
  embedUrl?: string;
  watchUrl?: string;
  description?: string;
};

type TermGroup = { query: string; results: Video[]; error?: string };
type BulkResponse = { terms: TermGroup[] };

function parseArgs(argv: string[]): { photoPath: string; flags: Flags } {
  const flags: Flags = { noCache: false, showQueries: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--no-cache') flags.noCache = true;
    else if (a === '--show-queries') flags.showQueries = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: find-vids <photo> [--no-cache] [--show-queries]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error('Usage: find-vids <photo> [--no-cache] [--show-queries]');
    process.exit(1);
  }
  return { photoPath: positional[0], flags };
}

async function downscaleToFit(bytes: Buffer, ext: string): Promise<Buffer> {
  // GIFs may be animated; sharp would flatten them. Pass through and let the
  // API reject if it's still too big — preserves user expectations for GIFs.
  if (ext === '.gif') return bytes;

  // .rotate() with no args applies EXIF Orientation into the pixels — without
  // this, iPhone photos taken in portrait come out sideways once sharp strips
  // the EXIF tag.
  const originalKB = Math.round(bytes.length / 1024);
  for (const width of [2048, 1536, 1024, 768]) {
    const out = await sharp(bytes).rotate().resize({ width, withoutEnlargement: true }).toBuffer();
    if (out.length <= MAX_RAW_BYTES) {
      console.error(
        `Downscaled ${originalKB} KB → ${Math.round(out.length / 1024)} KB (width ${width}px) to fit Anthropic 5 MB limit`,
      );
      return out;
    }
  }
  return sharp(bytes).rotate().resize({ width: 768, withoutEnlargement: true }).toBuffer();
}

async function loadAndValidatePhoto(photoPath: string): Promise<{ bytes: Buffer; ext: string; mime: string }> {
  const ext = extname(photoPath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    console.error(`Unsupported format: ${ext || '(none)'}.`);
    console.error(`Allowed: JPEG, PNG, WEBP, GIF. iPhone users: re-export HEIC as JPEG.`);
    process.exit(1);
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(photoPath);
  } catch (e) {
    console.error(`Cannot read photo: ${(e as Error).message}`);
    process.exit(1);
  }
  if (bytes.length > MAX_RAW_BYTES) {
    bytes = await downscaleToFit(bytes, ext);
  }
  return { bytes, ext, mime: EXT_TO_MIME[ext] };
}

async function getQueries(bytes: Buffer, mime: string, hash: string, flags: Flags): Promise<string[]> {
  const cacheDir = join('.cache', 'vision');
  const cacheFile = join(cacheDir, `${hash}.json`);
  if (!flags.noCache) {
    try {
      const raw = await fs.readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as { savedAt: number; queries: string[] };
      if (Date.now() - cached.savedAt < VISION_CACHE_TTL_MS) return cached.queries;
    } catch { /* miss */ }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Add it to .env (see .env.example).');
    process.exit(1);
  }

  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: z.object({
      queries: z
        .array(z.string().min(1))
        .length(3)
        .describe('Three YouTube search queries, one per intent axis: literal, instructional, broader-topical'),
    }),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Generate the 3 queries for this photo.' },
          { type: 'image', image: bytes, mediaType: mime },
        ],
      },
    ],
  });

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ savedAt: Date.now(), queries: object.queries }, null, 2));
  return object.queries;
}

function searchYouTube(queries: string[]): TermGroup[] {
  const cli = process.env.YOUTUBE_PP_CLI || 'youtube-pp-cli';
  const args = ['youtube', 'search-bulk', ...queries, '--top', '5', '--agent'];
  const r = spawnSync(cli, args, { encoding: 'utf-8' });
  if (r.error) {
    console.error(`Failed to spawn ${cli}: ${r.error.message}`);
    console.error('Set YOUTUBE_PP_CLI in .env to its absolute path if it is not on $PATH.');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`youtube-pp-cli exited ${r.status}`);
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }
  let parsed: BulkResponse;
  try {
    parsed = JSON.parse(r.stdout) as BulkResponse;
  } catch (e) {
    console.error(`Could not parse youtube-pp-cli output as JSON: ${(e as Error).message}`);
    console.error(r.stdout.slice(0, 500));
    process.exit(1);
  }
  return parsed.terms ?? [];
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHTML(photoDataUrl: string, terms: TermGroup[]): string {
  const sections = terms
    .map((t) => {
      if (t.error) {
        return `<section class="mb-12"><h2 class="text-lg font-medium text-zinc-100 mb-3">🔍 ${esc(t.query)}</h2><p class="text-red-400 text-sm">Error: ${esc(t.error)}</p></section>`;
      }
      const cards = t.results
        .map((v) => {
          const embed = v.embedUrl || `https://www.youtube.com/embed/${v.videoId}`;
          const embedAutoplay = embed.includes('?')
            ? `${embed}&autoplay=1`
            : `${embed}?autoplay=1`;
          return `<div class="group rounded-lg overflow-hidden bg-zinc-900 hover:bg-zinc-800 transition cursor-pointer" data-embed="${esc(embedAutoplay)}" data-vid="${esc(v.videoId)}">
        <div class="relative aspect-video bg-zinc-950">
          <img src="${esc(v.thumbnailUrl)}" alt="" class="w-full h-full object-cover" loading="lazy" />
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="w-14 h-14 rounded-full bg-black/60 group-hover:bg-red-600 transition flex items-center justify-center">
              <svg viewBox="0 0 24 24" class="w-7 h-7 fill-white"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </div>
        <div class="p-3">
          <h3 class="text-sm font-medium text-zinc-100 line-clamp-2">${esc(v.title)}</h3>
          <p class="text-xs text-zinc-400 mt-1">${esc(v.channelTitle)}</p>
        </div>
      </div>`;
        })
        .join('\n      ');
      return `<section class="mb-12">
    <h2 class="text-lg font-medium text-zinc-100 mb-4">🔍 <span class="text-zinc-400 font-normal">${esc(t.query)}</span></h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      ${cards}
    </div>
  </section>`;
    })
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>pictovideo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    body { background: #09090b; }
  </style>
</head>
<body class="text-zinc-200">
  <header class="border-b border-zinc-800 bg-zinc-950 sticky top-0 z-10">
    <div class="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
      <img src="${photoDataUrl}" alt="source photo" class="h-16 w-16 rounded-md object-cover ring-1 ring-zinc-800" />
      <div>
        <h1 class="text-base font-medium text-zinc-100">pictovideo</h1>
        <p class="text-xs text-zinc-500">${terms.length} queries, ${terms.reduce((n, t) => n + (t.results?.length ?? 0), 0)} videos</p>
      </div>
    </div>
  </header>
  <main class="max-w-7xl mx-auto px-6 py-8">
  ${sections}
  </main>
  <script>
    document.querySelectorAll('[data-embed]').forEach((card) => {
      card.addEventListener('click', () => {
        const src = card.getAttribute('data-embed');
        const wrap = card.querySelector('.aspect-video');
        if (!wrap || !src) return;
        wrap.innerHTML = '<iframe src="' + src + '" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen class="w-full h-full"></iframe>';
        card.classList.remove('cursor-pointer');
        card.replaceWith(card.cloneNode(true)); // detach further clicks once playing
      });
    });
  </script>
</body>
</html>
`;
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function main(): Promise<void> {
  const { photoPath, flags } = parseArgs(process.argv.slice(2));
  const { bytes, mime } = await loadAndValidatePhoto(photoPath);
  const hash = createHash('sha1').update(bytes).digest('hex');

  const queries = await getQueries(bytes, mime, hash, flags);
  if (flags.showQueries) {
    console.error('Queries:');
    for (const q of queries) console.error('  - ' + q);
  }

  const terms = searchYouTube(queries);

  const photoDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  const html = renderHTML(photoDataUrl, terms);

  await fs.mkdir('out', { recursive: true });
  const outFile = join('out', `${nowStamp()}-pictovideo.html`);
  await fs.writeFile(outFile, html);

  const latest = join('out', 'latest.html');
  try { await fs.unlink(latest); } catch { /* ok if missing */ }
  await fs.symlink(basename(outFile), latest);

  spawnSync('open', [latest], { stdio: 'inherit' });
  console.error(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
