# Running the store from the sheet

The store runs off one Google Sheet. You change a cell, the site changes on the next page load. Nothing else to log in to. This guide covers the things you will do every week. Keep the sheet shared with both owners and with Ronish, and never share it publicly: it holds your customers' phone numbers and addresses.

The sheet has five tabs. Do not rename the tabs or the header rows in row 1; the site reads them by name.

| Tab | What it is |
|---|---|
| Products | Your catalogue. One row per design. |
| Orders | Every order the site has taken. Your sales record. |
| Promos | Discount codes. |
| Reviews | Customer reviews from the review form. You approve them here. |
| Settings | Your emails, the e-Transfer address, pickup details, and the text on the site. |

## Add a product

Add a row at the bottom of Products and fill in the columns:

- `id`: a short word with no spaces or capitals, for example `poweredbygod`. Never change it once the product is live; the cart and the reviews use it.
- `name`: as it should appear, for example `Powered by God`.
- `price`: the adult price, numbers only, for example `35`.
- `youth_price`: the youth price, or leave blank to charge the adult price.
- `verse`: the reference, for example `Psalm 46:10`.
- `description`: two or three plain sentences: what the print is, the fabric, the fit, how to wash it.
- `colours`: the colours separated by commas. Add the colour code after the name if you have it, so the swatch on the site is right: `Black #111111, White #f2f2f2`. Without a code the site picks a close colour by name.
- `sizes_mens`, `sizes_womens`, `sizes_youth`: the sizes you stock, separated by commas, for example `S, M, L, XL`. Leave a range blank if you do not stock it.
- `sold_out_sizes`: see below. Leave blank when everything is in stock.
- `images`: the photo file names separated by semicolons, front first and back second: `poweredbygod-front.jpg; poweredbygod-back.jpg`. The first photo is the one on the shop tile; the product page shows them all. To show different photos for each colour, put the colour and a colon before the file name: `Black: name-black-front.jpg; White: name-white-front.jpg`. Send the photos to Ronish named exactly like this; he puts them on the site. A product with no photo shows a grey tile with its name.
- `active`: `yes` to show it, `no` to hide it.
- `new`: `yes` while it is new. The tile says "New". Clear it after a few weeks.
- `type`: `tee`, `hoodie`, and so on. For your own records.
- `note`: anything for yourselves. Not shown.

Check the site after you save. If a product does not appear, the usual reasons are `active` set to `no`, a missing name or price, or a typo in a header.

## Hide a product or take it off sale

Set `active` to `no`. Do not delete the row if anyone has ordered it; old orders refer to it by `id`.

## Mark sizes sold out

In `sold_out_sizes`, list what has run out, separated by commas:

- `Men's XL` marks that size out in every colour.
- `Black Men's XL` marks it out in black only.
- `Youth YS, Women's S` marks two sizes.
- `all` marks the whole product sold out. The tile says "Sold out" and nobody can add it to the cart.

Clear the cell when the stock is back. Spelling matters: use the colour names and size names exactly as they appear in the other columns.

## Add a promo code

Add a row to Promos:

- `code`: what the customer types, for example `CHURCH10`. Capitals do not matter.
- `type`: `percent` or `amount`.
- `value`: `10` means 10 percent off, or 10 dollars off, depending on `type`.
- `min_subtotal`: the smallest order it works on, or `0`.
- `starts` and `ends`: dates, or blank.
- `active`: `yes`. Set it to `no` to switch the code off; keep the row so old orders still make sense.

The discount comes off the subtotal before shipping.

## Handle an order

When someone orders, both of you get an email with everything in it, the customer gets a confirmation with their order number and what to have ready, and a row appears in Orders with `status` New and `paid` No.

1. Text or call the customer to agree a delivery or pickup time. Set `status` to Confirmed.
2. Hand over the shirt. If they pay cash, set `paid` to Yes. If they said they would e-Transfer, check your bank for the order number in the message before you set `paid` to Yes.
3. Set `status` to Delivered.
4. For a shipping order, wait for the e-Transfer first, then ship, then set `status` to Delivered and `paid` to Yes.
5. If a customer disappears or cancels, set `status` to Cancelled. Leave `paid` as it is.

Never delete an order row, not even a cancelled or test one. The Orders tab is your sales record for tax, and cash sales count toward the HST threshold like any other sale. If you need to tidy up, add a note in a column to the right.

The order number counter is the `next_order` row in Settings. Leave it alone; the script moves it up by itself.

## Approve a review

Reviews come in through the review form on the product page and land in the Reviews tab. Nothing shows on the site until you approve it.

1. Find the order number in the Orders tab to check it is a real customer.
2. Read the review. You do not have to approve a review you think is unfair, but a four-star review with a real complaint is worth more to shoppers than five stars only.
3. Set `approved` to `yes`. The review appears on that product's page with its stars.

Set it back to blank to take a review down.

## Export the email list

The checkout has a box, "Email me when new designs come out". The `consent` column in Orders says Yes for people who ticked it.

1. In Orders, click Data, then Create a filter.
2. Click the filter icon in the `consent` header and tick only Yes.
3. Copy the `email` column into your newsletter tool.
4. Click Data, Remove filter, when you are done.

Email only the people who said Yes, and put an unsubscribe line in every email; the law in Canada requires both.

## Change the words on the site

The Settings tab holds the text the site shows. Edit the `value` column; the `note` column tells you what each row does. The ones you will touch:

- `announcement`: the one line under the header. Leave blank to hide it.
- `hook_line`, `delivery_line`, `story`, `giveback_line`: the lines below the product grid.
- `pickup_note`: where and when pickup happens. Shown at checkout and in the pickup email.
- `gta_enabled`, `pickup_enabled`, `ship_enabled`: `yes` or `no` for each way of getting an order.
- `ship_rate` and `ship_free_over`: the shipping charge and the order size that makes it free.
- `gta_instructions`, `pickup_instructions`, `ship_instructions`: the "what to have ready" text in the customer's email. `{total}`, `{etransfer}` and `{number}` are filled in for you.
- `owner_emails`: who gets the order emails. Separate two addresses with a comma.
- `etransfer_email`: where customers send e-Transfers. Make sure auto-deposit is on at the bank.
- `music_url`, `music_label`, `music_credit`: the song button in the footer. Leave `music_url` blank for no button.

Do not change `token` without telling Ronish; the site carries a copy and orders stop if they differ.

## Photos

Phone photos are fine. Shoot the shirt on a person or flat, in daylight, portrait orientation; the site crops every photo to the same 4 by 5 shape. Name each file like the `images` column says, for example `poweredbygod-front.jpg`, and send them to Ronish. Adding a photo is part of the monthly plan.

## If something looks wrong

- The site shows "The shop could not load": the script is not answering. Open the sheet and check that the tabs are still named as above and nothing was deleted. Then tell Ronish.
- An order email did not arrive: check the spam folder, then the Orders tab. If the row is there, the order was taken.
- A customer says the site rejected their postal code: GTA delivery is for postal codes starting with M or L. They can choose pickup, or shipping if you have it on.
