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
broddy <url> [folder]

# explicit pages
broddy https://site.com / /about /pricing cool-site

# auto crawl depth-1
broddy https://site.com
```

---

## what it does

- grabs html  
- grabs css/js/images/fonts  
- rewrites links to `./assets`  
- creates dirs for `/deep/nested` paths  
- downloads dynamic chunks (webpack and vite)  
- zero 404s after serving

---

## why

wget/htttrack miss lazy chunks. broddy does not.

---

## tech

node 18+, cheerio, fetch, regex. single file.

---

## license

MIT – do whatever.

---

⭐ if it saved your day.

And use legitimately