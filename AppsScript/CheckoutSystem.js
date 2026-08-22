/**
 * Mouthyukyuk checkout and receipt manager.
 *
 * The module records one sheet row per purchased catalog item. Standard mode
 * uses Shopify for catalog and inventory; MTO32 mode uses only MTO 32 Summary.
 * Neither mode creates Shopify Admin orders. The spreadsheet is the auditable
 * order ledger.
 */
const CHECKOUT_CONFIG = Object.freeze({
  sheetName: '訂單紀錄',
  modes: Object.freeze({
    standard: 'STANDARD',
    mto32: 'MTO32',
  }),
  mto32: Object.freeze({
    sheetName: 'MTO 32 Summary',
    orderPrefix: 'MTO32',
    sequenceProperty: 'CHECKOUT_MTO32_LAST_SEQUENCE',
    locationSuggestions: Object.freeze([
      '大篋',
      '細篋',
    ]),
    headers: Object.freeze({
      itemId: Object.freeze(['MTO Item ID']),
      englishName: Object.freeze(['MTO English Name', 'English Name']),
      chineseName: Object.freeze(['MTO Chinese Name', 'Chinese Name']),
      option: Object.freeze(['MTO Item Option', 'Option']),
      price: Object.freeze(['MTO Item Price', 'MTO Price', 'Price']),
      location: Object.freeze([
        'MTO Item Location',
        'MTO Location',
        'Location',
      ]),
      stock: Object.freeze(['MTO Item Stock', 'MTO Stock', 'Stock']),
      left: Object.freeze(['MTO Item Left', 'MTO Left', 'Left']),
      sold: Object.freeze(['MTO Item Sold', 'MTO Sold', 'Sold']),
      imageUrl: Object.freeze([
        'MTO Image URL',
        'MTO Item Image URL',
        'Image URL',
      ]),
    }),
  }),
  spreadsheetIdProperty: 'CHECKOUT_SPREADSHEET_ID',
  receiptRootFolderName: '嘴郁郁 Receipt',
  receiptRootFolderProperty: 'CHECKOUT_RECEIPT_FOLDER_ID',
  locationProperty: 'SHOPIFY_LOCATION_ID',
  maxImages: 10,
  maxImageBytes: Math.floor(1.5 * 1024 * 1024),
  maxTotalImageBytes: 8 * 1024 * 1024,
  allowedImageTypes: Object.freeze([
    'image/jpeg',
    'image/png',
    'image/webp',
  ]),
  paymentMethods: Object.freeze([
    '現金',
    'FPS',
    'PayMe',
    '微信支付',
    'Alipay',
    '信用卡',
    '銀行轉帳',
    '其他',
  ]),
  cashierChoices: Object.freeze([
    'Ellery',
    'Cindy',
    'Henry',
  ]),
  statuses: Object.freeze({
    active: 'ACTIVE',
    cancelled: 'CANCELLED',
  }),
  headers: Object.freeze([
    '訂單編號',
    '訂單模式',
    '訂單狀態',
    '版本',
    '草稿鍵',
    '最後請求鍵',
    '建立時間',
    '更新時間',
    '取消時間',
    '取消者',
    '取消原因',
    '交易時間',
    '結帳員',
    '顧客名稱',
    '顧客電話',
    '顧客電郵',
    '付款方式',
    '備註',
    '項目鍵',
    '來源工作表',
    '來源項目ID',
    '中文品名',
    '來源位置',
    '商品圖片',
    'Shopify Product GID',
    'Shopify Variant GID',
    'Shopify Inventory Item GID',
    '庫存追蹤',
    'SKU',
    '品名',
    'Variant',
    '數量',
    '單價',
    '折扣類型',
    '折扣值',
    '行總額',
    '收據圖片連結',
    '收據圖片ID',
    '收據圖片名稱',
    '收據圖片JSON',
    '收據資料夾ID',
    '收據PDF連結',
    '收據PDF ID',
    '庫存狀態',
    '來源銷售已記錄',
    '訂單總額',
    '最後操作',
  ]),
});

/**
 * Serves Checkout as a standalone Apps Script web app.
 * Deploy this project as a web app, then launch it once from the bound Sheet
 * so CHECKOUT_SPREADSHEET_ID can be recorded for web-app requests.
 */
function doGet() {
  return HtmlService
      .createTemplateFromFile('Checkout')
      .evaluate()
      .setTitle('Mouthyukyuk Checkout');
}

/**
 * Menu-compatible launcher. The checkout itself opens in a browser tab, not
 * inside a spreadsheet popup.
 */
function showCheckoutDialog() {
  return showCheckoutApp();
}

/**
 * Records the bound spreadsheet and returns the deployed web-app URL.
 * Editor.html uses this endpoint after opening a browser tab synchronously,
 * which avoids popup blockers rejecting an asynchronous window.open call.
 */
function getCheckoutAppUrl() {
  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  if (spreadsheet) {
    PropertiesService.getScriptProperties().setProperty(
        CHECKOUT_CONFIG.spreadsheetIdProperty,
        spreadsheet.getId());
  } else if (
    !PropertiesService.getScriptProperties().getProperty(
        CHECKOUT_CONFIG.spreadsheetIdProperty)
  ) {
    throw new Error(
        'Open the bound spreadsheet before launching Checkout.');
  }

  const appUrl = ScriptApp.getService().getUrl();

  if (!appUrl) {
    throw new Error(
        'Checkout has not been deployed as a web app. Deploy the Apps ' +
        'Script project as a web app, then use Checkout again.');
  }

  return appUrl;
}

function showCheckoutApp() {
  const appUrl = getCheckoutAppUrl();

  const safeUrl = checkoutEscapeHtml_(appUrl);

  const launcher = HtmlService
      .createHtmlOutput(`
        <!doctype html>
        <html>
          <head><base target="_blank"></head>
          <body style="font:14px Arial,sans-serif;padding:18px;color:#202124">
            <p>Checkout opens as a standalone app.</p>
            <p>
              <a
                href="${safeUrl}"
                target="_blank"
                rel="noopener"
                style="display:inline-block;padding:9px 14px;border-radius:5px;background:#1769e0;color:#fff;text-decoration:none"
              >Open Checkout</a>
            </p>
            <p style="font-size:12px;color:#5f6368">
              If the browser previously blocked the new tab, click the button
              above. This launcher will stay open until you close it.
            </p>
          </body>
        </html>
      `)
      .setWidth(390)
      .setHeight(210);

  SpreadsheetApp.getUi().showModelessDialog(
      launcher,
      'Open Checkout');
}

function getCheckoutBootstrap() {
  checkoutEnsureSheet_();

  return {
    order: checkoutBlankOrder_(),
    modes: [
      CHECKOUT_CONFIG.modes.standard,
      CHECKOUT_CONFIG.modes.mto32,
    ],
    paymentMethods:
      CHECKOUT_CONFIG.paymentMethods.slice(),
    cashiers: checkoutGetCashierOptions_(),
    customers: checkoutGetCustomerOptions_(),
    mtoCatalogCreation:
      getCheckoutMtoCatalogCreationBootstrap(),
    recentOrders: findCheckoutOrders(''),
  };
}

/**
 * Static configuration for the MTO product form. Locations are suggestions,
 * not an allow-list: market staff may enter a new storage location.
 */
function getCheckoutMtoCatalogCreationBootstrap() {
  return {
    mode: CHECKOUT_CONFIG.modes.mto32,
    sheetName: CHECKOUT_CONFIG.mto32.sheetName,
    locationSuggestions:
      CHECKOUT_CONFIG.mto32.locationSuggestions.slice(),
    maxImages: CHECKOUT_CONFIG.maxImages,
  };
}

function getBlankCheckoutOrder(mode) {
  checkoutEnsureSheet_();
  return checkoutBlankOrder_(mode);
}

function checkoutBlankOrder_(mode) {
  const normalizedMode = checkoutNormalizeMode_(mode);

  return {
    mode: normalizedMode,
    checkoutMode: normalizedMode,
    orderId: '',
    status: CHECKOUT_CONFIG.statuses.active,
    version: 0,
    draftKey: Utilities.getUuid(),
    requestKey: Utilities.getUuid(),
    transactionDate: checkoutFormatClientDate_(new Date()),
    cashier: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    paymentMethod: CHECKOUT_CONFIG.paymentMethods[0],
    notes: '',
    items: [],
    receiptImages: [],
    receiptUrl: '',
    receiptFileId: '',
    receiptFolderId: '',
    orderTotal: 0,
    createdAt: '',
    updatedAt: '',
    cancelledAt: '',
    cancelledBy: '',
    cancellationReason: '',
    sourceSalesApplied: false,
  };
}

/**
 * Searches Shopify and returns exact variant identities for the cart.
 */
function checkoutSearchCatalog(searchText, mode) {
  if (
    searchText &&
    typeof searchText === 'object'
  ) {
    mode =
      searchText.checkoutMode ||
      searchText.catalogMode ||
      searchText.mode;
    searchText = searchText.searchText || searchText.query || '';
  }

  if (checkoutNormalizeMode_(mode) === CHECKOUT_CONFIG.modes.mto32) {
    return checkoutSearchMto32Catalog_(searchText);
  }

  const term = checkoutClean_(searchText);

  if (!term) {
    return [];
  }

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);

  const escaped = term
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  const shopifySearchClauses = [
    `"${escaped}"`,
    `title:"${escaped}"`,
    `sku:"${escaped}"`,
    `handle:"${escaped}"`,
    `vendor:"${escaped}"`,
  ];

  // Shopify documents trailing wildcards for prefix matching. Add them only
  // for a single search token; quoted clauses above handle names with spaces.
  if (!/\s/.test(term)) {
    shopifySearchClauses.push(
        `title:${escaped}*`,
        `sku:${escaped}*`,
        `handle:${escaped}*`,
        `vendor:${escaped}*`);
  }

  /*
   * Chinese names are stored in the original product sheets and in Shopify
   * metafields. Source-sheet matching gives us reliable contains-search even
   * when Shopify metafield filtering has not been enabled for an older store.
   */
  const sourceMatches = checkoutFindSourceCatalogMatches_(
      term,
      50);
  const sourceVariantIds = sourceMatches.map((match) => {
    return match.variantId;
  });
  const sourceMatchByVariantId = {};

  sourceMatches.forEach((match) => {
    sourceMatchByVariantId[match.variantId] = match;
  });

  const query = `
    query CheckoutCatalogSearch(
      $query: String!,
      $sourceVariantIds: [ID!]!,
      $locationId: ID!
    ) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          handle
          vendor
          status
          chineseName: metafield(
            namespace: "custom",
            key: "chinese_name"
          ) {
            value
          }
          featuredMedia {
            ... on MediaImage {
              image {
                url
                altText
              }
            }
          }
          variants(first: 50) {
            nodes {
              id
              title
              sku
              price
              image {
                url
                altText
              }
              inventoryItem {
                id
                tracked
                inventoryLevel(locationId: $locationId) {
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      }

      sourceVariants: nodes(ids: $sourceVariantIds) {
        ... on ProductVariant {
          id
          title
          sku
          price
          image {
            url
            altText
          }
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
          product {
            id
            title
            handle
            vendor
            status
            chineseName: metafield(
              namespace: "custom",
              key: "chinese_name"
            ) {
              value
            }
            featuredMedia {
              ... on MediaImage {
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = shopifyGraphql_(
      query,
      {
        query: shopifySearchClauses.join(' OR '),
        sourceVariantIds,
        locationId,
      });

  const products =
    data.products &&
    Array.isArray(data.products.nodes)
      ? data.products.nodes
      : [];

  const results = [];
  const resultByVariantId = {};

  const addVariant = (product, variant) => {
    if (!product || !variant || !variant.id) {
      return;
    }

    const sourceMatch = sourceMatchByVariantId[variant.id] || {};
    const existing = resultByVariantId[variant.id];

    if (existing) {
      if (!existing.chineseName && sourceMatch.chineseName) {
        existing.chineseName = sourceMatch.chineseName;
      }

      return;
    }

    const productImage =
      product.featuredMedia &&
      product.featuredMedia.image ||
      {};
    const variantImage = variant.image || {};
    const inventoryItem = variant.inventoryItem || {};
    const level = inventoryItem.inventoryLevel || null;
    const result = {
      productId: product.id,
      variantId: variant.id,
      inventoryItemId: inventoryItem.id || '',
      productTitle: product.title || '',
      chineseName:
        product.chineseName && product.chineseName.value ||
        sourceMatch.chineseName ||
        '',
      variantTitle:
        variant.title === 'Default Title'
          ? ''
          : variant.title,
      sku: variant.sku || '',
      price: checkoutMoney_(variant.price),
      available: checkoutAvailableFromLevel_(level),
      tracked: Boolean(inventoryItem.tracked),
      vendor:
        product.vendor ||
        sourceMatch.vendor ||
        '',
      productStatus: product.status || '',
      imageUrl:
        variantImage.url ||
        productImage.url ||
        sourceMatch.imageUrl ||
        '',
      imageAlt:
        variantImage.altText ||
        productImage.altText ||
        product.title ||
        '',
    };

    resultByVariantId[variant.id] = result;
    results.push(result);
  };

  const sourceVariants = Array.isArray(data.sourceVariants)
    ? data.sourceVariants
    : [];

  sourceVariants.forEach((variant) => {
    if (variant && variant.product) {
      addVariant(variant.product, variant);
    }
  });

  // Source-sheet Chinese-name and brand matches are deliberately added first
  // so the 100-result limit cannot hide the exact matches the cashier asked
  // for behind a large general Shopify result set.
  products.forEach((product) => {
    const variants =
      product.variants &&
      Array.isArray(product.variants.nodes)
        ? product.variants.nodes
        : [];

    variants.forEach((variant) => {
      addVariant(product, variant);
    });
  });

  return results.slice(0, 100);
}

/**
 * Searches only the fixed MTO source sheet. MTO catalog work must never query
 * Shopify or depend on Shopify credentials, locations, GIDs, or inventory.
 */
function checkoutSearchMto32Catalog_(searchText) {
  const term = checkoutNormalizeSearch_(searchText);

  if (!term) {
    return [];
  }

  const catalog = checkoutReadMto32Catalog_();

  return catalog.items
      .filter((item) => {
        return checkoutNormalizeSearch_([
          item.sourceItemId,
          item.productTitle,
          item.chineseName,
          item.variantTitle,
          item.sourceLocation,
        ].join(' ')).indexOf(term) !== -1;
      })
      .slice(0, 100)
      .map((item) => Object.assign({}, item));
}

/**
 * Creates one new MTO product with one or more variant rows.
 *
 * Payload:
 * {
 *   englishName: String,
 *   chineseName: String,
 *   imageUrl: String, // optional; or imageUrls: String[]
 *   variants: [{itemId, option, price, location, stock}]
 * }
 *
 * MTO Item ID is the case-insensitive identity. The whole request is
 * validated under one script lock and appended with one atomic Sheets API
 * request, so no subset of the submitted variants can be created and extra
 * helper columns remain untouched. This path never reads or writes Shopify.
 */
function createCheckoutMtoCatalogProduct(payload) {
  const submitted = payload || {};
  const submittedMode = checkoutClean_(
      submitted.checkoutMode ||
      submitted.catalogMode ||
      submitted.mode);

  if (
    !submittedMode ||
    checkoutNormalizeMode_(submittedMode) !==
      CHECKOUT_CONFIG.modes.mto32
  ) {
    throw new Error(
        'New market products can be created only in MTO32 mode.');
  }

  const product = checkoutNormalizeNewMtoCatalogProduct_(submitted);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const catalog = checkoutReadMto32Catalog_();

    product.variants.forEach((variant) => {
      if (catalog.byKey[variant.itemKey]) {
        throw new Error(
            `MTO Item ID already exists: ${variant.itemId}. ` +
            'Use a different ID.');
      }
    });

    const sheet = catalog.sheet;
    const lastCatalogRow = catalog.items.reduce((maximum, item) => {
      return Math.max(maximum, Number(item.sourceRow) || 1);
    }, 1);
    const startRow = Math.max(2, lastCatalogRow + 1);

    checkoutWriteNewMtoCatalogRows_(
        sheet.getParent(),
        sheet,
        startRow,
        product,
        catalog.columns);
    SpreadsheetApp.flush();

    const items = product.variants.map((variant, offset) => {
      return checkoutNewMtoCatalogItem_(
          product,
          variant,
          startRow + offset);
    });

    return {
      ok: true,
      createdCount: items.length,
      sourceSheetName: CHECKOUT_CONFIG.mto32.sheetName,
      product: {
        englishName: product.englishName,
        chineseName: product.chineseName,
        imageUrl: product.imageUrls[0] || '',
        imageUrls: product.imageUrls.slice(),
      },
      items,
      // Alias retained for clients that describe search results as catalogItems.
      catalogItems: items.map((item) => Object.assign({}, item)),
      message:
        `Created ${items.length} MTO item row(s) in ` +
        `${CHECKOUT_CONFIG.mto32.sheetName}.`,
    };
  } finally {
    lock.releaseLock();
  }
}

function checkoutNormalizeNewMtoCatalogProduct_(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error('New MTO product data is invalid.');
  }

  const englishName = checkoutMtoRequiredCatalogText_(
      payload.englishName || payload.productTitle,
      'MTO English Name',
      250);
  const chineseName = checkoutMtoRequiredCatalogText_(
      payload.chineseName,
      'MTO Chinese Name',
      250);
  const imageUrls = checkoutNormalizeNewMtoImageUrls_(
      payload.imageUrls !== undefined
        ? payload.imageUrls
        : payload.images !== undefined
          ? payload.images
          : payload.imageUrl);
  const submittedVariants = Array.isArray(payload.variants)
    ? payload.variants
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (submittedVariants.length === 0) {
    throw new Error('Add at least one MTO product variant.');
  }

  if (submittedVariants.length > 200) {
    throw new Error(
        'A single MTO product cannot contain more than 200 variants.');
  }

  const seenIds = {};
  const seenOptions = {};
  const hasMultipleVariants = submittedVariants.length > 1;
  const variants = submittedVariants.map((rawVariant, offset) => {
    const variant = rawVariant || {};
    const rowLabel = `Variant ${offset + 1}`;
    const itemId = checkoutMtoRequiredCatalogText_(
        variant.itemId ||
        variant.sourceItemId ||
        variant.marketItemId ||
        variant.mtoItemId ||
        variant.sku,
        `${rowLabel} MTO Item ID`,
        100);
    const itemKey = checkoutMtoItemKey_(itemId);

    if (seenIds[itemKey]) {
      throw new Error(
          `Duplicate MTO Item ID in this product: ${itemId}. ` +
          'IDs are case-insensitive.');
    }

    seenIds[itemKey] = true;

    const option = checkoutMtoOptionalCatalogText_(
        variant.option || variant.variantTitle,
        `${rowLabel} MTO Item Option`,
        250);

    if (hasMultipleVariants && !option) {
      throw new Error(
          `${rowLabel} MTO Item Option is required when a product has ` +
          'multiple variants.');
    }

    if (hasMultipleVariants) {
      const optionKey = option.toUpperCase();

      if (seenOptions[optionKey]) {
        throw new Error(
            `Duplicate MTO Item Option in this product: ${option}. ` +
            'Options are case-insensitive.');
      }

      seenOptions[optionKey] = true;
    }
    const location = checkoutMtoRequiredCatalogText_(
        variant.location || variant.sourceLocation,
        `${rowLabel} MTO Item Location`,
        160);
    const rawPrice = variant.price !== undefined
      ? variant.price
      : variant.unitPrice;
    const priceText = checkoutClean_(rawPrice);
    const price = checkoutMoney_(rawPrice);

    if (
      !priceText ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw new Error(
          `${rowLabel} MTO Item Price must be zero or a positive number.`);
    }

    const rawStock = variant.stock !== undefined
      ? variant.stock
      : variant.available;
    const stock = checkoutMtoWholeNumber_(
        rawStock,
        `${rowLabel} MTO Item Stock`,
        itemId);

    return {
      itemId,
      itemKey,
      option,
      price,
      location,
      stock,
    };
  });

  return {
    englishName,
    chineseName,
    imageUrls,
    variants,
  };
}

function checkoutMtoRequiredCatalogText_(value, label, maximumLength) {
  const text = checkoutMtoOptionalCatalogText_(
      value,
      label,
      maximumLength);

  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function checkoutMtoOptionalCatalogText_(value, label, maximumLength) {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object'
  ) {
    throw new Error(`${label} is invalid.`);
  }

  const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();

  if (text.length > maximumLength) {
    throw new Error(
        `${label} cannot exceed ${maximumLength} characters.`);
  }

  return text;
}

function checkoutNormalizeNewMtoImageUrls_(submitted) {
  const candidates = [];
  const values = Array.isArray(submitted)
    ? submitted
    : [submitted];

  values.forEach((rawValue) => {
    let value = rawValue;

    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      value = value.url || value.imageUrl || value.thumbnailUrl;
    }

    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'object') {
      throw new Error('MTO Image URL is invalid.');
    }

    String(value)
        .split(/[\r\n;|]+/)
        .map(checkoutClean_)
        .filter(Boolean)
        .forEach((url) => candidates.push(url));
  });

  if (candidates.length > CHECKOUT_CONFIG.maxImages) {
    throw new Error(
        `A product can contain at most ${CHECKOUT_CONFIG.maxImages} ` +
        'MTO image URLs.');
  }

  const normalized = [];
  const seen = {};

  candidates.forEach((candidate, offset) => {
    if (
      candidate.length > 2048 ||
      !/^https?:\/\/[^\s]+$/i.test(candidate)
    ) {
      throw new Error(
          `MTO Image URL ${offset + 1} must be a valid HTTP(S) URL.`);
    }

    const imageUrl = checkoutNormalizeCatalogImageUrl_(candidate);

    if (!seen[imageUrl]) {
      seen[imageUrl] = true;
      normalized.push(imageUrl);
    }
  });

  return normalized;
}

/**
 * Writes only the ten resolved MTO columns. userEnteredValue.stringValue keeps
 * browser text literal even when it begins with a spreadsheet formula sigil.
 * The single spreadsheets.batchUpdate request is atomic and does not blank
 * extra helper columns or formulas elsewhere in the target sheet.
 */
function checkoutWriteNewMtoCatalogRows_(
    spreadsheet,
    sheet,
    startRow,
    product,
    columns) {
  if (
    typeof Sheets === 'undefined' ||
    !Sheets.Spreadsheets ||
    typeof Sheets.Spreadsheets.batchUpdate !== 'function'
  ) {
    throw new Error(
        'The Advanced Google Sheets service is required for safe MTO ' +
        'catalog writes. Enable Google Sheets API v4 in Apps Script ' +
        'Services.');
  }

  const variants = product.variants || [];

  if (!variants.length) {
    return;
  }

  const requiredLastRow = startRow + variants.length - 1;
  const storedImageUrls = product.imageUrls.join('\n');
  const fieldValues = {
    itemId: variants.map((variant) => variant.itemId),
    englishName: variants.map(() => product.englishName),
    chineseName: variants.map(() => product.chineseName),
    option: variants.map((variant) => variant.option),
    price: variants.map((variant) => variant.price),
    location: variants.map((variant) => variant.location),
    stock: variants.map((variant) => variant.stock),
    left: variants.map((variant) => variant.stock),
    sold: variants.map(() => 0),
    imageUrl: variants.map(() => storedImageUrls),
  };
  const requests = [];

  if (requiredLastRow > sheet.getMaxRows()) {
    requests.push({
      appendDimension: {
        sheetId: sheet.getSheetId(),
        dimension: 'ROWS',
        length: requiredLastRow - sheet.getMaxRows(),
      },
    });
  }

  Object.keys(fieldValues).forEach((field) => {
    const columnIndex = columns[field];

    requests.push({
      updateCells: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: startRow - 1,
          endRowIndex: requiredLastRow,
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex + 1,
        },
        rows: fieldValues[field].map((value) => ({
          values: [{
            userEnteredValue: checkoutMtoExtendedValue_(value),
          }],
        })),
        fields: 'userEnteredValue',
      },
    });
  });

  Sheets.Spreadsheets.batchUpdate(
      {requests},
      spreadsheet.getId());
}

function checkoutMtoExtendedValue_(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {numberValue: value};
  }

  return {stringValue: String(value == null ? '' : value)};
}

function checkoutNewMtoCatalogItem_(product, variant, sourceRow) {
  return {
    mode: CHECKOUT_CONFIG.modes.mto32,
    checkoutMode: CHECKOUT_CONFIG.modes.mto32,
    catalogMode: CHECKOUT_CONFIG.modes.mto32,
    itemKey: variant.itemKey,
    sourceSheetName: CHECKOUT_CONFIG.mto32.sheetName,
    sourceItemId: variant.itemId,
    marketItemId: variant.itemId,
    sourceRow,
    sourceLocation: variant.location,
    productId: '',
    variantId: '',
    inventoryItemId: '',
    sku: variant.itemId,
    productTitle: product.englishName,
    chineseName: product.chineseName,
    variantTitle: variant.option,
    price: variant.price,
    available: variant.stock,
    tracked: false,
    vendor: '',
    productStatus: '',
    imageUrl: product.imageUrls[0] || '',
    imageUrls: product.imageUrls.slice(),
    imageAlt: product.englishName || variant.itemId,
    stock: variant.stock,
    left: variant.stock,
    sold: 0,
  };
}

/**
 * Converts common Google Drive share links into a directly renderable image
 * URL. Non-Drive HTTP(S) URLs are returned unchanged.
 */
function checkoutNormalizeCatalogImageUrl_(value) {
  const url = checkoutClean_(value);

  if (!url || !/^https?:\/\//i.test(url)) {
    return url;
  }

  if (!/^https?:\/\/(?:www\.)?drive\.google\.com\//i.test(url)) {
    return url;
  }

  const pathMatch = url.match(/\/file\/d\/([^/?#]+)/i);
  const queryMatch = url.match(/[?&]id=([^&#]+)/i);
  const encodedId = pathMatch && pathMatch[1] ||
    queryMatch && queryMatch[1] || '';

  if (!encodedId) {
    return url;
  }

  let fileId = encodedId;

  try {
    fileId = decodeURIComponent(encodedId);
  } catch (error) {
    // Keep the original ID when an old URL contains invalid escaping.
  }

  return `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`;
}

/**
 * Reads and validates the MTO catalog. MTO Item ID is the sole identity.
 */
function checkoutReadMto32Catalog_() {
  const spreadsheet = checkoutGetSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(
      CHECKOUT_CONFIG.mto32.sheetName);

  if (!sheet) {
    throw new Error(
        `Missing MTO source sheet: ${CHECKOUT_CONFIG.mto32.sheetName}`);
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastColumn < 1) {
    throw new Error('The MTO source sheet has no headers.');
  }

  const values = sheet
      .getRange(1, 1, Math.max(1, lastRow), lastColumn)
      .getValues();
  const displays = sheet
      .getRange(1, 1, Math.max(1, lastRow), lastColumn)
      .getDisplayValues();
  const index = checkoutHeaderIndex_(displays[0]);
  const headerNames = CHECKOUT_CONFIG.mto32.headers;
  const columns = {};

  Object.keys(headerNames).forEach((field) => {
    columns[field] = checkoutFindSourceColumn_(
        index,
        headerNames[field]);

    if (columns[field] < 0) {
      throw new Error(
          `Missing MTO header: ${headerNames[field][0]}`);
    }
  });

  const items = [];
  const byKey = {};

  for (let offset = 1; offset < displays.length; offset += 1) {
    const displayRow = displays[offset];

    if (displayRow.every((value) => !checkoutClean_(value))) {
      continue;
    }

    const sourceItemId = checkoutClean_(
        displayRow[columns.itemId]);

    if (!sourceItemId) {
      throw new Error(
          `${CHECKOUT_CONFIG.mto32.sheetName}!${offset + 1} ` +
          `is missing ${headerNames.itemId[0]}.`);
    }

    const itemKey = checkoutMtoItemKey_(sourceItemId);

    if (byKey[itemKey]) {
      throw new Error(
          `Duplicate ${headerNames.itemId[0]} in ` +
          `${CHECKOUT_CONFIG.mto32.sheetName}: ${sourceItemId}.`);
    }

    const priceText = checkoutClean_(
        displayRow[columns.price]);

    if (!priceText) {
      throw new Error(
          `Missing Price for MTO item ${sourceItemId}.`);
    }

    const price = checkoutMoney_(
        values[offset][columns.price]);
    const stock = checkoutMtoWholeNumber_(
        values[offset][columns.stock],
        'Stock',
        sourceItemId);
    const sold = checkoutMtoWholeNumberDefault_(
        values[offset][columns.sold],
        'Sold',
        sourceItemId,
        0);
    const left = checkoutMtoWholeNumberDefault_(
        values[offset][columns.left],
        'Left',
        sourceItemId,
        stock - sold);

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(
          `Invalid Price for MTO item ${sourceItemId}.`);
    }

    const imageUrls = checkoutClean_(
        displayRow[columns.imageUrl])
        .split(/[\r\n;|]+/)
        .map(checkoutClean_)
        .filter(Boolean);
    const item = {
      mode: CHECKOUT_CONFIG.modes.mto32,
      checkoutMode: CHECKOUT_CONFIG.modes.mto32,
      catalogMode: CHECKOUT_CONFIG.modes.mto32,
      itemKey,
      sourceSheetName: CHECKOUT_CONFIG.mto32.sheetName,
      sourceItemId,
      marketItemId: sourceItemId,
      sourceRow: offset + 1,
      sourceLocation: checkoutClean_(
          displayRow[columns.location]),
      productId: '',
      variantId: '',
      inventoryItemId: '',
      sku: sourceItemId,
      productTitle: checkoutClean_(
          displayRow[columns.englishName]),
      chineseName: checkoutClean_(
          displayRow[columns.chineseName]),
      variantTitle: checkoutClean_(
          displayRow[columns.option]),
      price,
      available: left,
      tracked: false,
      vendor: '',
      productStatus: '',
      imageUrl:
        checkoutNormalizeCatalogImageUrl_(imageUrls[0] || ''),
      imageAlt: checkoutClean_(
          displayRow[columns.englishName]) || sourceItemId,
      stock,
      left,
      sold,
    };

    byKey[itemKey] = item;
    items.push(item);
  }

  return {sheet, columns, items, byKey};
}

/**
 * Resolves only the MTO identity and inventory columns. Rollback must not be
 * blocked by an unrelated row's price, image, name, or temporarily invalid
 * calculated inventory value.
 */
function checkoutReadMto32IdentityIndex_(sourceItemIds) {
  const spreadsheet = checkoutGetSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(
      CHECKOUT_CONFIG.mto32.sheetName);

  if (!sheet) {
    throw new Error(
        `Missing MTO source sheet: ${CHECKOUT_CONFIG.mto32.sheetName}`);
  }

  const lastColumn = sheet.getLastColumn();

  if (lastColumn < 1) {
    throw new Error('The MTO source sheet has no headers.');
  }

  const index = checkoutHeaderIndex_(
      sheet.getRange(1, 1, 1, lastColumn)
          .getDisplayValues()[0]);
  const headerNames = CHECKOUT_CONFIG.mto32.headers;
  const columns = {};

  ['itemId', 'stock', 'left', 'sold'].forEach((field) => {
    columns[field] = checkoutFindSourceColumn_(
        index,
        headerNames[field]);

    if (columns[field] < 0) {
      throw new Error(
          `Missing MTO header: ${headerNames[field][0]}`);
    }
  });

  const byKey = {};
  const requestedKeys = {};

  (sourceItemIds || []).forEach((sourceItemId) => {
    const key = checkoutMtoItemKey_(sourceItemId);

    if (key) {
      requestedKeys[key] = true;
    }
  });

  const restrictToRequested =
    Object.keys(requestedKeys).length > 0;
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const ids = sheet
        .getRange(2, columns.itemId + 1, lastRow - 1, 1)
        .getDisplayValues();

    ids.forEach((row, offset) => {
      const sourceItemId = checkoutClean_(row[0]);

      if (!sourceItemId) {
        return;
      }

      const key = checkoutMtoItemKey_(sourceItemId);

      if (restrictToRequested && !requestedKeys[key]) {
        return;
      }

      if (byKey[key]) {
        throw new Error(
            `Duplicate ${headerNames.itemId[0]} in ` +
            `${CHECKOUT_CONFIG.mto32.sheetName}: ${sourceItemId}.`);
      }

      byKey[key] = {
        sourceItemId,
        rowNumber: offset + 2,
      };
    });
  }

  return {sheet, columns, byKey};
}

/**
 * Finds exact Shopify variant identities whose original-sheet Chinese name or
 * brand contains the search term. Shopify remains the source for the returned
 * price, image and live inventory quantity.
 */
function checkoutFindSourceCatalogMatches_(searchText, limit) {
  const term = checkoutNormalizeSearch_(searchText);

  if (!term) {
    return [];
  }

  const maximum = Math.max(1, Number(limit) || 50);
  const spreadsheet = checkoutGetSpreadsheet_();
  const matchesByVariantId = {};

  spreadsheet.getSheets().some((sheet) => {
    if (!checkoutIsCatalogSourceSheet_(sheet)) {
      return false;
    }

    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();

    if (lastRow < 2 || lastColumn < 1) {
      return false;
    }

    const values = sheet
        .getRange(1, 1, lastRow, lastColumn)
        .getDisplayValues();
    const index = checkoutHeaderIndex_(values[0]);
    const variantGidColumn = checkoutFindSourceColumn_(
        index,
        ['Shopify Variant GID']);
    const chineseNameColumn = checkoutFindSourceColumn_(
        index,
        ['Chinese Name', 'Chinese', '中文名稱']);
    const brandColumn = checkoutFindSourceColumn_(
        index,
        ['Brand', '品牌']);
    const imageUrlColumn = checkoutFindSourceColumn_(
        index,
        ['Image URL', 'Image URLs', 'Image Src', 'Image']);

    if (
      variantGidColumn < 0 ||
      (chineseNameColumn < 0 && brandColumn < 0)
    ) {
      return false;
    }

    for (let offset = 1; offset < values.length; offset += 1) {
      const row = values[offset];
      const variantId = checkoutClean_(row[variantGidColumn]);
      const chineseName = chineseNameColumn >= 0
        ? checkoutClean_(row[chineseNameColumn])
        : '';
      const vendor = brandColumn >= 0
        ? checkoutClean_(row[brandColumn])
        : '';
      const sourceImageUrls = imageUrlColumn >= 0
        ? checkoutClean_(row[imageUrlColumn])
            .split(/[\r\n;|]+/)
            .map((value) => checkoutClean_(value))
            .filter(Boolean)
        : [];
      const haystack = checkoutNormalizeSearch_(
          `${chineseName} ${vendor}`);

      if (
        /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId) &&
        haystack.indexOf(term) !== -1 &&
        !matchesByVariantId[variantId]
      ) {
        matchesByVariantId[variantId] = {
          variantId,
          chineseName,
          vendor,
          imageUrl: sourceImageUrls[0] || '',
        };
      }

      if (Object.keys(matchesByVariantId).length >= maximum) {
        return true;
      }
    }

    return false;
  });

  return Object.keys(matchesByVariantId)
      .map((variantId) => matchesByVariantId[variantId])
      .slice(0, maximum);
}

function findCheckoutOrders(searchText) {
  const term = checkoutNormalizeSearch_(searchText);
  const groups = checkoutReadOrderGroups_();

  return Object.keys(groups)
      .map((orderId) => {
        return checkoutOrderFromRows_(groups[orderId]);
      })
      .filter((order) => {
        if (!term) {
          return true;
        }

        const haystack = checkoutNormalizeSearch_([
          order.orderId,
          order.customerName,
          order.customerPhone,
          order.customerEmail,
          order.cashier,
          (order.items || [])
              .map((item) => {
                return [
                  item.sku,
                  item.sourceItemId,
                  item.productTitle,
                  item.chineseName,
                  item.variantTitle,
                ].join(' ');
              })
              .join(' '),
        ].join(' '));

        return haystack.indexOf(term) !== -1;
      })
      .sort((left, right) => {
        return checkoutDateNumber_(right.updatedAt) -
          checkoutDateNumber_(left.updatedAt);
      })
      .slice(0, 50)
      .map((order) => ({
        orderId: order.orderId,
        mode: order.mode,
        checkoutMode: order.mode,
        status: order.status,
        version: order.version,
        transactionDate: order.transactionDate,
        customerName: order.customerName,
        cashier: order.cashier,
        orderTotal: order.orderTotal,
        itemCount: (order.items || []).length,
        updatedAt: order.updatedAt,
        receiptUrl: order.receiptUrl,
      }));
}

function loadCheckoutOrder(orderId) {
  const order = checkoutLoadOrder_(orderId);

  if (!order) {
    throw new Error(
        `Order not found: ${checkoutClean_(orderId)}`);
  }

  order.requestKey = Utilities.getUuid();
  return order;
}

/**
 * Creates or edits an ACTIVE order.
 *
 * Inventory is adjusted by the difference between the previous and new cart.
 * A deterministic Shopify idempotency key prevents a retried request from
 * applying the same delta twice.
 */
function saveCheckoutOrder(inputModel) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const incoming = inputModel || {};
    const sheet = checkoutEnsureSheet_();
    const submittedOrderId =
      checkoutClean_(incoming.orderId);

    const previous = submittedOrderId
      ? checkoutLoadOrder_(submittedOrderId)
      : null;
    const incomingMode = checkoutNormalizeMode_(
        incoming.checkoutMode || incoming.mode);

    if (
      previous &&
      checkoutNormalizeMode_(previous.mode) !== incomingMode
    ) {
      throw new Error(
          'An existing order cannot be changed to another checkout mode.');
    }

    const orderMode = previous
      ? checkoutNormalizeMode_(previous.mode)
      : incomingMode;

    if (
      previous &&
      previous.status ===
        CHECKOUT_CONFIG.statuses.cancelled
    ) {
      throw new Error(
          'A cancelled order cannot be edited.');
    }

    const requestKey =
      checkoutClean_(incoming.requestKey) ||
      Utilities.getUuid();

    if (
      previous &&
      previous.lastRequestKey === requestKey
    ) {
      previous.requestKey = Utilities.getUuid();

      return {
        ok: true,
        order: previous,
        warnings: [
          'This save request had already completed and was not repeated.',
        ],
      };
    }

    const submittedVersion = Number(
        incoming.version || 0);

    if (
      previous &&
      submittedVersion !== previous.version
    ) {
      throw new Error(
          'This order was changed elsewhere. Reload it before saving.');
    }

    const draftKey =
      checkoutClean_(incoming.draftKey) ||
      Utilities.getUuid();

    const transactionDateText = checkoutClean_(
        incoming.transactionDate);

    if (!transactionDateText) {
      throw new Error(
          'Transaction date is required.');
    }

    const transactionDate =
      checkoutParseClientDate_(transactionDateText);

    const orderId = previous
      ? previous.orderId
      : checkoutOrderId_(transactionDate, draftKey, orderMode);

    if (!previous) {
      const sameDraft = checkoutFindOrderByDraftKey_(
          draftKey);

      if (sameDraft) {
        sameDraft.requestKey = Utilities.getUuid();

        return {
          ok: true,
          order: sameDraft,
          warnings: [
            'This new order had already completed and was not repeated.',
          ],
        };
      }

      if (checkoutLoadOrder_(orderId)) {
        throw new Error(
            `Order ID collision: ${orderId}. Open a fresh checkout form.`);
      }
    }

    const now = new Date();
    const version = previous
      ? previous.version + 1
      : 1;

    const order = {
      orderId,
      mode: orderMode,
      checkoutMode: orderMode,
      status: CHECKOUT_CONFIG.statuses.active,
      version,
      draftKey,
      lastRequestKey: requestKey,
      requestKey: Utilities.getUuid(),
      createdAt:
        previous && previous.createdAt
          ? previous.createdAt
          : checkoutFormatClientDate_(now),
      updatedAt: checkoutFormatClientDate_(now),
      cancelledAt: '',
      cancelledBy: '',
      cancellationReason: '',
      transactionDate:
        checkoutFormatClientDate_(transactionDate),
      cashier: checkoutClean_(incoming.cashier),
      customerName:
        checkoutClean_(incoming.customerName),
      customerPhone:
        checkoutClean_(incoming.customerPhone),
      customerEmail:
        checkoutClean_(incoming.customerEmail),
      paymentMethod:
        checkoutClean_(incoming.paymentMethod),
      notes: checkoutClean_(incoming.notes),
      items: checkoutNormalizeOrderItems_(
          incoming.items,
          orderMode),
      receiptImages: [],
      receiptUrl: '',
      receiptFileId: '',
      receiptFolderId: '',
      inventoryResult: '',
      sourceSalesApplied: true,
      orderTotal: 0,
      lastAction:
        previous ? 'UPDATED' : 'CREATED',
    };

    checkoutValidateOrderHeader_(order);
    checkoutHydrateTrustedItems_(order);
    checkoutCalculateTotals_(order);

    const sourcePlan =
      checkoutBuildSourceInventoryPlan_(
          previous,
          order);

    const imagePlan = checkoutBuildImagePlan_(
        previous,
        incoming.receiptImages);

    if (
      imagePlan.retained.length +
        imagePlan.newImages.length === 0
    ) {
      throw new Error(
          'Upload at least one receipt image.');
    }

    if (
      imagePlan.retained.length +
        imagePlan.newImages.length >
        CHECKOUT_CONFIG.maxImages
    ) {
      throw new Error(
          `A receipt can contain at most ` +
          `${CHECKOUT_CONFIG.maxImages} images.`);
    }

    const folder = checkoutGetOrderFolder_(
        order,
        previous && previous.receiptFolderId);

    const uploaded = checkoutSaveNewImages_(
        folder,
        order,
        imagePlan.newImages);

    order.receiptImages =
      imagePlan.retained.concat(uploaded);

    order.receiptFolderId = folder.getId();

    let inventoryResult = null;
    let ledgerWritten = false;
    let sourceWriteAttempted = false;

    try {
      inventoryResult =
        checkoutApplySourceInventoryPlan_(
            sourcePlan,
            order,
            'save');

      order.inventoryResult = inventoryResult.message;

      sourceWriteAttempted = true;
      checkoutApplySourceInventoryPlanToSheets_(
          sourcePlan);

      const receipt = checkoutCreateReceiptPdf_(
          folder,
          order);

      order.receiptFileId = receipt.id;
      order.receiptUrl = receipt.url;

      checkoutWriteOrder_(sheet, order);
      ledgerWritten = true;

      // A filter-layout problem must not roll back a successfully saved order.
      try {
        checkoutRefreshSheetFilter_(sheet);
      } catch (filterError) {
        console.warn(filterError);
      }
    } catch (error) {
      if (!ledgerWritten) {
        const rollbackErrors = [];

        if (sourceWriteAttempted) {
          try {
            checkoutRestoreSourceInventoryPlan_(
                sourcePlan);
          } catch (sourceRollbackError) {
            rollbackErrors.push(
                `sheet rollback: ${sourceRollbackError.message}`);
          }
        }

        if (
          inventoryResult &&
          inventoryResult.changes.length > 0
        ) {
          try {
            checkoutCompensateInventory_(
                inventoryResult,
                order,
                'save',
                requestKey);
          } catch (compensationError) {
            rollbackErrors.push(
                `Shopify rollback: ${compensationError.message}`);
          }
        }

        if (rollbackErrors.length > 0) {
          throw new Error(
              `${error.message} CRITICAL: ${rollbackErrors.join(' | ')}`);
        }

        return {
          ok: false,
          message:
            orderMode === CHECKOUT_CONFIG.modes.mto32
              ? `${error.message} MTO Left/Sold changes were rolled back; ` +
                'you can safely try saving again.'
              : `${error.message} Sheet sales and Shopify inventory were ` +
                'rolled back; you can safely try saving again.',
          retryRequestKey: Utilities.getUuid(),
        };
      }

      throw error;
    }

    const warnings = [];

    imagePlan.removed.forEach((image) => {
      try {
        checkoutTrashOwnedReceiptImage_(
            folder,
            order.orderId,
            image);
      } catch (error) {
        warnings.push(
            `Could not remove ${image.name || image.id}: ` +
            error.message);
      }
    });

    SpreadsheetApp.flush();

    const saved = checkoutLoadOrder_(order.orderId) || order;
    saved.requestKey = Utilities.getUuid();

    return {
      ok: true,
      order: saved,
      warnings,
    };
  } finally {
    lock.releaseLock();
  }
}

function cancelCheckoutOrder(
    orderId,
    reason,
    submittedVersion,
    submittedRequestKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const previous = checkoutLoadOrder_(orderId);

    if (!previous) {
      throw new Error(
          `Order not found: ${checkoutClean_(orderId)}`);
    }

    if (
      previous.status ===
      CHECKOUT_CONFIG.statuses.cancelled
    ) {
      previous.requestKey = Utilities.getUuid();
      return {
        ok: true,
        order: previous,
        warnings: [
          'The order was already cancelled.',
        ],
      };
    }

    if (
      Number(submittedVersion) !==
      previous.version
    ) {
      throw new Error(
          'This order was changed elsewhere. Reload it before cancelling.');
    }

    const cancellationReason =
      checkoutClean_(reason);

    if (!cancellationReason) {
      throw new Error(
          'Enter a cancellation reason.');
    }

    const now = new Date();
    const cancellationRequestKey =
      checkoutClean_(submittedRequestKey) ||
      Utilities.getUuid();

    const cancelled = Object.assign(
        {},
        previous,
        {
          status:
            CHECKOUT_CONFIG.statuses.cancelled,
          version: previous.version + 1,
          lastRequestKey:
            `cancel:${cancellationRequestKey}`,
          requestKey: Utilities.getUuid(),
          updatedAt: checkoutFormatClientDate_(now),
          cancelledAt: checkoutFormatClientDate_(now),
          cancelledBy:
            Session.getActiveUser().getEmail() ||
            previous.cashier,
          cancellationReason,
          sourceSalesApplied: false,
          lastAction: 'CANCELLED',
        });

    const folder = checkoutGetOrderFolder_(
        cancelled,
        previous.receiptFolderId);

    const sourcePlan =
      checkoutBuildSourceInventoryPlan_(
          previous,
          null);

    let inventoryResult = null;
    let ledgerWritten = false;
    let sourceWriteAttempted = false;

    try {
      inventoryResult =
        checkoutApplySourceInventoryPlan_(
            sourcePlan,
            cancelled,
            'cancel',
            cancellationRequestKey);

      cancelled.inventoryResult =
        inventoryResult.message;

      sourceWriteAttempted = true;
      checkoutApplySourceInventoryPlanToSheets_(
          sourcePlan);

      const receipt = checkoutCreateReceiptPdf_(
          folder,
          cancelled);

      cancelled.receiptFileId = receipt.id;
      cancelled.receiptUrl = receipt.url;

      const sheet = checkoutEnsureSheet_();
      checkoutWriteOrder_(sheet, cancelled);
      ledgerWritten = true;

      try {
        checkoutRefreshSheetFilter_(sheet);
      } catch (filterError) {
        console.warn(filterError);
      }
    } catch (error) {
      if (!ledgerWritten) {
        const rollbackErrors = [];

        if (sourceWriteAttempted) {
          try {
            checkoutRestoreSourceInventoryPlan_(
                sourcePlan);
          } catch (sourceRollbackError) {
            rollbackErrors.push(
                `sheet rollback: ${sourceRollbackError.message}`);
          }
        }

        if (
          inventoryResult &&
          inventoryResult.changes.length > 0
        ) {
          try {
            checkoutCompensateInventory_(
                inventoryResult,
                cancelled,
                'cancel',
                cancellationRequestKey);
          } catch (compensationError) {
            rollbackErrors.push(
                `Shopify rollback: ${compensationError.message}`);
          }
        }

        if (rollbackErrors.length > 0) {
          throw new Error(
              `${error.message} CRITICAL: ${rollbackErrors.join(' | ')}`);
        }

        return {
          ok: false,
          message:
            checkoutNormalizeMode_(cancelled.mode) ===
              CHECKOUT_CONFIG.modes.mto32
              ? `${error.message} MTO Left/Sold changes were rolled back; ` +
                'you can safely try cancelling again.'
              : `${error.message} Sheet sales and Shopify inventory were ` +
                'rolled back; you can safely try cancelling again.',
          retryRequestKey: Utilities.getUuid(),
        };
      }

      throw error;
    }

    SpreadsheetApp.flush();

    const saved =
      checkoutLoadOrder_(previous.orderId) ||
      cancelled;

    saved.requestKey = Utilities.getUuid();

    return {
      ok: true,
      order: saved,
      warnings: [],
    };
  } finally {
    lock.releaseLock();
  }
}

function checkoutNormalizeOrderItems_(items, mode) {
  const normalizedMode = checkoutNormalizeMode_(mode);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? 'Add at least one MTO item.'
          : 'Add at least one Shopify variant.');
  }

  const seen = {};

  return items.map((raw, index) => {
    const item = raw || {};
    const variantId =
      checkoutClean_(item.variantId);
    const sourceItemId = checkoutClean_(
        item.marketItemId || item.sourceItemId || item.mtoItemId ||
        (normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? item.sku
          : ''));
    const identityKey =
      normalizedMode === CHECKOUT_CONFIG.modes.mto32
        ? checkoutMtoItemKey_(sourceItemId)
        : variantId;

    if (
      normalizedMode === CHECKOUT_CONFIG.modes.mto32 &&
      !sourceItemId
    ) {
      throw new Error(
          `Item ${index + 1} has no MTO Item ID. ` +
          'Choose it from MTO catalog search.');
    }

    if (
      normalizedMode === CHECKOUT_CONFIG.modes.standard &&
      !variantId
    ) {
      throw new Error(
          `Item ${index + 1} has no Shopify Variant GID. ` +
          'Choose it from catalog search.');
    }

    if (seen[identityKey]) {
      throw new Error(
          `The same item appears more than once: ` +
          `${sourceItemId || checkoutClean_(item.sku) || variantId}`);
    }

    seen[identityKey] = true;

    const quantity = Number(item.quantity);
    const unitPrice = checkoutMoney_(item.unitPrice);
    const submittedDiscountType =
      checkoutClean_(item.discountType).toLowerCase();

    const discountType =
      submittedDiscountType === 'percentage'
        ? 'percentage'
        : submittedDiscountType === 'amount'
          ? 'amount'
          : 'none';

    const discountValue = discountType === 'none'
      ? 0
      : checkoutMoney_(item.discountValue || 0);

    if (
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      throw new Error(
          `Item ${index + 1} quantity must be a positive whole number.`);
    }

    if (
      !Number.isFinite(unitPrice) ||
      unitPrice < 0
    ) {
      throw new Error(
          `Item ${index + 1} has an invalid price.`);
    }

    if (
      !Number.isFinite(discountValue) ||
      discountValue < 0
    ) {
      throw new Error(
          `Item ${index + 1} has an invalid discount.`);
    }

    if (
      discountType === 'percentage' &&
      discountValue > 100
    ) {
      throw new Error(
          `Item ${index + 1} percentage discount cannot exceed 100.`);
    }

    const rawSubtotal =
      checkoutRoundMoney_(quantity * unitPrice);

    if (
      discountType === 'amount' &&
      discountValue > rawSubtotal
    ) {
      throw new Error(
          `Item ${index + 1} discount exceeds its subtotal.`);
    }

    return {
      mode: normalizedMode,
      checkoutMode: normalizedMode,
      catalogMode: normalizedMode,
      itemKey:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? checkoutMtoItemKey_(sourceItemId)
          : `SHOPIFY:${variantId}`,
      sourceSheetName:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? CHECKOUT_CONFIG.mto32.sheetName
          : checkoutClean_(item.sourceSheetName),
      sourceItemId:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? sourceItemId
          : checkoutClean_(item.sourceItemId),
      marketItemId:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? sourceItemId
          : checkoutClean_(item.marketItemId),
      sourceLocation:
        checkoutClean_(item.sourceLocation || item.location),
      chineseName: checkoutClean_(item.chineseName),
      imageUrl: checkoutClean_(item.imageUrl),
      productId:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? ''
          : checkoutClean_(item.productId),
      variantId:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? ''
          : variantId,
      inventoryItemId:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? ''
          : checkoutClean_(item.inventoryItemId),
      sku:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? sourceItemId
          : checkoutClean_(item.sku),
      productTitle:
        checkoutClean_(item.productTitle),
      variantTitle:
        checkoutClean_(item.variantTitle),
      quantity,
      unitPrice,
      discountType,
      discountValue,
      lineTotal: 0,
      tracked:
        normalizedMode === CHECKOUT_CONFIG.modes.mto32
          ? false
          : item.tracked !== false,
      available:
        item.available == null
          ? null
          : Number(item.available),
    };
  });
}

function checkoutValidateOrderHeader_(order) {
  const missing = [];

  if (!order.cashier) {
    missing.push('cashier');
  }

  if (!order.customerName) {
    missing.push('customer name');
  }

  if (!order.paymentMethod) {
    missing.push('payment method');
  }

  if (missing.length) {
    throw new Error(
        `Missing required field(s): ${missing.join(', ')}`);
  }

  if (
    order.customerEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        order.customerEmail)
  ) {
    throw new Error(
        'Customer email is invalid.');
  }
}

/**
 * Re-reads every variant from Shopify so IDs, titles, SKUs and tracking state
 * are never trusted from browser-submitted values.
 */
function checkoutHydrateTrustedItems_(order) {
  if (
    checkoutNormalizeMode_(order && order.mode) ===
    CHECKOUT_CONFIG.modes.mto32
  ) {
    checkoutHydrateTrustedMto32Items_(order);
    return;
  }

  checkoutHydrateTrustedVariants_(order);
}

/**
 * Re-reads MTO rows using MTO Item ID. This deliberately makes no Shopify
 * request and leaves every Shopify identity blank.
 */
function checkoutHydrateTrustedMto32Items_(order) {
  const catalog = checkoutReadMto32Catalog_();

  order.items.forEach((item, index) => {
    const key = checkoutMtoItemKey_(
        item.marketItemId || item.sourceItemId || item.sku);
    const trusted = catalog.byKey[key];

    if (!trusted) {
      throw new Error(
          `MTO item no longer exists for item ${index + 1}: ` +
          `${item.sourceItemId || item.sku || '(missing ID)'}.`);
    }

    item.mode = CHECKOUT_CONFIG.modes.mto32;
    item.checkoutMode = CHECKOUT_CONFIG.modes.mto32;
    item.catalogMode = CHECKOUT_CONFIG.modes.mto32;
    item.itemKey = trusted.itemKey;
    item.sourceSheetName = CHECKOUT_CONFIG.mto32.sheetName;
    item.sourceItemId = trusted.sourceItemId;
    item.marketItemId = trusted.sourceItemId;
    item.sourceLocation = trusted.sourceLocation;
    item.chineseName = trusted.chineseName;
    item.imageUrl = trusted.imageUrl;
    item.productId = '';
    item.variantId = '';
    item.inventoryItemId = '';
    item.sku = trusted.sourceItemId;
    item.productTitle = trusted.productTitle;
    item.variantTitle = trusted.variantTitle;
    item.tracked = false;
    item.available = trusted.left;
  });
}

function checkoutHydrateTrustedVariants_(order) {
  const ids = order.items.map((item) => {
    return item.variantId;
  });

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);

  const query = `
    query CheckoutTrustedVariants(
      $ids: [ID!]!,
      $locationId: ID!
    ) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          sku
          product {
            id
            title
            status
          }
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  `;

  const data = shopifyGraphql_(
      query,
      {ids, locationId});

  const nodes = Array.isArray(data.nodes)
    ? data.nodes
    : [];

  const byId = {};

  nodes.filter(Boolean).forEach((variant) => {
    byId[variant.id] = variant;
  });

  order.items.forEach((item, index) => {
    const variant = byId[item.variantId];

    if (!variant) {
      throw new Error(
          `Shopify variant no longer exists for item ${index + 1}.`);
    }

    const inventoryItem =
      variant.inventoryItem || {};

    item.productId =
      variant.product && variant.product.id ||
      item.productId;
    item.productTitle =
      variant.product && variant.product.title ||
      item.productTitle;
    item.variantTitle =
      variant.title === 'Default Title'
        ? ''
        : variant.title;
    item.sku = variant.sku || item.sku;
    item.inventoryItemId =
      inventoryItem.id || '';
    item.tracked = Boolean(inventoryItem.tracked);
    item.available = checkoutAvailableFromLevel_(
        inventoryItem.inventoryLevel || null);

    if (
      item.tracked &&
      !item.inventoryItemId
    ) {
      throw new Error(
          `Tracked variant has no inventory identity: ` +
          `${item.sku || item.variantId}`);
    }
  });
}

function checkoutCalculateTotals_(order) {
  let total = 0;

  order.items.forEach((item) => {
    const raw = checkoutRoundMoney_(
        item.quantity * item.unitPrice);

    const discount =
      item.discountType === 'percentage'
        ? checkoutRoundMoney_(
            raw * item.discountValue / 100)
        : item.discountType === 'amount'
          ? item.discountValue
          : 0;

    item.lineTotal = checkoutRoundMoney_(
        Math.max(0, raw - discount));

    total = checkoutRoundMoney_(
        total + item.lineTotal);
  });

  order.orderTotal = total;
}

function checkoutBuildImagePlan_(previous, submittedImages) {
  const previousImages =
    previous &&
    Array.isArray(previous.receiptImages)
      ? previous.receiptImages
      : [];

  const previousById = {};

  previousImages.forEach((image) => {
    if (image.id) {
      previousById[image.id] = image;
    }
  });

  const retained = [];
  const newImages = [];
  const submitted = Array.isArray(submittedImages)
    ? submittedImages
    : [];

  submitted.forEach((image) => {
    const candidate = image || {};

    if (candidate.base64) {
      newImages.push(
          checkoutValidateNewImage_(candidate));
      return;
    }

    const id = checkoutClean_(candidate.id);

    if (
      id &&
      candidate.removed !== true &&
      previousById[id]
    ) {
      retained.push(previousById[id]);
    }
  });

  const retainedIds = {};
  retained.forEach((image) => {
    retainedIds[image.id] = true;
  });

  const removed = previousImages.filter((image) => {
    return image.id && !retainedIds[image.id];
  });

  const totalNewImageBytes = newImages.reduce((total, image) => {
    return total + image.bytes.length;
  }, 0);

  if (totalNewImageBytes > CHECKOUT_CONFIG.maxTotalImageBytes) {
    throw new Error(
        'The new receipt images are too large together. ' +
        `Keep the combined upload below ` +
        `${Math.round(CHECKOUT_CONFIG.maxTotalImageBytes / 1024 / 1024)} MB.`);
  }

  return {retained, newImages, removed};
}

function checkoutValidateNewImage_(image) {
  const mime = checkoutClean_(image.mime)
      .toLowerCase();

  if (
    CHECKOUT_CONFIG.allowedImageTypes.indexOf(
        mime) === -1
  ) {
    throw new Error(
        `Unsupported receipt image type: ${mime || '(missing)'}`);
  }

  let base64 = checkoutClean_(image.base64);
  base64 = base64.replace(
      /^data:[^;]+;base64,/i,
      '');

  let bytes;

  try {
    bytes = Utilities.base64Decode(base64);
  } catch (error) {
    throw new Error(
        'A receipt image is not valid base64 data.');
  }

  if (bytes.length === 0) {
    throw new Error(
        'A receipt image is empty.');
  }

  if (bytes.length > CHECKOUT_CONFIG.maxImageBytes) {
    throw new Error(
        `Receipt image ${checkoutClean_(image.name)} exceeds ` +
        `${(CHECKOUT_CONFIG.maxImageBytes / 1024 / 1024).toFixed(1)} MB.`);
  }

  return {
    name: checkoutSafeFilePart_(
        image.name || 'receipt.jpg'),
    mime,
    base64,
    bytes,
  };
}

function checkoutSaveNewImages_(
    folder,
    order,
    images) {
  return images.map((image, index) => {
    const extension = checkoutImageExtension_(
        image.mime);

    const fileName =
      `${order.orderId}-R${order.version}-photo-` +
      `${String(index + 1).padStart(2, '0')}.${extension}`;

    checkoutTrashFilesByName_(folder, fileName);

    const blob = Utilities.newBlob(
        image.bytes,
        image.mime,
        fileName);

    const file = folder.createFile(blob);

    return {
      id: file.getId(),
      name: file.getName(),
      url: file.getUrl(),
      thumbnailUrl:
        `https://drive.google.com/thumbnail?id=` +
        `${encodeURIComponent(file.getId())}&sz=w800`,
    };
  });
}

function checkoutTrashOwnedReceiptImage_(
    folder,
    orderId,
    image) {
  const file = DriveApp.getFileById(image.id);
  const parents = file.getParents();
  let belongsToOrderFolder = false;

  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) {
      belongsToOrderFolder = true;
      break;
    }
  }

  const expectedPrefix =
    `${checkoutSafeFilePart_(orderId)}-R`;

  if (
    !belongsToOrderFolder ||
    file.getName().indexOf(expectedPrefix) !== 0 ||
    file.getName().indexOf('-photo-') === -1
  ) {
    throw new Error(
        'The file is not an owned image in this order folder.');
  }

  file.setTrashed(true);
}

/**
 * Builds the source-sheet sales transaction for a checkout change.
 *
 * Sold changes by new order quantity minus the quantity already represented
 * in Sold. Inventory is always derived as Stock + Purchased - Sold. Existing
 * orders created before this feature have a blank sourceSalesApplied flag, so
 * editing them imports their current quantities into Sold exactly once, while
 * cancelling them restores Shopify to the current sheet formula without
 * making Sold negative.
 */
function checkoutBuildSourceInventoryPlan_(
    previous,
    next) {
  const mode = checkoutNormalizeMode_(
      next && next.mode || previous && previous.mode);

  if (mode === CHECKOUT_CONFIG.modes.mto32) {
    return checkoutBuildMto32InventoryPlan_(previous, next);
  }

  const spreadsheet = checkoutGetSpreadsheet_();
  const previousQuantities =
    previous && previous.sourceSalesApplied === true
      ? checkoutVariantQuantities_(previous)
      : {};
  const nextQuantities = checkoutVariantQuantities_(next);
  const items = {};

  [previous, next].forEach((order) => {
    (order && order.items || []).forEach((item) => {
      const key = checkoutVariantIdentityKey_(item);

      if (key) {
        items[key] = item;
      }
    });
  });

  const usedSourceRows = {};

  return Object.keys(items).map((key) => {
    const item = items[key];
    const deltaSold =
      Number(nextQuantities[key] || 0) -
      Number(previousQuantities[key] || 0);
    const target = checkoutResolveCatalogSourceRow_(
        spreadsheet,
        item);
    const targetKey =
      `${target.sheetName}!${target.rowNumber}`;

    if (usedSourceRows[targetKey]) {
      throw new Error(
          `More than one Shopify variant resolves to ${targetKey}. ` +
          'Give every variant its own source row before checkout.');
    }

    usedSourceRows[targetKey] = true;

    const columns = checkoutEnsureSourceInventoryColumns_(
        target.sheet);
    const stockCell = checkoutCaptureSourceCell_(
        target.sheet,
        target.rowNumber,
        columns.stock);
    const purchasedCell = checkoutCaptureSourceCell_(
        target.sheet,
        target.rowNumber,
        columns.purchased);
    const soldCell = checkoutCaptureSourceCell_(
        target.sheet,
        target.rowNumber,
        columns.sold);
    const inventoryCell = checkoutCaptureSourceCell_(
        target.sheet,
        target.rowNumber,
        columns.inventory);

    const purchased = checkoutSourceWholeNumber_(
        purchasedCell.value,
        'Purchased',
        item);
    const currentSold = checkoutSourceWholeNumber_(
        soldCell.value,
        'Sold',
        item);
    const inventoryValue = checkoutOptionalWholeNumber_(
        inventoryCell.value,
        'Inventory',
        item);
    let stock = checkoutOptionalWholeNumber_(
        stockCell.value,
        'Stock',
        item);
    let inferredStock = false;

    if (stock === null) {
      if (inventoryValue === null) {
        throw new Error(
            `Source row ${targetKey} has neither Stock nor Inventory for ` +
            `${item.sku || item.variantId}.`);
      }

      stock = inventoryValue - purchased + currentSold;
      inferredStock = true;
    }

    const newSold = currentSold + deltaSold;
    const newInventory = stock + purchased - newSold;

    if (!Number.isInteger(newSold) || newSold < 0) {
      throw new Error(
          `Checkout would make Sold invalid for ${item.sku || item.variantId} ` +
          `on ${targetKey}: ${newSold}.`);
    }

    if (!Number.isInteger(newInventory) || newInventory < 0) {
      throw new Error(
          `Insufficient calculated inventory for ` +
          `${item.sku || item.variantId} on ${targetKey}. ` +
          `Stock ${stock} + Purchased ${purchased} - Sold ${newSold} = ` +
          `${newInventory}.`);
    }

    return {
      item: {
        variantId: checkoutClean_(item.variantId),
        inventoryItemId:
          checkoutClean_(item.inventoryItemId),
        sku: checkoutClean_(item.sku),
        tracked: item.tracked !== false,
      },
      sheetName: target.sheetName,
      rowNumber: target.rowNumber,
      columns,
      original: {
        stock: stockCell,
        purchased: purchasedCell,
        sold: soldCell,
        inventory: inventoryCell,
      },
      stock,
      purchased,
      currentSold,
      newSold,
      newInventory,
      deltaSold,
      inferredStock,
    };
  });
}

function checkoutVariantQuantities_(order) {
  const quantities = {};

  if (
    !order ||
    order.status === CHECKOUT_CONFIG.statuses.cancelled
  ) {
    return quantities;
  }

  (order.items || []).forEach((item) => {
    const key = checkoutVariantIdentityKey_(item);

    if (key) {
      quantities[key] =
        Number(quantities[key] || 0) +
        Number(item.quantity || 0);
    }
  });

  return quantities;
}

/**
 * Builds reversible MTO Left/Sold changes. Stock is read-only and Shopify is
 * intentionally absent from this transaction.
 */
function checkoutBuildMto32InventoryPlan_(previous, next) {
  const catalog = checkoutReadMto32Catalog_();
  const previousQuantities =
    previous && previous.sourceSalesApplied === true
      ? checkoutVariantQuantities_(previous)
      : {};
  const nextQuantities = checkoutVariantQuantities_(next);
  const items = {};

  [previous, next].forEach((order) => {
    (order && order.items || []).forEach((item) => {
      const key = checkoutVariantIdentityKey_(item);

      if (key) {
        items[key] = item;
      }
    });
  });

  return Object.keys(items).map((key) => {
    const item = items[key];
    const trusted = catalog.byKey[key];

    if (!trusted) {
      throw new Error(
          `No MTO source row was found for ` +
          `${item.sourceItemId || item.sku || key}.`);
    }

    const rowNumber = trusted.sourceRow;
    const stockCell = checkoutCaptureSourceCell_(
        catalog.sheet,
        rowNumber,
        catalog.columns.stock);
    const leftCell = checkoutCaptureSourceCell_(
        catalog.sheet,
        rowNumber,
        catalog.columns.left);
    const soldCell = checkoutCaptureSourceCell_(
        catalog.sheet,
        rowNumber,
        catalog.columns.sold);

    if (soldCell.formula) {
      throw new Error(
          `MTO Sold must be an editable value, not a formula: ` +
          `${trusted.sourceItemId}.`);
    }

    const stock = checkoutMtoWholeNumber_(
        stockCell.value,
        'Stock',
        trusted.sourceItemId);
    const currentLeft = checkoutMtoWholeNumber_(
        checkoutClean_(leftCell.value) === ''
          ? stock - checkoutMtoWholeNumberDefault_(
              soldCell.value,
              'Sold',
              trusted.sourceItemId,
              0)
          : leftCell.value,
        'Left',
        trusted.sourceItemId);
    const currentSold = checkoutMtoWholeNumberDefault_(
        soldCell.value,
        'Sold',
        trusted.sourceItemId,
        0);
    const deltaSold =
      Number(nextQuantities[key] || 0) -
      Number(previousQuantities[key] || 0);
    const newSold = currentSold + deltaSold;
    const newLeft = currentLeft - deltaSold;

    if (!Number.isInteger(newSold) || newSold < 0) {
      throw new Error(
          `Checkout would make MTO Sold invalid for ` +
          `${trusted.sourceItemId}: ${newSold}.`);
    }

    if (!Number.isInteger(newLeft) || newLeft < 0) {
      throw new Error(
          `Insufficient MTO Left for ${trusted.sourceItemId}. ` +
          `Available ${currentLeft}, requested change ${deltaSold}.`);
    }

    return {
      kind: CHECKOUT_CONFIG.modes.mto32,
      item: {
        mode: CHECKOUT_CONFIG.modes.mto32,
        itemKey: key,
        sourceItemId: trusted.sourceItemId,
        sourceSheetName: CHECKOUT_CONFIG.mto32.sheetName,
        sku: trusted.sourceItemId,
        tracked: false,
      },
      sheetName: CHECKOUT_CONFIG.mto32.sheetName,
      rowNumber,
      columns: catalog.columns,
      original: {
        stock: stockCell,
        left: leftCell,
        sold: soldCell,
      },
      stock,
      currentLeft,
      currentSold,
      newLeft,
      newSold,
      deltaSold,
      writeApplied: false,
      soldWriteApplied: false,
      leftWriteApplied: false,
      expectedAfter: {
        sold: {
          value: newSold,
          formula: '',
        },
        left: {
          value: newLeft,
          formula: leftCell.formula || '',
        },
      },
    };
  });
}

function checkoutVariantIdentityKey_(item) {
  const explicitKey = checkoutClean_(
      item && item.itemKey);
  const sourceItemId = checkoutClean_(
      item && (item.marketItemId || item.sourceItemId || item.mtoItemId));
  const rawMode = checkoutClean_(
      item && (item.mode || item.checkoutMode || item.catalogMode));
  const isMto =
    explicitKey.indexOf('MTO32:') === 0 ||
    rawMode.toUpperCase() === CHECKOUT_CONFIG.modes.mto32;

  if (isMto) {
    return sourceItemId
      ? checkoutMtoItemKey_(sourceItemId)
      : explicitKey;
  }

  const variantId = checkoutClean_(
      item && item.variantId);
  const sku = checkoutClean_(item && item.sku)
      .toUpperCase();

  return variantId
    ? `GID:${variantId}`
    : sku
      ? `SKU:${sku}`
      : '';
}

function checkoutResolveCatalogSourceRow_(
    spreadsheet,
    item) {
  const variantId = checkoutClean_(item.variantId);
  const sku = checkoutClean_(item.sku).toUpperCase();
  const gidMatches = [];
  const skuMatches = [];

  spreadsheet.getSheets().forEach((sheet) => {
    if (!checkoutIsCatalogSourceSheet_(sheet)) {
      return;
    }

    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();

    if (lastRow < 2 || lastColumn < 1) {
      return;
    }

    const values = sheet
        .getRange(1, 1, lastRow, lastColumn)
        .getDisplayValues();
    const index = checkoutHeaderIndex_(values[0]);
    const gidColumn = checkoutFindSourceColumn_(
        index,
        ['Shopify Variant GID']);
    const skuColumn = checkoutFindSourceColumn_(
        index,
        ['SKU', 'Variant SKU']);

    values.slice(1).forEach((row, offset) => {
      const match = {
        sheet,
        sheetName: sheet.getName(),
        rowNumber: offset + 2,
      };

      if (
        variantId &&
        gidColumn >= 0 &&
        checkoutClean_(row[gidColumn]) === variantId
      ) {
        gidMatches.push(match);
      }

      if (
        sku &&
        skuColumn >= 0 &&
        checkoutClean_(row[skuColumn]).toUpperCase() === sku
      ) {
        skuMatches.push(match);
      }
    });
  });

  if (gidMatches.length === 1) {
    return gidMatches[0];
  }

  if (gidMatches.length > 1) {
    throw new Error(
        `Shopify Variant GID appears in ${gidMatches.length} source rows: ` +
        `${variantId}.`);
  }

  if (skuMatches.length === 1) {
    return skuMatches[0];
  }

  if (skuMatches.length > 1) {
    throw new Error(
        `SKU appears in ${skuMatches.length} source rows: ${sku}. ` +
        'Add the exact Shopify Variant GID to identify one row.');
  }

  throw new Error(
      `No original product-sheet row was found for ` +
      `${sku || variantId || '(unknown variant)'}.`);
}

function checkoutIsCatalogSourceSheet_(sheet) {
  const name = checkoutClean_(sheet.getName());

  if (
    name === CHECKOUT_CONFIG.sheetName ||
    name.toUpperCase().indexOf('__MYK_REVIEW_') === 0 ||
    /^shopify\s.*(?:review|preview|import)/i.test(name)
  ) {
    return false;
  }

  if (sheet.getLastColumn() < 1) {
    return false;
  }

  const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0];
  const index = checkoutHeaderIndex_(headers);

  return (
    checkoutFindSourceColumn_(
        index,
        ['Shopify Variant GID']) >= 0 ||
    checkoutFindSourceColumn_(
        index,
        ['SKU', 'Variant SKU']) >= 0
  );
}

function checkoutFindSourceColumn_(index, aliases) {
  for (let offset = 0; offset < aliases.length; offset += 1) {
    const column = index[checkoutHeaderKey_(aliases[offset])];

    if (column !== undefined) {
      return column;
    }
  }

  return -1;
}

function checkoutEnsureSourceInventoryColumns_(sheet) {
  const definitions = {
    stock: ['Stock'],
    purchased: ['Purchased'],
    sold: ['Sold'],
    inventory: ['Inventory'],
  };
  let headers = sheet
      .getRange(1, 1, 1, Math.max(1, sheet.getLastColumn()))
      .getDisplayValues()[0];
  let index = checkoutHeaderIndex_(headers);
  const result = {};

  Object.keys(definitions).forEach((field) => {
    let column = checkoutFindSourceColumn_(
        index,
        definitions[field]);

    if (column < 0) {
      column = sheet.getLastColumn();
      sheet.getRange(1, column + 1)
          .setValue(definitions[field][0])
          .setFontWeight('bold');
      headers = headers.concat(definitions[field][0]);
      index = checkoutHeaderIndex_(headers);
    }

    result[field] = column;
  });

  return result;
}

function checkoutCaptureSourceCell_(sheet, row, column) {
  const range = sheet.getRange(row, column + 1);

  return {
    value: range.getValue(),
    formula: range.getFormula(),
  };
}

function checkoutOptionalWholeNumber_(value, field, item) {
  if (checkoutClean_(value) === '') {
    return null;
  }

  const parsed = Number(
      checkoutClean_(value).replace(/,/g, ''));

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
        `${field} must be a non-negative whole number for ` +
        `${item.sku || item.variantId}.`);
  }

  return parsed;
}

function checkoutSourceWholeNumber_(value, field, item) {
  const parsed = checkoutOptionalWholeNumber_(
      value,
      field,
      item);

  return parsed === null ? 0 : parsed;
}

function checkoutApplySourceInventoryPlanToSheets_(plan) {
  if (!plan || plan.length === 0) {
    return;
  }

  if (
    plan.length > 0 &&
    plan.every((entry) => {
      return entry.kind === CHECKOUT_CONFIG.modes.mto32;
    })
  ) {
    checkoutApplyMto32InventoryPlanToSheet_(plan);
    return;
  }

  const spreadsheet = checkoutGetSpreadsheet_();

  plan.forEach((entry) => {
    const currentTarget = checkoutResolveCatalogSourceRow_(
        spreadsheet,
        entry.item);

    if (
      currentTarget.sheetName !== entry.sheetName
    ) {
      throw new Error(
          `The source row for ${entry.item.sku || entry.item.variantId} ` +
          'moved to another sheet during checkout. Try again.');
    }

    entry.rowNumber = currentTarget.rowNumber;
    const sheet = currentTarget.sheet;
    const columns = checkoutEnsureSourceInventoryColumns_(sheet);
    const currentCells = {
      stock: checkoutCaptureSourceCell_(
          sheet,
          entry.rowNumber,
          columns.stock),
      purchased: checkoutCaptureSourceCell_(
          sheet,
          entry.rowNumber,
          columns.purchased),
      sold: checkoutCaptureSourceCell_(
          sheet,
          entry.rowNumber,
          columns.sold),
      inventory: checkoutCaptureSourceCell_(
          sheet,
          entry.rowNumber,
          columns.inventory),
    };
    const sourceChanged = Object.keys(currentCells)
        .some((field) => {
          return !checkoutSourceCellMatches_(
              currentCells[field],
              entry.original[field]);
        });

    if (sourceChanged) {
      throw new Error(
          `Stock, Purchased, Sold, or Inventory changed for ` +
          `${entry.item.sku || entry.item.variantId} ` +
          'while checkout was running. Try again.');
    }

    entry.columns = columns;

    if (entry.inferredStock) {
      sheet.getRange(
          entry.rowNumber,
          columns.stock + 1).setValue(entry.stock);
    }

    // Purchased is an input to the calculation, not a checkout output. Keep
    // an existing value or formula intact; initialize only a genuinely blank
    // cell so this sync never destroys the merchant's purchase calculation.
    if (
      !entry.original.purchased.formula &&
      checkoutClean_(entry.original.purchased.value) === ''
    ) {
      sheet.getRange(
          entry.rowNumber,
          columns.purchased + 1)
          .setValue(0);
    }
    sheet.getRange(
        entry.rowNumber,
        columns.sold + 1)
        .setValue(entry.newSold);

    const inventoryColumn = columns.inventory + 1;
    const stockOffset = columns.stock - columns.inventory;
    const purchasedOffset =
      columns.purchased - columns.inventory;
    const soldOffset = columns.sold - columns.inventory;

    sheet.getRange(entry.rowNumber, inventoryColumn)
        .setFormulaR1C1(
            `=RC[${stockOffset}]+RC[${purchasedOffset}]-` +
            `RC[${soldOffset}]`)
        .setNumberFormat('0');
  });

  SpreadsheetApp.flush();
}

function checkoutApplyMto32InventoryPlanToSheet_(plan) {
  const catalog = checkoutReadMto32IdentityIndex_(
      plan.map((entry) => entry.item.sourceItemId));

  plan.forEach((entry) => {
    const key = checkoutMtoItemKey_(entry.item.sourceItemId);
    const trusted = catalog.byKey[key];

    if (!trusted) {
      throw new Error(
          `MTO item moved or was removed during checkout: ` +
          `${entry.item.sourceItemId}.`);
    }

    entry.rowNumber = trusted.rowNumber;
    const currentCells = {
      stock: checkoutCaptureSourceCell_(
          catalog.sheet,
          entry.rowNumber,
          catalog.columns.stock),
      left: checkoutCaptureSourceCell_(
          catalog.sheet,
          entry.rowNumber,
          catalog.columns.left),
      sold: checkoutCaptureSourceCell_(
          catalog.sheet,
          entry.rowNumber,
          catalog.columns.sold),
    };

    if (
      !checkoutSourceCellMatches_(currentCells.stock, entry.original.stock) ||
      !checkoutSourceCellMatches_(currentCells.left, entry.original.left) ||
      !checkoutSourceCellMatches_(currentCells.sold, entry.original.sold)
    ) {
      throw new Error(
          `Stock, Left, or Sold changed for MTO item ` +
          `${entry.item.sourceItemId} while checkout was running. Try again.`);
    }

    catalog.sheet
        .getRange(entry.rowNumber, catalog.columns.sold + 1)
        .setValue(entry.newSold);
    entry.writeApplied = true;
    entry.soldWriteApplied = true;

    if (!entry.original.left.formula) {
      catalog.sheet
          .getRange(entry.rowNumber, catalog.columns.left + 1)
          .setValue(entry.newLeft);
      entry.leftWriteApplied = true;
    }
  });

  SpreadsheetApp.flush();

  plan.forEach((entry) => {
    const sold = checkoutMtoWholeNumber_(
        catalog.sheet
            .getRange(entry.rowNumber, catalog.columns.sold + 1)
            .getValue(),
        'Sold',
        entry.item.sourceItemId);
    const left = checkoutMtoWholeNumber_(
        catalog.sheet
            .getRange(entry.rowNumber, catalog.columns.left + 1)
            .getValue(),
        'Left',
        entry.item.sourceItemId);

    if (sold !== entry.newSold || left !== entry.newLeft) {
      throw new Error(
          `MTO inventory verification failed for ` +
          `${entry.item.sourceItemId}: expected Left ${entry.newLeft}, ` +
          `Sold ${entry.newSold}; got Left ${left}, Sold ${sold}.`);
    }
  });
}

function checkoutSourceCellMatches_(left, right) {
  const leftFormula = checkoutClean_(left && left.formula);
  const rightFormula = checkoutClean_(right && right.formula);

  if (leftFormula !== rightFormula) {
    return false;
  }

  const leftValue = left ? left.value : '';
  const rightValue = right ? right.value : '';

  if (
    typeof leftValue === 'number' ||
    typeof rightValue === 'number'
  ) {
    return Number(leftValue) === Number(rightValue);
  }

  return checkoutClean_(leftValue) ===
    checkoutClean_(rightValue);
}

function checkoutRestoreSourceInventoryPlan_(plan) {
  if (!plan || plan.length === 0) {
    return;
  }

  if (
    plan.length > 0 &&
    plan.every((entry) => {
      return entry.kind === CHECKOUT_CONFIG.modes.mto32;
    })
  ) {
    checkoutRestoreMto32InventoryPlan_(plan);
    return;
  }

  const spreadsheet = checkoutGetSpreadsheet_();
  const errors = [];

  plan.slice().reverse().forEach((entry) => {
    try {
      const target = checkoutResolveCatalogSourceRow_(
          spreadsheet,
          entry.item);
      const columns = checkoutEnsureSourceInventoryColumns_(
          target.sheet);

      checkoutRestoreSourceCell_(
          target.sheet,
          target.rowNumber,
          columns.stock,
          entry.original.stock);
      checkoutRestoreSourceCell_(
          target.sheet,
          target.rowNumber,
          columns.purchased,
          entry.original.purchased);
      checkoutRestoreSourceCell_(
          target.sheet,
          target.rowNumber,
          columns.sold,
          entry.original.sold);
      checkoutRestoreSourceCell_(
          target.sheet,
          target.rowNumber,
          columns.inventory,
          entry.original.inventory);
    } catch (error) {
      errors.push(
          `${entry.sheetName}!${entry.rowNumber}: ${error.message}`);
    }
  });

  SpreadsheetApp.flush();

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
}

function checkoutRestoreMto32InventoryPlan_(plan) {
  const writtenEntries = plan.filter((entry) => {
    return entry.writeApplied === true;
  });

  if (writtenEntries.length === 0) {
    return;
  }

  const catalog = checkoutReadMto32IdentityIndex_(
      writtenEntries.map((entry) => entry.item.sourceItemId));
  const errors = [];

  writtenEntries.slice().reverse().forEach((entry) => {
    try {
      const trusted = catalog.byKey[
          checkoutMtoItemKey_(entry.item.sourceItemId)];

      if (!trusted) {
        throw new Error('source row no longer exists');
      }

      const currentSold = checkoutCaptureSourceCell_(
          catalog.sheet,
          trusted.rowNumber,
          catalog.columns.sold);
      const currentLeft = checkoutCaptureSourceCell_(
          catalog.sheet,
          trusted.rowNumber,
          catalog.columns.left);
      const soldIsExpected = checkoutSourceCellMatches_(
          currentSold,
          entry.expectedAfter.sold);
      const soldIsOriginal = checkoutSourceCellMatches_(
          currentSold,
          entry.original.sold);

      if (!soldIsExpected && !soldIsOriginal) {
        throw new Error(
            'Sold changed again after checkout; rollback refused to ' +
            'overwrite the newer value');
      }

      if (entry.original.left.formula) {
        if (
          checkoutClean_(currentLeft.formula) !==
          checkoutClean_(entry.original.left.formula)
        ) {
          throw new Error(
              'Left formula changed after checkout; rollback refused to ' +
              'overwrite the newer formula');
        }
      } else if (entry.leftWriteApplied) {
        const leftIsExpected = checkoutSourceCellMatches_(
            currentLeft,
            entry.expectedAfter.left);
        const leftIsOriginal = checkoutSourceCellMatches_(
            currentLeft,
            entry.original.left);

        if (!leftIsExpected && !leftIsOriginal) {
          throw new Error(
              'Left changed again after checkout; rollback refused to ' +
              'overwrite the newer value');
        }

        if (leftIsExpected) {
          checkoutRestoreSourceCell_(
              catalog.sheet,
              trusted.rowNumber,
              catalog.columns.left,
              entry.original.left);
        }
      }

      if (soldIsExpected) {
        checkoutRestoreSourceCell_(
            catalog.sheet,
            trusted.rowNumber,
            catalog.columns.sold,
            entry.original.sold);
      }

      entry.writeApplied = false;
      entry.soldWriteApplied = false;
      entry.leftWriteApplied = false;
    } catch (error) {
      errors.push(
          `${entry.item.sourceItemId}: ${error.message}`);
    }
  });

  SpreadsheetApp.flush();

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
}

function checkoutRestoreSourceCell_(
    sheet,
    row,
    column,
    original) {
  const range = sheet.getRange(row, column + 1);

  if (original && original.formula) {
    range.setFormula(original.formula);
  } else {
    range.setValue(original ? original.value : '');
  }
}

/**
 * Aligns Shopify available quantities to the source-sheet formula targets.
 * It calculates a compare-and-swap delta from the current Shopify quantity,
 * so a checkout is never decremented once by the sheet and again by Shopify.
 */
function checkoutApplySourceInventoryPlan_(
    plan,
    order,
    action,
    operationKey) {
  if (
    checkoutNormalizeMode_(order && order.mode) ===
    CHECKOUT_CONFIG.modes.mto32
  ) {
    return {
      message:
        `MTO_SOURCE_UPDATED: ${plan.length}; SHOPIFY_SKIPPED`,
      changes: [],
    };
  }

  const trackedEntries = plan.filter((entry) => {
    return entry.item.tracked !== false;
  });

  trackedEntries.forEach((entry) => {
    if (!entry.item.inventoryItemId) {
      throw new Error(
          `Tracked item has no Shopify inventory identity: ` +
          `${entry.item.sku || entry.item.variantId}.`);
    }
  });

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);
  const states = checkoutReadInventoryStates_(
      trackedEntries.map((entry) => {
        return entry.item.inventoryItemId;
      }),
      locationId);
  const seenInventoryItems = {};
  const changes = [];

  trackedEntries.forEach((entry) => {
    const inventoryItemId =
      entry.item.inventoryItemId;

    if (seenInventoryItems[inventoryItemId]) {
      throw new Error(
          `Shopify inventory item is mapped more than once: ` +
          `${entry.item.sku || inventoryItemId}.`);
    }

    seenInventoryItems[inventoryItemId] = true;
    const state = states[inventoryItemId];

    if (!state || !state.tracked || !state.levelExists) {
      throw new Error(
          `Shopify inventory is unavailable for ` +
          `${entry.item.sku || inventoryItemId}.`);
    }

    const delta = entry.newInventory - state.available;

    if (delta !== 0) {
      changes.push({
        inventoryItemId,
        delta,
        changeFromQuantity: state.available,
      });
    }
  });

  if (changes.length === 0) {
    return {
      message:
        `SOURCE_UPDATED: ${plan.length}; SHOPIFY_ALREADY_ALIGNED`,
      changes: [],
    };
  }

  const idempotencyKey = checkoutUuidFromText_([
    order.orderId,
    order.version,
    action,
    operationKey || order.lastRequestKey || '',
    'source-aligned',
  ].join(':'));
  const referenceDocumentUri =
    `mouthyukyuk-checkout://order/` +
    `${encodeURIComponent(order.orderId)}/` +
    `v${order.version}/source-aligned`;
  const result = checkoutCommitInventoryDeltas_(
      changes,
      locationId,
      idempotencyKey,
      referenceDocumentUri);

  return {
    message:
      `SOURCE_UPDATED: ${plan.length}; ` +
      `SHOPIFY_INVENTORY_SYNCED: ${changes.length}`,
    changes,
    group: result.inventoryAdjustmentGroup || null,
  };
}

function checkoutApplyInventoryTransition_(
    previous,
    next,
    action,
    operationKey) {
  const oldQuantities =
    checkoutInventoryQuantities_(previous);

  const newQuantities =
    checkoutInventoryQuantities_(next);

  const inventoryIds = {};

  Object.keys(oldQuantities).forEach((id) => {
    inventoryIds[id] = true;
  });

  Object.keys(newQuantities).forEach((id) => {
    inventoryIds[id] = true;
  });

  const deltas = Object.keys(inventoryIds)
      .map((inventoryItemId) => ({
        inventoryItemId,
        delta:
          Number(oldQuantities[inventoryItemId] || 0) -
          Number(newQuantities[inventoryItemId] || 0),
      }))
      .filter((change) => change.delta !== 0);

  if (deltas.length === 0) {
    return {
      message: 'INVENTORY_NOT_CHANGED',
      changes: [],
    };
  }

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);

  const states = checkoutReadInventoryStates_(
      deltas.map((change) => {
        return change.inventoryItemId;
      }),
      locationId);

  deltas.forEach((change) => {
    const state = states[change.inventoryItemId];

    if (!state) {
      throw new Error(
          `Shopify inventory item not found: ` +
          change.inventoryItemId);
    }

    if (!state.tracked) {
      throw new Error(
          `Shopify inventory is not tracked for SKU: ` +
          `${state.sku || change.inventoryItemId}`);
    }

    if (!state.levelExists) {
      throw new Error(
          `No inventory level exists at the configured location for SKU: ` +
          `${state.sku || change.inventoryItemId}`);
    }

    if (
      change.delta < 0 &&
      state.available + change.delta < 0
    ) {
      throw new Error(
          `Insufficient inventory for ${state.sku || change.inventoryItemId}. ` +
          `Available: ${state.available}; requested change: ${change.delta}.`);
    }

    // Shopify rejects the mutation if another writer changes this quantity
    // between our read and write, preventing an accidental oversell.
    change.changeFromQuantity = state.available;
  });

  const baseOrder = next || previous;
  const operationVersion = next
    ? next.version
    : previous.version + 1;

  const idempotencyKey = checkoutUuidFromText_([
    baseOrder.orderId,
    operationVersion,
    action,
    operationKey || next && next.lastRequestKey || '',
  ].join(':'));

  const referenceDocumentUri =
    `mouthyukyuk-checkout://order/` +
    `${encodeURIComponent(baseOrder.orderId)}/` +
    `v${operationVersion}`;

  const result = checkoutCommitInventoryDeltas_(
      deltas,
      locationId,
      idempotencyKey,
      referenceDocumentUri);

  return {
    message:
      `INVENTORY_ADJUSTED: ${deltas.length} item(s)`,
    changes: deltas,
    group:
      result.inventoryAdjustmentGroup || null,
  };
}

function checkoutCommitInventoryDeltas_(
    deltas,
    locationId,
    idempotencyKey,
    referenceDocumentUri) {

  const mutation = `
    mutation CheckoutAdjustInventory(
      $input: InventoryAdjustQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventoryAdjustQuantities(input: $input)
        @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          id
          createdAt
          reason
          referenceDocumentUri
          changes {
            name
            delta
            quantityAfterChange
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const data = shopifyGraphql_(
      mutation,
      {
        input: {
          reason: 'correction',
          name: 'available',
          referenceDocumentUri,
          changes: deltas.map((change) => {
            const input = {
              inventoryItemId:
                change.inventoryItemId,
              locationId,
              delta: change.delta,
              // Shopify 2026-07 requires this field to be present. A number
              // enables CAS protection; null is an explicit opt-out used only
              // by callers that did not supply an expected quantity.
              changeFromQuantity:
                change.changeFromQuantity == null ||
                change.changeFromQuantity === ''
                  ? null
                  : Number(change.changeFromQuantity),
            };

            return input;
          }),
        },
        idempotencyKey,
      });

  const result = data.inventoryAdjustQuantities;

  if (!result) {
    throw new Error(
        'Shopify returned no inventory adjustment result.');
  }

  throwUserErrors_(
      result.userErrors,
      'inventoryAdjustQuantities');

  return result;
}

function checkoutCompensateInventory_(
    inventoryResult,
    order,
    action,
    operationKey) {
  const changes = inventoryResult &&
    Array.isArray(inventoryResult.changes)
      ? inventoryResult.changes
      : [];

  if (changes.length === 0) {
    return;
  }

  const reverseDeltas = changes.map((change) => ({
    inventoryItemId: change.inventoryItemId,
    delta: -Number(change.delta),
    // The first mutation expected changeFromQuantity and then applied delta,
    // so its resulting quantity is the safe CAS value for compensation.
    changeFromQuantity:
      change.changeFromQuantity == null ||
      change.changeFromQuantity === ''
        ? null
        : Number(change.changeFromQuantity) +
          Number(change.delta),
  }));

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);

  const compensationKey = checkoutUuidFromText_([
    order.orderId,
    order.version,
    action,
    operationKey || '',
    'compensation',
  ].join(':'));

  const referenceDocumentUri =
    `mouthyukyuk-checkout://order/` +
    `${encodeURIComponent(order.orderId)}/` +
    `v${order.version}/compensation`;

  checkoutCommitInventoryDeltas_(
      reverseDeltas,
      locationId,
      compensationKey,
      referenceDocumentUri);
}

function checkoutInventoryQuantities_(order) {
  const quantities = {};

  if (
    !order ||
    order.status ===
      CHECKOUT_CONFIG.statuses.cancelled
  ) {
    return quantities;
  }

  (order.items || []).forEach((item) => {
    if (
      item.tracked === false ||
      !item.inventoryItemId
    ) {
      return;
    }

    quantities[item.inventoryItemId] =
      Number(quantities[item.inventoryItemId] || 0) +
      Number(item.quantity || 0);
  });

  return quantities;
}

function checkoutReadInventoryStates_(
    inventoryItemIds,
    locationId) {
  const uniqueIds = Array.from(
      new Set(inventoryItemIds.filter(Boolean)));

  if (uniqueIds.length === 0) {
    return {};
  }

  const query = `
    query CheckoutInventoryStates(
      $ids: [ID!]!,
      $locationId: ID!
    ) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          sku
          tracked
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  `;

  const data = shopifyGraphql_(
      query,
      {ids: uniqueIds, locationId});

  const states = {};

  (data.nodes || [])
      .filter(Boolean)
      .forEach((inventoryItem) => {
        const level =
          inventoryItem.inventoryLevel || null;

        states[inventoryItem.id] = {
          id: inventoryItem.id,
          sku: inventoryItem.sku || '',
          tracked: Boolean(inventoryItem.tracked),
          levelExists: Boolean(level),
          available:
            level
              ? checkoutAvailableFromLevel_(level)
              : null,
        };
      });

  return states;
}

function checkoutAvailableFromLevel_(level) {
  if (!level) {
    return null;
  }

  const quantities = Array.isArray(level.quantities)
    ? level.quantities
    : [];

  const available = quantities.find((entry) => {
    return entry.name === 'available';
  });

  return available
    ? Number(available.quantity)
    : null;
}

function checkoutCreateReceiptPdf_(folder, order) {
  const fileName =
    `${order.orderId}-R${order.version}` +
    `${order.status === CHECKOUT_CONFIG.statuses.cancelled ? '-CANCELLED' : ''}.pdf`;

  checkoutTrashFilesByName_(folder, fileName);

  const html = HtmlService.createHtmlOutput(
      checkoutReceiptHtml_(order));

  const blob = html
      .getAs(MimeType.PDF)
      .setName(fileName);

  const file = folder.createFile(blob);

  return {
    id: file.getId(),
    url: file.getUrl(),
    name: file.getName(),
  };
}

function checkoutReceiptHtml_(order) {
  const itemRows = (order.items || [])
      .map((item) => {
        const name = [
          item.productTitle,
          item.variantTitle,
        ].filter(Boolean).join(' — ');

        const discountText = item.discountValue > 0
          ? item.discountType === 'percentage'
            ? `${checkoutMoneyText_(item.discountValue)}%`
            : `$${checkoutMoneyText_(item.discountValue)}`
          : '—';

        return `
          <tr>
            <td>
              <strong>${checkoutEscapeHtml_(name)}</strong>
              <div class="muted">${checkoutEscapeHtml_(item.sku)}</div>
            </td>
            <td class="number">${item.quantity}</td>
            <td class="number">$${checkoutMoneyText_(item.unitPrice)}</td>
            <td class="number">${discountText}</td>
            <td class="number">$${checkoutMoneyText_(item.lineTotal)}</td>
          </tr>
        `;
      })
      .join('');

  const imageLinks = (order.receiptImages || [])
      .map((image, index) => {
        return `
          <li>
            <a href="${checkoutEscapeAttribute_(image.url)}">
              ${checkoutEscapeHtml_(image.name || `Photo ${index + 1}`)}
            </a>
          </li>
        `;
      })
      .join('');

  const cancelled =
    order.status ===
    CHECKOUT_CONFIG.statuses.cancelled;

  return `
    <!DOCTYPE html>
    <html lang="zh-Hant">
      <head>
        <meta charset="utf-8">
        <style>
          body {
            margin: 34px;
            color: #202124;
            font: 12px Arial, sans-serif;
          }
          h1 { margin: 0 0 4px; font-size: 24px; }
          .header { display: flex; justify-content: space-between; }
          .status {
            display: inline-block;
            padding: 5px 9px;
            border: 1px solid ${cancelled ? '#c5221f' : '#188038'};
            border-radius: 999px;
            color: ${cancelled ? '#c5221f' : '#188038'};
            font-weight: bold;
          }
          .meta {
            display: grid;
            grid-template-columns: 130px 1fr;
            gap: 5px 10px;
            margin: 24px 0;
          }
          .label { color: #5f6368; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 9px 7px; border-bottom: 1px solid #dadce0; }
          th { text-align: left; background: #f8f9fa; }
          .number { text-align: right; }
          .total { margin-top: 15px; text-align: right; font-size: 18px; }
          .muted { margin-top: 3px; color: #5f6368; font-size: 10px; }
          .cancelled {
            margin: 18px 0;
            padding: 10px;
            border: 2px solid #c5221f;
            color: #c5221f;
          }
          .notes { white-space: pre-wrap; }
          a { color: #1769e0; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>Mouthyukyuk</h1>
            <div class="muted">Receipt / 收據</div>
          </div>
          <div class="status">${checkoutEscapeHtml_(order.status)}</div>
        </div>

        ${cancelled ? `
          <div class="cancelled">
            <strong>CANCELLED / 已取消</strong><br>
            ${checkoutEscapeHtml_(order.cancellationReason)}
          </div>
        ` : ''}

        <div class="meta">
          <div class="label">訂單編號</div>
          <div>${checkoutEscapeHtml_(order.orderId)}</div>
          <div class="label">交易時間</div>
          <div>${checkoutEscapeHtml_(checkoutDisplayDate_(order.transactionDate))}</div>
          <div class="label">顧客</div>
          <div>${checkoutEscapeHtml_(order.customerName)}</div>
          <div class="label">聯絡</div>
          <div>${checkoutEscapeHtml_([
            order.customerPhone,
            order.customerEmail,
          ].filter(Boolean).join(' / '))}</div>
          <div class="label">結帳員</div>
          <div>${checkoutEscapeHtml_(order.cashier)}</div>
          <div class="label">付款方式</div>
          <div>${checkoutEscapeHtml_(order.paymentMethod)}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th class="number">數量</th>
              <th class="number">單價</th>
              <th class="number">折扣</th>
              <th class="number">小計</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <div class="total">
          <strong>Total: $${checkoutMoneyText_(order.orderTotal)} HKD</strong>
        </div>

        ${order.notes ? `
          <h3>備註</h3>
          <div class="notes">${checkoutEscapeHtml_(order.notes)}</div>
        ` : ''}

        ${imageLinks ? `
          <h3>收據圖片</h3>
          <ol>${imageLinks}</ol>
        ` : ''}

        <p class="muted">
          Revision ${order.version} · Updated
          ${checkoutEscapeHtml_(checkoutDisplayDate_(order.updatedAt))}
        </p>
      </body>
    </html>
  `;
}

function checkoutEnsureSheet_() {
  const spreadsheet = checkoutGetSpreadsheet_();

  let sheet = spreadsheet.getSheetByName(
      CHECKOUT_CONFIG.sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
        CHECKOUT_CONFIG.sheetName);
  }

  let existingHeaders = sheet.getLastColumn() > 0
    ? sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getDisplayValues()[0]
    : [];

  const normalized = {};

  existingHeaders.forEach((header) => {
    normalized[checkoutHeaderKey_(header)] = true;
  });

  const missingHeaders = [];

  CHECKOUT_CONFIG.headers.forEach((header) => {
    const key = checkoutHeaderKey_(header);

    if (!normalized[key]) {
      missingHeaders.push(header);
      normalized[key] = true;
    }
  });

  if (missingHeaders.length > 0) {
    sheet
        .getRange(
            1,
            existingHeaders.length + 1,
            1,
            missingHeaders.length)
        .setValues([missingHeaders]);

    existingHeaders = existingHeaders.concat(
        missingHeaders);
  }

  sheet.setFrozenRows(1);
  sheet
      .getRange(1, 1, 1, existingHeaders.length)
      .setFontWeight('bold')
      .setBackground('#eef3f8');

  if (!sheet.getFilter()) {
    sheet
        .getRange(
            1,
            1,
            Math.max(1, sheet.getLastRow()),
            sheet.getLastColumn())
        .createFilter();
  }

  return sheet;
}

/**
 * Resolves the catalog spreadsheet in either bound-script or web-app context.
 */
function checkoutGetSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  const properties =
    PropertiesService.getScriptProperties();

  if (active) {
    properties.setProperty(
        CHECKOUT_CONFIG.spreadsheetIdProperty,
        active.getId());
    return active;
  }

  const spreadsheetId = properties.getProperty(
      CHECKOUT_CONFIG.spreadsheetIdProperty);

  if (!spreadsheetId) {
    throw new Error(
        'Checkout is not connected to a spreadsheet. Open the bound ' +
        'spreadsheet and choose Shopify Editor > Checkout once.');
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
        `Cannot open the configured checkout spreadsheet ` +
        `(${spreadsheetId}). Check sharing and authorization.`);
  }
}

function checkoutRefreshSheetFilter_(sheet) {
  const existing = sheet.getFilter();
  const lastRow = Math.max(1, sheet.getLastRow());
  const lastColumn = sheet.getLastColumn();

  if (existing) {
    const range = existing.getRange();

    if (
      range.getLastRow() >= lastRow &&
      range.getLastColumn() >= lastColumn
    ) {
      return;
    }
  }

  const criteria = {};

  if (existing) {
    const filteredLastColumn = existing
        .getRange()
        .getLastColumn();

    for (
      let column = 1;
      column <= filteredLastColumn;
      column += 1
    ) {
      const criterion = existing.getColumnFilterCriteria(
          column);

      if (criterion) {
        criteria[column] = criterion;
      }
    }

    existing.remove();
  }

  const refreshed = sheet
      .getRange(
          1,
          1,
          lastRow,
          lastColumn)
      .createFilter();

  Object.keys(criteria).forEach((column) => {
    refreshed.setColumnFilterCriteria(
        Number(column),
        criteria[column]);
  });
}

function checkoutWriteOrder_(sheet, order) {
  const records = order.items.map((item) => {
    return checkoutRecordForItem_(order, item);
  });

  // Resolve the current rows immediately before writing. Cached row numbers
  // can become stale if a cashier sorts or inserts rows while Shopify/Drive
  // operations are running.
  const existingRows = checkoutFindCurrentOrderRows_(
      sheet,
      order.orderId);
  const backupRows = existingRows.map((entry) => {
    return entry.preservedValues.slice();
  });
  const writeState = {applied: false};

  try {
    checkoutWriteOrderRows_(
        sheet,
        order,
        records,
        existingRows,
        writeState);
  } catch (error) {
    if (!writeState.applied) {
      throw error;
    }

    try {
      checkoutRestoreOrderLedgerRows_(
          sheet,
          order.orderId,
          backupRows);
    } catch (rollbackError) {
      throw new Error(
          `${error.message} CRITICAL: order-ledger rollback failed: ` +
          rollbackError.message);
    }

    throw error;
  }
}

function checkoutWriteOrderRows_(
    sheet,
    order,
    records,
    existingRows,
    writeState) {

  const rowsByItemKey = {};

  existingRows.forEach((entry) => {
    const key = checkoutClean_(entry.itemKey);

    if (!rowsByItemKey[key]) {
      rowsByItemKey[key] = [];
    }

    rowsByItemKey[key].push(entry);
  });

  const usedRows = {};
  const rowsToAppend = [];

  records.forEach((record) => {
    const itemKey = checkoutClean_(record['項目鍵']) ||
      checkoutLedgerItemKey_(
          record['訂單模式'],
          record['來源項目ID'],
          record['Shopify Variant GID']);

    const candidates = rowsByItemKey[itemKey] || [];
    const target = candidates.shift() || null;

    if (target) {
      const currentRow = sheet
          .getRange(target.rowNumber, 1, 1, sheet.getLastColumn())
          .getValues()[0];

      const currentOrderId = checkoutClean_(
          currentRow[target.orderColumn]);

      const currentItemKey = checkoutClean_(
          currentRow[target.itemKeyColumn]) ||
        checkoutLedgerItemKey_(
            currentRow[target.modeColumn],
            currentRow[target.sourceItemIdColumn],
            currentRow[target.variantColumn]);

      if (
        currentOrderId !== order.orderId ||
        currentItemKey !== target.itemKey
      ) {
        throw new Error(
            'The checkout sheet changed while this order was being saved. ' +
            'Reload the order and try again.');
      }

      sheet
          .getRange(
              target.rowNumber,
              1,
              1,
              sheet.getLastColumn())
          .setValues([
            checkoutRecordToRow_(
                sheet,
                record,
                target.preservedValues),
          ]);
      writeState.applied = true;

      usedRows[target.rowNumber] = true;
    } else {
      rowsToAppend.push(
          checkoutRecordToRow_(sheet, record, []));
    }
  });

  if (rowsToAppend.length > 0) {
    const startRow = Math.max(2, sheet.getLastRow() + 1);
    sheet
        .getRange(
            startRow,
            1,
            rowsToAppend.length,
            sheet.getLastColumn())
        .setValues(rowsToAppend);
    writeState.applied = true;
  }

  existingRows
      .filter((entry) => !usedRows[entry.rowNumber])
      .sort((left, right) => right.rowNumber - left.rowNumber)
      .forEach((entry) => {
        sheet.deleteRow(entry.rowNumber);
        writeState.applied = true;
      });
}

/**
 * Restores only the affected order after a partial multi-row ledger failure.
 * The rows may move to the end of the sheet, but their values and formulas are
 * preserved and unrelated orders are not rewritten.
 */
function checkoutRestoreOrderLedgerRows_(
    sheet,
    orderId,
    backupRows) {
  checkoutFindCurrentOrderRows_(sheet, orderId)
      .sort((left, right) => right.rowNumber - left.rowNumber)
      .forEach((entry) => {
        sheet.deleteRow(entry.rowNumber);
      });

  if (!backupRows || backupRows.length === 0) {
    return;
  }

  const startRow = Math.max(2, sheet.getLastRow() + 1);

  sheet
      .getRange(
          startRow,
          1,
          backupRows.length,
          sheet.getLastColumn())
      .setValues(backupRows);
}

function checkoutFindCurrentOrderRows_(sheet, orderId) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0];

  const index = checkoutHeaderIndex_(headers);
  const orderColumn = checkoutRequiredHeader_(
      index,
      '訂單編號');
  const variantColumn = checkoutRequiredHeader_(
      index,
      'Shopify Variant GID');
  const itemKeyColumn = checkoutRequiredHeader_(
      index,
      '項目鍵');
  const modeColumn = checkoutRequiredHeader_(
      index,
      '訂單模式');
  const sourceItemIdColumn = checkoutRequiredHeader_(
      index,
      '來源項目ID');

  const range = sheet.getRange(
      2,
      1,
      lastRow - 1,
      sheet.getLastColumn());

  const values = range.getValues();
  const formulas = range.getFormulas();
  const targetOrderId = checkoutClean_(orderId);
  const result = [];

  values.forEach((row, offset) => {
    if (checkoutClean_(row[orderColumn]) !== targetOrderId) {
      return;
    }

    result.push({
      rowNumber: offset + 2,
      orderColumn,
      variantColumn,
      itemKeyColumn,
      modeColumn,
      sourceItemIdColumn,
      itemKey:
        checkoutClean_(row[itemKeyColumn]) ||
        checkoutLedgerItemKey_(
            row[modeColumn],
            row[sourceItemIdColumn],
            row[variantColumn]),
      preservedValues: row.map((value, column) => {
        return formulas[offset][column] || value;
      }),
    });
  });

  return result;
}

function checkoutRecordForItem_(order, item) {
  const imageUrls = (order.receiptImages || [])
      .map((image) => image.url)
      .filter(Boolean);

  const imageIds = (order.receiptImages || [])
      .map((image) => image.id)
      .filter(Boolean);

  const imageNames = (order.receiptImages || [])
      .map((image) => image.name)
      .filter(Boolean);

  return {
    '訂單編號': order.orderId,
    '訂單模式': checkoutNormalizeMode_(order.mode),
    '訂單狀態': order.status,
    '版本': order.version,
    '草稿鍵': order.draftKey,
    '最後請求鍵': order.lastRequestKey,
    '建立時間': checkoutSheetDate_(order.createdAt),
    '更新時間': checkoutSheetDate_(order.updatedAt),
    '取消時間': checkoutSheetDate_(order.cancelledAt),
    '取消者': order.cancelledBy || '',
    '取消原因': order.cancellationReason || '',
    '交易時間': checkoutSheetDate_(order.transactionDate),
    '結帳員': order.cashier,
    '顧客名稱': order.customerName,
    '顧客電話': order.customerPhone,
    '顧客電郵': order.customerEmail,
    '付款方式': order.paymentMethod,
    '備註': order.notes,
    '項目鍵': checkoutLedgerItemKey_(
        order.mode,
        item.sourceItemId,
        item.variantId),
    '來源工作表': item.sourceSheetName || '',
    '來源項目ID': item.sourceItemId || '',
    '中文品名': item.chineseName || '',
    '來源位置': item.sourceLocation || '',
    '商品圖片': item.imageUrl || '',
    'Shopify Product GID': item.productId,
    'Shopify Variant GID': item.variantId,
    'Shopify Inventory Item GID': item.inventoryItemId,
    '庫存追蹤': item.tracked === false ? 'FALSE' : 'TRUE',
    'SKU': item.sku,
    '品名': item.productTitle,
    'Variant': item.variantTitle,
    '數量': item.quantity,
    '單價': item.unitPrice,
    '折扣類型': item.discountType,
    '折扣值': item.discountValue,
    '行總額': item.lineTotal,
    '收據圖片連結': imageUrls.join('\n'),
    '收據圖片ID': imageIds.join(','),
    '收據圖片名稱': imageNames.join('\n'),
    '收據圖片JSON': JSON.stringify(
        order.receiptImages || []),
    '收據資料夾ID': order.receiptFolderId,
    '收據PDF連結': order.receiptUrl,
    '收據PDF ID': order.receiptFileId,
    '庫存狀態': order.inventoryResult,
    '來源銷售已記錄':
      order.sourceSalesApplied === true
        ? 'TRUE'
        : 'FALSE',
    '訂單總額': order.orderTotal,
    '最後操作': order.lastAction,
  };
}

function checkoutRecordToRow_(sheet, record, preservedValues) {
  const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0];

  const normalizedRecord = {};

  Object.keys(record).forEach((header) => {
    normalizedRecord[checkoutHeaderKey_(header)] =
      record[header];
  });

  return headers.map((header, index) => {
    const key = checkoutHeaderKey_(header);

    return Object.prototype.hasOwnProperty.call(
        normalizedRecord,
        key)
      ? normalizedRecord[key]
      : preservedValues && index < preservedValues.length
        ? preservedValues[index]
        : '';
  });
}

function checkoutReadOrderGroups_() {
  const sheet = checkoutEnsureSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {};
  }

  const values = sheet
      .getRange(
          1,
          1,
          lastRow,
          sheet.getLastColumn())
      .getValues();

  const index = checkoutHeaderIndex_(values[0]);
  const orderColumn = checkoutRequiredHeader_(
      index,
      '訂單編號');

  const groups = {};

  values.slice(1).forEach((row, offset) => {
    const orderId = checkoutClean_(
        row[orderColumn]);

    if (!orderId) {
      return;
    }

    if (!groups[orderId]) {
      groups[orderId] = [];
    }

    groups[orderId].push({
      rowNumber: offset + 2,
      values: row,
      index,
    });
  });

  return groups;
}

function checkoutLoadOrder_(orderId) {
  const id = checkoutClean_(orderId);

  if (!id) {
    return null;
  }

  const groups = checkoutReadOrderGroups_();
  const order = groups[id]
    ? checkoutOrderFromRows_(groups[id])
    : null;

  checkoutAttachLiveMto32Availability_(order);
  return order;
}

/**
 * Adds the current MTO Item Left value when an order is loaded. Ledger history
 * remains readable even if the market sheet is temporarily unavailable or an
 * old item was removed; save/cancel still performs strict server validation.
 */
function checkoutAttachLiveMto32Availability_(order) {
  if (
    !order ||
    checkoutNormalizeMode_(order.mode) !==
      CHECKOUT_CONFIG.modes.mto32
  ) {
    return;
  }

  const items = order.items || [];

  items.forEach((item) => {
    item.available = '';
    item.liveAvailable = '';
  });

  try {
    const catalog = checkoutReadMto32IdentityIndex_(
        items.map((item) => item.sourceItemId || item.marketItemId));

    items.forEach((item) => {
      const trusted = catalog.byKey[
          checkoutMtoItemKey_(item.sourceItemId || item.marketItemId)];

      if (!trusted) {
        return;
      }

      const stock = checkoutMtoWholeNumber_(
          catalog.sheet
              .getRange(trusted.rowNumber, catalog.columns.stock + 1)
              .getValue(),
          'Stock',
          item.sourceItemId || item.sku);
      const sold = checkoutMtoWholeNumberDefault_(
          catalog.sheet
              .getRange(trusted.rowNumber, catalog.columns.sold + 1)
              .getValue(),
          'Sold',
          item.sourceItemId || item.sku,
          0);
      const left = checkoutMtoWholeNumberDefault_(
          catalog.sheet
              .getRange(trusted.rowNumber, catalog.columns.left + 1)
              .getValue(),
          'Left',
          item.sourceItemId || item.sku,
          stock - sold);

      const quantityAlreadyRecorded =
        order.status !== CHECKOUT_CONFIG.statuses.cancelled &&
        order.sourceSalesApplied === true
          ? Number(item.quantity || 0)
          : 0;

      item.liveAvailable = left;
      item.available = left + quantityAlreadyRecorded;
    });
  } catch (error) {
    console.warn(
        `Could not attach live MTO availability for ${order.orderId}: ` +
        error.message);
  }
}

function checkoutFindOrderByDraftKey_(draftKey) {
  const key = checkoutClean_(draftKey);

  if (!key) {
    return null;
  }

  const groups = checkoutReadOrderGroups_();
  const orderIds = Object.keys(groups);

  for (let index = 0; index < orderIds.length; index += 1) {
    const order = checkoutOrderFromRows_(
        groups[orderIds[index]]);

    if (order.draftKey === key) {
      return order;
    }
  }

  return null;
}

function checkoutOrderFromRows_(rows) {
  if (!rows || rows.length === 0) {
    return null;
  }

  const first = rows[0];
  const index = first.index;
  const get = (row, header) => {
    const column = checkoutRequiredHeader_(
        index,
        header);
    return row[column];
  };

  const base = first.values;
  const images = checkoutParseImages_(
      get(base, '收據圖片JSON'),
      get(base, '收據圖片ID'),
      get(base, '收據圖片名稱'),
      get(base, '收據圖片連結'));
  const ledgerOrderId = checkoutClean_(
      get(base, '訂單編號'));
  const storedMode = checkoutClean_(
      get(base, '訂單模式'));
  const historicalSourceItemId = checkoutClean_(
      get(base, '來源項目ID'));
  const ledgerMode = storedMode
    ? checkoutNormalizeMode_(storedMode)
    : (
      /^MTO32-/i.test(ledgerOrderId) || historicalSourceItemId
        ? CHECKOUT_CONFIG.modes.mto32
        : CHECKOUT_CONFIG.modes.standard
    );

  const order = {
    orderId: ledgerOrderId,
    mode: ledgerMode,
    status:
      checkoutClean_(get(base, '訂單狀態')) ||
      CHECKOUT_CONFIG.statuses.active,
    version: Number(get(base, '版本') || 1),
    draftKey:
      checkoutClean_(get(base, '草稿鍵')),
    lastRequestKey:
      checkoutClean_(get(base, '最後請求鍵')),
    requestKey: Utilities.getUuid(),
    createdAt:
      checkoutFormatClientDate_(get(base, '建立時間')),
    updatedAt:
      checkoutFormatClientDate_(get(base, '更新時間')),
    cancelledAt:
      checkoutFormatClientDate_(get(base, '取消時間')),
    cancelledBy:
      checkoutClean_(get(base, '取消者')),
    cancellationReason:
      checkoutClean_(get(base, '取消原因')),
    transactionDate:
      checkoutFormatClientDate_(get(base, '交易時間')),
    cashier:
      checkoutClean_(get(base, '結帳員')),
    customerName:
      checkoutClean_(get(base, '顧客名稱')),
    customerPhone:
      checkoutClean_(get(base, '顧客電話')),
    customerEmail:
      checkoutClean_(get(base, '顧客電郵')),
    paymentMethod:
      checkoutClean_(get(base, '付款方式')),
    notes: checkoutClean_(get(base, '備註')),
    receiptImages: images,
    receiptFolderId:
      checkoutClean_(get(base, '收據資料夾ID')),
    receiptUrl:
      checkoutClean_(get(base, '收據PDF連結')),
    receiptFileId:
      checkoutClean_(get(base, '收據PDF ID')),
    inventoryResult:
      checkoutClean_(get(base, '庫存狀態')),
    sourceSalesApplied:
      checkoutClean_(
          get(base, '來源銷售已記錄'))
          .toUpperCase() === 'TRUE',
    orderTotal:
      checkoutMoney_(get(base, '訂單總額')),
    lastAction:
      checkoutClean_(get(base, '最後操作')),
    items: [],
    _rowNumbers: rows.map((entry) => {
      return entry.rowNumber;
    }),
  };

  order.checkoutMode = order.mode;

  order.items = rows.map((entry) => {
    const row = entry.values;
    const sourceItemId = checkoutClean_(
        get(row, '來源項目ID'));
    const variantId = checkoutClean_(
        get(row, 'Shopify Variant GID'));

    return {
      mode: order.mode,
      checkoutMode: order.mode,
      catalogMode: order.mode,
      itemKey:
        checkoutClean_(get(row, '項目鍵')) ||
        checkoutLedgerItemKey_(
            order.mode,
            sourceItemId,
            variantId),
      sourceSheetName:
        checkoutClean_(get(row, '來源工作表')),
      sourceItemId,
      marketItemId: sourceItemId,
      sourceLocation:
        checkoutClean_(get(row, '來源位置')),
      chineseName:
        checkoutClean_(get(row, '中文品名')),
      imageUrl:
        checkoutClean_(get(row, '商品圖片')),
      productId:
        checkoutClean_(get(row, 'Shopify Product GID')),
      variantId,
      inventoryItemId:
        checkoutClean_(get(row, 'Shopify Inventory Item GID')),
      tracked:
        checkoutClean_(get(row, '庫存追蹤')).toUpperCase() !==
        'FALSE',
      sku: checkoutClean_(get(row, 'SKU')),
      productTitle:
        checkoutClean_(get(row, '品名')),
      variantTitle:
        checkoutClean_(get(row, 'Variant')),
      quantity: Number(get(row, '數量') || 0),
      unitPrice:
        checkoutMoney_(get(row, '單價')),
      discountType:
        checkoutClean_(get(row, '折扣類型')) ||
        'amount',
      discountValue:
        checkoutMoney_(get(row, '折扣值')),
      lineTotal:
        checkoutMoney_(get(row, '行總額')),
    };
  });

  return order;
}

function checkoutParseImages_(
    json,
    idsText,
    namesText,
    urlsText) {
  const text = checkoutClean_(json);

  if (text) {
    try {
      const parsed = JSON.parse(text);

      if (Array.isArray(parsed)) {
        return parsed
            .map((image) => ({
              id: checkoutClean_(image.id),
              name: checkoutClean_(image.name),
              url: checkoutClean_(image.url),
              thumbnailUrl:
                checkoutClean_(image.thumbnailUrl) ||
                checkoutDriveThumbnailUrl_(image.id),
            }))
            .filter((image) => image.id);
      }
    } catch (error) {
      // Fall back to the human-readable columns for an older row.
    }
  }

  const ids = checkoutClean_(idsText)
      .split(',')
      .map(checkoutClean_)
      .filter(Boolean);

  const names = checkoutClean_(namesText)
      .split(/\r?\n/)
      .map(checkoutClean_);

  const urls = checkoutClean_(urlsText)
      .split(/\r?\n/)
      .map(checkoutClean_);

  return ids.map((id, index) => ({
    id,
    name: names[index] || `Receipt ${index + 1}`,
    url:
      urls[index] ||
      `https://drive.google.com/open?id=${encodeURIComponent(id)}`,
    thumbnailUrl: checkoutDriveThumbnailUrl_(id),
  }));
}

function checkoutDriveThumbnailUrl_(fileId) {
  const id = checkoutClean_(fileId);

  return id
    ? `https://drive.google.com/thumbnail?id=` +
      `${encodeURIComponent(id)}&sz=w800`
    : '';
}

function checkoutGetCashierOptions_() {
  const fixed = CHECKOUT_CONFIG.cashierChoices.slice();
  const values = fixed.slice();

  const groups = checkoutReadOrderGroups_();

  Object.keys(groups).forEach((orderId) => {
    const order = checkoutOrderFromRows_(
        groups[orderId]);

    if (order && order.cashier) {
      values.push(order.cashier);
    }
  });

  const fixedKeys = {};

  fixed.forEach((name) => {
    fixedKeys[checkoutClean_(name).toUpperCase()] = true;
  });

  const otherValues = checkoutUnique_(values)
      .filter((name) => {
        return !fixedKeys[
            checkoutClean_(name).toUpperCase()];
      })
      .sort();

  return fixed.concat(otherValues);
}

/**
 * Returns saved customers for the searchable name dropdown. The latest order
 * wins, so selecting a returning customer can also restore phone and email.
 */
function checkoutGetCustomerOptions_() {
  const groups = checkoutReadOrderGroups_();
  const orders = Object.keys(groups)
      .map((orderId) => {
        return checkoutOrderFromRows_(groups[orderId]);
      })
      .filter((order) => order && order.customerName)
      .sort((left, right) => {
        return checkoutDateNumber_(right.updatedAt) -
          checkoutDateNumber_(left.updatedAt);
      });
  const seen = {};
  const result = [];

  orders.forEach((order) => {
    const key = checkoutClean_(order.customerName)
        .toUpperCase();

    if (!key || seen[key]) {
      return;
    }

    seen[key] = true;
    result.push({
      name: checkoutClean_(order.customerName),
      phone: checkoutClean_(order.customerPhone),
      email: checkoutClean_(order.customerEmail),
    });
  });

  return result.sort((left, right) => {
    return left.name.localeCompare(right.name);
  });
}

function checkoutGetOrderFolder_(
    order,
    existingFolderId) {
  if (existingFolderId) {
    try {
      return DriveApp.getFolderById(existingFolderId);
    } catch (error) {
      // Recreate the expected path when a previous folder was removed.
    }
  }

  const root = checkoutGetReceiptRootFolder_();
  const date = checkoutParseClientDate_(
      order.transactionDate);

  const year = Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      'yyyy');

  const month = Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      'MM');

  const yearFolder = checkoutGetOrCreateChildFolder_(
      root,
      year);

  const monthFolder = checkoutGetOrCreateChildFolder_(
      yearFolder,
      month);

  return checkoutGetOrCreateChildFolder_(
      monthFolder,
      order.orderId);
}

function checkoutGetReceiptRootFolder_() {
  const properties =
    PropertiesService.getScriptProperties();

  const savedId = properties.getProperty(
      CHECKOUT_CONFIG.receiptRootFolderProperty);

  if (savedId) {
    try {
      return DriveApp.getFolderById(savedId);
    } catch (error) {
      throw new Error(
          `The configured receipt folder (${savedId}) is unavailable. ` +
          'Ask the folder owner to share it with this cashier, or update ' +
          `${CHECKOUT_CONFIG.receiptRootFolderProperty} in Script Properties.`);
    }
  }

  const folders = DriveApp.getFoldersByName(
      CHECKOUT_CONFIG.receiptRootFolderName);

  const folder = folders.hasNext()
    ? folders.next()
    : DriveApp.createFolder(
        CHECKOUT_CONFIG.receiptRootFolderName);

  properties.setProperty(
      CHECKOUT_CONFIG.receiptRootFolderProperty,
      folder.getId());

  return folder;
}

function checkoutGetOrCreateChildFolder_(
    parent,
    name) {
  const safeName = checkoutSafeFilePart_(name);
  const folders = parent.getFoldersByName(safeName);

  return folders.hasNext()
    ? folders.next()
    : parent.createFolder(safeName);
}

function checkoutTrashFilesByName_(folder, fileName) {
  const files = folder.getFilesByName(fileName);

  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
}

function checkoutOrderId_(date, draftKey, mode) {
  if (
    checkoutNormalizeMode_(mode) ===
    CHECKOUT_CONFIG.modes.mto32
  ) {
    return checkoutNextMto32OrderId_();
  }

  const datePart = Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      'yyyyMMdd-HHmmss');

  const suffix = checkoutClean_(draftKey)
      .replace(/[^a-z0-9]/gi, '')
      .substring(0, 8)
      .toUpperCase();

  return `MYK-${datePart}-${suffix}`;
}

function checkoutNextMto32OrderId_() {
  const groups = checkoutReadOrderGroups_();
  const properties = PropertiesService.getScriptProperties();
  const pattern = new RegExp(
      `^${CHECKOUT_CONFIG.mto32.orderPrefix}-(\\d+)$`,
      'i');
  let maximum = Number(
      properties.getProperty(
          CHECKOUT_CONFIG.mto32.sequenceProperty) || 0);

  if (!Number.isInteger(maximum) || maximum < 0) {
    maximum = 0;
  }

  Object.keys(groups).forEach((orderId) => {
    const match = checkoutClean_(orderId).match(pattern);

    if (match) {
      maximum = Math.max(maximum, Number(match[1]) || 0);
    }
  });

  let sequence = maximum;
  let orderId = '';

  do {
    sequence += 1;
    orderId = `${CHECKOUT_CONFIG.mto32.orderPrefix}-` +
      String(sequence).padStart(2, '0');
  } while (Object.prototype.hasOwnProperty.call(groups, orderId));

  properties.setProperty(
      CHECKOUT_CONFIG.mto32.sequenceProperty,
      String(sequence));

  return orderId;
}

function checkoutNormalizeMode_(value) {
  const mode = checkoutClean_(value).toUpperCase();

  if (!mode || mode === CHECKOUT_CONFIG.modes.standard) {
    return CHECKOUT_CONFIG.modes.standard;
  }

  if (mode === CHECKOUT_CONFIG.modes.mto32) {
    return CHECKOUT_CONFIG.modes.mto32;
  }

  throw new Error(`Unsupported checkout mode: ${value}`);
}

function checkoutMtoItemKey_(value) {
  const id = checkoutClean_(value);

  return id ? `MTO32:${id.toUpperCase()}` : '';
}

function checkoutLedgerItemKey_(mode, sourceItemId, variantId) {
  if (
    checkoutNormalizeMode_(mode) ===
    CHECKOUT_CONFIG.modes.mto32
  ) {
    return checkoutMtoItemKey_(sourceItemId);
  }

  const gid = checkoutClean_(variantId);
  return gid ? `SHOPIFY:${gid}` : '';
}

function checkoutMtoWholeNumber_(value, field, sourceItemId) {
  const text = checkoutClean_(value).replace(/,/g, '');
  const number = Number(text);

  if (
    text === '' ||
    !Number.isInteger(number) ||
    number < 0
  ) {
    throw new Error(
        `${field} must be a non-negative whole number for MTO item ` +
        `${sourceItemId}.`);
  }

  return number;
}

function checkoutMtoWholeNumberDefault_(
    value,
    field,
    sourceItemId,
    defaultValue) {
  if (checkoutClean_(value) === '') {
    return checkoutMtoWholeNumber_(
        defaultValue,
        field,
        sourceItemId);
  }

  return checkoutMtoWholeNumber_(
      value,
      field,
      sourceItemId);
}

function checkoutUuidFromText_(value) {
  const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(value),
      Utilities.Charset.UTF_8);

  const hex = bytes
      .slice(0, 16)
      .map((byte) => {
        return (`0${((byte + 256) % 256).toString(16)}`).slice(-2);
      })
      .join('');

  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    `4${hex.substring(13, 16)}`,
    `8${hex.substring(17, 20)}`,
    hex.substring(20, 32),
  ].join('-');
}

function checkoutHeaderIndex_(headers) {
  const index = {};

  headers.forEach((header, position) => {
    index[checkoutHeaderKey_(header)] = position;
  });

  return index;
}

function checkoutRequiredHeader_(index, header) {
  const position = index[checkoutHeaderKey_(header)];

  if (position === undefined) {
    throw new Error(
        `Missing checkout header: ${header}`);
  }

  return position;
}

function checkoutHeaderKey_(value) {
  return checkoutClean_(value)
      .toLowerCase()
      .replace(/\s+/g, '_');
}

function checkoutParseClientDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  const text = checkoutClean_(value);

  if (!text) {
    return new Date();
  }

  const normalized = text
      .replace(' ', 'T')
      .substring(0, 16);

  try {
    return Utilities.parseDate(
        normalized,
        Session.getScriptTimeZone(),
        "yyyy-MM-dd'T'HH:mm");
  } catch (error) {
    throw new Error(
        `Invalid transaction date: ${text}`);
  }
}

function checkoutFormatClientDate_(value) {
  if (!value) {
    return '';
  }

  let date;

  try {
    date = value instanceof Date
      ? value
      : checkoutParseClientDate_(value);
  } catch (error) {
    return '';
  }

  if (isNaN(date.getTime())) {
    return '';
  }

  return Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd'T'HH:mm");
}

function checkoutSheetDate_(value) {
  if (!value) {
    return '';
  }

  return checkoutParseClientDate_(value);
}

function checkoutDisplayDate_(value) {
  const formatted = checkoutFormatClientDate_(value);
  return formatted
    ? formatted.replace('T', ' ')
    : '';
}

function checkoutDateNumber_(value) {
  try {
    return checkoutParseClientDate_(value).getTime();
  } catch (error) {
    return 0;
  }
}

function checkoutMoney_(value) {
  const number = Number(
      String(value == null ? '' : value)
          .replace(/[,HK$\s]/gi, ''));

  return Number.isFinite(number)
    ? checkoutRoundMoney_(number)
    : NaN;
}

function checkoutRoundMoney_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function checkoutMoneyText_(value) {
  const number = checkoutMoney_(value);
  return Number.isFinite(number)
    ? number.toFixed(2)
    : '0.00';
}

function checkoutImageExtension_(mime) {
  if (mime === 'image/png') {
    return 'png';
  }

  if (mime === 'image/webp') {
    return 'webp';
  }

  return 'jpg';
}

function checkoutSafeFilePart_(value) {
  const text = checkoutClean_(value)
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .substring(0, 160);

  return text || 'receipt';
}

function checkoutNormalizeSearch_(value) {
  return checkoutClean_(value)
      .toLowerCase()
      .replace(/\s+/g, ' ');
}

function checkoutUnique_(values) {
  const seen = {};

  return (values || [])
      .map(checkoutClean_)
      .filter(Boolean)
      .filter((value) => {
        const key = value.toUpperCase();

        if (seen[key]) {
          return false;
        }

        seen[key] = true;
        return true;
      });
}

function checkoutEscapeHtml_(value) {
  return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

function checkoutEscapeAttribute_(value) {
  return checkoutEscapeHtml_(value);
}

function checkoutClean_(value) {
  return String(value == null ? '' : value).trim();
}
