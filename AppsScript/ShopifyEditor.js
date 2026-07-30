const APP = Object.freeze({
  shop: '10durv-82',
  apiVersion: '2026-07',
  imageRootFolder: '嘴郁郁 Image',
  maxImageEdge: 2048,
  requiredProductFields: ['title', 'handle', 'vendor', 'productType'],
  requiredVariantFields: ['sku', 'price', 'inventory'],
  sheetAliases: Object.freeze({
    title: ['English Name', 'Title'],
    chineseName: ['Chinese Name'],
    handle: ['Handle'],
    vendor: ['Brand', 'Vendor'],
    collection: ['Collection'],
    productType: ['Product Type', 'Type'],
    descriptionHtml: ['Desc', 'Description', 'Body HTML', 'Body (HTML)'],
    tags: ['Label Tag', 'Tags'],
    sku: ['SKU', 'Variant SKU'],
    price: ['Price', 'Variant Price'],
    inventory: ['Inventory', 'Stock'],
    imageUrls: ['Image URL', 'Image URLs'],
    productGid: ['Shopify Product GID'],
    variantGid: ['Shopify Variant GID'],
    lastUpdated: ['Last Updated'],
    uploadResult: ['Upload Result'],
  }),
});

function onOpen() {
  const ui = SpreadsheetApp.getUi();

  // Menu 1: Shopify Editor
  ui.createMenu('Shopify Editor')
      .addItem('Open editor', 'showCatalogEditor')
      .addItem('Open new product', 'showNewProductEditor')
      .addToUi();

  // Menu 2: Shopify Sync
  ui.createMenu('Shopify Sync')
      .addItem('1. Build Review', 'buildReviewFromActiveSheet')
      .addItem('2. Check Shopify', 'preflightReviewRows')
      .addItem('3. Approve rows', 'showApprovalDialog')
      .addItem('4. Start sync', 'uploadApprovedRows')
      .addSeparator()
      .addItem('Sync Progress', 'showUploadProgressDialog')
      .addItem('Cancel Sync', 'cancelApprovedRowsUpload')
      .addSeparator()
      .addItem('Setup Metafields', 'setupShopifyMetafields')
      .addItem('List Locations', 'listShopifyLocations')
      .addItem('Supported Sheets', 'showSupportedSheets')
      .addToUi();
}

function getRequiredScriptProperty_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`Missing Script Property: ${name}`);
  return value;
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function slugify_(value) {
  return clean_(value).toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
}

function splitList_(value) {
  return clean_(value).split(/[,;\n|]+/).map(clean_).filter(Boolean);
}

function normalizeEditorTags_(value) {
  if (Array.isArray(value)) {
    return value
        .map((tag) => clean_(tag))
        .filter(Boolean);
  }

  return splitList_(value);
}

function safeFilePart_(value) {
  return clean_(value).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
}

/**
 * Escapes text before inserting it into a regular expression.
 */
function escapeRegularExpression_(value) {
  return String(value == null ? '' : value)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates an exact filename matcher for one product.
 *
 * For title:
 *   Bungubox Original Ink - 4B
 *
 * It matches:
 *   Bungubox Original Ink - 4B.jpg
 *   Bungubox Original Ink - 4B (1).jpg
 *   Bungubox Original Ink - 4B (2).png
 *
 * It does not match:
 *   Bungubox Original Ink - 4B Special.jpg
 *   Bungubox Original Ink - 4B Mini (1).jpg
 */
function getProductImageFilenamePattern_(productTitle) {
  const safeTitle = safeFilePart_(productTitle);

  if (!safeTitle) {
    throw new Error(
        'Cannot match Drive images: product title is empty.');
  }

  const escapedTitle =
    escapeRegularExpression_(safeTitle);

  return new RegExp(
      '^' +
      escapedTitle +
      '(?: \\((\\d+)\\))?' +
      '\\.(?:jpg|jpeg|png|webp)$',
      'i');
}

function deriveCollectionName_(englishName) {
  const name = clean_(englishName);
  const marker = name.indexOf(' - ');
  return marker >= 0 ? clean_(name.substring(0, marker)) : name;
}

function getOrCreateFolder_(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function getImageFolder_(brand, collection) {
  const roots = DriveApp.getFoldersByName(APP.imageRootFolder);
  const root = roots.hasNext() ? roots.next() : DriveApp.createFolder(APP.imageRootFolder);
  return getOrCreateFolder_(getOrCreateFolder_(root, safeFilePart_(brand) || 'Unknown Brand'), safeFilePart_(collection) || 'Unsorted');
}

function escapeRegex_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Only accepts:
 *   Product Name.jpg
 *   Product Name (1).jpg
 *   Product Name (2).jpg
 *
 * It will not accept another product from the same collection folder.
 */
function isDriveImageForProduct_(filename, productTitle) {
  const safeTitle = safeFilePart_(productTitle);

  if (!safeTitle) {
    return false;
  }

  const stem = clean_(filename).replace(/\.[^.]+$/, '');

  const pattern = new RegExp(
      '^' +
      escapeRegex_(safeTitle) +
      '(?: \\(\\d+\\))?$',
      'i');

  return pattern.test(stem);
}

function listDriveImages_(brand, collection, productTitle) {
  // Fail closed. Never return an entire collection folder.
  if (!brand || !collection || !productTitle) {
    return [];
  }

  const folder = getImageFolder_(brand, collection);
  const files = folder.getFiles();
  const output = [];

  while (files.hasNext()) {
    const file = files.next();

    if (!/^image\//i.test(file.getMimeType())) {
      continue;
    }

    if (!isDriveImageForProduct_(
        file.getName(),
        productTitle)) {
      continue;
    }

    output.push({
      id: file.getId(),
      name: file.getName(),
      driveUrl: file.getUrl(),
      downloadUrl:
        `https://drive.google.com/uc?export=view&id=${file.getId()}`,
      source: 'DRIVE',
      pendingUpload: true,
    });
  }

  return output.sort((a, b) => {
    return a.name.localeCompare(
        b.name,
        undefined,
        {numeric: true});
  });
}

function nextProductImageNumber_(images, productTitle) {
  const safeTitle = safeFilePart_(productTitle);
  const pattern = new RegExp(
      '^' +
      escapeRegex_(safeTitle) +
      ' \\((\\d+)\\)\\.[^.]+$',
      'i');

  let highest = 0;

  images.forEach((image) => {
    const match = clean_(image.name).match(pattern);

    if (match) {
      highest = Math.max(
          highest,
          Number(match[1]) || 0);
    }
  });

  return highest + 1;
}

function uploadEditorImage(payload) {
  if (!payload || !payload.base64) {
    throw new Error('No image data received.');
  }

  const brand = clean_(payload.brand);
  const title = clean_(payload.title);

  const collection =
    clean_(payload.collection) ||
    deriveCollectionName_(title);

  if (!brand || !title || !collection) {
    throw new Error(
        'Brand and English Name are required before uploading images.');
  }

  const existingImages = listDriveImages_(
      brand,
      collection,
      title);

  const imageNumber = nextProductImageNumber_(
      existingImages,
      title);

  const filename =
    `${safeFilePart_(title)} (${imageNumber}).jpg`;

  const base64 = String(payload.base64)
      .replace(/^data:image\/[\w.+-]+;base64,/, '');

  const bytes = Utilities.base64Decode(base64);
  const folder = getImageFolder_(brand, collection);

  const file = folder.createFile(
      Utilities.newBlob(
          bytes,
          'image/jpeg',
          filename));

  const uploadedImage = {
    id: file.getId(),
    name: filename,
    driveUrl: file.getUrl(),
    downloadUrl:
      `https://drive.google.com/uc?export=view&id=${file.getId()}`,
    source: 'DRIVE',
    pendingUpload: true,
  };

  const all = listDriveImages_(
      brand,
      collection,
      title)
      .map((image) => {
        image.pendingUpload =
          image.id === uploadedImage.id;

        return image;
      });

  return {
    image: uploadedImage,
    all,
  };
}

function removeDriveImage(fileId) {
  const file = DriveApp.getFileById(fileId);
  const name = file.getName();
  file.setTrashed(true);
  return {removed: name};
}

function blankEditorModel() {
  const spreadsheet = SpreadsheetApp.getActive();
  const activeSheet = spreadsheet.getActiveSheet();

  return {
    id: '',
    title: '',
    handle: '',
    vendor: '',
    collection: '',
    productType: '',
    status: 'DRAFT',
    tags: [],
    descriptionHtml: '',

    variants: [{
      id: '',
      title: 'Default Title',
      sku: '',
      price: '',
      compareAtPrice: '',
      barcode: '',
      inventory: '',
      inventoryItemId: '',
      tracked: true,
      optionValues: [],
    }],

    images: [],
    driveImages: [],
    sourceRows: [],

    sourceSpreadsheetId: spreadsheet.getId(),
    targetSheetName: activeSheet.getName(),
    targetSheetId: activeSheet.getSheetId(),
  };
}

function validateEditorModel_(model) {
  const errors = {};

  APP.requiredProductFields.forEach((key) => {
    if (!clean_(model[key])) {
      errors[key] = 'Required';
    }
  });

  if (!(model.variants || []).length) {
    errors.variants = 'At least one variant is required';
  }

  (model.variants || []).forEach((variant, index) => {
    APP.requiredVariantFields.forEach((key) => {
      if (clean_(variant[key]) === '') {
        errors[`variant_${index}_${key}`] =
          'Required';
      }
    });

    if (
      variant.price &&
      (
        !Number.isFinite(Number(variant.price)) ||
        Number(variant.price) <= 0
      )
    ) {
      errors[`variant_${index}_price`] =
        'Enter a positive price';
    }

    if (
      clean_(variant.inventory) !== '' &&
      (
        !Number.isInteger(Number(variant.inventory)) ||
        Number(variant.inventory) < 0
      )
    ) {
      errors[`variant_${index}_inventory`] =
        'Enter zero or a positive whole number';
    }
  });

  return errors;
}

function saveCatalogProduct(model) {
  model = model || {};

  model.tags =
  normalizeEditorTags_(model.tags);

  model.handle =
    slugify_(model.handle || model.title);

  model.collection =
    deriveCollectionName_(model.title);

  const incomingDriveImages =
    model.driveImages || [];

  const pendingDriveIds = new Set(
      incomingDriveImages
          .filter((image) => {
            return image.pendingUpload === true;
          })
          .map((image) => {
            return clean_(image.id);
          })
          .filter(Boolean));

  // Re-query Drive on the server and accept only exact product images.
  const exactDriveImages = listDriveImages_(
      model.vendor,
      model.collection,
      model.title);

  model.driveImages =
    exactDriveImages.map((image) => {
      image.pendingUpload =
        pendingDriveIds.has(image.id);

      return image;
    });

  const pendingExactImages =
    model.driveImages.filter((image) => {
      return image.pendingUpload === true;
    });

  const errors =
    validateEditorModel_(model);

  if (
    !model.id &&
    pendingExactImages.length === 0
  ) {
    errors.images =
      'Upload at least one image for the new product';
  }

  if (
    model.id &&
    !(model.images || []).length &&
    !(model.driveImages || []).length
  ) {
    errors.images =
      'At least one product image is required';
  }

  const spreadsheet =
  SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
        'Unable to access the spreadsheet containing this Apps Script.');
  }

  const hasExistingSource =
    (model.sourceRows || []).length > 0;

  const targetSheet =
    spreadsheet.getSheetByName(
        clean_(model.targetSheetName));

  if (!hasExistingSource && !targetSheet) {
    errors.targetSheetName =
      'Choose an existing source sheet';
  }

  if (Object.keys(errors).length) {
    return {
      ok: false,
      errors,
    };
  }

  model.optionNames = [];

  (model.variants || []).forEach((variant) => {
    (variant.optionValues || []).forEach((option) => {
      const optionName =
        clean_(option.optionName);

      if (
        optionName &&
        model.optionNames.indexOf(
            optionName) === -1
      ) {
        model.optionNames.push(
            optionName);
      }
    });
  });

  let productId = clean_(model.id);
  let initialVariantId = '';

  if (productId) {
    updateProduct_(model);
  } else {
    const created =
      createProduct_(model);

    productId =
      created.productId;

    initialVariantId =
      created.initialVariantId;

    model.id =
      productId;
  }

  const accessToken =
    getShopifyToken_();

  const locationId =
    getRequiredScriptProperty_(
        'SHOPIFY_LOCATION_ID');

  const warnings = [];
  const savedVariants = [];

  model.variants.forEach((variant, index) => {
    const candidate =
      Object.assign({}, variant);

    if (
      !candidate.id &&
      index === 0 &&
      initialVariantId
    ) {
      candidate.id =
        initialVariantId;
    }

    const saved = saveVariant_(
        productId,
        candidate,
        !candidate.id);

    candidate.id =
      saved.id;

    candidate.inventoryItemId =
      saved.inventoryItem &&
      saved.inventoryItem.id ||
      candidate.inventoryItemId ||
      '';

    try {
      const inventoryResult =
        setAndVerifyShopifyInventory_(
            accessToken,
            candidate.inventoryItemId,
            locationId,
            Number(candidate.inventory),
            `${model.handle}:${candidate.sku}`);

      candidate.inventory =
        inventoryResult.quantity;

      candidate.editorResult =
        `INVENTORY_VERIFIED=${inventoryResult.quantity}`;
    } catch (error) {
      candidate.editorResult =
        `INVENTORY_FAILED: ${error.message}`;

      warnings.push(
          `${candidate.sku}: ${candidate.editorResult}`);
    }

    savedVariants.push(candidate);
  });

  model.variants =
    savedVariants;

  try {
    attachImagesToProduct_(
        productId,
        pendingExactImages.map((image) => {
          return image.id;
        }),
        model.title);
  } catch (error) {
    warnings.push(
        `IMAGE_UPLOAD_FAILED: ${error.message}`);
  }

  // Refresh exact images only. Never load the complete collection.
  model.driveImages = listDriveImages_(
      model.vendor,
      model.collection,
      model.title);

  const overallResult =
    warnings.length
      ? `SAVED_WITH_WARNINGS: ${warnings.join(' | ')}`
      : 'SAVED_FROM_EDITOR';

  /*
   * Sheet write happens even if inventory or image attachment produced a
   * warning, because Shopify may already contain the product.
   */
  const written =
    writeProductToSource_(
        model,
        overallResult);

  SpreadsheetApp.flush();

  let refreshedProduct;

  try {
    refreshedProduct =
      loadShopifyProduct(productId);
  } catch (error) {
    refreshedProduct =
      hydrateEditorProduct_(model);

    warnings.push(
        `REFRESH_FAILED: ${error.message}`);
  }

  return {
    ok: true,
    productId,
    written,
    warnings,
    product: refreshedProduct,
  };
}

function getSheetIndex_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const index = {};
  headers.forEach((h, i) => index[clean_(h).toLowerCase().replace(/\s+/g, '_')] = i);
  return index;
}

function aliasColumn_(index, aliases) {
  for (const alias of aliases || []) {
    const key = alias.toLowerCase().replace(/\s+/g, '_');
    if (index[key] !== undefined) return index[key];
  }
  return -1;
}

function findSourceRows_(product) {
  const ss = SpreadsheetApp.getActive();
  const skus = new Set((product.variants || []).map(v => clean_(v.sku).toUpperCase()).filter(Boolean));
  const found = [];
  ss.getSheets().forEach(sheet => {
    if (sheet.getName().startsWith('Shopify ')) return;
    const values = sheet.getDataRange().getDisplayValues();
    if (values.length < 2) return;
    const index = getSheetIndex_(sheet);
    const skuCol = aliasColumn_(index, APP.sheetAliases.sku);
    const handleCol = aliasColumn_(index, APP.sheetAliases.handle);
    for (let i = 1; i < values.length; i++) {
      const skuMatch = skuCol >= 0 && skus.has(clean_(values[i][skuCol]).toUpperCase());
      const handleMatch = handleCol >= 0 && slugify_(values[i][handleCol]) === slugify_(product.handle);
      if (skuMatch || handleMatch) found.push({sheetName: sheet.getName(), row: i + 1, sku: skuCol >= 0 ? values[i][skuCol] : ''});
    }
  });
  return found;
}

function hydrateEditorProduct_(product) {
  const spreadsheet = SpreadsheetApp.getActive();

  product.sourceRows =
    findSourceRows_(product);

  product.collection =
    deriveCollectionName_(product.title);

  // Editing only shows Drive images belonging to this exact product.
  product.driveImages = listDriveImages_(
      product.vendor,
      product.collection,
      product.title);

  product.sourceSpreadsheetId =
    spreadsheet.getId();

  if (product.sourceRows.length > 0) {
    const firstSource =
      product.sourceRows[0];

    const sourceSheet =
      spreadsheet.getSheetByName(
          firstSource.sheetName);

    product.targetSheetName =
      firstSource.sheetName;

    product.targetSheetId =
      sourceSheet
        ? sourceSheet.getSheetId()
        : '';
  } else {
    product.targetSheetName =
      spreadsheet.getActiveSheet().getName();

    product.targetSheetId =
      spreadsheet.getActiveSheet().getSheetId();
  }

  return product;
}

function writeProductToSource_(
    model,
    overallResult) {
  const ss =
    SpreadsheetApp.getActiveSpreadsheet();

  if (!ss) {
    throw new Error(
        'Unable to access the active spreadsheet for write-back.');
  }

  const results = [];
  const variants =
    model.variants || [];

  const sourceRows =
    model.sourceRows || [];

  variants.forEach((variant) => {
    /*
     * First try to locate an existing source row using the exact SKU.
     */
    let target = sourceRows.find((sourceRow) => {
      const sourceSku =
        clean_(sourceRow.sku).toUpperCase();

      const variantSku =
        clean_(variant.sku).toUpperCase();

      return (
        sourceSku &&
        variantSku &&
        sourceSku === variantSku
      );
    });

    /*
     * If the product has exactly one variant and one source row, reuse that
     * row. This supports changing the SKU of a single-variant product.
     *
     * Do not use this fallback for products with multiple variants, because
     * a newly added variant must receive a new sheet row.
     */
    if (
      !target &&
      variants.length === 1 &&
      sourceRows.length === 1
    ) {
      target =
        sourceRows[0];
    }

    /*
     * No existing source row matched, so append a new row to the explicitly
     * selected target sheet.
     */
    if (!target) {
      target = appendSourceRow_(
          ss,
          model,
          variant);
    }

    if (
      !target ||
      !target.sheetName ||
      !target.row
    ) {
      throw new Error(
          `Unable to determine the source row for SKU: ` +
          `${variant.sku || '(missing SKU)'}`);
    }

    const sheet =
      ss.getSheetByName(
          target.sheetName);

    if (!sheet) {
      throw new Error(
          `Source sheet not found: ${target.sheetName}`);
    }

    /*
     * The fifth argument is used by the updated writeMappedRow_() to record
     * success or warning information in Upload Result.
     */
    writeMappedRow_(
        sheet,
        Number(target.row),
        model,
        variant,
        overallResult || 'SAVED_FROM_EDITOR');

    results.push(
        `${target.sheetName}!${target.row}`);
  });

  SpreadsheetApp.flush();

  return results;
}

function appendSourceRow_(ss, model, variant) {
  const sheetName = clean_(model.targetSheetName) || (ss.getActiveSheet().getName() !== 'Shopify Catalog Editor' ? ss.getActiveSheet().getName() : 'Products');
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastColumn() === 0) sheet.getRange(1, 1, 1, 16).setValues([[
    'English Name','Chinese Name','Brand','Collection','Product Type','Handle','SKU','Price','Inventory','Desc','Tags','Image URLs','Shopify Product GID','Shopify Variant GID','Last Updated','Upload Result'
  ]]);
  return {sheetName, row: Math.max(2, sheet.getLastRow() + 1)};
}

function ensureAliasColumn_(sheet, index, field) {
  let col = aliasColumn_(index, APP.sheetAliases[field]);
  if (col >= 0) return col;
  col = sheet.getLastColumn();
  sheet.getRange(1, col + 1).setValue(APP.sheetAliases[field][0]);
  index[APP.sheetAliases[field][0].toLowerCase().replace(/\s+/g, '_')] = col;
  return col;
}

function writeMappedRow_(sheet, rowNumber, model, variant) {
  const index = getSheetIndex_(sheet);
  const values = {
    title: model.title, handle: model.handle, vendor: model.vendor,
    collection: deriveCollectionName_(model.title), productType: model.productType,
    descriptionHtml: model.descriptionHtml, 
    tags:
      normalizeEditorTags_(
        model.tags).join(', '),
    sku: variant.sku, price: variant.price,
    inventory: variant.inventory == null ? '' : variant.inventory,
    imageUrls: (model.driveImages || []).map(i => i.driveUrl).join('\n'),
    productGid: model.id, variantGid: variant.id,
    lastUpdated: new Date(), uploadResult: 'SAVED_FROM_EDITOR',
  };
  Object.keys(values).forEach(field => {
    if (!APP.sheetAliases[field]) return;
    const col = ensureAliasColumn_(sheet, index, field);
    sheet.getRange(rowNumber, col + 1).setValue(values[field]);
  });
}

function shopifyGraphql_(query, variables) {
  const token = getShopifyToken_();
  const url = `https://${APP.shop}.myshopify.com/admin/api/${APP.apiVersion}/graphql.json`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: {'X-Shopify-Access-Token': token},
    payload: JSON.stringify({query, variables: variables || {}}),
    muteHttpExceptions: true,
  });
  const code = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (error) {
    throw new Error(`Shopify returned invalid JSON (${code}).`);
  }
  if (code < 200 || code >= 300) throw new Error(`Shopify HTTP ${code}: ${JSON.stringify(body)}`);
  if (body.errors && body.errors.length) throw new Error(`Shopify GraphQL: ${body.errors.map(e => e.message).join(' | ')}`);
  return body.data;
}

function getShopifyToken_() {
  const p = PropertiesService.getScriptProperties();
  const cached = p.getProperty('SHOPIFY_ACCESS_TOKEN');
  const expiry = Number(p.getProperty('SHOPIFY_ACCESS_TOKEN_EXPIRES_AT') || 0);
  if (cached && expiry > Date.now() + 300000) return cached;
  const response = UrlFetchApp.fetch(`https://${APP.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({
      client_id: getRequiredScriptProperty_('SHOPIFY_CLIENT_ID'),
      client_secret: getRequiredScriptProperty_('SHOPIFY_CLIENT_SECRET'),
      grant_type: 'client_credentials',
    }), muteHttpExceptions: true,
  });
  const data = JSON.parse(response.getContentText());
  if (!data.access_token) throw new Error(`Shopify authentication failed (${response.getResponseCode()}).`);
  p.setProperties({
    SHOPIFY_ACCESS_TOKEN: data.access_token,
    SHOPIFY_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + Number(data.expires_in || 3300) * 1000),
  });
  return data.access_token;
}

function throwUserErrors_(errors, operation) {
  if (!errors || !errors.length) return;
  throw new Error(`${operation}: ${errors.map(e => `${(e.field || []).join('.')}: ${e.message}`).join(' | ')}`);
}

function searchShopifyCatalog(searchText) {
  const term = clean_(searchText);
  if (!term) return [];
  const query = `query SearchCatalog($query: String!) {
    products(first: 25, query: $query) {
      nodes { id title handle vendor productType status tags descriptionHtml
        featuredMedia { ... on MediaImage { id image { url altText width height } } }
        media(first: 50) { nodes { id alt mediaContentType ... on MediaImage { image { url altText width height } } } }
        options { id name values }
        variants(first: 100) { nodes { id title sku price compareAtPrice barcode
          selectedOptions { name value }
          inventoryItem { id tracked }
          image { url altText }
        } }
      }
    }
  }`;
  const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const data = shopifyGraphql_(query, {query: `title:*${escaped}* OR sku:${escaped} OR handle:${escaped}`});
  return data.products.nodes.map(normalizeShopifyProduct_);
}

function loadShopifyProduct(productId) {
  const locationId =
    getRequiredScriptProperty_(
        'SHOPIFY_LOCATION_ID');

  const query = `
    query ProductEditor(
      $id: ID!,
      $locationId: ID!
    ) {
      product(id: $id) {
        id
        title
        handle
        vendor
        productType
        status
        tags
        descriptionHtml

        media(first: 50) {
          nodes {
            id
            alt
            mediaContentType

            ... on MediaImage {
              image {
                url
                altText
                width
                height
              }
            }
          }
        }

        options {
          id
          name
          values
        }

        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            barcode
            inventoryQuantity

            selectedOptions {
              name
              value
            }

            inventoryItem {
              id
              tracked

              inventoryLevel(
                locationId: $locationId
              ) {
                quantities(
                  names: ["available"]
                ) {
                  name
                  quantity
                }
              }
            }

            image {
              url
              altText
            }
          }
        }
      }
    }
  `;

  const product = shopifyGraphql_(
      query,
      {
        id: productId,
        locationId,
      }).product;

  if (!product) {
    throw new Error(
        'Shopify product not found.');
  }

  return hydrateEditorProduct_(
      normalizeShopifyProduct_(product));
}

function getVariantAvailableQuantity_(variant) {
  const inventoryItem =
    variant.inventoryItem || {};

  const inventoryLevel =
    inventoryItem.inventoryLevel || null;

  const quantities =
    inventoryLevel &&
    Array.isArray(inventoryLevel.quantities)
      ? inventoryLevel.quantities
      : [];

  const available = quantities.find((quantity) => {
    return quantity.name === 'available';
  });

  if (available) {
    return Number(available.quantity);
  }

  if (variant.inventoryQuantity != null) {
    return Number(variant.inventoryQuantity);
  }

  return 0;
}

function normalizeShopifyProduct_(product) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor || '',
    productType: product.productType || '',
    status: product.status || 'DRAFT',
    tags: product.tags || [],
    descriptionHtml:
      product.descriptionHtml || '',
    options: product.options || [],

    images:
      (
        product.media &&
        product.media.nodes ||
        []
      )
          .filter((media) => {
            return (
              media.mediaContentType ===
              'IMAGE'
            );
          })
          .map((media) => ({
            id: media.id,
            url:
              media.image &&
              media.image.url ||
              '',
            alt:
              media.alt ||
              (
                media.image &&
                media.image.altText
              ) ||
              '',
            width:
              media.image &&
              media.image.width,
            height:
              media.image &&
              media.image.height,
            source: 'SHOPIFY',
          })),

    variants:
      (
        product.variants &&
        product.variants.nodes ||
        []
      )
          .map((variant) => ({
            id: variant.id,
            title: variant.title,
            sku: variant.sku || '',
            price: variant.price || '',
            compareAtPrice:
              variant.compareAtPrice || '',
            barcode: variant.barcode || '',

            inventory:
              getVariantAvailableQuantity_(
                  variant),

            optionValues:
              (variant.selectedOptions || [])
                  .map((option) => ({
                    optionName: option.name,
                    name: option.value,
                  })),

            inventoryItemId:
              variant.inventoryItem &&
              variant.inventoryItem.id ||
              '',

            tracked: Boolean(
                variant.inventoryItem &&
                variant.inventoryItem.tracked),
          })),
  };
}

function createProduct_(model) {
  const mutation = `mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) { product { id title handle variants(first: 1) { nodes { id inventoryItem { id } } } }
      userErrors { field message } }
  }`;
  const input = productInput_(model); input.status = model.status || 'DRAFT';
  if (model.optionNames && model.optionNames.length) {
    input.productOptions = model.optionNames.map(name => ({name, values: [{name: model.variants[0].optionValues.find(v => v.optionName === name)?.name || 'Default'}]}));
  }
  const result = shopifyGraphql_(mutation, {product: input}).productCreate;
  throwUserErrors_(result.userErrors, 'productCreate');
  const initial = result.product.variants.nodes[0];
  return {productId: result.product.id, initialVariantId: initial.id};
}

function updateProduct_(model) {
  const mutation = `mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id title handle } userErrors { field message } }
  }`;
  const input = productInput_(model); input.id = model.id;
  const result = shopifyGraphql_(mutation, {product: input}).productUpdate;
  throwUserErrors_(result.userErrors, 'productUpdate');
  return result.product.id;
}

function productInput_(model) {
  return {
    title: clean_(model.title), handle: slugify_(model.handle || model.title),
    vendor: clean_(model.vendor), productType: clean_(model.productType),
    descriptionHtml: clean_(model.descriptionHtml), 
    tags:
      normalizeEditorTags_(
        model.tags),
  };
}

function saveVariant_(productId, variant, isNew) {
  const mutation = isNew ?
    `mutation AddVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id sku inventoryItem { id } } userErrors { field message }
      } }` :
    `mutation EditVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
        productVariants { id sku inventoryItem { id } } userErrors { field message }
      } }`;
  const input = {
    price: clean_(variant.price),
    inventoryItem: {sku: clean_(variant.sku), tracked: variant.tracked !== false},
  };
  if (variant.compareAtPrice) input.compareAtPrice = clean_(variant.compareAtPrice);
  if (variant.barcode) input.inventoryItem.barcode = clean_(variant.barcode);
  if (variant.optionValues && variant.optionValues.length) input.optionValues = variant.optionValues;
  if (!isNew) input.id = variant.id;
  const key = isNew ? 'productVariantsBulkCreate' : 'productVariantsBulkUpdate';
  const result = shopifyGraphql_(mutation, {productId, variants: [input]})[key];
  throwUserErrors_(result.userErrors, key);
  return result.productVariants[0];
}

function uploadBlobToShopify_(blob) {
  const mutation = `mutation Stage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
  }`;
  const stage = shopifyGraphql_(mutation, {input: [{
    filename: blob.getName(), mimeType: blob.getContentType(), resource: 'PRODUCT_IMAGE', httpMethod: 'POST',
  }]}).stagedUploadsCreate;
  throwUserErrors_(stage.userErrors, 'stagedUploadsCreate');
  const target = stage.stagedTargets[0];
  const payload = {};
  target.parameters.forEach(p => payload[p.name] = p.value);
  payload.file = blob;
  const response = UrlFetchApp.fetch(target.url, {method: 'post', payload, muteHttpExceptions: true});
  if (response.getResponseCode() >= 300) throw new Error(`Staged image upload failed (${response.getResponseCode()}).`);
  return target.resourceUrl;
}

function attachImagesToProduct_(productId, driveFileIds, altText) {
  if (!driveFileIds.length) return;
  const media = driveFileIds.map(id => ({
    originalSource: uploadBlobToShopify_(DriveApp.getFileById(id).getBlob()),
    mediaContentType: 'IMAGE', alt: altText,
  }));
  const mutation = `mutation AddMedia($id: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $id, media: $media) { media { id alt status } mediaUserErrors { field message } }
  }`;
  const result = shopifyGraphql_(mutation, {id: productId, media}).productCreateMedia;
  throwUserErrors_(result.mediaUserErrors, 'productCreateMedia');
}

function showCatalogEditor() {
  const html = HtmlService.createTemplateFromFile('Editor');
  html.mode = 'search';
  SpreadsheetApp.getUi().showModalDialog(html.evaluate().setWidth(1180).setHeight(760), 'Shopify Catalog Editor');
}

function showNewProductEditor() {
  const html = HtmlService.createTemplateFromFile('Editor');
  html.mode = 'new';
  SpreadsheetApp.getUi().showModalDialog(html.evaluate().setWidth(1180).setHeight(760), 'New Shopify Product');
}
