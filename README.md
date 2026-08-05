# Mouthyukyuk Apps Script

Google Apps Script tools for:

- editing Shopify products and variants from a Google Sheets editor;
- creating products, variants, images, metafields, and initial inventory;
- writing editor changes back to the source sheet;
- reviewing and synchronizing approved sheet rows to Shopify;
- creating, editing, and cancelling checkout records with Shopify inventory
  adjustments and Drive receipts; and
- synchronizing selected sheet data to Firebase.

## Required Script Properties

Set these under **Project Settings → Script Properties**:

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_LOCATION_ID`

For multiple cashiers, also set `CHECKOUT_RECEIPT_FOLDER_ID` to a shared Drive
folder that every cashier can access. If omitted, the first checkout creates or
reuses a folder named `嘴郁郁 Receipt` and stores its ID automatically.

The Shopify custom app needs these Admin API scopes:

- `read_products`
- `write_products`
- `read_inventory`
- `write_inventory`
- `write_files`

`write_files` is required because removing an existing image in the editor now
permanently removes that file from Shopify's media library. After adding a new
scope, update or reinstall the custom app and clear the cached
`SHOPIFY_ACCESS_TOKEN` and `SHOPIFY_ACCESS_TOKEN_EXPIRES_AT` Script Properties.

Do not commit `.clasp.json`, access tokens, service-account JSON files, or other
credentials.

## First Setup

1. Push or copy the files in `AppsScript/` into the bound Apps Script project.
2. Save the project and reload the spreadsheet.
3. Run `setupShopifyMetafields()` once and approve the requested permissions.
4. Reload the spreadsheet again.
5. Deploy the Apps Script project as a **Web app**. Then open the bound sheet
   and choose **Shopify Editor → Checkout** once; this stores the spreadsheet
   ID and opens the standalone checkout app.
6. Open **Shopify Editor → New product** and test one draft product.
7. Confirm the Shopify product, source-sheet row, Drive image folder, metafields,
   and inventory before processing more products.
8. Open **Shopify Editor → Checkout**, create one test order, and confirm the
   `訂單紀錄` sheet, Shopify stock, uploaded image, and generated PDF receipt.

The manifest requests full spreadsheet access because resumable background jobs
open the bound spreadsheet by ID.

## Editor Field Mapping

| Editor field | Shopify field | Source-sheet heading |
| --- | --- | --- |
| Item ID | `custom.item_id` | `ID` |
| English Name | Product title | `English Name` |
| Chinese Name | `custom.chinese_name` | `Chinese Name` |
| Status | Product status | `Status` |
| Brand | Vendor | `Brand` |
| Product Type | Product type | `Product Type` |
| Storage Location | `custom.storage_location` | `Storage Location` |
| Ink Size | `custom.ink_size` | `Ink Size` |
| Ink Base Color | `custom.ink_base_colors` | `Ink Base Color` |
| Ink Glitter Color | `custom.ink_glitter_colors` | `Ink Glitter Color` |
| Ink Sheen Color | `custom.ink_sheen_colors` | `Ink Sheen Color` |
| Tags | Product tags | `Tags` or `Label Tag` |
| Inventory | Variant inventory | `Inventory` |

Inventory is written automatically for a new product or variant. For an
existing variant, select **Update stock** in the editor before saving.

## Drive Images

Images are stored under:

```text
嘴郁郁 Image/
  Brand/
    Collection/
      Exact Product Name (1).jpg
      Exact Product Name (2).jpg
```

The collection is derived from the part of the English product name before
` - `. If the separator is absent, the complete English name is used.

Only filenames matching the exact product name are shown or uploaded.

When an existing Shopify image is removed in the editor, deletion is staged
until Save. Any replacement is attached first; only then is the old file
permanently removed from Shopify.

## Approved product sync

Building the review resolves the current Shopify taxonomy category from each
Product Type and writes the selected GID to both the review and original source
sheet. Existing valid values are retained when no unique automatic match is
available.

Every approved create or update is sent to Shopify with `ACTIVE` status. The
source row's `Status` is changed to `ACTIVE` only after Shopify confirms the
successful sync.

## Checkout

Checkout is a standalone Apps Script web app. It uses Shopify as the
product/variant catalog and records one row per purchased variant in the
`訂單紀錄` sheet. It does not create a Shopify Admin order.

Cashiers can choose Ellery, Cindy, Henry, or enter another name. Customer names
are remembered from earlier orders; selecting a returning customer can also
restore the latest phone number and email address.

Receipt evidence and versioned PDF receipts are saved under:

```text
嘴郁郁 Receipt/
  YYYY/
    MM/
      MYK-YYYYMMDD-HHMMSS-XXXXXXXX/
```

Creating or editing an order changes the original product row's `Sold` value by
the order quantity difference. `Inventory` is recalculated as
`Stock + Purchased - Sold`, then Shopify inventory is aligned to that result
with a compare-and-swap check. Cancelling reverses the recorded sale once.
Orders are cancelled by status and retained for audit; their rows and receipt
files are not deleted.

Before using Checkout, ensure the Shopify app has `read_products`,
`read_inventory`, and `write_inventory`, and confirm `SHOPIFY_LOCATION_ID`
points to the intended store location.
