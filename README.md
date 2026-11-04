# Qivgu store

A cash-on-delivery online store for Qivgu, a scripture t-shirt brand in Toronto, to live at qivgu.com. A static site on Cloudflare Pages (the demo is on GitHub Pages) reads one Google Sheet through a small Apps Script, takes orders into that sheet and emails both owners and the customer. No payment processor, no monthly fees: customers pay cash or e-Transfer when the shirt is handed over, or e-Transfer first for shipping within Ontario.

Demo, with sample products and nothing recorded: https://sunmoonron.github.io/faith-tee-demo/

The retired first demo (Still Waters, hero and cards design) is kept in `legacy/still-waters/` and served at https://sunmoonron.github.io/faith-tee-demo/old/ in case any of its CSS is wanted again. Nothing in the live store loads it.

## Files

| Path | What it is |
|---|---|
| `index.html` | The page source, published as a Claude artifact, so it carries no doctype of its own. The site config sits at the top of its script. |
| `build.sh` | Wraps `index.html` into `docs/index.html`, the standalone page that static hosts serve. Run it after every edit. |
| `docs/` | What gets deployed: `index.html`, `robots.txt`, `sitemap.xml`, and product photos in `docs/img/`. |
| `sheets/Code.gs` | The Apps Script bound to the store sheet: serves the catalogue, validates and records orders, sends the emails. |
| `sheets/appsscript.json` | The script manifest: time zone, permissions, web app access. |
| `sheets/template/` | The five tabs as CSV, with headers, example rows and the column conventions. |
| `sheets/SETUP.md` | Creating the sheet, pasting or pushing the script, deploying it, wiring the site. |
| `sheets/clasp-setup.md` | The same from the terminal with clasp. |
| `sheets/test/harness.js` | Runs the script locally with the Google services mocked: `node sheets/test/harness.js`. |
| `sheets/test/post-order.sh` | Posts test orders to a deployed script with curl. |
| `OWNER-GUIDE.md` | For the owners: products, sold-out sizes, promos, orders, reviews, the email list. |

## Working on the site

Edit `index.html`, run `./build.sh`, and open `docs/` on any static server, for example:

```bash
python3 -m http.server 8795 --directory docs
```

With `scriptUrl` empty the site runs in sample mode: four example products, two example reviews, the FAITH10 code, and a fake order number at checkout. Nothing is recorded or emailed. Set `scriptUrl` and `token` to switch it to the real sheet; `productsCsvUrl` and `reviewsCsvUrl` are an optional fallback. `siteUrl`, the Open Graph tags, the canonical link, `docs/sitemap.xml` and `docs/robots.txt` all say https://qivgu.com/; change them together if the domain ever changes. The GitHub Pages demo shares them, which is fine: it is a preview, not the store.

Photos go in `docs/img/` with the file names used in the sheet's `images` column. The crest logo is there as `qivgu-logo.png`, and `favicon.png`, `apple-touch-icon.png` and `og.jpg` (the 1200 by 630 image social networks show when the link is shared) are made from it. The header keeps a text wordmark on purpose: the crest is blue and gold, and the design rules keep colour out of the page chrome. Ask the owners for the original vector or a larger export; the file in hand is 442 pixels wide.

The design rules the site follows are in the proposal doc under "Design rules for the real site". Before committing a design change, grep the CSS for `gradient`, `backdrop-filter`, `box-shadow`, `letter-spacing`, `animation` and `transition`, and for any `border-radius` above 2px; none should be there.

## Deploying to Cloudflare Pages

Done inside the client's Cloudflare account, where Ronish is a member.

1. Workers & Pages, Create, Pages, "Connect to Git", pick this repository (or "Upload assets" and drag the `docs` folder in for a one-off deploy).
2. Build settings: framework None, build command empty, build output directory `docs`. Save and deploy. The site is live at a `pages.dev` address within a minute.
3. Custom domains, Set up a custom domain, enter `qivgu.com`. Cloudflare adds the DNS record itself because the domain is in the same account. Add `www.qivgu.com` too.
4. Every push to `main` redeploys. For an upload deploy, drag the folder in again.

The addresses in `index.html`, `docs/sitemap.xml` and `docs/robots.txt` already say qivgu.com.

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
2. In the copy, open Extensions, Apps Script, and run `setupTabs` once only if any tab is missing (a copy keeps all five). Approve the permissions when asked.
3. Deploy, New deployment, Web app, Execute as Me, Who has access Anyone. Copy the new `/exec` URL. Set a fresh `token` in the Settings tab of the copy.
4. In `index.html` swap `scriptUrl` and `token` for the new ones (and `productsCsvUrl` and `reviewsCsvUrl` if the fallback links are used; publish them from the new sheet). Run `./build.sh` and push, or upload `docs/` again.
5. Share the sheet with both owners as editors and with Ronish as an editor. Remove the test rows from Orders or mark them Cancelled.
6. The review form, if one was created, needs to be re-linked to the new sheet (Responses, Sheets icon) and its pre-filled link pasted into `review_form_url` again.

From then on the old sheet can be deleted. Everything in `OWNER-GUIDE.md` applies to the new one.
