import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import sharp from 'sharp';

const execFile = promisify(execFileCb);

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const VISION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENRICH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_TRUNCATE_CHARS = 2000;

// Anthropic rejects images whose base64 payload exceeds 5 MB. Base64 inflates
// raw bytes by ~33%, so the safe raw ceiling is ~3.75 MB. Subtract a small
// buffer to leave room for the JSON envelope around the payload.
export const MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 8 * 1024;

const SYSTEM_PROMPT = `You generate 3 YouTube search queries for a photo. Each query MUST target a different intent — the queries are not synonyms of each other.

1. Literal/descriptive: name what is visibly shown (subject, scene, object)
2. Instructional: how to do, make, learn, or fix what is shown
3. Broader topical: the wider domain, theme, history, or context

Each query: 3 to 7 words, plain language as a real YouTube user would type. No quotes, no "YouTube" in the query itself. Return them in the order above.`;

export type Flags = { noCache: boolean; showQueries: boolean; noEnrich: boolean };

export type TopComment = { text: string; author: string; likeCount: number };

export type Video = {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  publishedAt?: string;
  thumbnailUrl: string;
  embedUrl?: string;
  watchUrl?: string;
  description?: string;
  summary?: string;
  topComment?: TopComment;
};

export type TermGroup = { query: string; results: Video[]; error?: string };
type BulkResponse = { terms: TermGroup[] };

type CachedEnrichment = {
  savedAt: number;
  transcript: string;
  topComment?: TopComment;
  summary?: string;
};

export function parseArgs(argv: string[]): { photoPath: string; flags: Flags } {
  const flags: Flags = { noCache: false, showQueries: false, noEnrich: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === '--no-cache') flags.noCache = true;
    else if (a === '--show-queries') flags.showQueries = true;
    else if (a === '--no-enrich') flags.noEnrich = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: find-vids <photo> [--no-cache] [--show-queries] [--no-enrich]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error('Usage: find-vids <photo> [--no-cache] [--show-queries] [--no-enrich]');
    process.exit(1);
  }
  return { photoPath: positional[0], flags };
}

export async function downscaleToFit(bytes: Buffer, ext: string): Promise<Buffer> {
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

export async function loadAndValidatePhoto(photoPath: string): Promise<{ bytes: Buffer; ext: string; mime: string }> {
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
  if (ext === '.gif') {
    // GIFs may be animated; pass through so we don't flatten frames.
  } else if (bytes.length > MAX_RAW_BYTES) {
    bytes = await downscaleToFit(bytes, ext);
  } else {
    // Normalize EXIF orientation for all under-limit inputs too — otherwise
    // portrait iPhone JPEGs under the size cap arrive sideways when the API
    // doesn't honor EXIF.
    bytes = await sharp(bytes).rotate().toBuffer();
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

async function fetchTranscript(cli: string, videoId: string): Promise<string> {
  try {
    const { stdout } = await execFile(cli, ['youtube', 'videos-transcript', videoId, '--agent'], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    });
    const parsed = JSON.parse(stdout) as { text?: string };
    return (parsed.text ?? '').slice(0, TRANSCRIPT_TRUNCATE_CHARS);
  } catch {
    // No captions, private video, or transient error — graceful empty.
    return '';
  }
}

async function fetchTopComment(cli: string, videoId: string): Promise<TopComment | undefined> {
  try {
    const { stdout } = await execFile(cli, ['youtube', 'videos-comments', videoId, '--top', '1', '--agent'], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000,
    });
    const parsed = JSON.parse(stdout) as { comments?: Array<{ text?: string; author?: string; likeCount?: number }> };
    const c = parsed.comments?.[0];
    if (!c || !c.text) return undefined;
    return { text: c.text, author: c.author ?? '', likeCount: c.likeCount ?? 0 };
  } catch {
    return undefined;
  }
}

async function summarizeTranscripts(
  videos: Array<{ videoId: string; title: string; transcript: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (videos.length === 0) return out;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY missing; skipping transcript summaries.');
    return out;
  }

  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: z.object({
      summaries: z.array(
        z.object({
          videoId: z.string(),
          summary: z.string().min(1).describe('One sentence, max 25 words, grounded strictly in the transcript.'),
        }),
      ),
    }),
    system:
      'For each video, write ONE sentence (max 25 words) describing what the video actually delivers, grounded strictly in the transcript. ' +
      'Avoid clickbait phrasing and the channel name. If the transcript is too sparse to summarize, return the literal string "Transcript too sparse to summarize."',
    messages: [
      {
        role: 'user',
        content: 'Summarize each of these videos:\n\n' + JSON.stringify(videos, null, 2),
      },
    ],
  });

  for (const s of object.summaries) {
    // Drop the "sparse transcript" sentinel so the renderer omits the summary
    // block entirely rather than displaying an apology line.
    if (s.summary.trim().toLowerCase().startsWith('transcript too sparse')) continue;
    out.set(s.videoId, s.summary);
  }
  return out;
}

export async function enrichVideos(terms: TermGroup[], opts: { noCache: boolean } = { noCache: false }): Promise<TermGroup[]> {
  const cli = process.env.YOUTUBE_PP_CLI || 'youtube-pp-cli';
  const cacheDir = join('.cache', 'enrich');
  await fs.mkdir(cacheDir, { recursive: true });

  const allVideos: Video[] = terms.flatMap((t) => (t.error ? [] : t.results));
  if (allVideos.length === 0) return terms;

  // Phase 1: hydrate transcript + top-comment per video (cache or fetch in parallel).
  const enrichments = await Promise.all(
    allVideos.map(async (v): Promise<CachedEnrichment & { videoId: string }> => {
      const cacheFile = join(cacheDir, `${v.videoId}.json`);
      if (!opts.noCache) {
        try {
          const raw = await fs.readFile(cacheFile, 'utf-8');
          const cached = JSON.parse(raw) as CachedEnrichment;
          if (Date.now() - cached.savedAt < ENRICH_CACHE_TTL_MS) {
            // Migrate older cache entries that stored the "too sparse"
            // sentinel as a literal summary.
            if (cached.summary && cached.summary.trim().toLowerCase().startsWith('transcript too sparse')) {
              cached.summary = undefined;
            }
            return { videoId: v.videoId, ...cached };
          }
        } catch { /* miss */ }
      }
      const [transcript, topComment] = await Promise.all([
        fetchTranscript(cli, v.videoId),
        fetchTopComment(cli, v.videoId),
      ]);
      const entry: CachedEnrichment = { savedAt: Date.now(), transcript, topComment };
      await fs.writeFile(cacheFile, JSON.stringify(entry, null, 2));
      return { videoId: v.videoId, ...entry };
    }),
  );

  // Phase 2: batch-summarize videos that have a transcript but no cached summary.
  const titleById = new Map(allVideos.map((v) => [v.videoId, v.title]));
  const needSummary = enrichments.filter((e) => !e.summary && e.transcript.length > 0);
  if (needSummary.length > 0) {
    const summaries = await summarizeTranscripts(
      needSummary.map((e) => ({
        videoId: e.videoId,
        title: titleById.get(e.videoId) ?? '',
        transcript: e.transcript,
      })),
    );
    for (const e of enrichments) {
      const s = summaries.get(e.videoId);
      if (!s) continue;
      e.summary = s;
      const cacheFile = join(cacheDir, `${e.videoId}.json`);
      const toWrite: CachedEnrichment = {
        savedAt: e.savedAt,
        transcript: e.transcript,
        topComment: e.topComment,
        summary: e.summary,
      };
      await fs.writeFile(cacheFile, JSON.stringify(toWrite, null, 2));
    }
  }

  // Phase 3: attach enrichment back onto each Video.
  const byId = new Map(enrichments.map((e) => [e.videoId, e]));
  return terms.map((t) => ({
    ...t,
    results: t.results.map((v) => {
      const e = byId.get(v.videoId);
      if (!e) return v;
      return { ...v, summary: e.summary, topComment: e.topComment };
    }),
  }));
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHTML(photoDataUrl: string, terms: TermGroup[]): string {
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
          const summaryBlock = v.summary
            ? `\n          <p class="text-xs text-zinc-300 mt-2 italic line-clamp-3">${esc(v.summary)}</p>`
            : '';
          const commentBlock = v.topComment
            ? `\n          <div class="mt-2 pt-2 border-t border-zinc-800">
            <p class="text-[10px] text-zinc-500 uppercase tracking-wide">▲ ${v.topComment.likeCount} · ${esc(v.topComment.author)}</p>
            <p class="text-xs text-zinc-400 line-clamp-2 mt-0.5">${esc(v.topComment.text)}</p>
          </div>`
            : '';
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
          <p class="text-xs text-zinc-400 mt-1">${esc(v.channelTitle)}</p>${summaryBlock}${commentBlock}
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
    .line-clamp-3 { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
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

export function resolveOpenCommand(platform: NodeJS.Platform, path: string): string[] | null {
  if (platform === 'darwin') return ['open', path];
  if (platform === 'linux') return ['xdg-open', path];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', path];
  return null;
}

function openInBrowser(path: string): void {
  const cmd = resolveOpenCommand(process.platform, path);
  if (!cmd) {
    console.error(`Auto-open not supported on ${process.platform}. Open ${path} manually.`);
    return;
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
  if (r.error) {
    console.error(`Could not auto-open (${r.error.message}). Open ${path} manually.`);
  }
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

  let terms = searchYouTube(queries);

  if (!flags.noEnrich) {
    terms = await enrichVideos(terms, { noCache: flags.noCache });
  }

  const photoDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  const html = renderHTML(photoDataUrl, terms);

  await fs.mkdir('out', { recursive: true });
  const outFile = join('out', `${nowStamp()}-pictovideo.html`);
  await fs.writeFile(outFile, html);

  const latest = join('out', 'latest.html');
  try { await fs.unlink(latest); } catch { /* ok if missing */ }
  await fs.symlink(basename(outFile), latest);

  openInBrowser(latest);
  console.error(`Wrote ${outFile}`);
}

// Only run main() when invoked as a script — not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
