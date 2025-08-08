#!/usr/bin/env node
/**
 * Broddy v1
 * copy any SPA or static sites
 * usage: npx broddy <url> [output-folder]
 */

import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { URL } from 'url';
import { load } from 'cheerio';

const [, , baseUrl, ...rest] = process.argv;
if (!baseUrl) {
    console.error('usage: broddy <url> [output-folder]');
    process.exit(1);
}

let outDir = 'mirror';
let pages = [];
if (rest.length && !rest.at(-1).startsWith('/')) outDir = rest.pop();
if (rest.length) pages = rest;
else pages = await crawlRoot(baseUrl);

await broddy(baseUrl, pages, outDir);

/* ---------- helpers ---------- */
async function crawlRoot(base) {
    const root = new URL('/', base).href;
    const html = await fetch(root).then(r => r.text());
    const $ = load(html);
    const set = new Set(['/']);
    $('a[href]').each((_, el) => {
        try {
            const u = new URL($(el).attr('href'), base);
            if (u.origin === new URL(base).origin) set.add(u.pathname);
        } catch { /* ignore */ }
    });
    return [...set];
}

async function broddy(baseUrl, pages, outDir) {
    const ASSETS_DIR = path.join(outDir, 'assets');
    await fs.mkdir(ASSETS_DIR, { recursive: true });

    const assetUrls = new Set();
    const save = async (p, data) => {
        const filePath = path.join(outDir, p);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        return fs.writeFile(filePath, data);
    };
    const download = async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return Buffer.from(await res.arrayBuffer());
    };
    const assetName = (url) => {
        const { pathname, search } = new URL(url, baseUrl);
        const base = path.basename(pathname) || 'unnamed';
        return search ? `${base}${Buffer.from(search).toString('base64url')}` : base;
    };

    /* 1. pages */
    for (const page of pages) {
        const url = new URL(page, baseUrl).href;
        console.log('Get:', url);
        const res = await fetch(url);
        const html = await res.text();
        const file = page === '/' ? 'index.html' : `${page.slice(1)}.html`;
        await save(file, html);
        console.log(`✅ ${file}`);
    }

    /* 2. deep scan every file */
    const files = await fs.readdir(outDir, { recursive: true })
        .then(list => list.filter(n => /\.(html|css|js|mjs)$/.test(n))
            .map(n => path.join(outDir, n)));

    const JS_REGEX = /(?:import\(|new\s+URL\(|__webpack_require__\.p\s*\+|__framer__url)\s*[`'"]([^`"']+?)[`"']/g;
    const CSS_REGEX = /url\((['"]?)([^)]+)\1\)/g;

    for (const file of files) {
        let code = await fs.readFile(file, 'utf8');
        let changed = false;

        code = code.replace(JS_REGEX, (m, raw) => {
            if (!raw.startsWith('http')) return m;
            const url = new URL(raw, baseUrl).href;
            assetUrls.add(url);
            return m.replace(raw, `assets/${assetName(url)}`);
        });

        code = code.replace(CSS_REGEX, (_, _q, raw) => {
            if (!raw.startsWith('http')) return _;
            const url = new URL(raw, baseUrl).href;
            assetUrls.add(url);
            return `url(assets/${assetName(url)})`;
        });

        if (file.endsWith('.html')) {
            const $ = load(code);
            $('link[href], script[src], img[src]').each((_, el) => {
                ['href', 'src'].forEach(attr => {
                    const val = $(el).attr(attr);
                    if (!val || !val.startsWith('http')) return;
                    assetUrls.add(val);
                    $(el).attr(attr, `assets/${assetName(val)}`);
                });
            });
            code = $.html();
        }

        if (code !== (await fs.readFile(file, 'utf8'))) await fs.writeFile(file, code);
    }

    /* 3. assets */
    console.log(`📦 ${assetUrls.size} assets`);
    await Promise.all([...assetUrls].map(async url => {
        try {
            await fs.writeFile(path.join(ASSETS_DIR, assetName(url)), await download(url));
        } catch (e) {
            console.warn(`⚠️  ${e.message}`);
        }
    }));

    console.log(`🎉 Done → ${path.resolve(outDir)}`);
}