// Inlines every <script src="..."> in network_vis.html into a single self-contained
// build/network_vis.inline.html, for distributing/opening the visualizer as one file instead
// of the app's own multi-file layout (network_vis.html is already classic-script/file://-safe
// on its own - see its header comment - this is for the "hand someone one file" case, not a
// requirement for normal use). Not part of the app - run manually from this directory:
//   node src/tools/build-inline.mjs
//
// JS only, matching what was asked for - the one external, non-JS asset
// (src/vendor/leaflet/leaflet.css, plus the marker-icon images it references) is left as a
// normal <link>, so the output isn't a fully dependency-free single file, only JS-free of
// external files.
//
// Output is checked in (build/ is NOT gitignored) - unlike this repo's other generated
// artifacts (oui-data.js, Configuration.json.enc), the whole point of this one is to be
// grabbable straight from the repo without anyone needing to run Node first. Re-run this
// script and commit the result after any change to network_vis.html or src/*.js - nothing
// regenerates it automatically.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const visualizerRoot = resolve(toolsDir, '..', '..'); // src/tools/ -> src/ -> Network_Visualizer/
const htmlPath = process.argv[2] ? resolve(process.argv[2]) : join(visualizerRoot, 'network_vis.html');
const buildDir = join(dirname(htmlPath), 'build');
const outPath = join(buildDir, 'network_vis.inline.html');

if (!existsSync(htmlPath)) {
    console.error(`No such file: ${htmlPath}`);
    process.exit(1);
}

const html = readFileSync(htmlPath, 'utf8');

// Matches this file's own <script ... src="...">...</script> tags (always written as an
// explicit open/close pair here, never self-closing) - deliberately not a full HTML parser,
// since the input is one known, hand-written file, not arbitrary HTML. Case-insensitive to
// tolerate <SCRIPT>, though nothing here actually uses that.
const SCRIPT_TAG_RE = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>\s*<\/script>/gi;

let inlinedCount = 0;
const skipped = [];

const output = html.replace(SCRIPT_TAG_RE, (fullMatch, src) => {
    // Only local relative paths get inlined - an absolute http(s):// src (none exist in this
    // file today, but the regex doesn't know that) is left untouched rather than treated as a
    // local file path.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return fullMatch;

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

    let content = readFileSync(filePath, 'utf8');
    // Defends against a literal "</script" sequence anywhere in the source (a string, a
    // comment, a regex) prematurely closing the HTML <script> element - the HTML tokenizer
    // matches that byte sequence regardless of JS syntax. "\/" is always just "/" to the JS
    // parser (in a string or regex; harmless as inert text inside a comment too), so this
    // never changes what the inlined script actually does.
    content = content.replace(/<\/script/gi, '<\\/script');

    inlinedCount++;
    return `<script>\n${content}\n</script>`;
});

mkdirSync(buildDir, { recursive: true });
writeFileSync(outPath, output, 'utf8');

console.log(`Inlined ${inlinedCount} script(s) into ${outPath}`);
if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} missing file(s) (tag dropped, same as a 404'd <script src> today): ${skipped.join(', ')}`);
}
