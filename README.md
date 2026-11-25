# new-post-links

You've published a new post, and now you need to link to it from your older ones.

A plugin like Internal Link Juicer can add those links for you. You give it keywords, and it links them wherever they appear. But it only matches words. It doesn't know what a sentence means, so when an older post describes the same thing differently, the plugin misses it.

This Claude skill reads your older posts and looks for places where a reader would want to open the new one, even if your keywords aren't there.

Say your new post is about insomnia. An older one, about stress at work, has this line: "It's three in the morning, and you're counting the hours left until the alarm." The word "insomnia" isn't in it, so a plugin would skip it. A reader who knows those nights may well want your new post, and the skill suggests a link right there, on "counting the hours left until the alarm".

Give Claude the address of your new post. It will show you which sentences to link from and which words to turn into links. You choose the ones you like, and Claude adds them: in WordPress or another editor through the browser, or in your site's files on GitHub. Then it checks that the links are there and lead to the right page.

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

WordPress sites are read through their public API, others through their sitemap, one request a second. The script only reads. Claude adds the links with the access you give it.

## Good to know

- The skill won't find every good place, and some of its suggestions will be weak. You decide which ones to use.
- It looks at headings, paragraphs and lists. Tables, captions, buttons, footnotes, menus, sidebars and footers are skipped.
- On a WordPress site it reads up to 1,000 posts, plus pages if there are no more than 100. Products, case studies and other kinds of content aren't read. On any other site it reads up to 300 pages.
- If an older page already links to your new post, the skill won't suggest another link there. A link in a "related posts" list can count too.
- Some website builders, such as Framer, keep hidden copies of a paragraph for different screen sizes. The skill sees those copies, so it may say that a sentence is on the page more than once.
- If your site is in several languages, it needs hreflang tags to tell them apart. Without them, it can mix the languages up.
- Don't aim for a certain number of links. Google recommends at least one to every page you care about and says there's [no ideal number](https://developers.google.com/search/docs/crawling-indexing/links-crawlable).
