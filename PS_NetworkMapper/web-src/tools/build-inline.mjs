// Inlines every <script src="..."> and <link rel="stylesheet"> in index.html into a
// single, genuinely self-contained ../lib/Network_Visualizer.html - no external .js/.css
// files, and no image files either (a stylesheet's own url(...) references are embedded as
// base64 data URIs) - then strips HTML/JS/CSS comments and minifies every script/style block
// with esbuild. For distributing/opening the visualizer as one file instead of the app's own
// multi-file layout, or for Start-NetworkMapper.ps1 to serve directly (see that script's own
// SingleFileVisualizer detection) - a release ships only Start-NetworkMapper.ps1 + lib/ (this
// output included), never web-src/. Not part of the app - run manually from this directory
// (one-time `npm install` first, to pull in the esbuild devDependency used for minifying):
//   npm install
//   node tools/build-inline.mjs
//
// Output is checked in (lib/ is NOT gitignored for this file) - unlike this repo's other
// generated artifacts (oui-data.js, Configuration.json.enc), the whole point of this one is
// to be grabbable straight from the repo (or copied on its own, with nothing else) without
// anyone needing to run Node first. Re-run this script and commit the result after any
// change to index.html, *.js, or vendor/leaflet/leaflet.css - nothing regenerates it
// automatically.

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

// Embeds a CSS file's own url(...) references (images, fonts) as base64 data URIs, so the
// <style> block this lands in has no external dependencies of its own either - inlining
// leaflet.css alone would still leave its 3 background-image url()s (zoom control icons,
// the default marker - unused by this app's own custom divIcons, but still CSS-referenced)
// pointing at files that don't exist once this is the only file left.
function inlineCssUrls(cssContent, cssDir) {
    return cssContent.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, ref) => {
        // Skips: already a data URI, an absolute http(s) URL, and a bare fragment reference
        // (leaflet.css has `behavior: url(#default#VML)`, an IE-only rule with no file at
        // all - not a relative path just because it isn't absolute).
        if (/^(data:|https?:|#)/i.test(ref)) return full;
        const filePath = resolve(cssDir, ref);
        if (!existsSync(filePath)) return full; // can't resolve - leave the reference as-is
        const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] || 'application/octet-stream';
        const b64 = readFileSync(filePath).toString('base64');
        return `url(data:${mime};base64,${b64})`;
    });
}

let html = readFileSync(htmlPath, 'utf8');

// Strip top-level HTML comments before any tag parsing below - also keeps a doc-comment that
// happens to mention "<style>" or "<script>" in prose (several of this file's own comments
// do, e.g. "before the <style> block below is even parsed") from being misread by
// SCRIPT_TAG_RE/LINK_TAG_RE, or by the minify pass's own tag scan further down, as the start
// of a real tag.
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');

// Verify the strip didn't corrupt a real <script>/<style> body before trusting its result: a
// genuine, unmatched "<!--" or "-->" inside actual code (as opposed to inside a real comment,
// which this same regex already removed above) survives stripping untouched, since a
// non-greedy /<!--[\s\S]*?-->/  only ever consumes matched pairs - so its presence here means
// stripping either ate into that code from an earlier real comment, or left a stray delimiter
// that would break isolated cases like it. Checked on the STRIPPED text, not the raw one:
// checking pre-strip would also trip on prose mentioning "<style>"/"<script>" inside a real
// comment (a false alarm on this file's own doc-comments), which stripping itself already
// resolves correctly - there's nothing to warn about once comments are actually gone.
for (const m of stripped.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (m[2].includes('<!--') || m[2].includes('-->')) {
        console.error(`ERROR: a <${m[1]}> block in ${htmlPath} contains a literal "<!--" or "-->" that survived comment-stripping - either that block never should have had one, or the strip corrupted it. Investigate before trusting this build's output.`);
        process.exit(1);
    }
}
html = stripped;

// Deliberately not a full HTML parser for either tag pattern below - the input is one known,
// hand-written file, not arbitrary HTML. Case-insensitive to tolerate <SCRIPT>/<LINK>, though
// nothing here actually uses that. Both patterns capture the FULL attribute string (not just
// src/href) so the replacement tag can preserve every other attribute (type="module", defer,
// async, crossorigin, media, ...) verbatim - only src/href is special because it becomes the
// inline content instead of staying an attribute. Attribute-value matching is quote-agnostic
// (single or double) since nothing here guarantees index.html only ever uses one style.
const SCRIPT_TAG_RE = /<script\b([^>]*)>\s*<\/script>/gi;
const LINK_TAG_RE = /<link\b([^>]*)>/gi;

const ATTR_VALUE_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');

// Pulls an attribute's value out of a raw attribute string, honoring either quote style.
function getAttr(attrs, name) {
    const m = ATTR_VALUE_RE(name).exec(attrs);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2];
}

// Removes one attribute (any quote style) from a raw attribute string, collapsing the
// leftover whitespace so the rebuilt tag doesn't end up with stray double spaces.
function removeAttr(attrs, name) {
    return attrs.replace(ATTR_VALUE_RE(name), '').replace(/\s+/g, ' ').trim();
}

let inlinedCount = 0;
const skipped = [];

function inlineLocalFile(src, wrap) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return null; // absolute URL - not a local file, leave untouched
    const filePath = resolve(dirname(htmlPath), src);
    if (!existsSync(filePath)) {
        // oui-data.js is the one script this app already tolerates being absent on a fresh
        // checkout (see network_vis.html's own comment on it, and utils.js's
        // window.lookupVendor typeof-guard) - dropping the tag here reproduces exactly what
        // already happens today when a browser requests a missing script src: nothing loads,
        // the rest of the app runs fine without it. Any OTHER missing file is still reported,
        // just the same way - this build has no separate "expected vs. surprising" list to
        // maintain, and a missing REQUIRED file will fail loudly the moment the inlined page
        // tries to call something that was never defined.
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
        // Left raw here (no </script escaping yet, no minifying yet) - both happen in one
        // unified pass over the whole assembled document further down, after every <script>
        // block (this file's own hand-written theme-stamp one included, not just files
        // inlined here) has been minified. Escaping must be the truly last step: minifying
        // already-escaped text risks esbuild normalizing away the escape's backslash and
        // reintroducing a literal "</script" that would prematurely close the tag.
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
        // rel="stylesheet" is dropped along with href since a <style> element has no rel
        // attribute; any other attribute the original <link> carried (media, etc.) survives.
        const attrComment = restAttrs ? ` /* ${restAttrs} */` : '';
        return `<style>${attrComment}\n${content}\n</style>`;
    });
    return result === null ? fullMatch : result;
});

// Safety net: rather than trust SCRIPT_TAG_RE/LINK_TAG_RE to anticipate every
// future tag shape, scan the OUTPUT for any <script src=...> or stylesheet <link href=...>
// that is still present verbatim - i.e. the regexes above didn't recognize and replace it -
// and treat that as a build failure exactly like a required-but-missing file, rather than
// silently shipping a single-file artifact with a dangling reference to a file that won't be
// there. Quote-agnostic and attribute-order-agnostic, same as the main patterns.
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

// Validate BEFORE writing anything: a failed build must leave whatever last-known-good
// artifact is already at outPath untouched rather than clobbering it with a broken or
// partial one.

// vendor/oui-data.js is the one file this build tolerates being absent (see the comment in
// inlineLocalFile above); any other missing referenced file means the build produced a
// broken artifact and must not be reported as a success.
const requiredSkipped = skipped.filter((src) => !src.endsWith('vendor/oui-data.js'));
if (requiredSkipped.length > 0) {
    console.error(`ERROR: ${requiredSkipped.length} required file(s) could not be inlined and are missing from ${outPath}: ${requiredSkipped.join(', ')}`);
    process.exit(1);
}

if (unresolved.length > 0) {
    console.error(`ERROR: ${unresolved.length} local script/stylesheet tag(s) survived inlining unresolved in ${outPath} (a pattern SCRIPT_TAG_RE/LINK_TAG_RE didn't recognize): ${unresolved.join(', ')}`);
    process.exit(1);
}

// Strip comments and minify every <script>/<style> block in one final pass over the fully
// assembled document - this catches both files inlined above AND this file's own two
// hand-written blocks (the theme-stamp <script>, the leaflet-override <style>), which never
// went through inlineLocalFile at all. Full-tag (open+body+close) regexes, not open-tag-only
// scans, so a match can't start on a "<style"/"<script"-shaped substring stranded inside
// another block's already-matched body.
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
    // Applied here, AFTER minifying, not before: see the comment at this content's inlining
    // site on why escaping any earlier would risk the minifier normalizing the escape away.
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
