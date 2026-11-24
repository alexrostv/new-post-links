import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Parser } from 'htmlparser2';

const HELP = `Finds places on a site that could link to a page, and checks the links once they're made.
Reads public pages only, one request a second.

  node links.mjs read <URL>                  read the site once, into site.json
  node links.mjs pages [word]                its pages, and how many others link to each
  node links.mjs find "term, another term"   paragraphs that use the terms, on pages that don't link to it yet
  node links.mjs show <URL> [<URL> ...]      pages, paragraph by paragraph
  node links.mjs check links.json            can each planned link be made?
  node links.mjs check links.json --live     is each planned link there?`;

const MAX_POSTS = 1000;
const MAX_WORDPRESS_PAGES = 100;
const MAX_SITEMAP_PAGES = 300;

// Requests

let lastRequest = 0;

export async function get(url, { mayRefuse = false } = {}) {
  const typed = url;
  url = resolve(url);
  if (!url) throw new Error(`${typed} is not a full address (https://…).`);
  for (let hop = 0; hop < 6; hop++) {
    const wait = lastRequest + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'new-post-links (read-only)' }, signal: AbortSignal.timeout(60_000) })
      .catch(error => { throw new Error(`${url}: ${error.cause?.message ?? error.message}`); });
    const charset = /charset\s*=\s*"?([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
    const body = new TextDecoder(charset).decode(await res.arrayBuffer());
    lastRequest = Date.now();
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = resolve(location, url);
      continue;
    }
    if (res.status === 429 || (res.status === 403 && !mayRefuse)) throw new Error(`${url} answered ${res.status}. Stopped.`);
    return { ok: res.ok, status: res.status, url, headers: res.headers, body };
  }
  throw new Error(`${url}: too many redirects.`);
}

// HTML

// The full address, with percent escapes in capitals, so that the same address is always the same string.
function resolve(href, base) {
  try {
    return new URL(href, base).href.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
  } catch {
    return '';
  }
}

function parse(html, handlers) {
  const parser = new Parser(handlers);
  parser.write(html);
  parser.end();
}

function textOf(html) {
  let text = '';
  parse(html, { ontext: t => { text += t; } });
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

// The attributes of every such tag that isn't in a template or hidden.
function tags(html, name) {
  const found = [];
  let skipped = 0;
  parse(html, {
    onopentag(tag, attrs) {
      if (skipped || tag === 'template' || 'hidden' in attrs) skipped++;
      else if (tag === name) found.push(attrs);
    },
    onclosetag() { if (skipped) skipped--; },
  });
  return found;
}

function titleOf(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) ?? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return match ? textOf(match[1]) : '';
}

const NOT_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'table', 'figure']);
const BLOCK = new Set(['p', 'li', 'div', 'ul', 'ol', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'main', 'blockquote', 'pre']);
const HEADING = /^h[1-6]$/;
const FOOTNOTE_MARK = /^[\s\d[\]().,*†‡]+$/; // in a superscript; outside one, only symbols
const FOOTNOTE_SYMBOL = /^\s*[*†‡]+\s*$/;

// The headings, paragraphs and list items of the page at `url`, each with the heading it's under and its links:
// { heading, isHeading, text, links: [{ from, to, href, rel }] }, where from and to are positions in text.
// Footnotes, the marks that point to them, and hidden elements are left out.
export function blocksOf(html, url) {
  const root = ['main', 'article'].find(tag => tags(html, tag).length === 1);
  const base = resolve(tags(html, 'base').find(a => 'href' in a)?.href ?? '', url) || url;
  const footnotes = new Set();
  const open = [];
  const found = [];
  let inRoot = root ? 0 : 1;
  let skipped = 0;
  let heading = '';
  let block = null;
  let anchor = null; // the <a> that is open
  let link = null; // its part in this block
  let sup = null;

  const startLink = () => { if (block && anchor) link = { ...anchor, from: block.text.length }; };

  const endLink = () => {
    if (!link) return;
    const text = block.text.slice(link.from);
    if (link.href.startsWith('#') && (sup ? FOOTNOTE_MARK : FOOTNOTE_SYMBOL).test(text)) {
      footnotes.add(link.href.slice(1));
      block.text = block.text.slice(0, link.from);
      if (sup) sup.hasMark = true;
    } else if (link.href) {
      block.links.push({ ...link, href: resolve(link.href, base), to: block.text.length });
    }
    link = null;
  };

  const start = isHeading => {
    block = { heading, isHeading, text: '', links: [] };
    startLink();
  };

  const finish = () => {
    endLink();
    if (block?.text.trim()) found.push({ ...block, text: block.text.trimEnd() });
    block = sup = null;
  };

  const addText = text => {
    if (!block) return;
    text = text.replace(/[\s\p{Cc}]+/gu, ' ');
    block.text += block.text === '' || block.text.endsWith(' ') ? text.trimStart() : text;
  };

  parse(html, {
    onopentag(tag, attrs) {
      const pageHeader = tag === 'header' && !(root && inRoot);
      if (skipped || pageHeader || NOT_CONTENT.has(tag) || 'hidden' in attrs || (BLOCK.has(tag) && footnotes.has(attrs.id))) {
        skipped++;
        return;
      }
      if (tag === root) inRoot++;
      if (!inRoot) return;
      if (HEADING.test(tag)) {
        finish();
        start(true);
      } else if (BLOCK.has(tag)) {
        finish();
        open.push(tag);
        if (tag === 'p' || open.includes('li')) start(false);
      } else if (tag === 'br') {
        addText(' ');
      } else if (block && tag === 'sup') {
        sup = { from: block.text.length, hasMark: false };
      } else if (tag === 'a') {
        anchor = { href: attrs.href ?? '', rel: attrs.rel ?? '' };
        startLink();
      }
    },

    ontext(text) {
      if (!skipped && inRoot) addText(text);
    },

    onclosetag(tag) {
      if (skipped) { skipped--; return; }
      if (HEADING.test(tag)) {
        if (block?.isHeading) heading = block.text.trim();
        finish();
        if (open.includes('li')) start(false);
      } else if (BLOCK.has(tag)) {
        finish();
        open.pop();
        if (open.includes('li')) start(false); // the rest of an item, after a block inside it
      } else if (tag === 'sup' && sup) {
        if (sup.hasMark || /^[\s,;]*$/.test(block.text.slice(sup.from))) block.text = block.text.slice(0, sup.from);
        sup = null;
      } else if (tag === 'a') {
        endLink();
        anchor = null;
      }
      if (tag === root) inRoot--;
    },
  });
  finish();
  return found;
}

// Reading a site

// An address without its protocol, "www.", final slash and fragment.
function key(url) {
  if (!resolve(url)) return '';
  const u = new URL(resolve(url));
  return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search;
}

const leadsTo = (href, target) => key(href) === key(target);

const paragraphsOf = page => page.blocks.filter(b => !b.isHeading);

const linksTo = (page, target) => page.blocks.flatMap(b => b.links
  .filter(l => leadsTo(l.href, target))
  .map(l => b.text.slice(l.from, l.to)));

// Returns a function that gives the language folder of a URL ("ru" for /ru/page/), going by the page's hreflang links.
export function languageFolders(html, base) {
  const firstFolder = url => new URL(url, base).pathname.split('/')[1];
  const folders = new Set(tags(html, 'link')
    .filter(a => a.hreflang && a.href)
    .map(a => firstFolder(a.href))
    .filter(f => /^[a-z]{2}(-[a-z]{2})?$/i.test(f)));
  return url => (folders.has(firstFolder(url)) ? firstFolder(url) : '');
}

function wordPressApi(page) {
  const header = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(page.headers.get('link') ?? '');
  return header ? header[1] : tags(page.body, 'link').find(a => a.rel === 'https://api.w.org/')?.href;
}

async function fromWordPress(api, language) {
  const pages = [];
  for (const type of ['posts', 'pages']) {
    let pageCount = 1;
    for (let n = 1; n <= pageCount; n++) {
      const query = new URLSearchParams({ per_page: 20, page: n, _fields: 'link,title,modified,content' });
      if (language) query.set('lang', language);
      const url = `${api}wp/v2/${type}?${query}`;
      let res = await get(url, { mayRefuse: true });
      if (res.status >= 500) {
        await sleep(10_000);
        res = await get(url, { mayRefuse: true });
      }
      const answered = res.ok && /json/i.test(res.headers.get('content-type') ?? '');
      if (!answered && type === 'posts' && n === 1) return null;
      if (!answered) throw new Error(`${url} answered ${res.status}.`);
      const total = Number(res.headers.get('x-wp-total'));
      if (type === 'pages' && total > MAX_WORDPRESS_PAGES) {
        console.log(`Fetching its posts only: there are ${total} WordPress pages.\n`);
        break;
      }
      if (n === 1 && total > MAX_POSTS) console.log(`Fetching the newest ${MAX_POSTS} of ${total} posts.\n`);
      pageCount = Math.min(Number(res.headers.get('x-wp-totalpages')), MAX_POSTS / 20);
      for (const post of JSON.parse(res.body)) {
        pages.push({
          url: post.link,
          title: textOf(post.title.rendered),
          changed: post.modified.slice(0, 10),
          blocks: blocksOf(post.content.rendered, post.link),
        });
      }
    }
  }
  return pages;
}

async function sitemapUrls(origin) {
  const robots = await get(`${origin}/robots.txt`);
  const sitemaps = [...robots.body.matchAll(/^sitemap:\s*(\S+)/gim)].map(m => m[1]);
  if (!sitemaps.length) sitemaps.push(`${origin}/sitemap.xml`);
  const urls = new Set();
  for (const sitemap of sitemaps) { // an index adds its own sitemaps to the list
    const res = await get(sitemap);
    if (!res.ok) throw new Error(`${sitemap} answered ${res.status}.`);
    const locations = [...res.body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => textOf(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')));
    if (/<sitemapindex\b/i.test(res.body)) sitemaps.push(...locations);
    else locations.filter(u => !/\.(jpe?g|png|webp|gif|svg|pdf)$/i.test(u)).forEach(u => urls.add(u));
  }
  return [...urls];
}

async function fromSitemap(origin, wanted) {
  const urls = (await sitemapUrls(origin)).filter(wanted);
  if (!urls.length) throw new Error('No pages found in the sitemap.');
  const chosen = urls.slice(0, MAX_SITEMAP_PAGES);
  console.log(`Fetching ${chosen.length} of the ${urls.length} pages in the sitemap, one a second.\n`);
  const pages = [];
  for (const url of chosen) {
    const res = await get(url);
    if (res.ok) pages.push({ url, title: titleOf(res.body), changed: '', blocks: blocksOf(res.body, res.url) });
    else console.log(`Left out: ${url} answered ${res.status}.`);
  }
  return pages;
}

async function read(url) {
  const page = await get(url);
  if (!page.ok) throw new Error(`${url} answered ${page.status}.`);
  const target = page.url;
  const languageOf = languageFolders(page.body, target);
  const language = languageOf(target);
  const wanted = u => languageOf(u) === language;

  const api = wordPressApi(page);
  let pages = api ? await fromWordPress(api, language) : null;
  if (pages) pages = pages.filter(p => wanted(p.url));
  else pages = await fromSitemap(new URL(target).origin, wanted);

  let own = pages.find(p => key(p.url) === key(target));
  if (!own) {
    own = { url: target, title: titleOf(page.body), changed: '', blocks: blocksOf(page.body, target) };
    pages.push(own);
  }
  writeFileSync('site.json', JSON.stringify({ target, pages }));

  const robots = `${page.headers.get('x-robots-tag')} ${tags(page.body, 'meta').find(a => a.name === 'robots')?.content}`;
  const linking = pages.filter(p => p !== own && linksTo(p, target).length);
  console.log(own.title);
  console.log(target);
  if (/noindex/i.test(robots)) console.log('NOINDEX: it asks search engines to leave it out.');
  console.log(`\nSections: ${own.blocks.filter(b => b.isHeading).map(b => b.text).join(' | ')}`);
  console.log(`\nFetched ${pages.length} pages${language ? ` in "${language}"` : ''}. ${linking.length} link to it from their text.`);
  for (const p of linking) console.log(`  ${p.url}  [${linksTo(p, target).join('] [')}]`);
}

// Looking for places

function load() {
  if (!existsSync('site.json')) throw new Error('No site.json here. Run read first.');
  return JSON.parse(readFileSync('site.json', 'utf8'));
}

function withBrackets({ text, links }, withAddresses = false) {
  let out = '';
  let at = 0;
  for (const l of links) {
    out += `${text.slice(at, l.from)}[${text.slice(l.from, l.to)}]${withAddresses ? `(${l.href})` : ''}`;
    at = l.to;
  }
  return out + text.slice(at);
}

function pages(word) {
  const site = load();
  const linkedFrom = new Map(site.pages.map(p => [key(p.url), new Set()]));
  for (const page of site.pages) {
    for (const l of page.blocks.flatMap(b => b.links)) {
      if (key(l.href) !== key(page.url)) linkedFrom.get(key(l.href))?.add(page.url);
    }
  }
  const rows = site.pages
    .filter(p => p.title.toLowerCase().includes(word.toLowerCase()))
    .map(p => ({ ...p, count: linkedFrom.get(key(p.url)).size }))
    .sort((a, b) => a.count - b.count);
  for (const p of rows) console.log(`${String(p.count).padStart(4)}  ${p.title}  ${p.url}`);
  console.log(`\n${rows.length} pages. The number is how many other pages link to it from a heading, paragraph or list; menus, tables and figures don't count.`);
}

function find(list) {
  const site = load();
  const terms = list.split(',').map(t => t.trim()).filter(Boolean);
  const patterns = terms.map(t => new RegExp(`(?<![\\p{L}\\p{N}])${asTyped(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu'));
  const hits = text => patterns.filter(p => p.test(asTyped(text))).length;

  const others = site.pages.filter(p => key(p.url) !== key(site.target));
  const linking = others.filter(p => linksTo(p, site.target).length);

  const results = [];
  for (const page of others.filter(p => !linking.includes(p))) {
    const places = paragraphsOf(page).filter(p => hits(p.text)).sort((a, b) => hits(b.text) - hits(a.text));
    if (places.length) results.push({ page, places, terms: hits(places.map(p => p.text).join('\n')) });
  }
  results.sort((a, b) => b.terms - a.terms || b.places.length - a.places.length);

  for (const { page, places, terms: n } of results.slice(0, 12)) {
    console.log(`${page.title}\n  ${page.url}  (${n} of ${terms.length} terms)`);
    for (const p of places.slice(0, 5)) console.log(`  - ${p.heading || '(no heading)'}: ${withBrackets(p)}`);
    if (places.length > 5) console.log(`  ${places.length - 5} more on this page.`);
    console.log();
  }
  if (results.length > 12) console.log(`${results.length - 12} more pages use them:`);
  for (const { page } of results.slice(12)) console.log(`  ${page.title}  ${page.url}`);
  if (!results.length) console.log('No page uses them without linking to it already.');
  if (linking.length) console.log(`\nNot searched, as they link to it already: ${linking.length} pages. read lists them.`);
}

function show(urls) {
  const site = load();
  for (const url of urls.split(/\s+/)) showPage(site, url);
}

function showPage(site, url) {
  const page = site.pages.find(p => key(p.url) === key(url));
  if (!page) throw new Error(`${url} isn't in site.json.`);
  console.log(`${page.title}\n${page.url}${page.changed ? `  changed ${page.changed}` : ''}`);
  let heading = null;
  for (const p of paragraphsOf(page)) {
    if (p.heading !== heading) {
      heading = p.heading;
      console.log(`\n## ${heading || '(no heading)'}`);
    }
    console.log(`- ${withBrackets(p, true)}`);
  }
  console.log();
}

// Checking planned links. A plan is { page, sentence, anchor, to }, or with "new" for a sentence to add after it.

// Quotes, dashes, × and spaces as they are typed, one character for one, so that positions still match.
const asTyped = s => s.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/\s/g, ' ');

function positions(text, part) {
  const found = [];
  let i = asTyped(text).indexOf(asTyped(part));
  while (part && i >= 0) {
    found.push(i);
    i = asTyped(text).indexOf(asTyped(part), i + 1);
  }
  return found;
}

// Why a link can't be made as planned, or '' if it can.
export function whyNot(blocks, plan) {
  const existing = linksTo({ blocks }, plan.to);
  if (existing.length) return `the page already links to it, at "${existing[0]}"`;
  const places = blocks.filter(b => !b.isHeading).flatMap(block => positions(block.text, plan.sentence).map(at => ({ block, at })));
  if (!places.length) return 'the sentence is not on the page';
  if (places.length > 1) return `the sentence is on the page ${places.length} times`;
  const anchors = positions(plan.new ?? plan.sentence, plan.anchor);
  if (!anchors.length) return 'the anchor is not in the sentence';
  if (anchors.length > 1) return 'the anchor is in the sentence more than once';
  const [{ block, at }] = places;
  const inSentence = l => l.from < at + plan.sentence.length && l.to > at;
  if (!plan.new && block.links.some(inSentence)) return 'the sentence already has a link';
  return '';
}

// Whether the planned sentence ends right before position `at` of a block, or the block before it does.
function follows(blocks, i, at, sentence) {
  const previous = blocks[i - 1];
  const before = at > 0 ? blocks[i].text.slice(0, at) : previous && !previous.isHeading ? previous.text : '';
  return asTyped(before).trimEnd().endsWith(asTyped(sentence));
}

// What's different from the plan. Empty if the link is there as planned.
export function differences(blocks, plan) {
  const links = blocks.flatMap((block, i) => block.links
    .filter(l => leadsTo(l.href, plan.to))
    .map(l => ({ ...l, i, text: block.text })));
  if (!links.length) return ['no link to it in the text'];
  // WordPress shows ... as … and -- as –.
  const shown = s => s.replace(/\.\.\./g, '…').replace(/---?/g, '–');
  if (plan.new && !links.some(l => positions(l.text, plan.new).length)) plan = { ...plan, new: shown(plan.new), anchor: shown(plan.anchor) };
  const sentence = plan.new ?? plan.sentence;
  const found = links.length > 1 ? [`${links.length} links to it`] : [];
  for (const l of links) {
    const anchor = l.text.slice(l.from, l.to).trim();
    const from = l.text.indexOf(anchor, l.from);
    if (asTyped(anchor) !== asTyped(plan.anchor)) found.push(`the anchor is "${anchor}"`);
    const at = positions(l.text, sentence).find(start => from >= start && from + anchor.length <= start + sentence.length);
    if (at === undefined || blocks[l.i].isHeading) found.push('the link is not in the planned sentence');
    else if (plan.new && !follows(blocks, l.i, at, plan.sentence)) found.push('the new sentence is not right after the planned one');
    if (l.href !== resolve(plan.to)) found.push(`it points to ${l.href}`);
    if (/nofollow|ugc|sponsored/i.test(l.rel)) found.push(`it has rel="${l.rel}"`);
  }
  return found;
}

async function check(file, live) {
  const plans = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(plans)) throw new Error(`${file} should be a list of links.`);
  plans.forEach((plan, i) => {
    const wrong = ['page', 'to'].find(f => !/^https?:/.test(plan[f])) ?? ['sentence', 'anchor'].find(f => !plan[f]);
    if (wrong) throw new Error(`Link ${i + 1} in ${file} needs "${wrong}"${wrong === 'page' || wrong === 'to' ? ', a full address' : ''}.`);
  });
  const fetched = new Map();
  const blocksAt = async url => {
    if (!fetched.has(url)) {
      const res = await get(url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
      fetched.set(url, blocksOf(res.body, res.url));
    }
    return fetched.get(url);
  };

  let good = 0;
  for (const plan of plans) {
    const blocks = await blocksAt(plan.page);
    const problem = live ? differences(blocks, plan).join('; ') : whyNot(blocks, plan);
    if (!problem) good++;
    const state = problem ? 'no' : live ? 'live' : 'ready';
    console.log(`${state.padEnd(6)} ${plan.page}  "${plan.anchor}"${problem ? `: ${problem}` : ''}`);
  }
  console.log(`\n${good} of ${plans.length} ${live ? 'are there' : 'can be made'}.`);
  if (good < plans.length) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const live = rest.includes('--live');
  const argument = rest.filter(a => a !== '--live').join(' ');
  const commands = { read, pages, find, show, check: file => check(file, live) };
  if (!commands[command] || (!argument && command !== 'pages') || (command !== 'find' && /(^| )-/.test(argument))) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  try {
    await commands[command](argument);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
