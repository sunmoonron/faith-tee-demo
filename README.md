# Qivgu store

A cash-on-delivery online store for Qivgu, a scripture t-shirt brand in Toronto, to live at qivgu.com. A static site on Cloudflare Pages (the demo is on GitHub Pages) reads one Google Sheet through a small Apps Script, takes orders into that sheet and emails both owners and the customer. No payment processor, no monthly fees: customers pay cash or e-Transfer when the shirt is handed over, or e-Transfer first for shipping within Ontario. Two more pages sit beside the shop: Media, for flyers and videos, and Churches, where a church sends its own artwork and sizes and gets a quote back.

Demo, with sample products and nothing recorded: https://sunmoonron.github.io/faith-tee-demo/

The retired first demo (Still Waters, hero and cards design) is kept in `legacy/still-waters/` and served at https://sunmoonron.github.io/faith-tee-demo/old/ in case any of its CSS is wanted again. Nothing in the live store loads it.

## Files

| Path | What it is |
|---|---|
| `index.html` | The shop's source, published as a Claude artifact, so it carries no doctype of its own. It also owns the code the three pages share: the styles, the header and footer, and the script that holds the site config. |
| `media.html` | The Media page's source: flyers and videos from the Media tab. |
| `churches.html` | The Churches page's source: the request form with the artwork upload. |
| `build.sh` | Copies the shared blocks from `index.html` into the other two sources, then wraps all three into `docs/`. Run it after every edit. |
| `docs/` | What gets deployed: `index.html`, `media/index.html`, `churches/index.html`, `robots.txt`, `sitemap.xml`, product photos in `docs/img/` and flyer PDFs in `docs/media/`. |
| `sheets/Code.gs` | The Apps Script bound to the store sheet: serves the catalogue, validates and records orders, keeps the stock counts, files church requests and their artwork, sends the emails. |
| `sheets/appsscript.json` | The script manifest: time zone, the three permissions, the Drive service, web app access. |
| `sheets/template/` | The eight tabs as CSV, with headers, example rows and the column conventions. |
| `sheets/SETUP.md` | Creating the sheet, pasting or pushing the script, deploying it, wiring the site. |
| `sheets/clasp-setup.md` | The same from the terminal with clasp. |
| `sheets/test/harness.js` | Runs the script locally with the Google services mocked: `node sheets/test/harness.js`. |
| `sheets/test/sync-template.js` | Rewrites the setup rows inside `Code.gs` from `sheets/template/`. Run it after editing a template. |
| `sheets/test/post-order.sh`, `post-church.sh` | Post test orders and a test church request to a deployed script with curl. |
| `OWNER-GUIDE.md` | For the owners: products, sold-out sizes, stock, promos, orders, reviews, flyers and videos, church requests, the email list. |

## Working on the site

There are three page sources, `index.html`, `media.html` and `churches.html`, each a complete page with everything inline. What they share (the `<style>`, the header and announcement line, the footer, and the script with the site config and common code) sits between `<!--shared:NAME-->` and `<!--/shared:NAME-->` lines. `index.html` is the only place to edit those blocks; `build.sh` copies them into the other two, so a change to the config, the header or the styles is made once. Everything outside the markers belongs to its own page.

Edit, run `./build.sh`, and open `docs/` on any static server, for example:

```bash
python3 -m http.server 8795 --directory docs
```

With `scriptUrl` empty the site runs in sample mode: the four designs under working names, two example reviews, the FAITH10 code, a fake order number at checkout, one sample flyer on the Media page and a Churches form that sends nothing. Each page says it is a sample. Nothing is recorded or emailed. Set `scriptUrl` and `token` to switch it to the real sheet; `productsCsvUrl`, `reviewsCsvUrl` and `mediaCsvUrl` are an optional fallback (stock counts and church requests need the script). `siteUrl`, the Open Graph tags, the canonical link, `docs/sitemap.xml` and `docs/robots.txt` all say https://qivgu.com/; change them together if the domain ever changes. The GitHub Pages demo shares them, which is fine: it is a preview, not the store.

Photos go in `docs/img/` with the file names used in the sheet's `images` column. The crest logo is there as `qivgu-logo.png`, and `favicon.png`, `apple-touch-icon.png` and `og.jpg` (the 1200 by 630 image social networks show when the link is shared) are made from it. The header keeps a text wordmark on purpose: the crest is blue and gold, and the design rules keep colour out of the page chrome. Ask the owners for the original vector or a larger export; the file in hand is 442 pixels wide.

The design rules the site follows are in the proposal doc under "Design rules for the real site", with one change the clients asked for: there is a dark theme. It follows the visitor's system setting, and a plain text toggle in the footer ("Dark" or "Light") overrides it and is remembered in the browser. Both themes are six colours defined once at the top of the stylesheet: background, text, rule, placeholder tile, muted and error. The button and the selected size invert, photos are untouched, and there is still no accent colour. Before committing a design change, grep the CSS for `gradient`, `backdrop-filter`, `box-shadow`, `letter-spacing`, `animation` and `transition`, and for any `border-radius` above 2px; none should be there. Check both themes at 375, 768 and 1280 wide.

The Media page lists PDFs (the files live in `docs/media/` and open in a new tab) and videos (YouTube or Instagram links). A YouTube video is embedded only on the built site; an artifact copy of the page shows the same entry as a plain link, because `build.sh` is what sets the flag the page checks.

## Deploying to Cloudflare Pages

Done inside the client's Cloudflare account, where Ronish is a member.

1. Workers & Pages, Create, Pages, "Connect to Git", pick this repository (or "Upload assets" and drag the `docs` folder in for a one-off deploy).
2. Build settings: framework None, build command empty, build output directory `docs`. Save and deploy. The site is live at a `pages.dev` address within a minute.
3. Custom domains, Set up a custom domain, enter `qivgu.com`. Cloudflare adds the DNS record itself because the domain is in the same account. Add `www.qivgu.com` too.
4. Every push to `main` redeploys. For an upload deploy, drag the folder in again.

The addresses in `index.html`, `docs/sitemap.xml` and `docs/robots.txt` already say qivgu.com.

## Cloudflare Web Analytics

The site loads Cloudflare's beacon only when `cfAnalyticsToken` in the site config is not empty. There are two ways to turn analytics on; use one, not both, or every visit is counted twice.

- One click, for a site on Cloudflare Pages: in the client's Cloudflare account open Workers & Pages, the Pages project, Metrics, and choose Enable under Web Analytics. Cloudflare adds the beacon itself on the next deployment. Leave `cfAnalyticsToken` empty.
- By token, for any host: Analytics & Logs, Web Analytics, Add a site, enter `qivgu.com`. Cloudflare shows a snippet containing `data-cf-beacon='{"token": "..."}'`. Copy the value of `token` into `cfAnalyticsToken` in `index.html`, run `./build.sh` and deploy.

The beacon sets no cookies and needs no banner. It counts page loads; moving between the shop's own views (product, cart, checkout) does not load a new page, so those show up as one visit to the home page.

## Email Routing for info@ and careers@

Also in the client's Cloudflare account.

1. Email, Email Routing, Get started. Cloudflare adds the MX and SPF records it needs; accept them.
2. Destination addresses: add the owners' Gmail addresses. Each gets a verification email to click.
3. Custom addresses: create `info@qivgu.com` and forward it to the store Gmail, and `careers@qivgu.com` forwarded wherever they want applications to land. Both can forward to the same inbox.
4. To reply as `info@qivgu.com` from Gmail: Gmail Settings, Accounts, "Send mail as", Add another email address, enter `info@qivgu.com`, untick "Treat as an alias" if they want replies to stay separate, and on the next screen use `smtp.gmail.com`, port 587, the store Gmail address and an app password (Google Account, Security, 2-Step Verification, App passwords). Gmail sends a confirmation code to `info@qivgu.com`, which Email Routing forwards back to the same inbox.

Put `info@qivgu.com` into the Settings tab as `contact_email` and, if that is where e-Transfers go, `etransfer_email`.

## Handover to the store account

The test sheet and script live in Ronish's Google account. To move the store to David's account:

1. Signed in as the store account, open the shared test sheet and choose File, Make a copy. The copy includes the bound script. Name it, keep it in the store account's Drive.
2. In the copy, open Extensions, Apps Script, and run `setupTabs` once. A copy keeps every tab, so it creates nothing, but running it is how the store account approves the script's three permissions: this spreadsheet, sending email as the account, and the Drive files the script itself creates (the church artwork).
3. Deploy, New deployment, Web app, Execute as Me, Who has access Anyone. Copy the new `/exec` URL. Set a fresh `token` in the Settings tab of the copy.
4. In `index.html` swap `scriptUrl` and `token` for the new ones (and `productsCsvUrl` and `reviewsCsvUrl` if the fallback links are used; publish them from the new sheet). Run `./build.sh` and push, or upload `docs/` again.
5. Share the sheet with both owners as editors and with Ronish as an editor. Remove the test rows from Orders and Church requests or mark them Cancelled, and reset the counts in the Stock tab.
6. The "Church artwork" folder does not move with the copy. The script makes a new one in the store account's Drive the first time a church sends a request.
7. The review form, if one was created, needs to be re-linked to the new sheet (Responses, Sheets icon) and its pre-filled link pasted into `review_form_url` again.

From then on the old sheet can be deleted. Everything in `OWNER-GUIDE.md` applies to the new one.
