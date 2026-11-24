import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { blocksOf, differences, get, languageFolders, whyNot } from './links.mjs';

const SCRIPT = fileURLToPath(new URL('links.mjs', import.meta.url));
const URL_A = 'https://x.test/a/';
const paragraphs = (html, url = URL_A) => blocksOf(html, url).filter(b => !b.isHeading);
const text = html => paragraphs(html).map(p => p.text);

test('paragraphs and list items, under their heading', () => {
  const [a, b] = paragraphs('<h2>Sleep &amp; rest</h2><p> One&nbsp; line.\n</p><ul><li>Two</li></ul>');
  assert.deepEqual([a.heading, a.text, b.text], ['Sleep & rest', 'One line.', 'Two']);
});

test('broken HTML', () => {
  assert.deepEqual(text('<div><p>One<p>Two <b>bold</div><p>Three'), ['One', 'Two bold', 'Three']);
});

test('links in headings are kept, with the heading', () => {
  const [h] = blocksOf('<h2>See <a href="/b/">this</a></h2><p>Text</p>', URL_A);
  assert.deepEqual([h.isHeading, h.text, h.links.map(l => l.href)], [true, 'See this', ['https://x.test/b/']]);
});

test('menus, captions, tables, scripts and headings are left out', () => {
  assert.deepEqual(text('<nav><p>Menu</p></nav><h2>Title</h2><p>Body.</p><figure><figcaption><p>Caption</p></figcaption></figure><table><tr><td><p>Cell</p></td></tr></table><script>"<p>x</p>"</script>'), ['Body.']);
});

test('only the main part of a page, when it has one', () => {
  assert.deepEqual(text('<p>Before</p><main><p>In</p></main><p>After</p>'), ['In']);
  assert.deepEqual(text('<script>const sample = "<main>";</script><p>Body.</p>'), ['Body.']);
  assert.deepEqual(text('<header><p>Site</p></header><article><header><p>Lead.</p></header><p>Body.</p></article>'), ['Lead.', 'Body.']);
  assert.deepEqual(text('<header><p>Site</p></header><p>Body.</p>'), ['Body.']);
  assert.deepEqual(text('<p>Body.</p><article><p>Card</p></article><article><p>Card two</p></article>'), ['Body.', 'Card', 'Card two']);
  assert.deepEqual(text('<template><main><p>No</p></main></template><main hidden><p>No</p></main><p>Body.</p>'), ['Body.']);
});

test('hidden elements are left out, and the text around them stays', () => {
  assert.deepEqual(text('<div hidden><p>No</p></div><p>Yes <span hidden>no </span>and <svg><text>no</text></svg>yes.</p>'), ['Yes and yes.']);
});

test('a list item goes on after the list inside it', () => {
  assert.deepEqual(text('<ul><li>Before.<ul><li>Child.</li></ul>After.</li><li>Next.</li></ul>'), ['Before.', 'Child.', 'After.', 'Next.']);
  assert.deepEqual(text('<ul><li><div>In a block.</div> Tail.</li></ul>'), ['In a block.', 'Tail.']);
  assert.deepEqual(text('<div><ul><li>A</li></ul>Loose</div><ul><li><h3>T</h3>tail</li></ul>'), ['A', 'tail']);
});

test('footnotes and their marks are left out, other superscripts stay', () => {
  const marks = '<sup><a href="#r1">1</a>, <a href="#r2">2</a></sup>';
  const separate = '<sup><a href="#r1">1</a></sup><sup>, </sup><sup><a href="#r2">2</a></sup>';
  assert.deepEqual(text(`<p>It works.${marks} In 10 m<sup>2</sup>.${separate}</p><ol><li id="r1">Smith</li><li id="r2">Lee</li></ol>`), ['It works. In 10 m2.']);
  assert.deepEqual(text('<p>See step <a href="#s2">2</a> below.</p><div id="s2"><p>Step two.</p></div>'), ['See step 2 below.', 'Step two.']);
  assert.deepEqual(text('<ol><li><a href="#s1">1.</a> Intro</li></ol><div id="s1"><p>Text.<a href="#n">*</a></p></div><p id="n">A note.</p>'), ['1. Intro', 'Text.']);
});

test('where each link is in the text', () => {
  const [p] = paragraphs('<p>See <a href="/sleep/">good <em>sleep</em></a>, or <a href="#top">the top</a>.</p>');
  assert.deepEqual(p.links.map(l => [l.href, p.text.slice(l.from, l.to)]), [['https://x.test/sleep/', 'good sleep'], ['https://x.test/a/#top', 'the top']]);
});

test('links are resolved as a browser would', () => {
  const href = (html, url) => paragraphs(html, url)[0].links[0].href;
  assert.equal(href('<base href="https://other.test/"><p><a href="/memory/">m</a></p>'), 'https://other.test/memory/');
  assert.equal(href('<p><a href="../memory/">m</a></p>', 'https://x.test/archive/a/'), 'https://x.test/archive/memory/');
  assert.equal(href('<base target="_blank"><template><base href="https://no.test/"></template><base href="https://other.test/"><p><a href="/memory/">m</a></p>'), 'https://other.test/memory/');
  assert.equal(href('<base href="https://"><p><a href="/memory/">m</a></p>'), 'https://x.test/memory/');
  assert.equal(href('<p><a href="https://">m</a></p>'), '');
  assert.equal(href('<p><a href="/%d0%bf/">m</a></p>'), href('<p><a href="/п/">m</a></p>'));
});

test('language folders come from hreflang, not from short folder names', () => {
  const html = '<link rel="alternate" hreflang="en" href="https://x.test/a/"><link rel="alternate" hreflang="pt-br" href="https://x.test/pt-br/a/">';
  const languageOf = languageFolders(html, 'https://x.test/');
  assert.deepEqual(['/pt-br/b/', '/it/helpdesk/', '/b/'].map(p => languageOf(`https://x.test${p}`)), ['pt-br', '', '']);
});

const plan = { page: 'https://x.test/a/', sentence: 'Good sleep helps memory.', anchor: 'helps memory', to: 'https://x.test/memory/' };
const added = { ...plan, new: 'Memory fades without it.', anchor: 'Memory fades' };
const link = (words, href = plan.to) => `<a href="${href}">${words}</a>`;

test('a link that can be made', () => {
  assert.equal(whyNot(paragraphs('<p>First. Good sleep helps memory. Last.</p>'), plan), '');
  assert.equal(whyNot(paragraphs('<p>It’s “good” – really.</p>'), { ...plan, sentence: 'It\'s "good" - really.', anchor: 'good' }), '');
  assert.equal(whyNot(paragraphs('<p>Good sleep helps memory.</p>'), added), '');
});

test('a link that can\'t be made, and why', () => {
  const why = (html, p = plan) => whyNot(blocksOf(html, URL_A), p);
  assert.match(why('<p>Other text.</p>'), /not on the page/);
  assert.match(why('<p>Good sleep helps memory.</p><p>Good sleep helps memory.</p>'), /2 times/);
  assert.match(why(`<p>Good ${link('sleep', '/sleep/')} helps memory.</p>`), /already has a link/);
  assert.match(why(`<p>Good sleep ${link('helps memory', '#details')}.</p>`), /already has a link/);
  assert.match(why('<a href="/sleep/"><p>Good sleep helps memory.</p></a>'), /already has a link/);
  assert.match(why(`<p>Good sleep helps memory. ${link('Old', 'https://www.x.test/memory')}.</p>`), /already links to it, at "Old"/);
  assert.match(why('<h2>Good sleep helps memory.</h2><p>Other.</p>'), /not on the page/);
  assert.match(why('<p>Good sleep helps memory.</p>', { ...plan, anchor: 'dreams' }), /not in the sentence/);
});

test('addresses with a query string are pages of their own', () => {
  const p2 = { ...plan, to: 'https://x.test/?p=2' };
  assert.equal(whyNot(paragraphs(`<p>Good sleep helps memory. ${link('Other', 'https://x.test/?p=3')}.</p>`), p2), '');
  assert.match(whyNot(paragraphs(`<p>Good sleep helps memory. ${link('Same', 'https://x.test/?p=2')}.</p>`), p2), /already links/);
  assert.equal(whyNot(paragraphs(`<p>Good sleep helps memory. ${link('Post', 'https://x.test/?p=3')}.</p>`), { ...plan, to: 'https://x.test/' }), '');
});

test('a link as planned', () => {
  assert.deepEqual(differences(paragraphs(`<p>Good sleep ${link('helps memory')}.</p>`), plan), []);
  assert.deepEqual(differences(paragraphs(`<p>Good sleep ${link('helps memory. ')}Today.</p>`), { ...plan, anchor: 'helps memory.' }), []);
  assert.deepEqual(differences(paragraphs(`<p>Good sleep helps memory. ${link('Memory fades')} without it.</p>`), added), []);
  assert.deepEqual(differences(paragraphs(`<p>Good sleep helps memory.</p><p>${link('Memory fades')} without it.</p>`), added), []);
});

test('a link that differs from the plan', () => {
  const what = html => differences(paragraphs(html), plan).join('; ');
  assert.match(what('<p>Good sleep helps memory.</p>'), /no link/);
  assert.match(what(`<p>Good sleep helps ${link('memory')}.</p>`), /anchor is "memory"/);
  assert.match(what(`<p>Good sleep helps memory.</p><p>It ${link('helps memory')}.</p>`), /not in the planned sentence/);
  assert.match(what(`<p>Good sleep ${link('helps memory', `${plan.to}?x=1`)}.</p>`), /no link/);
  assert.match(what(`<p>Good sleep ${link('helps memory', `${plan.to}#top`)}.</p>`), /points to/);
  assert.match(what(`<base href="https://other.test/"><p>Good sleep ${link('helps memory', '/memory/')}.</p>`), /no link/);
  assert.match(what(`<p>Good sleep ${link('helps memory')}.</p><p>${link('More')}.</p>`), /2 links/);
  assert.match(differences(blocksOf(`<h2>Good sleep ${link('helps memory')}.</h2><p>Good sleep helps memory.</p>`, URL_A), plan).join(), /not in the planned sentence/);
  assert.match(what('<p>Good sleep <a rel="nofollow" href="https://x.test/memory/">helps memory</a>.</p>'), /nofollow/);
});

test('a new sentence as WordPress shows it', () => {
  const what = (shown, typed, anchor, before = plan.sentence) =>
    differences(paragraphs(`<p>${before}</p><p>${shown}</p>`), { ...plan, new: typed, anchor }).join();
  assert.equal(what(`Wait… ${link('2–3 days')} — or more.`, 'Wait... 2--3 days --- or more.', '2--3 days'), '');
  assert.equal(what(`Wait... ${link('2--3 days')}.`, 'Wait... 2--3 days.', '2--3 days'), '');
  assert.equal(what(`A ${link('3×3 grid')}, 7′ by 9″.`, 'A 3x3 grid, 7\' by 9".', '3x3 grid'), '');
  assert.match(what(`Wait… ${link('2–3 days')}.`, 'Wait... 2--3 days.', '2--3 days', 'Other.'), /not right after/);
  assert.match(what(`Wait. ${link('2–3 days')}.`, 'Wait... 2--3 days.', '2--3 days'), /not in the planned sentence/);
});

test('a new sentence in another place', () => {
  const fades = `${link('Memory fades')} without it.`;
  for (const html of [
    `<p>${fades}</p><h2>H</h2><p>Good sleep helps memory.</p>`,
    `<p>Good sleep helps memory. Other. ${fades}</p>`,
    `<p>Good sleep helps memory. Memory fades without it. Other. ${fades}</p>`,
    `<p>${fades} Good sleep helps memory.</p>`,
    `<p>Good sleep helps memory. Other.</p><p>${fades}</p>`,
    `<p>Good sleep helps memory.</p><p>Other. ${fades}</p>`,
    `<p>Good sleep helps memory.</p><p>x</p><h2>Why Good sleep helps memory.</h2><p>${fades}</p>`,
  ]) assert.match(differences(blocksOf(html, URL_A), added).join(), /not right after/, html);
});

test('requests are a second apart, redirects included, and follow the charset', async () => {
  const times = [];
  const server = createServer((req, res) => {
    times.push(performance.now());
    if (req.url === '/old') res.writeHead(302, { location: 'new/' }).end();
    else if (req.url === '/no') res.writeHead(403).end();
    else res.writeHead(200, { 'content-type': 'text/html; charset="windows-1251"' }).end(Buffer.from([0xf1, 0xee, 0xed]));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const at = `http://127.0.0.1:${server.address().port}`;
  const page = await get(`${at}/old`);
  await assert.rejects(get(`${at}/no`), /403/);
  server.close();
  assert.deepEqual([page.url, page.body], [`${at}/new/`, 'сон']);
  assert.ok(times[1] - times[0] > 950 && times[2] - times[1] > 950);
});

test('reading a site and finding places', async () => {
  const pages = {
    '/new/': '<title>New | Blog</title><h1>Blog</h1><p>They can’t sleep.</p>',
    '/a/': '<title>A\u001b[2J</title><h1>Blog</h1>' + '<p>They can’t\u0007 sleep.</p>'.repeat(6),
    '/b/': '<title>B</title><p>They can’t sleep.</p><ul><li><a href="/new/">New</a></li></ul>',
  };
  const server = createServer((req, res) => {
    const at = `http://${req.headers.host}`;
    res.end(pages[req.url] ?? Object.keys(pages).map(p => `<loc>${at}${p}</loc>`).join(''));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const run = async (...args) => (await promisify(execFile)(process.execPath, [SCRIPT, ...args], { cwd: dir })).stdout;
  assert.match(await run('read', `http://127.0.0.1:${server.address().port}/new/`), /Fetched 3 pages\. 1 link to it/);
  server.close();
  assert.match(await run('pages'), / 0  A \[2J  http.*\n +0  B  http.*\n +1  New \| Blog  http/);
  const found = await run('find', 'can\'t, they can’t, -x');
  assert.match(found, /\(2 of 3 terms\)\n(  - Blog: They can’t sleep\.\n){5}  1 more on this page\.\n\n/);
  assert.match(found, /Not searched, as they link to it already: 1 pages/);
  assert.doesNotMatch(found, /\/b\/|\/new\//);
  rmSync(dir, { recursive: true });
});

test('wrong use is answered plainly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
    return r.status === 1 ? r.stdout + r.stderr : `exit ${r.status}`;
  };
  const check = (plans, ...flags) => {
    writeFileSync(join(dir, 'links.json'), JSON.stringify(plans));
    return run('check', 'links.json', ...flags);
  };
  assert.match(run('pages'), /Run read first/);
  assert.match(run('read', 'x.test/a'), /not a full address/);
  assert.match(check({}), /should be a list/);
  assert.match(check([{ ...plan, to: undefined }]), /Link 1 .* needs "to", a full address/);
  assert.match(check([{ ...plan, page: '/a/' }]), /needs "page"/);
  assert.match(check([plan, { ...plan, anchor: '' }]), /Link 2 .* needs "anchor"/);
  assert.match(check([plan], '--lvie'), /node links.mjs read/);
  rmSync(dir, { recursive: true });
});
