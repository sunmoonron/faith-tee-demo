# Setting up the sheet and the script

One Google Sheet is the whole backend: the Products tab is the catalogue, the Orders tab is the order book, Promos holds discount codes, Reviews holds customer reviews, and Settings holds everything else (owner emails, e-Transfer address, pickup note, the text on the site). A small Apps Script bound to that sheet serves the catalogue to the site and takes the orders.

Do all of this signed in to the Google account that should own the store (for the test run, Ronish's account; for the real store, the store account David creates). The whole thing takes about twenty minutes. If `clasp` is installed, `clasp-setup.md` does steps 1 to 5 from the terminal.

## 1. Create the sheet

Go to sheets.new and name the sheet, for example "Still Waters store". Leave it with its one empty tab; the script creates the real tabs in step 3.

If you would rather build the tabs by hand, import each file in `template/` as its own tab (File, Import, Upload, then "Insert new sheet(s)") and name the tabs exactly Products, Orders, Promos, Reviews and Settings. Then skip the `setupTabs` part of step 3.

## 2. Paste the script

In the sheet, open Extensions, Apps Script. Delete the contents of the `Code.gs` file in the editor, paste the whole of `sheets/Code.gs`, and save (the disk icon or Ctrl+S). Name the project if asked.

Optional: open Project Settings (the gear) and tick "Show appsscript.json manifest file in editor", then replace its contents with `sheets/appsscript.json`. This pins the time zone and the two permissions the script needs. Without it the editor works out the permissions itself, which is also fine.

## 3. Create the tabs and approve the permissions

In the editor, pick `setupTabs` in the function dropdown next to "Debug" and press Run. Google asks you to review permissions: choose your account, click Advanced, then "Go to (project name) (unsafe)", then Allow. It says unsafe only because it is your own unpublished script. The script creates the five tabs with their headers and the example rows from `template/`, and removes the empty default tab.

Back in the sheet, fill in the Settings tab:

- `owner_emails`: who gets the new-order email, separated by commas.
- `token`: any random string, for example 24 letters and digits. The site sends the same string with every order; posts without it are refused.
- `etransfer_email`: where customers send e-Transfers.
- `contact_email` and `instagram`: shown in the site footer.
- `pickup_note`: where and when pickup happens, in one or two sentences.
- `ship_enabled`: `yes` to offer Ontario shipping by e-Transfer first, otherwise `no`.
- `next_order`: the first order number, for example 1042.

Delete the sample product rows in Products and the sample rows in Reviews before the real launch, or set the sample products' `active` to `no`.

## 4. Deploy the web app

In the editor click Deploy, New deployment. Click the gear next to "Select type" and choose Web app. Fill in:

- Description: anything, for example "store".
- Execute as: Me.
- Who has access: Anyone.

Click Deploy and copy the Web app URL. It ends in `/exec`. That is the address the site talks to.

Check it in a browser: open the URL with `?action=ping` on the end. It should show `{"ok":true}`. Open it with `?action=catalog` and you should see the products as JSON.

## 5. Point the site at it

In `index.html`, near the top of the script, set:

```
scriptUrl: 'https://script.google.com/macros/s/.../exec',
token: 'the same string as the token row in Settings',
```

Run `./build.sh` and deploy the `docs` folder (see the README). The site now loads products, reviews and settings from the sheet on every page load.

## 6. Optional: published CSV links

The site can also read the Products and Reviews tabs as published CSV files, as a fallback when the script does not answer. In the sheet choose File, Share, Publish to web. Under Link pick the Products tab and "Comma-separated values (.csv)", publish, and copy the link into `productsCsvUrl`. Do the same for the Reviews tab into `reviewsCsvUrl`. Anyone with these links can read those two tabs, so never publish Orders or Settings.

## 7. The review form

Create a Google Form (forms.new) with five short-answer questions titled exactly: Product, Order number, Name, Stars, Review. Make Stars a linear scale from 1 to 5 if you like; the site reads the number either way.

In the form's Responses tab click the Sheets icon and choose "Select existing spreadsheet", then the store sheet. Google adds a tab called "Form Responses 1". Rename that tab to Reviews (delete the Reviews tab the script created first, or move its two example rows if you want to keep them). Add a column called `approved` at the end; the site only shows rows where it says `yes`.

Then make the pre-filled link: in the form editor click the three dots, "Get pre-filled link", type `PRODUCT` in the Product field and `ORDER` in the Order number field, click "Get link" and copy it. Paste it into the Settings row `review_form_url`, replacing `PRODUCT` with `{product}` and `ORDER` with `{order}`. The site and the confirmation email fill those in.

## 8. Test it

With the deployment URL and the token in hand, run from the repository root:

```
SCRIPT_URL='https://script.google.com/macros/s/.../exec' TOKEN='...' EMAIL='you@example.com' sheets/test/post-order.sh all
```

It places a GTA order, a pickup order, a shipping order (rejected unless `ship_enabled` is `yes`), a GTA order with an Ottawa postal code (rejected) and a pickup order with the FAITH10 code. Each accepted order adds a row to Orders and sends two emails: one to `owner_emails`, one to EMAIL. Delete the test rows afterwards or mark them Cancelled.

The script's logic also runs locally without Google: `node sheets/test/harness.js`.

## Updating the script later

Paste the new `Code.gs` over the old one and save. Then Deploy, Manage deployments, the pencil icon, Version: New version, Deploy. The URL does not change, so the site needs no edit. A brand-new deployment would have a new URL.

## Limits

A personal Google account can send 100 emails a day from Apps Script, and every order sends two. A Google Workspace account can send 1,500. The sheet itself has no practical limit for a store this size.
