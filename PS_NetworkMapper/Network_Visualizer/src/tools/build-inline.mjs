// Inlines every <script src="..."> and <link rel="stylesheet"> in network_vis.html into a
// single, genuinely self-contained build/Network_Visualizer.html - no external .js/.css
// files, and no image files either (a stylesheet's own url(...) references are embedded as
// base64 data URIs). For distributing/opening the visualizer as one file instead of the
// app's own multi-file layout, or for Start-NetworkMapper.ps1 to serve directly when this
// file sits next to it (see that script's own SingleFileVisualizer detection). Not part of
// the app - run manually from this directory:
//   node src/tools/build-inline.mjs
//
// Output is checked in (build/ is NOT gitignored) - unlike this repo's other generated
// artifacts (oui-data.js, Configuration.json.enc), the whole point of this one is to be
// grabbable straight from the repo (or copied on its own, with nothing else) without anyone
// needing to run Node first. Re-run this script and commit the result after any change to
// network_vis.html, src/*.js, or src/vendor/leaflet/leaflet.css - nothing regenerates it
// automatically.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const visualizerRoot = resolve(toolsDir, '..', '..'); // src/tools/ -> src/ -> Network_Visualizer/
const htmlPath = process.argv[2] ? resolve(process.argv[2]) : join(visualizerRoot, 'network_vis.html');
const buildDir = join(dirname(htmlPath), 'build');
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

const html = readFileSync(htmlPath, 'utf8');

// Deliberately not a full HTML parser for either tag pattern below - the input is one known,
// hand-written file, not arbitrary HTML. Case-insensitive to tolerate <SCRIPT>/<LINK>, though
// nothing here actually uses that.
const SCRIPT_TAG_RE = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>\s*<\/script>/gi;
// Matches rel/href in either attribute order (network_vis.html only ever writes rel first,
// but the source order isn't this build's concern to assume).
const LINK_TAG_RE = /<link\b[^>]*\brel\s*=\s*"stylesheet"[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>|<link\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*\brel\s*=\s*"stylesheet"[^>]*>/gi;

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

let output = html.replace(SCRIPT_TAG_RE, (fullMatch, src) => {
    const result = inlineLocalFile(src, (filePath) => {
        let content = readFileSync(filePath, 'utf8');
        // Defends against a literal "</script" sequence anywhere in the source (a string, a
        // comment, a regex) prematurely closing the HTML <script> element - the HTML
        // tokenizer matches that byte sequence regardless of JS syntax. "\/" is always just
        // "/" to the JS parser (in a string or regex; harmless as inert text inside a comment
        // too), so this never changes what the inlined script actually does.
        content = content.replace(/<\/script/gi, '<\\/script');
        return `<script>\n${content}\n</script>`;
    });
    return result === null ? fullMatch : result;
});

output = output.replace(LINK_TAG_RE, (fullMatch, hrefA, hrefB) => {
    const src = hrefA || hrefB;
    const result = inlineLocalFile(src, (filePath) => {
        const content = inlineCssUrls(readFileSync(filePath, 'utf8'), dirname(filePath));
        return `<style>\n${content}\n</style>`;
    });
    return result === null ? fullMatch : result;
});

mkdirSync(buildDir, { recursive: true });
writeFileSync(outPath, output, 'utf8');

console.log(`Inlined ${inlinedCount} file(s) into ${outPath}`);
if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} missing file(s) (tag dropped, same as a 404'd src/href today): ${skipped.join(', ')}`);
}
