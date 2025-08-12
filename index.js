#!/usr/bin/env node
/**
 * Broddy v2
 * Enhanced SPA/static site copier with complete asset capture and source map support
 * usage: npx broddy <url> [--sourcemaps] [output-folder]
 */

import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { URL } from 'url';
import { load } from 'cheerio';

const args = process.argv.slice(2);
const baseUrl = args.find(a => !a.startsWith('--'));
const enableSourceMaps = args.includes('--sourcemaps');

if (!baseUrl) {
    console.error('usage: broddy <url> [--sourcemaps] [output-folder]');
    console.error('  --sourcemaps  Download and apply source maps when available');
    process.exit(1);
}

let outDir = 'mirror';
let pages = [];
const remaining = args.filter(a => a !== baseUrl && !a.startsWith('--'));
if (remaining.length && !remaining.at(-1).startsWith('/')) outDir = remaining.pop();
if (remaining.length) pages = remaining;
else pages = await crawlRoot(baseUrl);

await broddy(baseUrl, pages, outDir, enableSourceMaps);

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

async function broddy(baseUrl, pages, outDir, enableSourceMaps) {
    const ASSETS_DIR = path.join(outDir, 'assets');
    await fs.mkdir(ASSETS_DIR, { recursive: true });

    const assetUrls = new Map(); // url -> type
    const processedAssets = new Set();
    const sourceMapUrls = new Map(); // original file -> source map url
    
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

    // Enhanced regex patterns for better capture
    const PATTERNS = {
        // Dynamic imports, webpack chunks, lazy loading, etc.
        JS_IMPORTS: [
            /import\s*\(\s*[`'"]([^`"']+?)[`"']\s*\)/g,
            /import\s+.*?\s+from\s+[`'"]([^`"']+?)[`"']/g,
            /require\s*\(\s*[`'"]([^`"']+?)[`"']\s*\)/g,
            /new\s+URL\s*\(\s*[`'"]([^`"']+?)[`"']/g,
            /__webpack_require__\.p\s*\+\s*[`'"]([^`"']+?)[`"']/g,
            /__webpack_public_path__\s*\+\s*[`'"]([^`"']+?)[`"']/g,
            /__framer__url\s*[`'"]([^`"']+?)[`"']/g,
            /fetch\s*\(\s*[`'"]([^`"']+?)[`"']\s*\)/g,
            /loadScript\s*\(\s*[`'"]([^`"']+?)[`"']\s*\)/g,
            /\.lazy\s*\(\s*\(\)\s*=>\s*import\s*\(\s*[`'"]([^`"']+?)[`"']\s*\)/g,
            /chunk:\s*[`'"]([^`"']+?)[`"']/g,
            /src:\s*[`'"]([^`"']+?)[`"']/g,
            /href:\s*[`'"]([^`"']+?)[`"']/g,
            /url:\s*[`'"]([^`"']+?)[`"']/g,
        ],
        // CSS URLs including data URIs exclusion
        CSS_URLS: [
            /url\s*\(\s*(['"]?)([^)]+?)\1\s*\)/g,
            /@import\s+(?:url\s*\(\s*)?['"]([^'"]+?)['"](?:\s*\))?/g,
            /src:\s*url\s*\(\s*(['"]?)([^)]+?)\1\s*\)/g,
        ],
        // Source map patterns
        SOURCE_MAP: [
            /\/\/[#@]\s*sourceMappingURL=([^\s]+)/,
            /\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//,
        ],
        // JSON config files that might contain asset URLs
        JSON_ASSETS: [
            /"(?:src|href|url|image|icon|logo|poster|thumbnail)"\s*:\s*"([^"]+?)"/g,
        ]
    };

    // Extract assets from code
    const extractAssets = (code, type, baseUrl) => {
        const found = new Set();
        
        if (type === 'js' || type === 'mjs') {
            PATTERNS.JS_IMPORTS.forEach(pattern => {
                const matches = [...code.matchAll(pattern)];
                matches.forEach(match => {
                    const url = match[1];
                    if (url && (url.startsWith('http') || url.startsWith('//'))) {
                        found.add(url.startsWith('//') ? `https:${url}` : url);
                    } else if (url && !url.startsWith('data:') && !url.startsWith('#')) {
                        try {
                            const resolved = new URL(url, baseUrl).href;
                            found.add(resolved);
                        } catch { /* ignore */ }
                    }
                });
            });
            
            // Check for source maps
            if (enableSourceMaps) {
                PATTERNS.SOURCE_MAP.forEach(pattern => {
                    const match = code.match(pattern);
                    if (match && match[1]) {
                        const mapUrl = match[1];
                        if (mapUrl.startsWith('http')) {
                            found.add(mapUrl);
                        } else {
                            try {
                                const resolved = new URL(mapUrl, baseUrl).href;
                                found.add(resolved);
                                sourceMapUrls.set(baseUrl, resolved);
                            } catch { /* ignore */ }
                        }
                    }
                });
            }
        }
        
        if (type === 'css') {
            PATTERNS.CSS_URLS.forEach(pattern => {
                const matches = [...code.matchAll(pattern)];
                matches.forEach(match => {
                    const url = match[2] || match[1];
                    if (url && !url.startsWith('data:') && !url.startsWith('#')) {
                        if (url.startsWith('http') || url.startsWith('//')) {
                            found.add(url.startsWith('//') ? `https:${url}` : url);
                        } else {
                            try {
                                const resolved = new URL(url, baseUrl).href;
                                found.add(resolved);
                            } catch { /* ignore */ }
                        }
                    }
                });
            });
        }
        
        if (type === 'json') {
            PATTERNS.JSON_ASSETS.forEach(pattern => {
                const matches = [...code.matchAll(pattern)];
                matches.forEach(match => {
                    const url = match[1];
                    if (url && url.startsWith('http')) {
                        found.add(url);
                    }
                });
            });
        }
        
        return found;
    };

    // Replace asset URLs in code
    const replaceAssetUrls = (code, type, assetMap) => {
        let result = code;
        
        if (type === 'js' || type === 'mjs') {
            PATTERNS.JS_IMPORTS.forEach(pattern => {
                result = result.replace(pattern, (match, url) => {
                    if (!url || url.startsWith('data:') || url.startsWith('#')) return match;
                    
                    let fullUrl;
                    if (url.startsWith('http') || url.startsWith('//')) {
                        fullUrl = url.startsWith('//') ? `https:${url}` : url;
                    } else {
                        try {
                            fullUrl = new URL(url, baseUrl).href;
                        } catch {
                            return match;
                        }
                    }
                    
                    if (assetMap.has(fullUrl)) {
                        return match.replace(url, `assets/${assetName(fullUrl)}`);
                    }
                    return match;
                });
            });
        }
        
        if (type === 'css') {
            PATTERNS.CSS_URLS.forEach(pattern => {
                result = result.replace(pattern, (match, quote, url) => {
                    const actualUrl = url || quote;
                    if (!actualUrl || actualUrl.startsWith('data:') || actualUrl.startsWith('#')) return match;
                    
                    let fullUrl;
                    if (actualUrl.startsWith('http') || actualUrl.startsWith('//')) {
                        fullUrl = actualUrl.startsWith('//') ? `https:${actualUrl}` : actualUrl;
                    } else {
                        try {
                            fullUrl = new URL(actualUrl, baseUrl).href;
                        } catch {
                            return match;
                        }
                    }
                    
                    if (assetMap.has(fullUrl)) {
                        if (url) {
                            return match.replace(url, `assets/${assetName(fullUrl)}`);
                        } else {
                            return match.replace(quote, `assets/${assetName(fullUrl)}`);
                        }
                    }
                    return match;
                });
            });
        }
        
        return result;
    };

    /* 1. Download pages */
    for (const page of pages) {
        const url = new URL(page, baseUrl).href;
        console.log('📄 Page:', url);
        const res = await fetch(url);
        const html = await res.text();
        const file = page === '/' ? 'index.html' : `${page.slice(1)}.html`;
        await save(file, html);
        console.log(`✅ ${file}`);
    }

    /* 2. Initial scan of HTML files for assets */
    const htmlFiles = await fs.readdir(outDir, { recursive: true })
        .then(list => list.filter(n => n.endsWith('.html'))
            .map(n => path.join(outDir, n)));

    for (const file of htmlFiles) {
        const html = await fs.readFile(file, 'utf8');
        const $ = load(html);
        
        // Collect all asset URLs from HTML
        $('link[href], script[src], img[src], source[src], video[src], audio[src], embed[src], object[data], iframe[src]').each((_, el) => {
            ['href', 'src', 'data'].forEach(attr => {
                const val = $(el).attr(attr);
                if (val && (val.startsWith('http') || val.startsWith('//'))) {
                    const url = val.startsWith('//') ? `https:${val}` : val;
                    const ext = path.extname(new URL(url).pathname).toLowerCase();
                    let type = 'other';
                    if (['.js', '.mjs'].includes(ext)) type = 'js';
                    else if (['.css'].includes(ext)) type = 'css';
                    else if (['.json'].includes(ext)) type = 'json';
                    assetUrls.set(url, type);
                }
            });
        });
        
        // Also check inline scripts for asset references
        $('script:not([src])').each((_, el) => {
            const scriptContent = $(el).html();
            if (scriptContent) {
                const found = extractAssets(scriptContent, 'js', baseUrl);
                found.forEach(url => assetUrls.set(url, 'js'));
            }
        });
        
        // Check inline styles
        $('style').each((_, el) => {
            const styleContent = $(el).html();
            if (styleContent) {
                const found = extractAssets(styleContent, 'css', baseUrl);
                found.forEach(url => assetUrls.set(url, 'css'));
            }
        });
    }

    /* 3. Recursively scan assets for more dependencies */
    console.log('🔍 Scanning for dependencies...');
    const toProcess = [...assetUrls.keys()];
    
    while (toProcess.length > 0) {
        const url = toProcess.shift();
        if (processedAssets.has(url)) continue;
        processedAssets.add(url);
        
        const type = assetUrls.get(url) || 'other';
        
        try {
            const content = await download(url);
            const text = content.toString('utf8');
            
            // Extract more assets from this file
            const found = extractAssets(text, type, url);
            for (const foundUrl of found) {
                if (!assetUrls.has(foundUrl) && !processedAssets.has(foundUrl)) {
                    const ext = path.extname(new URL(foundUrl).pathname).toLowerCase();
                    let foundType = 'other';
                    if (['.js', '.mjs'].includes(ext)) foundType = 'js';
                    else if (['.css'].includes(ext)) foundType = 'css';
                    else if (['.json'].includes(ext)) foundType = 'json';
                    
                    assetUrls.set(foundUrl, foundType);
                    toProcess.push(foundUrl);
                    console.log(`  → Found: ${foundUrl}`);
                }
            }
        } catch (e) {
            console.warn(`  ⚠️  Failed to scan ${url}: ${e.message}`);
        }
    }

    /* 4. Download all assets */
    console.log(`📦 Downloading ${assetUrls.size} assets...`);
    const downloadedAssets = new Map();
    
    for (const [url, type] of assetUrls) {
        try {
            const content = await download(url);
            const name = assetName(url);
            
            // If source maps are enabled and this is a JS file, check for source map
            if (enableSourceMaps && (type === 'js' || type === 'mjs')) {
                const text = content.toString('utf8');
                let processedContent = text;
                
                // Look for source map reference
                let sourceMapUrl = null;
                for (const pattern of PATTERNS.SOURCE_MAP) {
                    const match = text.match(pattern);
                    if (match && match[1]) {
                        const mapRef = match[1];
                        if (mapRef.startsWith('http')) {
                            sourceMapUrl = mapRef;
                        } else if (!mapRef.startsWith('data:')) {
                            sourceMapUrl = new URL(mapRef, url).href;
                        }
                        break;
                    }
                }
                
                if (sourceMapUrl && !sourceMapUrl.startsWith('data:')) {
                    console.log(`  📍 Found source map for ${name}: ${sourceMapUrl}`);
                    try {
                        const mapContent = await download(sourceMapUrl);
                        const mapData = JSON.parse(mapContent.toString('utf8'));
                        
                        // Save the source map
                        const mapName = `${name}.map`;
                        await fs.writeFile(path.join(ASSETS_DIR, mapName), mapContent);
                        
                        // Update the source map reference in the JS file
                        processedContent = processedContent.replace(
                            /\/\/[#@]\s*sourceMappingURL=[^\s]+/,
                            `//# sourceMappingURL=${mapName}`
                        ).replace(
                            /\/\*[#@]\s*sourceMappingURL=[^\s*]+\s*\*\//,
                            `/*# sourceMappingURL=${mapName} */`
                        );
                        
                        // If the source map contains embedded sources, we're done
                        // Otherwise, we could download the source files too (optional enhancement)
                        if (mapData.sources && mapData.sourcesContent) {
                            console.log(`    ✅ Source map includes ${mapData.sources.length} embedded sources`);
                        }
                        
                        downloadedAssets.set(url, Buffer.from(processedContent));
                    } catch (e) {
                        console.warn(`    ⚠️  Failed to process source map: ${e.message}`);
                        downloadedAssets.set(url, content);
                    }
                } else {
                    downloadedAssets.set(url, content);
                }
            } else {
                downloadedAssets.set(url, content);
            }
            
            console.log(`  ✅ ${name}`);
        } catch (e) {
            console.warn(`  ⚠️  Failed to download ${url}: ${e.message}`);
        }
    }

    /* 5. Save assets and update references in all files */
    for (const [url, content] of downloadedAssets) {
        await fs.writeFile(path.join(ASSETS_DIR, assetName(url)), content);
    }

    /* 6. Update all file references */
    console.log('🔄 Updating references...');
    const allFiles = await fs.readdir(outDir, { recursive: true })
        .then(list => list.filter(n => /\.(html|css|js|mjs|json)$/.test(n))
            .map(n => path.join(outDir, n)));

    for (const file of allFiles) {
        let code = await fs.readFile(file, 'utf8');
        const ext = path.extname(file).toLowerCase();
        let type = 'other';
        if (['.js', '.mjs'].includes(ext)) type = 'js';
        else if (['.css'].includes(ext)) type = 'css';
        else if (['.json'].includes(ext)) type = 'json';
        else if (['.html'].includes(ext)) type = 'html';
        
        const originalCode = code;
        
        if (type === 'html') {
            const $ = load(code);
            $('link[href], script[src], img[src], source[src], video[src], audio[src], embed[src], object[data], iframe[src]').each((_, el) => {
                ['href', 'src', 'data'].forEach(attr => {
                    const val = $(el).attr(attr);
                    if (val && (val.startsWith('http') || val.startsWith('//'))) {
                        const url = val.startsWith('//') ? `https:${val}` : val;
                        if (downloadedAssets.has(url)) {
                            $(el).attr(attr, `assets/${assetName(url)}`);
                        }
                    }
                });
            });
            
            // Update inline scripts
            $('script:not([src])').each((_, el) => {
                const scriptContent = $(el).html();
                if (scriptContent) {
                    const updated = replaceAssetUrls(scriptContent, 'js', downloadedAssets);
                    if (updated !== scriptContent) {
                        $(el).html(updated);
                    }
                }
            });
            
            // Update inline styles
            $('style').each((_, el) => {
                const styleContent = $(el).html();
                if (styleContent) {
                    const updated = replaceAssetUrls(styleContent, 'css', downloadedAssets);
                    if (updated !== styleContent) {
                        $(el).html(updated);
                    }
                }
            });
            
            code = $.html();
        } else {
            code = replaceAssetUrls(code, type, downloadedAssets);
        }
        
        if (code !== originalCode) {
            await fs.writeFile(file, code);
            console.log(`  ✏️  Updated ${path.basename(file)}`);
        }
    }

    console.log(`\n🎉 Done! Mirror saved to: ${path.resolve(outDir)}`);
    console.log(`📊 Stats: ${pages.length} pages, ${downloadedAssets.size} assets`);
    if (enableSourceMaps) {
        const sourceMapsFound = [...downloadedAssets.keys()].filter(url => url.endsWith('.map')).length;
        console.log(`🗺️  Source maps processed: ${sourceMapsFound}`);
    }
}