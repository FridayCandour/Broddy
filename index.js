#!/usr/bin/env node
/**
 * Broddy v2
 * Enhanced SPA/static site copier with complete asset capture and source map support
 * usage: npx broddy <url> [--sourcemaps] [output-folder]
 */

import { promises as fs } from "fs";
import path from "path";
import fetch from "node-fetch";
import { URL } from "url";
import { load } from "cheerio";

const args = process.argv.slice(2);
const baseUrl = args.find((a) => !a.startsWith("--"));
const enableSourceMaps = args.includes("--sourcemaps");

if (!baseUrl) {
  console.error("usage: broddy <url> [--sourcemaps] [output-folder]");
  console.error(
    "  --sourcemaps  Download and apply source maps when available"
  );
  process.exit(1);
}

let outDir = "mirror";
let pages = [];
const remaining = args.filter((a) => a !== baseUrl && !a.startsWith("--"));
if (remaining.length && !remaining.at(-1).startsWith("/"))
  outDir = remaining.pop();
if (remaining.length) pages = remaining;
else pages = await crawlRoot(baseUrl);

await broddy(baseUrl, pages, outDir, enableSourceMaps);

/* ---------- helpers ---------- */
async function crawlRoot(base) {
  const root = new URL("/", base).href;
  const html = await fetch(root).then((r) => r.text());
  const $ = load(html);
  const set = new Set(["/"]);
  $("a[href]").each((_, el) => {
    try {
      const u = new URL($(el).attr("href"), base);
      if (u.origin === new URL(base).origin) set.add(u.pathname);
    } catch {
      /* ignore */
    }
  });
  return [...set];
}

async function broddy(baseUrl, pages, outDir, enableSourceMaps) {
  await fs.mkdir(outDir, { recursive: true });

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

  const assetPath = (url) => {
    const { pathname, search } = new URL(url, baseUrl);
    let filePath = pathname;

    if (search) {
      // For URLs with query strings, append a hash to the filename
      let hash = 0;
      for (let i = 0; i < search.length; i++) {
        const char = search.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
      }
      const ext = path.extname(filePath);
      if (ext) {
        const nameWithoutExt = filePath.slice(0, -ext.length);
        filePath = `${nameWithoutExt}-${Math.abs(hash).toString(36)}${ext}`;
      } else {
        filePath = `${filePath}-${Math.abs(hash).toString(36)}`;
      }
    }

    return filePath;
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
    ],
  };

  // Extract assets from code
  const extractAssets = (code, type, baseUrl) => {
    const found = new Set();

    if (type === "js" || type === "mjs") {
      PATTERNS.JS_IMPORTS.forEach((pattern) => {
        const matches = [...code.matchAll(pattern)];
        matches.forEach((match) => {
          const url = match[1];
          if (url && (url.startsWith("http") || url.startsWith("//"))) {
            found.add(url.startsWith("//") ? `https:${url}` : url);
          } else if (url && !url.startsWith("data:") && !url.startsWith("#")) {
            // Only resolve if it looks like a real path (has / or . or common extensions)
            if (/^[./]|\.js|\.mjs|\.css|\.json|\.wasm|\.map/.test(url)) {
              try {
                const resolved = new URL(url, baseUrl).href;
                found.add(resolved);
              } catch {
                /* ignore */
              }
            }
          }
        });
      });

      // Check for source maps
      if (enableSourceMaps) {
        PATTERNS.SOURCE_MAP.forEach((pattern) => {
          const match = code.match(pattern);
          if (match && match[1]) {
            const mapUrl = match[1];
            if (mapUrl.startsWith("http")) {
              found.add(mapUrl);
            } else {
              try {
                const resolved = new URL(mapUrl, baseUrl).href;
                found.add(resolved);
                sourceMapUrls.set(baseUrl, resolved);
              } catch {
                /* ignore */
              }
            }
          }
        });
      }
    }

    if (type === "css") {
      PATTERNS.CSS_URLS.forEach((pattern) => {
        const matches = [...code.matchAll(pattern)];
        matches.forEach((match) => {
          const url = match[2] || match[1];
          if (url && !url.startsWith("data:") && !url.startsWith("#")) {
            if (url.startsWith("http") || url.startsWith("//")) {
              found.add(url.startsWith("//") ? `https:${url}` : url);
            } else {
              try {
                const resolved = new URL(url, baseUrl).href;
                found.add(resolved);
              } catch {
                /* ignore */
              }
            }
          }
        });
      });
    }

    if (type === "json") {
      PATTERNS.JSON_ASSETS.forEach((pattern) => {
        const matches = [...code.matchAll(pattern)];
        matches.forEach((match) => {
          const url = match[1];
          if (url && url.startsWith("http")) {
            found.add(url);
          }
        });
      });
    }

    return found;
  };

  // No URL rewriting needed - assets are stored at their original paths

  /* 1. Download pages */
  for (const page of pages) {
    const url = new URL(page, baseUrl).href;
    console.log("📄 Page:", url);
    const res = await fetch(url);
    const html = await res.text();
    const file = page === "/" ? "index.html" : `${page.slice(1)}.html`;
    await save(file, html);
    console.log(`✅ ${file}`);
  }

  /* 2. Initial scan of HTML files for assets */
  const htmlFiles = await fs
    .readdir(outDir, { recursive: true })
    .then((list) =>
      list.filter((n) => n.endsWith(".html")).map((n) => path.join(outDir, n))
    );

  for (const file of htmlFiles) {
    const html = await fs.readFile(file, "utf8");
    const $ = load(html);

    // Collect all asset URLs from HTML
    $(
      "link[href], script[src], img[src], source[src], video[src], audio[src], embed[src], object[data], iframe[src]"
    ).each((_, el) => {
      ["href", "src", "data"].forEach((attr) => {
        const val = $(el).attr(attr);
        if (val && !val.startsWith("data:") && !val.startsWith("#")) {
          let url;
          try {
            if (val.startsWith("http")) {
              url = val;
            } else if (val.startsWith("//")) {
              url = `https:${val}`;
            } else if (val.startsWith("/")) {
              // Relative URL from root
              url = new URL(val, baseUrl).href;
            } else {
              // Relative URL from current page
              url = new URL(val, baseUrl).href;
            }

            const ext = path.extname(new URL(url).pathname).toLowerCase();
            let type = "other";
            if ([".js", ".mjs"].includes(ext)) type = "js";
            else if ([".css"].includes(ext)) type = "css";
            else if ([".json"].includes(ext)) type = "json";
            assetUrls.set(url, type);
          } catch {
            // Ignore invalid URLs
          }
        }
      });
    });

    // Also check inline scripts for asset references
    $("script:not([src])").each((_, el) => {
      const scriptContent = $(el).html();
      if (scriptContent) {
        const found = extractAssets(scriptContent, "js", baseUrl);
        found.forEach((url) => assetUrls.set(url, "js"));
      }
    });

    // Check inline styles
    $("style").each((_, el) => {
      const styleContent = $(el).html();
      if (styleContent) {
        const found = extractAssets(styleContent, "css", baseUrl);
        found.forEach((url) => assetUrls.set(url, "css"));
      }
    });

    // Extract URLs from all data attributes (for tracking pixels, beacons, etc.)
    $("*").each((_, el) => {
      const attrs = el.attribs || {};
      Object.values(attrs).forEach((val) => {
        if (typeof val === "string") {
          // Look for URLs in data attributes
          const urlMatches = val.match(/https?:\/\/[^\s"'<>{}|\\^`\]]+/g);
          if (urlMatches) {
            urlMatches.forEach((url) => {
              try {
                const cleanUrl = url.replace(/[,;]$/, ""); // Remove trailing punctuation
                new URL(cleanUrl); // Validate
                const ext = path
                  .extname(new URL(cleanUrl).pathname)
                  .toLowerCase();
                let type = "other";
                if ([".js", ".mjs"].includes(ext)) type = "js";
                else if ([".css"].includes(ext)) type = "css";
                else if ([".json"].includes(ext)) type = "json";
                assetUrls.set(cleanUrl, type);
              } catch {
                /* ignore invalid URLs */
              }
            });
          }
        }
      });
    });
  }

  /* 3. Recursively scan assets for more dependencies */
  console.log("🔍 Scanning for dependencies...");
  const toProcess = [...assetUrls.keys()];

  while (toProcess.length > 0) {
    const url = toProcess.shift();
    if (processedAssets.has(url)) continue;
    processedAssets.add(url);

    const type = assetUrls.get(url) || "other";

    try {
      const content = await download(url);
      const text = content.toString("utf8");

      // Extract more assets from this file
      const found = extractAssets(text, type, url);
      for (const foundUrl of found) {
        if (!assetUrls.has(foundUrl) && !processedAssets.has(foundUrl)) {
          const ext = path.extname(new URL(foundUrl).pathname).toLowerCase();
          let foundType = "other";
          if ([".js", ".mjs"].includes(ext)) foundType = "js";
          else if ([".css"].includes(ext)) foundType = "css";
          else if ([".json"].includes(ext)) foundType = "json";

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
      const { pathname } = new URL(url, baseUrl);
      // Skip root paths and HTML pages
      if (pathname === "/" || pathname.endsWith(".html")) continue;

      const content = await download(url);
      const filePath = assetPath(url);

      // If source maps are enabled and this is a JS file, check for source map
      if (enableSourceMaps && (type === "js" || type === "mjs")) {
        const text = content.toString("utf8");
        let processedContent = text;

        // Look for source map reference
        let sourceMapUrl = null;
        for (const pattern of PATTERNS.SOURCE_MAP) {
          const match = text.match(pattern);
          if (match && match[1]) {
            const mapRef = match[1];
            if (mapRef.startsWith("http")) {
              sourceMapUrl = mapRef;
            } else if (!mapRef.startsWith("data:")) {
              sourceMapUrl = new URL(mapRef, url).href;
            }
            break;
          }
        }

        if (sourceMapUrl && !sourceMapUrl.startsWith("data:")) {
          console.log(
            `  📍 Found source map for ${path.basename(
              filePath
            )}: ${sourceMapUrl}`
          );
          try {
            const mapContent = await download(sourceMapUrl);
            const mapData = JSON.parse(mapContent.toString("utf8"));

            // Save the source map
            const mapPath = `${assetPath(url)}.map`;
            await save(mapPath, mapContent);

            // Update the source map reference in the JS file
            const mapFileName = path.basename(mapPath);
            processedContent = processedContent
              .replace(
                /\/\/[#@]\s*sourceMappingURL=[^\s]+/,
                `//# sourceMappingURL=${mapFileName}`
              )
              .replace(
                /\/\*[#@]\s*sourceMappingURL=[^\s*]+\s*\*\//,
                `/*# sourceMappingURL=${mapFileName} */`
              );

            // If the source map contains embedded sources, we're done
            // Otherwise, we could download the source files too (optional enhancement)
            if (mapData.sources && mapData.sourcesContent) {
              console.log(
                `    ✅ Source map includes ${mapData.sources.length} embedded sources`
              );
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

      console.log(`  ✅ ${path.basename(filePath)}`);
    } catch (e) {
      console.warn(`  ⚠️  Failed to download ${url}: ${e.message}`);
    }
  }

  /* 5. Save assets and update references in all files */
  for (const [url, content] of downloadedAssets) {
    await save(assetPath(url), content);
  }

  /* 6. No URL rewriting needed - assets are at their original paths */

  console.log(`\n🎉 Done! Mirror saved to: ${path.resolve(outDir)}`);
  console.log(
    `📊 Stats: ${pages.length} pages, ${downloadedAssets.size} assets`
  );
  if (enableSourceMaps) {
    const sourceMapsFound = [...downloadedAssets.keys()].filter((url) =>
      url.endsWith(".map")
    ).length;
    console.log(`🗺️  Source maps processed: ${sourceMapsFound}`);
  }
}
