# new-post-links

A plugin can link matching terms. This Claude skill looks for the links it can't make: sentences on your site that raise a question your new page answers, even when they have none of its words. On a medical site, "memory problems" in a list of symptoms now leads to an article on a neck vein and dementia.

It reads your site and proposes exact edits: this page, this sentence, these words as the link. You make the edits. Then it checks that each link is live, in the right sentence, with the right address.

## Install

Put this folder in `~/.claude/skills/` and run `npm install` in it (Node 20 or newer; tested on 24). Then ask Claude:

> Find internal links for https://example.com/my-new-post/

The script also works without Claude:

```
node links.mjs read https://example.com/my-new-post/
node links.mjs pages sleep
node links.mjs find "insomnia, tired"
node links.mjs show https://example.com/an-older-post/
node links.mjs check links.json
node links.mjs check links.json --live
```

The format of `links.json` is in [SKILL.md](SKILL.md).

WordPress sites are read through their public API, others through their sitemap, one request a second. It doesn't sign in anywhere and doesn't change anything.

## Limits

- Only headings, paragraphs and lists are read. Tables, figures, asides, forms, buttons, footnotes, menus and page footers are left out, with the links in them.
- Text a stylesheet hides is read too. Framer, for one, can keep hidden copies of a paragraph for other screen sizes, and the check then finds its sentence more than once.
- On WordPress, `read` sees the post itself and `check` the whole page, so only `check` sees a "related posts" list under it. On other sites both do, and such a list counts as a link.
- Up to 1,000 posts, or 300 pages of a sitemap. WordPress pages, as opposed to posts, are read when there are 100 or fewer; other post types, such as products or case studies, aren't.
- Languages are told apart by the page's `hreflang` tags. Without them, a multilingual site read through its sitemap comes out mixed.
- `find` looks for words. Whether a sentence should carry the link is for Claude, and then you, to judge.
- There's no target number of links. Google asks for at least one to every page you care about, and gives [no ideal number](https://developers.google.com/search/docs/crawling-indexing/links-crawlable).
