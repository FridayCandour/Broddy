# Broddy

Copy any SPA or static site in one command.

```
npx broddy https://google.com
```

done. folder `mirror` is ready to `python -m http.server`.

---

## install

```
npm i -g broddy
```

---

## usage

```
broddy <url> [--sourcemaps] [output-folder]

# explicit pages
broddy https://site.com / /about /pricing cool-site

# auto crawl depth-1
broddy https://site.com

# with source maps
broddy https://site.com --sourcemaps
```

---

## what it does

- grabs html  
- grabs css/js/images/fonts  
- rewrites links to `./assets`  
- creates dirs for `/deep/nested` paths  
- downloads dynamic chunks (webpack, vite, dynamic imports)  
- handles source maps (with `--sourcemaps` flag)  
- zero 404s after serving

---

## why

wget/htttrack miss lazy chunks and dynamic imports. broddy handles them all.

---

## tech

node 18+, cheerio, fetch, regex. single file.

---

## license

MIT – do whatever.

---

⭐ if it saved your day.

And use legitimately