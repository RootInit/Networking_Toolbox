// Inlines every <script src> and <link rel="stylesheet"> from index.html into a single
// self-contained ../lib/Network_Visualizer.html - stylesheet url(...) refs become base64 data URIs -
// then strips comments and minifies each block with esbuild. A release ships Start-NetworkMapper.ps1
// plus lib/, never web-src/. Run `npm install` once, then `node tools/build-inline.mjs`.
//
// The output is checked in and nothing regenerates it: re-run and commit after touching index.html,
// *.js or leaflet.css.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const visualizerRoot = resolve(toolsDir, '..'); // tools/ -> web-src/
const htmlPath = process.argv[2] ? resolve(process.argv[2]) : join(visualizerRoot, 'index.html');
const buildDir = resolve(visualizerRoot, '..', 'lib'); // web-src/ -> PS_NetworkMapper/ -> lib/
const outPath = join(buildDir, 'Network_Visualizer.html');

if (!existsSync(htmlPath)) {
    console.error(`No such file: ${htmlPath}`);
    process.exit(1);
}

const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// Embeds a CSS file's url(...) references as base64 data URIs: leaflet.css's 3 background-image
// url()s would otherwise point at files that don't exist beside the single output file.
function inlineCssUrls(cssContent, cssDir) {
    return cssContent.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, ref) => {
        // Skips data URIs, absolute URLs and bare fragments (leaflet.css's IE-only url(#default#VML)).
        if (/^(data:|https?:|#)/i.test(ref)) return full;
        const filePath = resolve(cssDir, ref);
        if (!existsSync(filePath)) return full; // can't resolve - leave the reference as-is
        const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] || 'application/octet-stream';
        const b64 = readFileSync(filePath).toString('base64');
        return `url(data:${mime};base64,${b64})`;
    });
}

let html = readFileSync(htmlPath, 'utf8');

// Stripped before any tag parsing, so a doc-comment quoting "<script>" isn't misread as a tag.
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');

// Verify the strip didn't eat into a real <script>/<style> body. Checked on the STRIPPED text:
// pre-strip it would trip on prose inside a real comment, which stripping already resolves.
for (const m of stripped.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (m[2].includes('<!--') || m[2].includes('-->')) {
        console.error(`ERROR: a <${m[1]}> block in ${htmlPath} contains a literal "<!--" or "-->" that survived comment-stripping - either that block never should have had one, or the strip corrupted it. Investigate before trusting this build's output.`);
        process.exit(1);
    }
}
html = stripped;

// Not a full HTML parser: the input is one known hand-written file. Both patterns capture the FULL
// attribute string so every other attribute survives verbatim; matching is quote-agnostic.
const SCRIPT_TAG_RE = /<script\b([^>]*)>\s*<\/script>/gi;
const LINK_TAG_RE = /<link\b([^>]*)>/gi;

const ATTR_VALUE_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');

// Pulls an attribute's value out of a raw attribute string, honoring either quote style.
function getAttr(attrs, name) {
    const m = ATTR_VALUE_RE(name).exec(attrs);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2];
}

// Removes one attribute (any quote style), collapsing the leftover whitespace.
function removeAttr(attrs, name) {
    return attrs.replace(ATTR_VALUE_RE(name), '').replace(/\s+/g, ' ').trim();
}

let inlinedCount = 0;
const skipped = [];

function inlineLocalFile(src, wrap) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return null; // absolute URL - not a local file, leave untouched
    const filePath = resolve(dirname(htmlPath), src);
    if (!existsSync(filePath)) {
        // vendor/oui-data.js is the one script tolerated missing on a fresh checkout - dropping the tag
        // matches what a 404'd src already does. Any other missing file fails loudly at first use.
        skipped.push(src);
        return '';
    }
    inlinedCount++;
    return wrap(filePath);
}

let output = html.replace(SCRIPT_TAG_RE, (fullMatch, attrs) => {
    const src = getAttr(attrs, 'src');
    if (src === null) return fullMatch; // no src - e.g. an inline <script> block, untouched
    const restAttrs = removeAttr(attrs, 'src');
    const openTag = restAttrs ? `<script ${restAttrs}>` : '<script>';
    const result = inlineLocalFile(src, (filePath) => {
        // Left raw: escaping and minifying happen in one later pass, and escaping must be last or esbuild
        // can normalize the backslash away and reintroduce a literal "</script".
        const content = readFileSync(filePath, 'utf8');
        return `${openTag}\n${content}\n</script>`;
    });
    return result === null ? fullMatch : result;
});

output = output.replace(LINK_TAG_RE, (fullMatch, attrs) => {
    const rel = getAttr(attrs, 'rel');
    const href = getAttr(attrs, 'href');
    if (rel === null || rel.trim().toLowerCase() !== 'stylesheet' || href === null) return fullMatch;
    const restAttrs = removeAttr(removeAttr(attrs, 'href'), 'rel');
    const result = inlineLocalFile(href, (filePath) => {
        const content = inlineCssUrls(readFileSync(filePath, 'utf8'), dirname(filePath));
        // rel/href are dropped since a <style> element has no rel; any other attribute survives.
        const attrComment = restAttrs ? ` /* ${restAttrs} */` : '';
        return `<style>${attrComment}\n${content}\n</style>`;
    });
    return result === null ? fullMatch : result;
});

// Fail the build rather than ship a dangling local <script src>/<link href> the regexes missed.
const LEFTOVER_SCRIPT_RE = /<script\b([^>]*)>\s*<\/script>/gi;
const LEFTOVER_LINK_RE = /<link\b([^>]*)>/gi;
const unresolved = [];

for (const m of output.matchAll(LEFTOVER_SCRIPT_RE)) {
    const src = getAttr(m[1], 'src');
    if (src !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) unresolved.push(m[0]);
}
for (const m of output.matchAll(LEFTOVER_LINK_RE)) {
    const rel = getAttr(m[1], 'rel');
    const href = getAttr(m[1], 'href');
    if (rel !== null && rel.trim().toLowerCase() === 'stylesheet' && href !== null
        && !/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) unresolved.push(m[0]);
}

// Validate BEFORE writing: a failed build must leave the last-known-good artifact untouched.
// vendor/oui-data.js is the one tolerated absence (see inlineLocalFile).
const requiredSkipped = skipped.filter((src) => !src.endsWith('vendor/oui-data.js'));
if (requiredSkipped.length > 0) {
    console.error(`ERROR: ${requiredSkipped.length} required file(s) could not be inlined and are missing from ${outPath}: ${requiredSkipped.join(', ')}`);
    process.exit(1);
}

if (unresolved.length > 0) {
    console.error(`ERROR: ${unresolved.length} local script/stylesheet tag(s) survived inlining unresolved in ${outPath} (a pattern SCRIPT_TAG_RE/LINK_TAG_RE didn't recognize): ${unresolved.join(', ')}`);
    process.exit(1);
}

// Final pass over the assembled document, catching inlined files and this file's own blocks alike.
// Full-tag regexes, so a match can't start on a "<style"-shaped substring inside another body.
let minifiedScripts = 0;
let minifiedStyles = 0;

const MINIFIABLE_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

output = output.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (fullMatch, attrs, body) => {
    if (getAttr(attrs, 'src') !== null) return fullMatch; // absolute-URL passthrough - nothing to inline or minify
    if (!body.trim()) return fullMatch; // e.g. a leftover empty tag - nothing to minify
    const scriptType = (getAttr(attrs, 'type') || '').trim().toLowerCase();
    if (!MINIFIABLE_SCRIPT_TYPES.has(scriptType)) return fullMatch; // e.g. a JSON data island - not JS, leave untouched
    const { code } = esbuild.transformSync(body, { loader: 'js', minify: true });
    minifiedScripts++;
    // AFTER minifying: escaping earlier risks the minifier normalizing the escape away.
    const escaped = code.replace(/<\/script/gi, '<\\/script');
    return `<script${attrs}>${escaped}</script>`;
});

output = output.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (fullMatch, attrs, body) => {
    if (!body.trim()) return fullMatch;
    const { code } = esbuild.transformSync(body, { loader: 'css', minify: true });
    minifiedStyles++;
    return `<style${attrs}>${code}</style>`;
});

mkdirSync(buildDir, { recursive: true });
writeFileSync(outPath, output, 'utf8');

const outBytes = Buffer.byteLength(output, 'utf8');
console.log(`Inlined ${inlinedCount} file(s), minified ${minifiedScripts} script(s) and ${minifiedStyles} style block(s), into ${outPath} (${(outBytes / 1024).toFixed(0)} KiB)`);
if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} missing file(s) (tag dropped, same as a 404'd src/href today): ${skipped.join(', ')}`);
}
