# Mouthyukyuk Apps Script

Google Apps Script tools for:

- editing Shopify products and variants from a Google Sheets popup;
- creating products, variants, images, metafields, and initial inventory;
- writing editor changes back to the source sheet;
- reviewing and synchronizing approved sheet rows to Shopify; and
- synchronizing selected sheet data to Firebase.

## Required Script Properties

Set these under **Project Settings → Script Properties**:

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_LOCATION_ID`

Do not commit `.clasp.json`, access tokens, service-account JSON files, or other
credentials.

## First Setup

1. Push or copy the files in `AppsScript/` into the bound Apps Script project.
2. Save the project and reload the spreadsheet.
3. Run `setupShopifyMetafields()` once and approve the requested permissions.
4. Reload the spreadsheet again.
5. Open **Shopify Editor → New product** and test one draft product.
6. Confirm the Shopify product, source-sheet row, Drive image folder, metafields,
   and inventory before processing more products.

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
