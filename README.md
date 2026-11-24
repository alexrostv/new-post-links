# new-post-links

You've published a new post, and now you need to link to it from your older ones.

A plugin like Internal Link Juicer can add those links for you. You give it keywords, and it links them wherever they appear. But it only matches words. It doesn't know what a sentence means, so when an older post describes the same thing differently, the plugin misses it.

This Claude skill reads your older posts and looks for places where a reader would want to open the new one, even if your keywords aren't there. For example, one medical article mentions "memory problems" in a list of symptoms. The skill suggested linking those words to a new article about a possible cause of dementia. A plugin looking for the word "dementia" would have skipped that sentence.

Give Claude the address of your new post. It will show you which sentences to link from and which words to turn into links. You choose the ones you like and add them to your site yourself. When you're done, Claude checks that the links are there and lead to the right page.

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
