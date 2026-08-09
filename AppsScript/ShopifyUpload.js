/**
 * Mouthyukyuk Studio — reviewed Google Sheets to Shopify direct sync.
 *
 * Workflow:
 *   1. Open a configured source sheet.
 *   2. Build the review sheet.
 *   3. Run a read-only Shopify SKU preflight.
 *   4. Open the approval popup.
 *   5. Select individual rows or all eligible rows.
 *   6. Approve the rows.
 *   7. Upload approved rows to Shopify.
 *
 * New SKU:
 *   Creates a Shopify product with the reviewed source-sheet status.
 *
 * One exact existing SKU:
 *   Updates the corresponding Shopify product and variant.
 *
 * Multiple exact existing SKU matches:
 *   Blocks the row because the Shopify identity is ambiguous.
 *
 * Inventory:
 *   - Uses Inventory when present.
 *   - Falls back to Stock when Inventory is empty.
 *   - Activates the inventory item at the configured location if needed.
 *   - Sets the absolute available quantity.
 *   - Reads the quantity back and verifies the final value.
 *
 * Required Script Properties:
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 *   SHOPIFY_LOCATION_ID
 *
 * Recommended app scopes:
 *   read_products
 *   write_products
 *   read_inventory
 *   write_inventory
 *   read_locations
 */

const MYK_SHOPIFY = Object.freeze({
  shopName: '10durv-82',
  apiVersion: '2026-07',

  reviewSheetName: 'Shopify Direct Sync Review',
  allowedProductStatuses: Object.freeze([
    'ACTIVE',
    'DRAFT',
    'ARCHIVED',
  ]),

  // Set false while testing product fields without changing stock.
  inventoryWriteEnabled: true,

  inventoryQuantityName: 'available',
  inventoryChangeReason: 'correction',

  metafieldNamespace: 'custom',
  itemIdMetafieldKey: 'item_id',
  chineseNameMetafieldKey: 'chinese_name',
  storageLocationMetafieldKey: 'storage_location',
  inkSizeMetafieldKey: 'ink_size',
  baseColorsMetafieldKey: 'ink_base_colors',
  glitterColorsMetafieldKey: 'ink_glitter_colors',
  sheenColorsMetafieldKey: 'ink_sheen_colors',
  glitterPotionColorMetafieldKey: 'glitter_potion_color',
  glitterPotionSizeMetafieldKey: 'glitter_potion_size',
  penBaseColorMetafieldKey: 'pen_base_color',
  penSizeMetafieldKey: 'pen_size',
  sourceSheetMetafieldKey: 'source_sheet',
  sourceRowMetafieldKey: 'source_row',

  resultHeaders: [
    'Review Select',
    'Approval',
    'Validation',
    'Upload Action',
    'Source Sheet',
    'Source Row',
    'Item Type',
    'Item ID',
    'Handle',
    'English Name',
    'Collection',
    'Chinese Name',
    'Brand',
    'Product Type',
    'Status',
    'Shopify Taxonomy ID',
    'SKU',
    'Price',
    'Inventory',
    'Ink Base Colors',
    'Ink Glitter Colors',
    'Ink Sheen Colors',
    'Option',
    'Glitter Potion Color',
    'Glitter Potion Size',
    'Pen Base Color',
    'Pen Size',
    'Tags',
    'Body HTML',
    'Image URL',
    'Shopify Product GID',
    'Shopify Variant GID',
    'Shopify Inventory Item GID',
    'Shopify Result',
    'Uploaded At',
  ],
});

const MYK_TAXONOMY = Object.freeze({
  /*
   * The live Shopify Admin taxonomy is authoritative. These official GitHub
   * endpoints are used only when the live taxonomy query is unavailable.
   * Discovering GitHub's latest release avoids pinning a stale fallback.
   */
  latestReleaseApiUrl:
    'https://api.github.com/repos/Shopify/product-taxonomy/releases/latest',

  publishedReleaseUrlTemplate:
    'https://raw.githubusercontent.com/Shopify/product-taxonomy/' +
    'v{VERSION}/dist/en/categories.txt',

  mainDistributionUrl:
    'https://raw.githubusercontent.com/Shopify/product-taxonomy/' +
    'main/dist/en/categories.txt',

  cacheSeconds: 21600,

  /*
   * Product Type -> taxonomy search phrase.
   *
   * Add or adjust these values to match the Product Type values in your sheet.
   * The search phrase should resemble the final category name or breadcrumb.
   */
  productTypeSearchTerms: Object.freeze({
    'INK': 'Pen Ink & Refills',
    'FOUNTAIN PEN INK': 'Pen Ink & Refills',
    'GLITTER POTION': 'Pen Ink & Refills',
    'FOUNTAIN PEN': 'Fountain Pens',
    'DIP PEN': 'Dip Pens',
    'NOTEBOOK': 'Notebooks',
    'PAPER': 'Paper Products',
    'ACCESSORY': 'Writing Instrument Accessories',
  }),
});

const MYK_UPLOAD_JOB = Object.freeze({
  maxRuntimeMs: 4 * 60 * 1000,
  resumeDelayMs: 60 * 1000,

  spreadsheetIdProperty:
    'MYK_UPLOAD_SPREADSHEET_ID',

  nextRowProperty:
    'MYK_UPLOAD_NEXT_ROW',

  runningProperty:
    'MYK_UPLOAD_RUNNING',

  totalProperty:
    'MYK_UPLOAD_TOTAL',

  processedProperty:
    'MYK_UPLOAD_PROCESSED',

  successProperty:
    'MYK_UPLOAD_SUCCESS',

  failedProperty:
    'MYK_UPLOAD_FAILED',

  currentItemProperty:
    'MYK_UPLOAD_CURRENT_ITEM',

  finishedProperty:
    'MYK_UPLOAD_FINISHED',

  triggerFunctionName:
    'resumeApprovedRowsUpload',
});

const MYK_REVIEW_BUILD = Object.freeze({
  batchSize: 15,
  maxBatchRuntimeMs: 25 * 1000,
  stateKeyPrefix: 'MYK_REVIEW_BUILD_',
  stagingSheetPrefix: '__MYK_REVIEW_',
});

/**
 * Configure source sheets here.
 *
 * Each internal field can have multiple possible spreadsheet headings.
 */
const MYK_SHEET_PROFILES = Object.freeze({
  '墨水': Object.freeze({
    itemType: 'INK',

    colorMode: 'INK',

    defaultTaxonomyCategoryId: '',

    aliases: Object.freeze({
      englishName: [
        'English Name',
        'English',
        'Product English Name',
      ],

      chineseName: [
        'Chinese Name',
        'Chinese',
        '中文名稱',
      ],

      collection: ['Collection', '系列'],

      brand: [
        'Brand',
        '品牌',
      ],

      brandShortName: [
        'Brand Short Name',
        'Brand Short',
        'Brand Code',
      ],

      collectionShortName: [
        'Item Collection Short Name',
        'Collection Short Name',
        'Collection Code',
      ],

      uniqueShortName: [
        'Item Unique Short Name',
        'Unique Short Name',
        'Unique Code',
      ],

      sku: [
        'SKU',
        'Variant SKU',
      ],

      price: [
        'Price',
        '售價',
      ],

      inventory: [
        'Inventory',
        '庫存',
      ],

      stock: [
        'Stock',
        '存貨',
      ],

      tags: [
        'Label Tag',
        'Tags',
        'Tag',
        '標籤',
      ],

      desc: [
        'Desc',
        'Description',
        'Body HTML',
        'Body (HTML)',
      ],

      productType: [
        'Product Type',
        'Type',
        '產品類型',
      ],

      status: [
        'Status',
        'Product Status',
        '狀態',
      ],

      imageUrl: [
        'Image URL',
        'Image URLs',
        'Image Src',
        'Image',
      ],

      option: [
        'Option',
        'Variant Option',
        'Item Option',
      ],

      baseColors: [
        'Ink Base Color',
        'Ink Base Colors',
        'Base Color',
      ],

      glitterColors: [
        'Ink Glitter Color',
        'Ink Glitter Colors',
        'Glitter Color',
      ],

      sheenColors: [
        'Ink Sheen Color',
        'Ink Sheen Colors',
        'Sheen Color',
      ],

      taxonomyCategoryId: [
        'Shopify Taxonomy ID',
        'Taxonomy ID',
        'Shopify Category ID',
      ],
    }),
  }),

  '閃粉': Object.freeze({
    // Glitter Potion Item IDs use GP-<SKU>. Product Type can still be
    // "Glitter Potion" in the source row and Shopify.
    itemType: 'GP',
    colorMode: 'GLITTER_POTION',
    supportsSharedProductVariants: true,
    defaultTaxonomyCategoryId: '',

    aliases: Object.freeze({
      englishName: [
        'English Name',
        'English',
        'Product English Name',
      ],
      chineseName: [
        'Chinese Name',
        'Chinese',
        '中文名稱',
      ],
      collection: ['Collection', '系列'],
      brand: ['Brand', '品牌'],
      brandShortName: [
        'Brand Short Name',
        'Brand Short',
        'Brand Code',
      ],
      collectionShortName: [
        'Item Collection Short Name',
        'Collection Short Name',
        'Collection Code',
      ],
      uniqueShortName: [
        'Item Unique Short Name',
        'Unique Short Name',
        'Unique Code',
      ],
      sku: ['SKU', 'Variant SKU'],
      price: ['Price', '售價'],
      inventory: ['Inventory', '庫存'],
      stock: ['Stock', '存貨'],
      tags: ['Label Tag', 'Tags', 'Tag', '標籤'],
      desc: [
        'Desc',
        'Description',
        'Body HTML',
        'Body (HTML)',
      ],
      productType: ['Product Type', 'Type', '產品類型'],
      status: ['Status', 'Product Status', '狀態'],
      imageUrl: ['Image URL', 'Image URLs', 'Image Src', 'Image'],
      option: ['Option', 'Variant Option', 'Item Option'],
      glitterPotionColor: [
        'Glitter Potion Color',
        'Glitter Color',
      ],
      glitterPotionSize: [
        'Glitter Potion Size',
        'Glitter Size',
        'Size',
      ],
      taxonomyCategoryId: [
        'Shopify Taxonomy ID',
        'Taxonomy ID',
        'Shopify Category ID',
      ],
    }),
  }),

  '鋼筆': Object.freeze({
    itemType: 'PEN',
    colorMode: 'PEN',
    supportsSharedProductVariants: true,
    defaultTaxonomyCategoryId: '',

    aliases: Object.freeze({
      englishName: ['English Name'],
      chineseName: ['Chinese Name'],
      collection: ['Collection'],
      brand: ['Brand'],
      brandShortName: [],
      collectionShortName: [],
      uniqueShortName: [],
      sku: ['SKU'],
      price: ['Price'],
      inventory: ['Inventory'],
      stock: ['Stock'],
      tags: ['Label Tag'],
      desc: ['Desc'],
      productType: ['Product Type'],
      status: ['Status'],
      imageUrl: ['Image URL'],
      option: ['Option'],
      penBaseColor: ['Pen Base Color'],
      penSize: ['Pen Size'],
      taxonomyCategoryId: [
        'Shopify Taxonomy ID',
        'Taxonomy ID',
        'Shopify Category ID',
      ],
    }),
  }),

  '原子筆/鉛筆': Object.freeze({
    itemType: 'PEN',
    colorMode: 'PEN',
    supportsSharedProductVariants: true,
    defaultTaxonomyCategoryId: '',

    // This profile intentionally mirrors the exact source headings used by
    // 原子筆/鉛筆. Pen attributes are not aliases of ink or glitter fields.
    aliases: Object.freeze({
      englishName: ['English Name'],
      chineseName: ['Chinese Name'],
      collection: ['Collection'],
      brand: ['Brand'],
      brandShortName: [],
      collectionShortName: [],
      uniqueShortName: [],
      sku: ['SKU'],
      price: ['Price'],
      inventory: ['Inventory'],
      stock: ['Stock'],
      tags: ['Label Tag'],
      desc: ['Desc'],
      productType: ['Product Type'],
      status: ['Status'],
      imageUrl: ['Image URL'],
      option: ['Option'],
      penBaseColor: ['Pen Base Color'],
      penSize: ['Pen Size'],
      taxonomyCategoryId: [
        'Shopify Taxonomy ID',
        'Taxonomy ID',
        'Shopify Category ID',
      ],
    }),
  }),

  /*
   * Add additional source-sheet profiles here.
   *
   * Example:
   *
   * '鋼筆': Object.freeze({
   *   itemType: 'PEN',
   *   aliases: Object.freeze({
   *     englishName: ['English Name'],
   *     chineseName: ['Chinese Name'],
   *     brand: ['Brand'],
   *     brandShortName: ['Brand Short Name'],
   *     collectionShortName: ['Item Collection Short Name'],
   *     uniqueShortName: ['Item Unique Short Name'],
   *     sku: ['SKU'],
   *     price: ['Price'],
   *     inventory: ['Inventory'],
   *     stock: ['Stock'],
   *     colors: ['Body Color', 'Color'],
   *     tags: ['Label Tag', 'Tags'],
   *     desc: ['Desc'],
   *     productType: ['Product Type'],
   *     imageUrl: ['Image URL'],
   *   }),
   * }),
   */
});

/**
 * Creates or confirms the product metafield definitions used by this script.
 *
 * Run once after installing the script, or after changing metafield keys.
 */
function setupShopifyMetafields() {
  const accessToken = getCachedShopifyAccessToken_();

  const definitions = [
    {
      name: 'Mouthyukyuk Item ID',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.itemIdMetafieldKey,
      type: 'single_line_text_field',
      description: 'Internal Mouthyukyuk item identifier.',
    },
    {
      name: 'Chinese Name',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.chineseNameMetafieldKey,
      type: 'single_line_text_field',
      description: 'Chinese product name.',
    },
    {
      name: 'Storage Location',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.storageLocationMetafieldKey,
      type: 'single_line_text_field',
      description: 'Internal product storage location.',
    },
    {
      name: 'Ink Size',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.inkSizeMetafieldKey,
      type: 'single_line_text_field',
      description: 'Ink bottle or sample size.',
    },
    {
      name: 'Ink Base Colors',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.baseColorsMetafieldKey,
      type: 'list.single_line_text_field',
      description: 'One or more base ink colors.',
    },
    {
      name: 'Ink Glitter Colors',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.glitterColorsMetafieldKey,
      type: 'list.single_line_text_field',
      description: 'One or more glitter colors.',
    },
    {
      name: 'Ink Sheen Colors',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sheenColorsMetafieldKey,
      type: 'list.single_line_text_field',
      description: 'One or more sheen colors.',
    },
    {
      name: 'Glitter Potion Color',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.glitterPotionColorMetafieldKey,
      type: 'single_line_text_field',
      ownerType: 'PRODUCT_VARIANT',
      description: 'Glitter potion variant color.',
    },
    {
      name: 'Variant Item ID',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.itemIdMetafieldKey,
      type: 'single_line_text_field',
      ownerType: 'PRODUCT_VARIANT',
      description: 'Internal Mouthyukyuk variant identifier.',
    },
    {
      name: 'Glitter Potion Size',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.glitterPotionSizeMetafieldKey,
      type: 'single_line_text_field',
      ownerType: 'PRODUCT_VARIANT',
      description: 'Glitter potion variant size.',
    },
    {
      name: 'Pen Base Color',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.penBaseColorMetafieldKey,
      type: 'single_line_text_field',
      ownerType: 'PRODUCT_VARIANT',
      description: 'Pen variant base color.',
    },
    {
      name: 'Pen Size',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.penSizeMetafieldKey,
      type: 'single_line_text_field',
      ownerType: 'PRODUCT_VARIANT',
      description: 'Pen variant size.',
    },
    {
      name: 'Source Sheet',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sourceSheetMetafieldKey,
      type: 'single_line_text_field',
      description: 'Google Sheets source tab.',
    },
    {
      name: 'Source Row',
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sourceRowMetafieldKey,
      type: 'number_integer',
      description: 'Google Sheets source row.',
    },
  ];

  const results = definitions.map((definition) => {
    return ensureShopifyMetafieldDefinition_(
        accessToken,
        definition);
  });

  SpreadsheetApp.getUi().alert(
      'Metafield setup',
      results.join('\n'),
      SpreadsheetApp.getUi().ButtonSet.OK);
}

function ensureShopifyMetafieldDefinition_(
    accessToken,
    definition) {
  const existing = findShopifyMetafieldDefinition_(
      accessToken,
      definition.namespace,
      definition.key,
      definition.ownerType || 'PRODUCT');

  let definitionId;

  if (existing) {
    definitionId = existing.id;

    if (existing.type.name !== definition.type) {
      throw new Error(
          `${definition.namespace}.${definition.key} already exists ` +
          `with type ${existing.type.name}; expected ${definition.type}.`);
    }
  } else {
    definitionId = createShopifyMetafieldDefinition_(
        accessToken,
        definition);
  }

  pinShopifyMetafieldDefinition_(
      accessToken,
      definitionId);

  return (
    `READY: ${definition.namespace}.${definition.key}`
  );
}

function findShopifyMetafieldDefinition_(
    accessToken,
    namespace,
    key,
    ownerType) {
  const query = `
    query FindMetafieldDefinition(
      $identifier: MetafieldDefinitionIdentifierInput!
    ) {
      metafieldDefinition(identifier: $identifier) {
        id
        name
        namespace
        key
        type {
          name
        }
        pinnedPosition
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {
        identifier: {
          namespace,
          key,
          ownerType: ownerType || 'PRODUCT',
        },
      });

  return payload.data.metafieldDefinition || null;
}

function createShopifyMetafieldDefinition_(
    accessToken,
    definition) {
  const mutation = `
    mutation CreateMetafieldDefinition(
      $definition: MetafieldDefinitionInput!
    ) {
      metafieldDefinitionCreate(
        definition: $definition
      ) {
        createdDefinition {
          id
          name
          namespace
          key
          type {
            name
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

  /*
   * These definitions use the non-reserved "custom" namespace and are
   * merchant-owned. Do not send access.admin.
   */
  const definitionInput = {
    name: definition.name,
    namespace: definition.namespace,
    key: definition.key,
    description: definition.description,
    type: definition.type,
    ownerType: definition.ownerType || 'PRODUCT',

    /*
     * PUBLIC_READ permits use through Storefront API where applicable.
     * Remove this entire access property if storefront exposure is not needed.
     */
    access: {
      storefront: 'PUBLIC_READ',
    },
  };

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        definition: definitionInput,
      });

  const result =
    payload.data &&
    payload.data.metafieldDefinitionCreate;

  if (!result) {
    throw new Error(
        'Shopify returned no metafieldDefinitionCreate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'metafieldDefinitionCreate failed');

  if (!result.createdDefinition) {
    throw new Error(
        `No metafield definition returned for ` +
        `${definition.namespace}.${definition.key}.`);
  }

  return result.createdDefinition.id;
}

function pinShopifyMetafieldDefinition_(
    accessToken,
    definitionId) {
  const mutation = `
    mutation PinMetafieldDefinition($definitionId: ID!) {
      metafieldDefinitionPin(definitionId: $definitionId) {
        pinnedDefinition {
          id
          pinnedPosition
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {definitionId});

  const result =
    payload.data.metafieldDefinitionPin;

  /*
   * Already-pinned definitions can return a harmless user error depending on
   * API behavior. Ignore only that specific condition.
   */
  const meaningfulErrors = (
    result.userErrors || []
  ).filter((error) => {
    return (
      clean_(error.code) !== 'ALREADY_PINNED' &&
      clean_(error.message)
          .toLowerCase()
          .indexOf('already pinned') === -1
    );
  });

  throwOnUserErrors_(
      meaningfulErrors,
      'metafieldDefinitionPin failed');
}

function verifyProductMetafields_(accessToken, productId) {
  const query = `
    query VerifyProductMetafields(
      $id: ID!,
      $namespace: String!
    ) {
      product(id: $id) {
        id
        metafields(
          first: 20,
          namespace: $namespace
        ) {
          nodes {
            id
            namespace
            key
            type
            value
          }
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {
        id: productId,
        namespace: MYK_SHOPIFY.metafieldNamespace,
      });

  const product = payload.data.product;

  if (!product) {
    throw new Error(
        'Unable to verify product metafields.');
  }

  return product.metafields.nodes || [];
}

/**
 * Starts a client-driven, resumable review build from the active source tab.
 *
 * The browser dialog requests one small server batch at a time. This lets the
 * progress bar repaint between batches and avoids a single long Apps Script
 * execution. The current visible review remains untouched until finalization.
 */
function buildReviewFromActiveSheet() {
  const lock = LockService.getUserLock();
  lock.waitLock(10000);

  try {
    initializeReviewBuildFromActiveSheet_();
  } finally {
    lock.releaseLock();
  }
}

function initializeReviewBuildFromActiveSheet_() {
  const spreadsheet = SpreadsheetApp.getActive();
  const sourceSheet = spreadsheet.getActiveSheet();
  const sourceSheetName = sourceSheet.getName();

  if (
    sourceSheetName === MYK_SHOPIFY.reviewSheetName ||
    sourceSheetName.indexOf(MYK_REVIEW_BUILD.stagingSheetPrefix) === 0
  ) {
    throw new Error(
        'Select a configured source product sheet before building the review.');
  }

  const profile = requireSheetProfile_(sourceSheetName);
  const taxonomyColumnIndex = ensureSourceTaxonomyColumn_(
      sourceSheet,
      profile);

  // Permanent Shopify identities are copied into the review and later filled
  // by preflight or upload when they are missing.
  ensureSourceShopifyIdentityColumns_(sourceSheet);

  const lastSourceRow = sourceSheet.getLastRow();

  if (lastSourceRow < 2) {
    throw new Error(
        `The source sheet “${sourceSheetName}” has no data rows.`);
  }

  cleanupOldReviewBuilds_(spreadsheet);

  const jobId = Utilities.getUuid().replace(/-/g, '');
  const stagingSheetName =
    `${MYK_REVIEW_BUILD.stagingSheetPrefix}${jobId.substring(0, 12)}`;
  const stagingSheet = spreadsheet.insertSheet(stagingSheetName);

  ensureSheetSize_(
      stagingSheet,
      lastSourceRow,
      MYK_SHOPIFY.resultHeaders.length);

  stagingSheet
      .getRange(1, 1, 1, MYK_SHOPIFY.resultHeaders.length)
      .setValues([MYK_SHOPIFY.resultHeaders]);
  stagingSheet.hideSheet();

  const now = new Date().toISOString();
  const state = {
    jobId,
    spreadsheetId: spreadsheet.getId(),
    sourceSheetId: sourceSheet.getSheetId(),
    sourceSheetName,
    stagingSheetId: stagingSheet.getSheetId(),
    stagingSheetName,
    taxonomyColumnIndex,
    nextRow: 2,
    lastSourceRow,
    totalRows: lastSourceRow - 1,
    processedRows: 0,
    reviewRows: 0,
    blockedRows: 0,
    stage: 'PREPARING',
    currentItem: '',
    message: 'Preparing the first batch…',
    error: '',
    startedAt: now,
    updatedAt: now,
  };

  saveReviewBuildState_(state);
  showReviewBuildProgress_(jobId);
}

/** Processes one source-row batch or finalizes the completed review. */
function processReviewBuildBatch(jobId) {
  const lock = LockService.getUserLock();

  if (!lock.tryLock(5000)) {
    const waitingState = loadReviewBuildState_(jobId);

    if (waitingState) {
      waitingState.message = 'Waiting for the current batch to finish…';
      return reviewBuildProgressFromState_(waitingState);
    }

    return missingReviewBuildProgress_(jobId);
  }

  let state = null;

  try {
    state = loadReviewBuildState_(jobId);

    if (!state) {
      return missingReviewBuildProgress_(jobId);
    }

    if (isTerminalReviewBuildStage_(state.stage)) {
      return reviewBuildProgressFromState_(state);
    }

    const spreadsheet = SpreadsheetApp.openById(state.spreadsheetId);
    const sourceSheet = findSheetById_(
        spreadsheet,
        state.sourceSheetId);
    const stagingSheet = findSheetById_(
        spreadsheet,
        state.stagingSheetId);

    if (!sourceSheet) {
      throw new Error(
          `The source sheet “${state.sourceSheetName}” no longer exists.`);
    }

    if (!stagingSheet) {
      throw new Error(
          'The temporary review-build sheet no longer exists. Start again.');
    }

    if (state.stage === 'FINALIZING') {
      finalizeReviewBuild_(spreadsheet, stagingSheet, state);
      return reviewBuildProgressFromState_(state);
    }

    state.stage = 'BUILDING';
    const startedAt = Date.now();
    const startRow = Math.max(2, Number(state.nextRow) || 2);

    if (startRow > state.lastSourceRow) {
      state.stage = 'FINALIZING';
      state.currentItem = '';
      state.message = 'All rows prepared. Formatting the review…';
      saveReviewBuildState_(state);
      return reviewBuildProgressFromState_(state);
    }

    let endRow = Math.min(
        state.lastSourceRow,
        startRow + MYK_REVIEW_BUILD.batchSize - 1);

    const sourceLastColumn = sourceSheet.getLastColumn();
    const sourceIndices = getColumnIndices(sourceSheet);
    const profile = requireSheetProfile_(state.sourceSheetName);
    const batchValues = sourceSheet
        .getRange(
            startRow,
            1,
            endRow - startRow + 1,
            sourceLastColumn)
        .getDisplayValues();
    const stagingRows = [];
    const taxonomyValues = [];
    let batchReviewRows = 0;
    let batchBlockedRows = 0;
    let rowsHandled = 0;

    for (let offset = 0; offset < batchValues.length; offset += 1) {
      if (
        rowsHandled > 0 &&
        Date.now() - startedAt >= MYK_REVIEW_BUILD.maxBatchRuntimeMs
      ) {
        endRow = startRow + rowsHandled - 1;
        break;
      }

      const row = batchValues[offset];
      const sourceRowNumber = startRow + offset;
      const currentTaxonomy = clean_(
          row[state.taxonomyColumnIndex]);

      if (row.every((value) => !clean_(value))) {
        stagingRows.push(
            new Array(MYK_SHOPIFY.resultHeaders.length).fill(''));
        taxonomyValues.push([currentTaxonomy]);
        rowsHandled += 1;
        continue;
      }

      state.currentItem =
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.englishName) ||
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.sku) ||
        `Source row ${sourceRowNumber}`;
      state.message =
        `Reading ${state.sourceSheetName}, row ${sourceRowNumber}…`;
      state.updatedAt = new Date().toISOString();
      saveReviewBuildState_(state);

      try {
        const product = buildNormalizedProduct_(
            state.sourceSheetName,
            sourceRowNumber,
            row,
            sourceIndices,
            profile);
        const validation = validateNormalizedProduct_(product);

        stagingRows.push(buildReviewRow_(
            state.sourceSheetName,
            sourceRowNumber,
            row,
            sourceIndices,
            product,
            validation));

        taxonomyValues.push([
          product.taxonomyCategoryId || currentTaxonomy,
        ]);
        batchReviewRows += 1;

        if (normalize_(validation).indexOf('BLOCKED:') === 0) {
          batchBlockedRows += 1;
        }
      } catch (error) {
        const failureMessage = formatReviewBuildError_(error);

        stagingRows.push(buildReviewErrorRow_(
            state.sourceSheetName,
            sourceRowNumber,
            row,
            sourceIndices,
            profile,
            failureMessage));
        taxonomyValues.push([currentTaxonomy]);
        batchReviewRows += 1;
        batchBlockedRows += 1;
      }

      rowsHandled += 1;
    }

    if (rowsHandled === 0) {
      throw new Error(
          'The review builder could not process a source row in this batch.');
    }

    ensureSheetSize_(
        stagingSheet,
        endRow,
        MYK_SHOPIFY.resultHeaders.length);
    stagingSheet
        .getRange(
            startRow,
            1,
            stagingRows.length,
            MYK_SHOPIFY.resultHeaders.length)
        .setValues(stagingRows);
    sourceSheet
        .getRange(
            startRow,
            state.taxonomyColumnIndex + 1,
            taxonomyValues.length,
            1)
        .setValues(taxonomyValues);

    state.processedRows += rowsHandled;
    state.reviewRows += batchReviewRows;
    state.blockedRows += batchBlockedRows;
    state.nextRow = endRow + 1;
    state.currentItem = '';
    state.updatedAt = new Date().toISOString();

    if (state.nextRow > state.lastSourceRow) {
      state.stage = 'FINALIZING';
      state.message = 'All rows prepared. Formatting the review…';
    } else {
      state.message =
        `Prepared ${state.processedRows} of ${state.totalRows} source rows.`;
    }

    saveReviewBuildState_(state);
    SpreadsheetApp.flush();
    return reviewBuildProgressFromState_(state);
  } catch (error) {
    if (!state) {
      state = {
        jobId: clean_(jobId),
        stage: 'FAILED',
        totalRows: 0,
        processedRows: 0,
        reviewRows: 0,
        blockedRows: 0,
        currentItem: '',
        message: 'Review build failed.',
        error: formatReviewBuildError_(error),
      };
    } else {
      state.stage = 'FAILED';
      state.message = 'Review build stopped. The existing review was kept.';
      state.error = formatReviewBuildError_(error);
      state.updatedAt = new Date().toISOString();
      saveReviewBuildState_(state);
    }

    return reviewBuildProgressFromState_(state);
  } finally {
    lock.releaseLock();
  }
}

/** Returns lightweight job state for the progress window. */
function getReviewBuildProgress(jobId) {
  const state = loadReviewBuildState_(jobId);

  return state
    ? reviewBuildProgressFromState_(state)
    : missingReviewBuildProgress_(jobId);
}

/** Cancels a review build and removes only its hidden temporary sheet. */
function cancelReviewBuild(jobId) {
  const lock = LockService.getUserLock();
  lock.waitLock(10000);

  try {
    const state = loadReviewBuildState_(jobId);

    if (!state) {
      return missingReviewBuildProgress_(jobId);
    }

    if (!isTerminalReviewBuildStage_(state.stage)) {
      state.stage = 'CANCELLED';
      state.currentItem = '';
      state.message = 'Review build cancelled. The existing review was kept.';
      state.error = '';
      state.updatedAt = new Date().toISOString();

      try {
        const spreadsheet = SpreadsheetApp.openById(state.spreadsheetId);
        const stagingSheet = findSheetById_(
            spreadsheet,
            state.stagingSheetId);

        if (stagingSheet) {
          spreadsheet.deleteSheet(stagingSheet);
        }
      } catch (error) {
        console.warn(
            `Unable to remove cancelled review staging sheet: ${error.message}`);
      }

      saveReviewBuildState_(state);
    }

    return reviewBuildProgressFromState_(state);
  } finally {
    lock.releaseLock();
  }
}

function showReviewBuildProgress_(jobId) {
  const template = HtmlService.createTemplateFromFile('ReviewProgress');
  template.jobId = jobId;

  const html = template
      .evaluate()
      .setWidth(520)
      .setHeight(390);

  SpreadsheetApp.getUi().showModelessDialog(
      html,
      'Build Shopify review');
}

function finalizeReviewBuild_(spreadsheet, stagingSheet, state) {
  state.stage = 'FINALIZING';
  state.currentItem = '';
  state.message = 'Writing and formatting the review sheet…';
  state.updatedAt = new Date().toISOString();
  saveReviewBuildState_(state);

  const sourceSheetColumn = requiredColumn_(
      MYK_SHOPIFY.resultHeaders.reduce((indices, heading, index) => {
        indices[formatHeaderKey_(heading)] = index;
        return indices;
      }, {}),
      'Source Sheet');
  const stagedValues = state.lastSourceRow >= 2
    ? stagingSheet
        .getRange(
            2,
            1,
            state.lastSourceRow - 1,
            MYK_SHOPIFY.resultHeaders.length)
        .getValues()
    : [];
  const reviewRows = stagedValues.filter((row) => {
    return clean_(row[sourceSheetColumn]) !== '';
  });

  replaceReviewSheetFromStaging_(
      spreadsheet,
      stagingSheet,
      reviewRows);

  state.stage = 'COMPLETE';
  state.processedRows = state.totalRows;
  state.reviewRows = reviewRows.length;
  state.currentItem = '';
  state.message =
    `Built ${reviewRows.length} review row(s) from ` +
    `“${state.sourceSheetName}”. Run “Check Shopify” next.`;
  state.error = '';
  state.updatedAt = new Date().toISOString();
  saveReviewBuildState_(state);
}

/**
 * Fully prepares the hidden staging sheet before replacing the live review.
 * If formatting fails, the previous visible review is never cleared.
 */
function replaceReviewSheetFromStaging_(
    spreadsheet,
    stagingSheet,
    rows) {
  writeReviewRowsToSheet_(stagingSheet, rows);

  const reviewName = MYK_SHOPIFY.reviewSheetName;
  const stagingName = stagingSheet.getName();
  const previousReview = spreadsheet.getSheetByName(reviewName);
  const backupName =
    `${MYK_REVIEW_BUILD.stagingSheetPrefix}OLD_` +
    Utilities.getUuid().replace(/-/g, '').substring(0, 10);

  if (previousReview) {
    previousReview.setName(backupName);
  }

  try {
    stagingSheet.setName(reviewName);
    stagingSheet.showSheet();
  } catch (error) {
    if (stagingSheet.getName() === reviewName) {
      try {
        stagingSheet.setName(stagingName);
      } catch (renameError) {
        console.warn(
            `Unable to restore staging-sheet name: ${renameError.message}`);
      }
    }

    if (previousReview && !spreadsheet.getSheetByName(reviewName)) {
      previousReview.setName(reviewName);
      previousReview.showSheet();
    }

    throw error;
  }

  try {
    spreadsheet.setActiveSheet(stagingSheet);
  } catch (error) {
    console.warn(
        `Unable to activate the completed review sheet: ${error.message}`);
  }

  if (previousReview) {
    try {
      spreadsheet.deleteSheet(previousReview);
    } catch (error) {
      // The new review is already live; a leftover backup can be removed by
      // the next build's temporary-sheet cleanup.
      console.warn(
          `Unable to delete the previous review backup: ${error.message}`);
    }
  }
}

function buildReviewRow_(
    sourceSheetName,
    sourceRowNumber,
    sourceRowValues,
    sourceIndices,
    product,
    validation) {
  return [
    false,
    'PENDING',
    validation,
    'NOT_CHECKED',
    sourceSheetName,
    sourceRowNumber,
    product.itemType,
    product.itemId,
    product.handle,
    product.englishName,
    product.collection,
    product.chineseName,
    product.brand,
    product.productType,
    product.status,
    product.taxonomyCategoryId,
    product.sku,
    product.price,
    product.inventory,
    product.baseColors.join(', '),
    product.glitterColors.join(', '),
    product.sheenColors.join(', '),
    product.sourceOption,
    product.glitterPotionColor,
    product.glitterPotionSize,
    product.penBaseColor,
    product.penSize,
    product.tags.join(', '),
    product.bodyHtml,
    product.imageUrl,
    getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Product GID']),
    getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Variant GID']),
    getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Inventory Item GID']),
    'NOT_UPLOADED',
    '',
  ];
}

/** Creates an inspectable blocked row instead of aborting the full build. */
function buildReviewErrorRow_(
    sourceSheetName,
    sourceRowNumber,
    row,
    sourceIndices,
    profile,
    failureMessage) {
  const aliases = profile.aliases;
  const englishName = getAliasedValue_(
      row,
      sourceIndices,
      aliases.englishName);
  const sku = normalizeSku_(getAliasedValue_(
      row,
      sourceIndices,
      aliases.sku));
  const itemType = normalizeCodePart_(profile.itemType);
  const inventory =
    getAliasedValue_(row, sourceIndices, aliases.inventory) ||
    getAliasedValue_(row, sourceIndices, aliases.stock);
  const blockedMessage = `BLOCKED: REVIEW_BUILD_ERROR: ${failureMessage}`;

  return [
    false,
    'PENDING',
    blockedMessage,
    'BLOCKED',
    sourceSheetName,
    sourceRowNumber,
    itemType,
    sku ? `${itemType}-${sku}` : '',
    slugifyHandle_(englishName),
    englishName,
    getAliasedValue_(row, sourceIndices, aliases.collection),
    getAliasedValue_(row, sourceIndices, aliases.chineseName),
    getAliasedValue_(row, sourceIndices, aliases.brand),
    getAliasedValue_(row, sourceIndices, aliases.productType),
    normalizeShopifyProductStatus_(
        getAliasedValue_(row, sourceIndices, aliases.status)),
    getAliasedValue_(row, sourceIndices, aliases.taxonomyCategoryId),
    sku,
    getAliasedValue_(row, sourceIndices, aliases.price),
    inventory,
    getAliasedValue_(row, sourceIndices, aliases.baseColors),
    getAliasedValue_(row, sourceIndices, aliases.glitterColors),
    getAliasedValue_(row, sourceIndices, aliases.sheenColors),
    getAliasedValue_(row, sourceIndices, aliases.option),
    getAliasedValue_(row, sourceIndices, aliases.glitterPotionColor),
    getAliasedValue_(row, sourceIndices, aliases.glitterPotionSize),
    getAliasedValue_(row, sourceIndices, aliases.penBaseColor),
    getAliasedValue_(row, sourceIndices, aliases.penSize),
    getAliasedValue_(row, sourceIndices, aliases.tags),
    getAliasedValue_(row, sourceIndices, aliases.desc),
    normalizeReviewImageUrls_(
        getAliasedValue_(row, sourceIndices, aliases.imageUrl)),
    getAliasedValue_(row, sourceIndices, ['Shopify Product GID']),
    getAliasedValue_(row, sourceIndices, ['Shopify Variant GID']),
    getAliasedValue_(row, sourceIndices, ['Shopify Inventory Item GID']),
    failureMessage,
    '',
  ];
}

function reviewBuildStateKey_(jobId) {
  const safeJobId = clean_(jobId).replace(/[^A-Za-z0-9]/g, '');

  if (!safeJobId) {
    throw new Error('Invalid review-build job ID.');
  }

  return `${MYK_REVIEW_BUILD.stateKeyPrefix}${safeJobId}`;
}

function saveReviewBuildState_(state) {
  state.updatedAt = new Date().toISOString();
  PropertiesService
      .getUserProperties()
      .setProperty(
          reviewBuildStateKey_(state.jobId),
          JSON.stringify(state));
}

function loadReviewBuildState_(jobId) {
  const value = PropertiesService
      .getUserProperties()
      .getProperty(reviewBuildStateKey_(jobId));

  return value ? JSON.parse(value) : null;
}

function reviewBuildProgressFromState_(state) {
  const totalRows = Math.max(0, Number(state.totalRows) || 0);
  const processedRows = Math.max(0, Number(state.processedRows) || 0);
  let percentage = totalRows > 0
    ? Math.min(98, Math.round((processedRows / totalRows) * 98))
    : 0;

  if (state.stage === 'FINALIZING') {
    percentage = 99;
  } else if (state.stage === 'COMPLETE') {
    percentage = 100;
  }

  return {
    jobId: state.jobId,
    stage: state.stage,
    sourceSheetName: state.sourceSheetName || '',
    totalRows,
    processedRows,
    reviewRows: Math.max(0, Number(state.reviewRows) || 0),
    blockedRows: Math.max(0, Number(state.blockedRows) || 0),
    currentItem: state.currentItem || '',
    message: state.message || '',
    error: state.error || '',
    percentage,
  };
}

function missingReviewBuildProgress_(jobId) {
  return {
    jobId: clean_(jobId),
    stage: 'FAILED',
    sourceSheetName: '',
    totalRows: 0,
    processedRows: 0,
    reviewRows: 0,
    blockedRows: 0,
    currentItem: '',
    message: 'This review-build job is no longer available.',
    error: 'Start Build Review again from the source sheet.',
    percentage: 0,
  };
}

function isTerminalReviewBuildStage_(stage) {
  return ['COMPLETE', 'FAILED', 'CANCELLED']
      .indexOf(normalize_(stage)) !== -1;
}

function formatReviewBuildError_(error) {
  return clean_(error && error.message ? error.message : error)
      .replace(/[\r\n]+/g, ' ')
      .substring(0, 500) || 'Unknown review-build error';
}

function findSheetById_(spreadsheet, sheetId) {
  const normalizedId = Number(sheetId);

  return spreadsheet.getSheets().find((sheet) => {
    return sheet.getSheetId() === normalizedId;
  }) || null;
}

function ensureSheetSize_(sheet, requiredRows, requiredColumns) {
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(
        sheet.getMaxRows(),
        requiredRows - sheet.getMaxRows());
  }

  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(
        sheet.getMaxColumns(),
        requiredColumns - sheet.getMaxColumns());
  }
}

function cleanupOldReviewBuilds_(spreadsheet) {
  const properties = PropertiesService.getUserProperties();
  const allProperties = properties.getProperties();
  const spreadsheetId = spreadsheet.getId();

  Object.keys(allProperties).forEach((key) => {
    if (key.indexOf(MYK_REVIEW_BUILD.stateKeyPrefix) !== 0) {
      return;
    }

    let oldState = null;

    try {
      oldState = JSON.parse(allProperties[key]);
    } catch (error) {
      // A malformed temporary state cannot be resumed safely.
    }

    if (!oldState || oldState.spreadsheetId === spreadsheetId) {
      properties.deleteProperty(key);
    }
  });

  spreadsheet.getSheets().forEach((sheet) => {
    if (
      sheet.getName().indexOf(MYK_REVIEW_BUILD.stagingSheetPrefix) === 0
    ) {
      spreadsheet.deleteSheet(sheet);
    }
  });
}

/**
 * Normalizes one source row.
 */
function buildNormalizedProduct_(
    sourceSheetName,
    sourceRowNumber,
    row,
    sourceIndices,
    profile) {
  const englishName = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.englishName);

  const chineseName = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.chineseName);

  const collection = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.collection);

  const brand = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.brand);

  const brandShortName = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.brandShortName);

  const collectionShortName = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.collectionShortName);

  const uniqueShortName = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.uniqueShortName);

  const sourceSku = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.sku);

  const generatedSku = [
    brandShortName,
    collectionShortName,
    uniqueShortName,
  ]
      .map(normalizeCodePart_)
      .filter(Boolean)
      .join('-');

  // An explicit SKU is preferred. If it is blank, generate the SKU from
  // brand, collection and unique short-name components.
  const sku = normalizeSku_(sourceSku || generatedSku);

  const itemType = normalizeCodePart_(profile.itemType);
  const itemId = sku ? `${itemType}-${sku}` : '';

  const inventoryValue = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.inventory);

  const stockValue = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.stock);

  const inventory = clean_(inventoryValue) !== ''
    ? parseWholeNumber_(inventoryValue)
    : parseWholeNumber_(stockValue);

  const baseColors = parseList_(
    getAliasedValue_(
        row,
        sourceIndices,
        profile.aliases.baseColors));

  const glitterColors = parseList_(
      getAliasedValue_(
          row,
          sourceIndices,
          profile.aliases.glitterColors));

  const sheenColors = parseList_(
      getAliasedValue_(
          row,
          sourceIndices,
          profile.aliases.sheenColors));

  const sourceOption = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.option);

  const glitterPotionColor = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.glitterPotionColor);

  const glitterPotionSize = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.glitterPotionSize);

  const penBaseColor = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.penBaseColor);

  const penSize = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.penSize);

  const tags = parseList_(
      getAliasedValue_(
          row,
          sourceIndices,
          profile.aliases.tags));

  const desc = getAliasedValue_(
      row,
      sourceIndices,
      profile.aliases.desc);

  const productType =
    getAliasedValue_(
        row,
        sourceIndices,
        profile.aliases.productType) ||
    itemType;

  const status = normalizeShopifyProductStatus_(
      getAliasedValue_(
          row,
          sourceIndices,
          profile.aliases.status));

  const existingTaxonomyCategoryId =
    normalizeTaxonomyCategoryId_(
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.taxonomyCategoryId));

  // resolveTaxonomyCategoryForProductType_ caches by normalized Product Type,
  // so each distinct type is looked up once without enlarging job state.
  const taxonomyCategoryId =
    resolveTaxonomyCategoryForProductType_(
        productType,
        existingTaxonomyCategoryId);

  const colorMode = profile.colorMode || '';
  const variantOptionValues = [];

  if (sourceOption) {
    variantOptionValues.push({
      optionName: 'Option',
      name: sourceOption,
    });
  }

  if (colorMode === 'GLITTER_POTION') {
    if (glitterPotionColor) {
      variantOptionValues.push({
        optionName: 'Glitter Potion Color',
        name: glitterPotionColor,
      });
    }

    if (glitterPotionSize) {
      variantOptionValues.push({
        optionName: 'Glitter Potion Size',
        name: glitterPotionSize,
      });
    }
  }

  if (colorMode === 'PEN') {
    if (penBaseColor) {
      variantOptionValues.push({
        optionName: 'Pen Base Color',
        name: penBaseColor,
      });
    }

    if (penSize) {
      variantOptionValues.push({
        optionName: 'Pen Size',
        name: penSize,
      });
    }
  }

  return {
    sourceSheetName,
    sourceRowNumber,
    itemType,
    itemId,
    handle: slugifyHandle_(englishName),
    englishName,
    collection,
    chineseName,
    title: englishName || chineseName,
    brand,
    productType,
    status,
    sku,

    price: parseMoney_(
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.price)),

    inventory,
    baseColors,
    glitterColors,
    sheenColors,
    sourceOption,
    glitterPotionColor,
    glitterPotionSize,
    penBaseColor,
    penSize,
    variantOptionValues,
    supportsSharedProductVariants:
      profile.supportsSharedProductVariants === true,
    taxonomyCategoryId,
    colorMode,
    tags,
    bodyHtml: normalizeBodyHtml_(desc),

    imageUrl: normalizeReviewImageUrls_(
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.imageUrl)),
  };
}

/**
 * Uses the same sheet format as Shopify Editor: one image URL per line, with
 * Google Drive images written as https://drive.google.com/uc?id=<FILE_ID>.
 */
function normalizeReviewImageUrls_(value) {
  const seen = new Set();

  return clean_(value)
      .split(/[\r\n;|]+/)
      .map((url) => normalizeReviewImageUrl_(url))
      .filter((url) => {
        if (!url || seen.has(url)) {
          return false;
        }

        seen.add(url);
        return true;
      })
      .join('\n');
}

function normalizeReviewImageUrl_(value) {
  const url = clean_(value);

  if (!url) {
    return '';
  }

  const isDriveUrl = /^https?:\/\/(?:www\.)?drive\.google\.com\//i
      .test(url);

  if (!isDriveUrl) {
    // A bare Drive file ID is also accepted for compatibility with manually
    // maintained source sheets. Other non-Drive URLs remain unchanged.
    return /^[A-Za-z0-9_-]{20,}$/.test(url)
      ? `https://drive.google.com/uc?id=${encodeURIComponent(url)}`
      : url;
  }

  const pathMatch = url.match(/\/file\/d\/([^/?#]+)/i);
  const queryMatch = url.match(/[?&]id=([^&#]+)/i);
  let fileId = pathMatch
    ? pathMatch[1]
    : queryMatch
      ? queryMatch[1]
      : '';

  try {
    fileId = decodeURIComponent(fileId);
  } catch (error) {
    // Keep the captured value when a manually entered URL contains malformed
    // percent encoding; validation below will reject an invalid file ID.
  }

  fileId = clean_(fileId);

  return /^[A-Za-z0-9_-]+$/.test(fileId)
    ? `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`
    : url;
}

/**
 * Resolves one current Shopify taxonomy category from Product Type.
 *
 * The live Admin API taxonomy for MYK_SHOPIFY.apiVersion is authoritative.
 * Shopify's latest published taxonomy distribution is a read-only fallback.
 * A pre-existing source-sheet category is retained only if both automatic
 * lookups cannot safely select one category.
 */
function resolveTaxonomyCategoryForProductType_(
    productType,
    fallbackCategoryId) {
  const normalizedType = normalizeProductTypeKey_(productType);
  const normalizedFallback = normalizeTaxonomyCategoryId_(
      fallbackCategoryId);

  if (!normalizedType) {
    return normalizedFallback;
  }

  const searchTerm =
    MYK_TAXONOMY.productTypeSearchTerms[normalizedType] ||
    clean_(productType);

  if (!searchTerm) {
    return normalizedFallback;
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = taxonomyCategoryCacheKey_(normalizedType);
  const cached = cache.get(cacheKey);

  if (cached) {
    const cachedValue = JSON.parse(cached);
    return cachedValue.gid || normalizedFallback;
  }

  let selected = null;
  let liveLookupFailed = false;

  try {
    selected = selectBestTaxonomyCategory_(
        searchShopifyTaxonomyCategories_(searchTerm),
        searchTerm);
  } catch (error) {
    liveLookupFailed = true;
    console.warn(
        `Live Shopify taxonomy lookup failed for “${productType}”: ` +
        `${error.message}`);
  }

  // Only download and parse the published taxonomy when the live API request
  // itself failed. A successful but ambiguous search must not trigger a slow
  // second lookup or silently choose a different category.
  if (!selected && liveLookupFailed) {
    try {
      selected = selectBestTaxonomyCategory_(
          getLatestPublishedTaxonomyCandidates_(searchTerm),
          searchTerm);
    } catch (error) {
      console.warn(
          `Published taxonomy fallback failed for “${productType}”: ` +
          `${error.message}`);
    }
  }

  if (selected && selected.gid) {
    cache.put(
        cacheKey,
        JSON.stringify({gid: selected.gid}),
        MYK_TAXONOMY.cacheSeconds);
    return selected.gid;
  }

  // Cache an unresolved automatic lookup, but retain a valid manual fallback.
  cache.put(
      cacheKey,
      JSON.stringify({gid: ''}),
      Math.min(MYK_TAXONOMY.cacheSeconds, 1800));
  return normalizedFallback;
}

/**
 * Searches the taxonomy exposed by the configured Shopify Admin API version.
 */
function searchShopifyTaxonomyCategories_(searchTerm) {
  const query = `
    query SearchCurrentProductTaxonomy($search: String!) {
      taxonomy {
        categories(first: 50, search: $search) {
          nodes {
            id
            name
            fullName
            isLeaf
            isArchived
            level
          }
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      getCachedShopifyAccessToken_(),
      query,
      {search: clean_(searchTerm)});

  const nodes =
    payload.data &&
    payload.data.taxonomy &&
    payload.data.taxonomy.categories &&
    Array.isArray(payload.data.taxonomy.categories.nodes)
      ? payload.data.taxonomy.categories.nodes
      : [];

  return nodes.map((category) => ({
    gid: category.id,
    leafName: category.name,
    breadcrumb: category.fullName,
    isLeaf: category.isLeaf === true,
    isArchived: category.isArchived === true,
    level: Number(category.level) || 0,
  }));
}

/**
 * Selects a category only when the search identifies it safely.
 */
function selectBestTaxonomyCategory_(categories, searchTerm) {
  const normalizedSearch = normalizeTaxonomyText_(searchTerm);

  if (!normalizedSearch || !Array.isArray(categories)) {
    return null;
  }

  const available = categories.filter((category) => {
    return category && category.gid && !category.isArchived;
  });

  const exactBreadcrumbMatches = available.filter((category) => {
    return normalizeTaxonomyText_(category.breadcrumb) === normalizedSearch;
  });

  if (exactBreadcrumbMatches.length === 1) {
    return exactBreadcrumbMatches[0];
  }

  const exactLeafMatches = available.filter((category) => {
    return normalizeTaxonomyText_(category.leafName) === normalizedSearch;
  });

  if (exactLeafMatches.length === 1) {
    return exactLeafMatches[0];
  }

  const exactLeafCategories = exactLeafMatches.filter((category) => {
    return category.isLeaf;
  });

  if (exactLeafCategories.length === 1) {
    return exactLeafCategories[0];
  }

  const partialMatches = available.filter((category) => {
    const leaf = normalizeTaxonomyText_(category.leafName);
    const breadcrumb = normalizeTaxonomyText_(category.breadcrumb);
    return (
      leaf.indexOf(normalizedSearch) !== -1 ||
      breadcrumb.indexOf(normalizedSearch) !== -1
    );
  });

  return partialMatches.length === 1
    ? partialMatches[0]
    : null;
}

/**
 * Discovers Shopify's latest GitHub release, then downloads its distribution.
 * If the release asset is temporarily unavailable, main/dist is used.
 */
function getLatestPublishedTaxonomyCandidates_(searchTerm) {
  const version = getLatestPublishedTaxonomyVersion_();
  const normalizedSearch = normalizeTaxonomyText_(searchTerm);
  const cache = CacheService.getScriptCache();
  const cacheKey =
    'MYK_TAXONOMY_DIST_' +
    version.replace(/[^0-9A-Z]+/gi, '_') + '_' +
    normalizedSearch.replace(/[^a-z0-9]+/g, '_').substring(0, 80);
  const cached = cache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const releaseUrl = version === 'main'
    ? MYK_TAXONOMY.mainDistributionUrl
    : MYK_TAXONOMY.publishedReleaseUrlTemplate
        .replace('{VERSION}', encodeURIComponent(version));

  let text;

  try {
    text = fetchTaxonomyText_(releaseUrl);
  } catch (releaseError) {
    console.warn(
        `Taxonomy release ${version} unavailable; using main: ` +
        `${releaseError.message}`);
    text = fetchTaxonomyText_(MYK_TAXONOMY.mainDistributionUrl);
  }

  const categories = text
      .split(/\r?\n/)
      .map((line) => clean_(line))
      .filter((line) => line && line.charAt(0) !== '#')
      .map((line) => {
        const separatorIndex = line.indexOf(' : ');

        if (separatorIndex === -1) {
          return null;
        }

        const gid = clean_(
            line.substring(0, separatorIndex));

        const breadcrumb = clean_(
            line.substring(separatorIndex + 3));

        if (
          gid.indexOf(
              'gid://shopify/TaxonomyCategory/') !== 0 ||
          !breadcrumb
        ) {
          return null;
        }

        const path = breadcrumb
            .split(' > ')
            .map((part) => clean_(part))
            .filter(Boolean);

        return {
          gid,
          breadcrumb,
          leafName:
            path.length > 0
              ? path[path.length - 1]
              : breadcrumb,
          isLeaf: true,
          isArchived: false,
          level: path.length,
        };
      })
      .filter(Boolean);

  if (categories.length === 0) {
    throw new Error(
        'The Shopify taxonomy release contained no readable categories.');
  }

  const relevantCategories = categories.filter((category) => {
    const searchable = normalizeTaxonomyText_(
        `${category.leafName} ${category.breadcrumb}`);
    return searchable.indexOf(normalizedSearch) !== -1;
  });

  const serialized = JSON.stringify(relevantCategories);

  if (serialized.length < 90000) {
    cache.put(
        cacheKey,
        serialized,
        MYK_TAXONOMY.cacheSeconds);
  }

  return relevantCategories;
}

function getLatestPublishedTaxonomyVersion_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'MYK_TAXONOMY_PUBLISHED_VERSION';
  const cached = cache.get(cacheKey);

  if (cached) {
    return cached;
  }

  let version = '';

  try {
    const response = UrlFetchApp.fetch(
        MYK_TAXONOMY.latestReleaseApiUrl,
        {
          muteHttpExceptions: true,
          followRedirects: true,
          headers: {
            Accept: 'application/vnd.github+json',
          },
        });
    const status = response.getResponseCode();

    if (status < 200 || status >= 300) {
      throw new Error(`GitHub releases API returned ${status}`);
    }

    const payload = JSON.parse(response.getContentText());
    version = clean_(payload.tag_name).replace(/^v/i, '');

    if (!/^\d{4}-\d{2}$/.test(version)) {
      throw new Error(`Unexpected release tag: ${payload.tag_name}`);
    }
  } catch (error) {
    /*
     * The live Shopify Admin taxonomy remains the primary source. If both it
     * and GitHub's release endpoint are unavailable, main/dist is the last
     * read-only fallback instead of a permanently pinned old release.
     */
    console.warn(
        `Unable to discover published taxonomy release; using main: ` +
        `${error.message}`);
    version = 'main';
  }

  cache.put(cacheKey, version, MYK_TAXONOMY.cacheSeconds);
  return version;
}

function fetchTaxonomyText_(url) {
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      Accept: 'text/plain',
    },
  });
  const status = response.getResponseCode();

  if (status < 200 || status >= 300) {
    throw new Error(`Taxonomy download failed (${status}) from ${url}`);
  }

  return response.getContentText();
}

function taxonomyCategoryCacheKey_(normalizedProductType) {
  return (
    'MYK_TAXONOMY_CATEGORY_' +
    MYK_SHOPIFY.apiVersion.replace(/[^0-9A-Z]+/gi, '_') + '_' +
    normalizedProductType
        .replace(/[^A-Z0-9]+/g, '_')
        .substring(0, 120)
  );
}

function normalizeProductTypeKey_(value) {
  return clean_(value)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .toUpperCase();
}

function normalizeTaxonomyText_(value) {
  return clean_(value)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

/**
 * Validates normalized local data.
 *
 * Repeating SKU is not blocked here. One existing exact Shopify SKU means
 * UPDATE_EXISTING. Multiple exact matches are blocked during preflight.
 */
function validateNormalizedProduct_(product) {
  const errors = [];

  if (!product.englishName) {
    errors.push('MISSING_ENGLISH_NAME');
  }

  if (!product.handle) {
    errors.push('MISSING_HANDLE');
  }

  if (!product.brand) {
    errors.push('MISSING_BRAND');
  }

  if (!product.sku) {
    errors.push('MISSING_SKU');
  } else if (!isStructuredSku_(product.sku)) {
    errors.push('SKU_MUST_HAVE_BRAND_COLLECTION_UNIQUE_FORMAT');
  }

  if (!product.itemId) {
    errors.push('MISSING_ITEM_ID');
  }

  if (!Number.isFinite(product.price) || product.price <= 0) {
    errors.push('MISSING_OR_INVALID_PRICE');
  }

  if (
    product.inventory === null ||
    !Number.isInteger(product.inventory) ||
    product.inventory < 0
  ) {
    errors.push('MISSING_OR_INVALID_INVENTORY');
  }

  if (!product.productType) {
    errors.push('MISSING_PRODUCT_TYPE');
  }

  if (!isValidShopifyProductStatus_(product.status)) {
    errors.push('MISSING_OR_INVALID_STATUS');
  }

  if (
    product.colorMode === 'INK' &&
    product.baseColors.length === 0
  ) {
    errors.push('MISSING_INK_BASE_COLOR');
  }

  if (
    product.colorMode === 'GLITTER_POTION' &&
    !product.glitterPotionColor
  ) {
    errors.push('MISSING_GLITTER_POTION_COLOR');
  }

  if (
    product.colorMode === 'GLITTER_POTION' &&
    !product.glitterPotionSize
  ) {
    errors.push('MISSING_GLITTER_POTION_SIZE');
  }

  return errors.length
    ? `BLOCKED: ${errors.join(', ')}`
    : 'READY_FOR_SHOPIFY_CHECK';
}

function normalizeShopifyProductStatus_(value) {
  return normalize_(value);
}

function isValidShopifyProductStatus_(value) {
  return MYK_SHOPIFY.allowedProductStatuses.indexOf(
      normalizeShopifyProductStatus_(value)) !== -1;
}

function createActionForStatus_(status) {
  const normalizedStatus = normalizeShopifyProductStatus_(status);

  if (!isValidShopifyProductStatus_(normalizedStatus)) {
    throw new Error(
        `Cannot create Shopify product with status: ${status || '(blank)'}.`);
  }

  return `CREATE_${normalizedStatus}`;
}

function isCreateProductAction_(action) {
  return [
    'CREATE_ACTIVE',
    'CREATE_DRAFT',
    'CREATE_ARCHIVED',
  ].indexOf(normalize_(action)) !== -1;
}

function normalizeTaxonomyCategoryId_(value) {
  const text = clean_(value);

  if (!text) {
    return '';
  }

  if (
    text.indexOf(
        'gid://shopify/TaxonomyCategory/') === 0
  ) {
    return text;
  }

  // Shopify taxonomy handles have used prefixes such as sg, aa and os across
  // releases. Accept the published handle format instead of pinning one
  // historical prefix.
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(text)) {
    return (
      'gid://shopify/TaxonomyCategory/' +
      text.toLowerCase()
    );
  }

  throw new Error(
      `Invalid Shopify taxonomy ID: ${value}`);
}

/**
 * Performs read-only Shopify SKU checks.
 */
function preflightReviewRows() {
  const accessToken = getCachedShopifyAccessToken_();
  const spreadsheet = SpreadsheetApp.getActive();

  const reviewSheet = requireSheet_(
      spreadsheet,
      MYK_SHOPIFY.reviewSheetName);

  const values = reviewSheet.getDataRange().getDisplayValues();
  const indices = getColumnIndices(reviewSheet);

  const handleIndex = requiredColumn_(
    indices,
    'Handle');

  const collectionIndex = requiredColumn_(
      indices,
      'Collection');

  const statusIndex = requiredColumn_(
      indices,
      'Status');

  const validationIndex = requiredColumn_(
      indices,
      'Validation');

  const actionIndex = requiredColumn_(
      indices,
      'Upload Action');

  const skuIndex = requiredColumn_(
      indices,
      'SKU');

  const sourceSheetIndex = requiredColumn_(
      indices,
      'Source Sheet');

  const sourceRowIndex = requiredColumn_(
      indices,
      'Source Row');

  const productGidIndex = requiredColumn_(
      indices,
      'Shopify Product GID');

  const variantGidIndex = requiredColumn_(
      indices,
      'Shopify Variant GID');

  const inventoryItemGidIndex = requiredColumn_(
      indices,
      'Shopify Inventory Item GID');

  const resultIndex = requiredColumn_(
      indices,
      'Shopify Result');

  const updates = [];
  const plannedVariantHandles = {};
  const variantHandleCollections = {};
  const variantHandleStatuses = {};

  values.slice(1).forEach((candidate) => {
    const candidateSheet = clean_(candidate[sourceSheetIndex]);
    const candidateProfile = MYK_SHEET_PROFILES[candidateSheet] || {};

    if (candidateProfile.supportsSharedProductVariants !== true) {
      return;
    }

    const handleKey = slugifyHandle_(candidate[handleIndex]);

    if (!handleKey) {
      return;
    }

    if (!variantHandleCollections[handleKey]) {
      variantHandleCollections[handleKey] = new Set();
      variantHandleStatuses[handleKey] = new Set();
    }

    variantHandleCollections[handleKey].add(
        normalize_(candidate[collectionIndex]));
    variantHandleStatuses[handleKey].add(
        normalizeShopifyProductStatus_(candidate[statusIndex]));
  });

  for (let offset = 1; offset < values.length; offset += 1) {
    const row = values[offset];

    let action = clean_(row[actionIndex]);
    let productGid = clean_(row[productGidIndex]);
    let variantGid = clean_(row[variantGidIndex]);
    let inventoryItemGid = clean_(row[inventoryItemGidIndex]);
    let result = clean_(row[resultIndex]);

    const sourceSheetName = clean_(row[sourceSheetIndex]);
    const sourceRow = Number(row[sourceRowIndex]);
    const sourceProfile =
      MYK_SHEET_PROFILES[sourceSheetName] || {};
    const supportsSharedProductVariants =
      sourceProfile.supportsSharedProductVariants === true;

    if (
      normalize_(row[validationIndex]) !==
      'READY_FOR_SHOPIFY_CHECK'
    ) {
      action = 'BLOCKED';
      result = clean_(row[validationIndex]) || 'BLOCKED: local validation failed';

      writeSourceUploadResult_(
          spreadsheet,
          sourceSheetName,
          sourceRow,
          result,
          false);

      updates.push([
        action,
        productGid,
        variantGid,
        inventoryItemGid,
        result,
      ]);

      continue;
    }

    const rowHandleKey = slugifyHandle_(row[handleIndex]);

    if (
      supportsSharedProductVariants &&
      variantHandleCollections[rowHandleKey] &&
      variantHandleCollections[rowHandleKey].size > 1
    ) {
      action = 'BLOCKED';
      result =
        'BLOCKED: SAME_HANDLE_HAS_DIFFERENT_COLLECTION_NAMES';

      writeSourceUploadResult_(
          spreadsheet,
          sourceSheetName,
          sourceRow,
          result,
          false);

      updates.push([
        action,
        productGid,
        variantGid,
        inventoryItemGid,
        result,
      ]);
      continue;
    }

    if (
      supportsSharedProductVariants &&
      variantHandleStatuses[rowHandleKey] &&
      variantHandleStatuses[rowHandleKey].size > 1
    ) {
      action = 'BLOCKED';
      result =
        'BLOCKED: SAME_PRODUCT_VARIANTS_HAVE_DIFFERENT_STATUSES';

      writeSourceUploadResult_(
          spreadsheet,
          sourceSheetName,
          sourceRow,
          result,
          false);

      updates.push([
        action,
        productGid,
        variantGid,
        inventoryItemGid,
        result,
      ]);
      continue;
    }

    try {
      const resolution =
        resolveShopifyProductIdentity_(
            accessToken,
            clean_(row[skuIndex]),
            clean_(row[handleIndex]),
            supportsSharedProductVariants);

      action = resolution.action;
      result = resolution.message;

      if (action === 'CREATE_ACTIVE') {
        action = createActionForStatus_(row[statusIndex]);
        result = `READY_TO_${action}`;
      }

      const normalizedHandle = slugifyHandle_(
          clean_(row[handleIndex]));
      const plannedGroupKey = [
        normalizedHandle,
        normalize_(row[collectionIndex]),
      ].join('|');

      // If several new source rows share one glitter-potion handle, only the
      // first row creates the product. Later rows create variants on it.
      if (
        supportsSharedProductVariants &&
        isCreateProductAction_(action)
      ) {
        if (plannedVariantHandles[plannedGroupKey]) {
          action = 'CREATE_VARIANT';
          result =
            'READY_TO_CREATE_VARIANT_AFTER_PRODUCT';
        } else {
          plannedVariantHandles[plannedGroupKey] = true;
        }
      }

      if (resolution.identity) {
        productGid =
          resolution.identity.productId;

        variantGid =
          resolution.identity.variantId;

        inventoryItemGid =
          resolution.identity.inventoryItemId;

        // The identity is safe to persist only after Shopify resolution has
        // returned one unambiguous product and variant.
        writeSourceShopifyIdentity_(
            spreadsheet,
            sourceSheetName,
            sourceRow,
            resolution.identity);
      } else {
        productGid = '';
        variantGid = '';
        inventoryItemGid = '';
      }

      if (action === 'BLOCKED') {
        writeSourceUploadResult_(
            spreadsheet,
            sourceSheetName,
            sourceRow,
            result,
            false);
      }
    } catch (error) {
      action = 'CHECK_FAILED';
      result = `CHECK_FAILED: ${error.message}`;

      writeSourceUploadResult_(
          spreadsheet,
          sourceSheetName,
          sourceRow,
          result,
          false);
    }

    updates.push([
      action,
      productGid,
      variantGid,
      inventoryItemGid,
      result,
    ]);
  }

  if (updates.length > 0) {
    writeSingleColumn_(
        reviewSheet,
        actionIndex,
        updates.map((row) => row[0]));

    writeSingleColumn_(
        reviewSheet,
        productGidIndex,
        updates.map((row) => row[1]));

    writeSingleColumn_(
        reviewSheet,
        variantGidIndex,
        updates.map((row) => row[2]));

    writeSingleColumn_(
        reviewSheet,
        inventoryItemGidIndex,
        updates.map((row) => row[3]));

    writeSingleColumn_(
        reviewSheet,
        resultIndex,
        updates.map((row) => row[4]));
  }

  SpreadsheetApp.getUi().alert(
      'Shopify preflight finished.\n\n' +
      'CREATE_ACTIVE / CREATE_DRAFT / CREATE_ARCHIVED: ' +
      'create using the source-sheet status.\n' +
      'CREATE_VARIANT: add a new variant to a shared product handle.\n' +
      'UPDATE_EXISTING: one exact matching SKU exists.\n' +
      'BLOCKED: multiple exact SKU matches or local validation failed.\n' +
      'CHECK_FAILED: Shopify lookup failed.\n\n' +
      'Blocked and failed reasons were written back to the original sheet.');
}

/**
 * Finds exact Shopify variant SKU matches.
 */
/**
 * Resolves a Shopify product using SKU first and handle second.
 *
 * Resolution:
 *   1 exact SKU                    -> UPDATE_EXISTING
 *   Multiple SKU matches, but only
 *   one has the expected handle    -> UPDATE_EXISTING
 *   No SKU match, handle exists
 *   with exactly one variant       -> UPDATE_EXISTING_BY_HANDLE
 *   No SKU and no handle           -> CREATE_ACTIVE
 *   Otherwise                      -> BLOCKED
 */
function resolveShopifyProductIdentity_(
    accessToken,
    sku,
    handle,
    allowNewVariant) {
  const normalizedSku = normalizeSku_(sku);
  const normalizedHandle = slugifyHandle_(handle);

  const query = `
    query ResolveProductIdentity(
      $skuQuery: String!,
      $identifier: ProductIdentifierInput!
    ) {
      productVariants(first: 50, query: $skuQuery) {
        nodes {
          id
          sku
          inventoryItem {
            id
            tracked
          }
          product {
            id
            title
            handle
            status
          }
        }
      }

      productByHandle: productByIdentifier(
        identifier: $identifier
      ) {
        id
        title
        handle
        status
        variants(first: 20) {
          nodes {
            id
            sku
            inventoryItem {
              id
              tracked
            }
          }
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {
        skuQuery:
          `sku:${escapeShopifySearchValue_(normalizedSku)}`,

        identifier: {
          handle: normalizedHandle,
        },
      });

  const variantNodes =
    payload.data &&
    payload.data.productVariants &&
    Array.isArray(payload.data.productVariants.nodes)
      ? payload.data.productVariants.nodes
      : [];

  const exactSkuMatches = variantNodes
      .filter((node) => {
        return (
          normalizeSku_(node.sku) === normalizedSku
        );
      })
      .map((node) => ({
        productId: node.product.id,
        variantId: node.id,

        inventoryItemId:
          node.inventoryItem &&
          node.inventoryItem.id
            ? node.inventoryItem.id
            : '',

        title: node.product.title,
        handle: node.product.handle,
        status: node.product.status,
        matchedBy: 'SKU',
      }));

  // One unambiguous exact SKU.
  if (exactSkuMatches.length === 1) {
    return {
      action: 'UPDATE_EXISTING',
      identity: exactSkuMatches[0],
      message:
        `READY_TO_UPDATE_BY_SKU: ` +
        `${exactSkuMatches[0].title} ` +
        `(${exactSkuMatches[0].handle})`,
    };
  }

  /*
   * Multiple exact SKU matches:
   * use the expected handle only when it identifies exactly one of them.
   */
  if (exactSkuMatches.length > 1) {
    const sameHandleMatches =
      exactSkuMatches.filter((match) => {
        return (
          slugifyHandle_(match.handle) ===
          normalizedHandle
        );
      });

    if (sameHandleMatches.length === 1) {
      return {
        action: 'UPDATE_EXISTING',
        identity: sameHandleMatches[0],
        message:
          `READY_TO_UPDATE_BY_SKU_AND_HANDLE: ` +
          `${sameHandleMatches[0].title} ` +
          `(${sameHandleMatches[0].handle})`,
      };
    }

    return {
      action: 'BLOCKED',
      identity: null,
      message:
        `BLOCKED: ${exactSkuMatches.length} exact SKU matches; ` +
        `handle “${normalizedHandle}” did not identify exactly one product`,
    };
  }

  const handleProduct =
    payload.data && payload.data.productByHandle;

  // Neither SKU nor handle exists.
  if (!handleProduct) {
    return {
      action: 'CREATE_ACTIVE',
      identity: null,
      message: 'READY_TO_CREATE_ACTIVE',
    };
  }

  const handleVariants =
    handleProduct.variants &&
    Array.isArray(handleProduct.variants.nodes)
      ? handleProduct.variants.nodes
      : [];

  if (allowNewVariant === true) {
    return {
      action: 'CREATE_VARIANT',
      identity: {
        productId: handleProduct.id,
        variantId: '',
        inventoryItemId: '',
        title: handleProduct.title,
        handle: handleProduct.handle,
        status: handleProduct.status,
        matchedBy: 'HANDLE_FOR_NEW_VARIANT',
      },
      message:
        `READY_TO_CREATE_VARIANT: ` +
        `${handleProduct.title} (${handleProduct.handle})`,
    };
  }

  /*
   * A handle identifies a product, but we still need an unambiguous variant
   * to update its SKU and price.
   */
  if (handleVariants.length !== 1) {
    return {
      action: 'BLOCKED',
      identity: null,
      message:
        `BLOCKED: Shopify handle exists but contains ` +
        `${handleVariants.length} variants — ` +
        `${handleProduct.title} (${handleProduct.handle})`,
    };
  }

  const variant = handleVariants[0];

  return {
    action: 'UPDATE_EXISTING',
    identity: {
      productId: handleProduct.id,
      variantId: variant.id,

      inventoryItemId:
        variant.inventoryItem &&
        variant.inventoryItem.id
          ? variant.inventoryItem.id
          : '',

      title: handleProduct.title,
      handle: handleProduct.handle,
      status: handleProduct.status,
      matchedBy: 'HANDLE',
      existingSku: clean_(variant.sku),
    },

    message:
      `READY_TO_UPDATE_BY_HANDLE: ` +
      `${handleProduct.title} (${handleProduct.handle}); ` +
      `existing SKU=${clean_(variant.sku) || '(blank)'}`,
  };
}

/**
 * Displays the row-selection approval popup.
 */
function showApprovalDialog() {
  const html = HtmlService
      .createHtmlOutput(buildApprovalDialogHtml_())
      .setWidth(920)
      .setHeight(600);

  SpreadsheetApp.getUi().showModalDialog(
      html,
      'Approve Shopify product rows');
}

/**
 * Supplies review rows to the approval popup.
 */
function getApprovalCandidates() {
  const spreadsheet = SpreadsheetApp.getActive();

  const reviewSheet = requireSheet_(
      spreadsheet,
      MYK_SHOPIFY.reviewSheetName);

  const values = reviewSheet.getDataRange().getDisplayValues();
  const indices = getColumnIndices(reviewSheet);

  const approvalIndex = requiredColumn_(
      indices,
      'Approval');

  const validationIndex = requiredColumn_(
      indices,
      'Validation');

  const actionIndex = requiredColumn_(
      indices,
      'Upload Action');

  const statusIndex = requiredColumn_(
      indices,
      'Status');

  const sourceRowIndex = requiredColumn_(
      indices,
      'Source Row');

  const itemIdIndex = requiredColumn_(
      indices,
      'Item ID');

  const titleIndex = requiredColumn_(
      indices,
      'English Name');

  const skuIndex = requiredColumn_(
      indices,
      'SKU');

  const priceIndex = requiredColumn_(
      indices,
      'Price');

  const inventoryIndex = requiredColumn_(
      indices,
      'Inventory');

  const optionIndex = requiredColumn_(
      indices,
      'Option');

  const glitterPotionColorIndex = requiredColumn_(
      indices,
      'Glitter Potion Color');

  const glitterPotionSizeIndex = requiredColumn_(
      indices,
      'Glitter Potion Size');

  const penBaseColorIndex = requiredColumn_(
      indices,
      'Pen Base Color');

  const penSizeIndex = requiredColumn_(
      indices,
      'Pen Size');

  const resultIndex = requiredColumn_(
      indices,
      'Shopify Result');

  return values
      .slice(1)
      .map((row, offset) => ({
        sheetRow: offset + 2,
        sourceRow: row[sourceRowIndex],
        itemId: row[itemIdIndex],
        title: row[titleIndex],
        sku: row[skuIndex],
        price: row[priceIndex],
        inventory: row[inventoryIndex],
        option: row[optionIndex],
        glitterPotionColor: row[glitterPotionColorIndex],
        glitterPotionSize: row[glitterPotionSizeIndex],
        penBaseColor: row[penBaseColorIndex],
        penSize: row[penSizeIndex],
        validation: row[validationIndex],
        action: row[actionIndex],
        status: row[statusIndex],
        result: row[resultIndex],

        approved:
          normalize_(row[approvalIndex]) === 'APPROVED',

        selectable:
          normalize_(row[validationIndex]) ===
            'READY_FOR_SHOPIFY_CHECK' &&
          (
            isCreateProductAction_(row[actionIndex]) ||
            normalize_(row[actionIndex]) === 'CREATE_VARIANT' ||
            normalize_(row[actionIndex]) === 'UPDATE_EXISTING'
          ),
      }));
}

/**
 * Saves popup row selections as APPROVED.
 */
function approveSelectedReviewRows(sheetRows) {
  if (!Array.isArray(sheetRows)) {
    throw new Error('No selected rows were supplied.');
  }

  const selected = new Set(
      sheetRows.map((value) => Number(value)));

  const spreadsheet = SpreadsheetApp.getActive();

  const reviewSheet = requireSheet_(
      spreadsheet,
      MYK_SHOPIFY.reviewSheetName);

  const values = reviewSheet.getDataRange().getDisplayValues();
  const indices = getColumnIndices(reviewSheet);

  const approvalIndex = requiredColumn_(
      indices,
      'Approval');

  const validationIndex = requiredColumn_(
      indices,
      'Validation');

  const actionIndex = requiredColumn_(
      indices,
      'Upload Action');

  const approvals = [];
  let approvedCount = 0;

  for (let offset = 1; offset < values.length; offset += 1) {
    const sheetRow = offset + 1;
    const row = values[offset];

    const locallyValid =
      normalize_(row[validationIndex]) ===
      'READY_FOR_SHOPIFY_CHECK';

    const action = normalize_(row[actionIndex]);

    const shopifyValid =
      isCreateProductAction_(action) ||
      action === 'CREATE_VARIANT' ||
      action === 'UPDATE_EXISTING';

    const approval =
      selected.has(sheetRow) &&
      locallyValid &&
      shopifyValid
        ? 'APPROVED'
        : 'PENDING';

    approvals.push(approval);

    if (approval === 'APPROVED') {
      approvedCount += 1;
    }
  }

  writeSingleColumn_(
      reviewSheet,
      approvalIndex,
      approvals);

  return {
    approvedCount,
    message:
      `Approved ${approvedCount} row(s). ` +
      'Shopify has not been changed yet.',
  };
}

/**
 * Uploads every APPROVED review row.
 */
function uploadApprovedRows() {
  const ui = SpreadsheetApp.getUi();

  const confirmation = ui.alert(
      'Start sync?',
      'Approved rows will upload now and resume automatically if needed.',
      ui.ButtonSet.YES_NO);

  if (confirmation !== ui.Button.YES) {
    return;
  }

  const spreadsheet = SpreadsheetApp.getActive();

  const reviewSheet = requireSheet_(
      spreadsheet,
      MYK_SHOPIFY.reviewSheetName);

  const values =
    reviewSheet.getDataRange().getDisplayValues();

  const indices = getColumnIndices(reviewSheet);

  const approvalIndex = requiredColumn_(
      indices,
      'Approval');

  const total = values
      .slice(1)
      .filter((row) => {
        return (
          normalize_(row[approvalIndex]) ===
          'APPROVED'
        );
      })
      .length;

  if (total === 0) {
    ui.alert(
        'No APPROVED rows were found. Approve rows first.');
    return;
  }

  const properties =
    PropertiesService.getScriptProperties();

  properties.setProperties({
    [MYK_UPLOAD_JOB.spreadsheetIdProperty]:
      spreadsheet.getId(),

    [MYK_UPLOAD_JOB.nextRowProperty]:
      '2',

    [MYK_UPLOAD_JOB.runningProperty]:
      'true',

    [MYK_UPLOAD_JOB.totalProperty]:
      String(total),

    [MYK_UPLOAD_JOB.processedProperty]:
      '0',

    [MYK_UPLOAD_JOB.successProperty]:
      '0',

    [MYK_UPLOAD_JOB.failedProperty]:
      '0',

    [MYK_UPLOAD_JOB.currentItemProperty]:
      '',

    [MYK_UPLOAD_JOB.finishedProperty]:
      'false',
  });

  deleteUploadResumeTriggers_();

  showUploadProgressDialog();

  /*
   * Do not use a trigger for the initial batch.
   * Calling this directly also forces Apps Script to request any missing
   * authorization while the user is present.
   */
  processApprovedUploadBatch_();
}

function showUploadProgressDialog() {
  const html = HtmlService
      .createHtmlOutput(buildUploadProgressHtml_())
      .setWidth(460)
      .setHeight(265);

  SpreadsheetApp.getUi().showModelessDialog(
      html,
      'Shopify sync');
}

function getUploadProgress() {
  const properties =
    PropertiesService.getScriptProperties();

  const total = Number(
      properties.getProperty(
          MYK_UPLOAD_JOB.totalProperty) || 0);

  const processed = Number(
      properties.getProperty(
          MYK_UPLOAD_JOB.processedProperty) || 0);

  const succeeded = Number(
      properties.getProperty(
          MYK_UPLOAD_JOB.successProperty) || 0);

  const failed = Number(
      properties.getProperty(
          MYK_UPLOAD_JOB.failedProperty) || 0);

  const running =
    properties.getProperty(
        MYK_UPLOAD_JOB.runningProperty) === 'true';

  const finished =
    properties.getProperty(
        MYK_UPLOAD_JOB.finishedProperty) === 'true';

  return {
    total,
    processed,
    succeeded,
    failed,
    running,
    finished,
    currentItem:
      properties.getProperty(
          MYK_UPLOAD_JOB.currentItemProperty) || '',
    percentage:
      total > 0
        ? Math.min(
            100,
            Math.round((processed / total) * 100))
        : 0,
  };
}

function buildUploadProgressHtml_() {
  return `
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 18px;
      color: #202124;
    }

    .track {
      height: 18px;
      background: #e8eaed;
      border-radius: 9px;
      overflow: hidden;
      margin: 14px 0 8px;
    }

    .bar {
      width: 0%;
      height: 100%;
      background: #1a73e8;
      transition: width 0.35s ease;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-top: 16px;
    }

    .metric {
      border: 1px solid #dadce0;
      border-radius: 6px;
      padding: 8px;
      text-align: center;
    }

    .number {
      display: block;
      font-size: 18px;
      font-weight: bold;
    }

    .label {
      font-size: 11px;
      color: #5f6368;
    }

    #current {
      margin-top: 12px;
      font-size: 12px;
      word-break: break-word;
      min-height: 30px;
    }
  </style>
</head>
<body>
  <strong id="title">Preparing sync…</strong>

  <div class="track">
    <div class="bar" id="bar"></div>
  </div>

  <div id="percentage">0%</div>

  <div class="summary">
    <div class="metric">
      <span class="number" id="processed">0</span>
      <span class="label">Processed</span>
    </div>

    <div class="metric">
      <span class="number" id="success">0</span>
      <span class="label">Success</span>
    </div>

    <div class="metric">
      <span class="number" id="failed">0</span>
      <span class="label">Failed</span>
    </div>
  </div>

  <div id="current"></div>

  <script>
    let timer = null;

    function refresh() {
      google.script.run
        .withSuccessHandler(render)
        .withFailureHandler(showError)
        .getUploadProgress();
    }

    function render(progress) {
      document.getElementById('bar').style.width =
        progress.percentage + '%';

      document.getElementById('percentage').textContent =
        progress.percentage + '% — ' +
        progress.processed + ' / ' + progress.total;

      document.getElementById('processed').textContent =
        progress.processed;

      document.getElementById('success').textContent =
        progress.succeeded;

      document.getElementById('failed').textContent =
        progress.failed;

      document.getElementById('current').textContent =
        progress.currentItem
          ? 'Current: ' + progress.currentItem
          : '';

      if (progress.finished) {
        document.getElementById('title').textContent =
          'Sync complete';

        clearInterval(timer);
      } else if (progress.running) {
        document.getElementById('title').textContent =
          'Uploading to Shopify…';
      } else {
        document.getElementById('title').textContent =
          'Waiting to resume…';
      }
    }

    function showError(error) {
      document.getElementById('title').textContent =
        error && error.message
          ? error.message
          : String(error);
    }

    refresh();
    timer = setInterval(refresh, 1500);
  </script>
</body>
</html>
  `;
}

function resumeApprovedRowsUpload() {
  processApprovedUploadBatch_();
}

function processApprovedUploadBatch_() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    const startedAt = Date.now();

    const properties =
      PropertiesService.getScriptProperties();

    if (
      properties.getProperty(
          MYK_UPLOAD_JOB.runningProperty) !== 'true'
    ) {
      deleteUploadResumeTriggers_();
      return;
    }

    const spreadsheetId = properties.getProperty(
        MYK_UPLOAD_JOB.spreadsheetIdProperty);

    if (!spreadsheetId) {
      throw new Error(
          'Upload job has no saved Spreadsheet ID.');
    }

    const spreadsheet =
      SpreadsheetApp.openById(spreadsheetId);

    const reviewSheet = requireSheet_(
        spreadsheet,
        MYK_SHOPIFY.reviewSheetName);

    const values =
      reviewSheet.getDataRange().getDisplayValues();

    const indices = getColumnIndices(reviewSheet);

    const englishNameIndex =
      requiredColumn_(indices, 'English Name');

    const approvalIndex =
      requiredColumn_(indices, 'Approval');

    const actionIndex =
      requiredColumn_(indices, 'Upload Action');

    const sourceSheetIndex =
      requiredColumn_(indices, 'Source Sheet');

    const sourceRowIndex =
      requiredColumn_(indices, 'Source Row');

    const resultIndex =
      requiredColumn_(indices, 'Shopify Result');

    let nextRow = Number(
        properties.getProperty(
            MYK_UPLOAD_JOB.nextRowProperty) || 2);

    for (
      let sheetRow = nextRow;
      sheetRow <= values.length;
      sheetRow += 1
    ) {
      properties.setProperty(
          MYK_UPLOAD_JOB.nextRowProperty,
          String(sheetRow));

      if (
        Date.now() - startedAt >=
        MYK_UPLOAD_JOB.maxRuntimeMs
      ) {
        scheduleUploadResume_();
        return;
      }

      const row = values[sheetRow - 1];

      if (
        normalize_(row[approvalIndex]) !== 'APPROVED'
      ) {
        properties.setProperty(
            MYK_UPLOAD_JOB.nextRowProperty,
            String(sheetRow + 1));

        continue;
      }

      properties.setProperty(
        MYK_UPLOAD_JOB.currentItemProperty,
        clean_(row[englishNameIndex]) ||
        `Review row ${sheetRow}`);

      try {
        processOneApprovedReviewRow_(
          spreadsheet,
          reviewSheet,
          row,
          sheetRow,
          indices);

        incrementUploadJobCounter_(
            MYK_UPLOAD_JOB.successProperty);

        incrementUploadJobCounter_(
            MYK_UPLOAD_JOB.processedProperty);
      } catch (error) {
        const failureResult =
          `FAILED: ${error.message}`;

        writeCell_(
            reviewSheet,
            sheetRow,
            approvalIndex,
            'UPLOAD_FAILED');

        writeCell_(
            reviewSheet,
            sheetRow,
            resultIndex,
            failureResult);

        writeSourceUploadResult_(
            spreadsheet,
            clean_(row[sourceSheetIndex]),
            Number(row[sourceRowIndex]),
            failureResult,
            false);
        incrementUploadJobCounter_(
            MYK_UPLOAD_JOB.failedProperty);

        incrementUploadJobCounter_(
            MYK_UPLOAD_JOB.processedProperty);
      }

      properties.setProperty(
          MYK_UPLOAD_JOB.nextRowProperty,
          String(sheetRow + 1));
    }

    properties.setProperties({
      [MYK_UPLOAD_JOB.runningProperty]: 'false',
      [MYK_UPLOAD_JOB.finishedProperty]: 'true',
      [MYK_UPLOAD_JOB.currentItemProperty]: '',
    });

    deleteUploadResumeTriggers_();

    clearUploadJob_();
  } finally {
    lock.releaseLock();
  }
}

function processOneApprovedReviewRow_(
    spreadsheet,
    reviewSheet,
    row,
    sheetRow,
    indices) {
  const accessToken =
    getCachedShopifyAccessToken_();

  const locationId =
    MYK_SHOPIFY.inventoryWriteEnabled
      ? requireScriptProperty_(
          'SHOPIFY_LOCATION_ID')
      : '';

  const approvalIndex =
    requiredColumn_(indices, 'Approval');

  const actionIndex =
    requiredColumn_(indices, 'Upload Action');

  const itemIdIndex =
    requiredColumn_(indices, 'Item ID');

  const handleIndex =
    requiredColumn_(indices, 'Handle');

  const englishNameIndex =
    requiredColumn_(indices, 'English Name');

  const chineseNameIndex =
    requiredColumn_(indices, 'Chinese Name');

  const brandIndex =
    requiredColumn_(indices, 'Brand');

  const typeIndex =
    requiredColumn_(indices, 'Product Type');

  const statusIndex =
    requiredColumn_(indices, 'Status');

  const taxonomyIndex =
    requiredColumn_(
        indices,
        'Shopify Taxonomy ID');

  const skuIndex =
    requiredColumn_(indices, 'SKU');

  const priceIndex =
    requiredColumn_(indices, 'Price');

  const inventoryIndex =
    requiredColumn_(indices, 'Inventory');

  const baseColorsIndex =
    requiredColumn_(
        indices,
        'Ink Base Colors');

  const glitterColorsIndex =
    requiredColumn_(
        indices,
        'Ink Glitter Colors');

  const sheenColorsIndex =
    requiredColumn_(
        indices,
        'Ink Sheen Colors');

  const optionIndex =
    requiredColumn_(indices, 'Option');

  const glitterPotionColorIndex =
    requiredColumn_(
        indices,
        'Glitter Potion Color');

  const glitterPotionSizeIndex =
    requiredColumn_(
        indices,
        'Glitter Potion Size');

  const penBaseColorIndex =
    requiredColumn_(
        indices,
        'Pen Base Color');

  const penSizeIndex =
    requiredColumn_(
        indices,
        'Pen Size');

  const tagsIndex =
    requiredColumn_(indices, 'Tags');

  const bodyIndex =
    requiredColumn_(indices, 'Body HTML');

  const sourceSheetIndex =
    requiredColumn_(indices, 'Source Sheet');

  const sourceRowIndex =
    requiredColumn_(indices, 'Source Row');

  const productGidIndex =
    requiredColumn_(
        indices,
        'Shopify Product GID');

  const variantGidIndex =
    requiredColumn_(
        indices,
        'Shopify Variant GID');

  const inventoryItemGidIndex =
    requiredColumn_(
        indices,
        'Shopify Inventory Item GID');

  const resultIndex =
    requiredColumn_(
        indices,
        'Shopify Result');

  const uploadedAtIndex =
    requiredColumn_(
        indices,
        'Uploaded At');

  const action = normalize_(row[actionIndex]);
  const desiredStatus = normalizeShopifyProductStatus_(
      row[statusIndex]);

  if (!isValidShopifyProductStatus_(desiredStatus)) {
    throw new Error(
        `Review row has an invalid Shopify status: ` +
        `${row[statusIndex] || '(blank)'}.`);
  }

  const isCreateAction = isCreateProductAction_(action);
  const sourceProfile =
    MYK_SHEET_PROFILES[clean_(row[sourceSheetIndex])] || {};
  const colorMode = clean_(sourceProfile.colorMode);
  const sourceOption = clean_(row[optionIndex]);
  const glitterPotionColor = clean_(
      row[glitterPotionColorIndex]);
  const glitterPotionSize = clean_(
      row[glitterPotionSizeIndex]);
  const penBaseColor = clean_(row[penBaseColorIndex]);
  const penSize = clean_(row[penSizeIndex]);
  const variantOptionValues = [];

  if (sourceOption) {
    variantOptionValues.push({
      optionName: 'Option',
      name: sourceOption,
    });
  }

  if (colorMode === 'GLITTER_POTION') {
    if (glitterPotionColor) {
      variantOptionValues.push({
        optionName: 'Glitter Potion Color',
        name: glitterPotionColor,
      });
    }

    if (glitterPotionSize) {
      variantOptionValues.push({
        optionName: 'Glitter Potion Size',
        name: glitterPotionSize,
      });
    }
  }

  if (colorMode === 'PEN') {
    if (penBaseColor) {
      variantOptionValues.push({
        optionName: 'Pen Base Color',
        name: penBaseColor,
      });
    }

    if (penSize) {
      variantOptionValues.push({
        optionName: 'Pen Size',
        name: penSize,
      });
    }
  }

  writeCell_(
      reviewSheet,
      sheetRow,
      approvalIndex,
      'PROCESSING');

  const productInput = {
    handle: clean_(row[handleIndex]),
    title: clean_(row[englishNameIndex]),
    vendor: clean_(row[brandIndex]),
    productType: clean_(row[typeIndex]),
    status: desiredStatus,
    descriptionHtml: clean_(row[bodyIndex]),
    tags: parseList_(row[tagsIndex]),
  };

  const taxonomy =
    normalizeTaxonomyCategoryId_(
        clean_(row[taxonomyIndex])) ||
    resolveTaxonomyCategoryForProductType_(
        clean_(row[typeIndex]),
        '');

  if (taxonomy) {
    productInput.category = taxonomy;
    writeCell_(
        reviewSheet,
        sheetRow,
        taxonomyIndex,
        taxonomy);
  }

  const productCreateInput = Object.assign({}, productInput);

  if (variantOptionValues.length > 0) {
    productCreateInput.productOptions =
      variantOptionValues.map((option) => ({
        name: option.optionName,
        values: [{name: option.name}],
      }));
  }

  let identity = {
    productId: clean_(row[productGidIndex]),
    variantId: clean_(row[variantGidIndex]),
    inventoryItemId:
      clean_(row[inventoryItemGidIndex]),
  };
  let effectiveAction = action;

  // Re-resolve planned creates at execution time. This is important when a
  // previous approved row created the shared product after preflight, or when
  // only a later variant row was approved.
  if (
    isCreateAction &&
    sourceProfile.supportsSharedProductVariants === true &&
    !identity.variantId
  ) {
    const currentResolution =
      resolveShopifyProductIdentity_(
          accessToken,
          clean_(row[skuIndex]),
          clean_(row[handleIndex]),
          true);

    if (currentResolution.action === 'UPDATE_EXISTING') {
      effectiveAction = 'UPDATE_EXISTING';
      identity = Object.assign(
          identity,
          currentResolution.identity || {});
    } else if (currentResolution.action === 'CREATE_VARIANT') {
      effectiveAction = 'CREATE_VARIANT';
      identity.productId =
        currentResolution.identity.productId;
    }
  }

  if (effectiveAction === 'CREATE_VARIANT') {
    if (!identity.productId) {
      const currentResolution =
        resolveShopifyProductIdentity_(
            accessToken,
            clean_(row[skuIndex]),
            clean_(row[handleIndex]),
            true);

      if (currentResolution.identity) {
        identity.productId =
          currentResolution.identity.productId;
      }
    }

    if (!identity.productId) {
      // The planned first row may not have been approved. In that case this
      // row safely becomes the product's initial variant.
      identity = createShopifyProduct_(
          accessToken,
          productCreateInput);
      effectiveAction = createActionForStatus_(desiredStatus);
    } else {
      updateShopifyProduct_(
          accessToken,
          identity.productId,
          productInput);

      ensureShopifyProductOptions_(
          accessToken,
          identity.productId,
          variantOptionValues);

      identity = Object.assign(
          identity,
          createShopifyVariant_(
              accessToken,
              identity.productId,
              clean_(row[skuIndex]),
              fixedPrice_(row[priceIndex]),
              variantOptionValues));
    }
  } else if (
    isCreateAction &&
    identity.productId
  ) {
    // A previous attempt already created the product. Complete its fields and
    // apply the reviewed source status instead of creating a duplicate.
    updateShopifyProduct_(
        accessToken,
        identity.productId,
        productInput);
  } else if (isCreateAction) {

    identity = createShopifyProduct_(
        accessToken,
        productCreateInput);

    writeCell_(
        reviewSheet,
        sheetRow,
        productGidIndex,
        identity.productId);

    writeCell_(
        reviewSheet,
        sheetRow,
        variantGidIndex,
        identity.variantId);

    writeCell_(
        reviewSheet,
        sheetRow,
        inventoryItemGidIndex,
        identity.inventoryItemId);
  } else if (effectiveAction === 'UPDATE_EXISTING') {
    if (
      !identity.productId ||
      !identity.variantId
    ) {
      throw new Error(
          'Missing Shopify identity. Run preflight again.');
    }

    updateShopifyProduct_(
        accessToken,
        identity.productId,
        productInput);
  } else {
    throw new Error(
        `Row action is not uploadable: ${action}`);
  }

  if (
    effectiveAction === 'UPDATE_EXISTING' &&
    variantOptionValues.length > 0
  ) {
    ensureShopifyProductOptions_(
        accessToken,
        identity.productId,
        variantOptionValues);
  }

  // Continue with your existing updateShopifyVariant_,
  // setShopifyProductMetafields_ and inventory code here.

  const variantResult = updateShopifyVariant_(
      accessToken,
      identity.productId,
      identity.variantId,
      clean_(row[skuIndex]),
      fixedPrice_(row[priceIndex]),
      variantOptionValues);

  identity.variantId =
    variantResult.variantId;

  identity.inventoryItemId =
    variantResult.inventoryItemId ||
    identity.inventoryItemId;

  setShopifyProductMetafields_(
      accessToken,
      identity.productId,
      {
        itemId: clean_(row[itemIdIndex]),
        skipItemId: variantOptionValues.length > 0,
        colorMode,
        chineseName:
          clean_(row[chineseNameIndex]),
        baseColors:
          parseList_(row[baseColorsIndex]),
        glitterColors:
          parseList_(row[glitterColorsIndex]),
        sheenColors:
          parseList_(row[sheenColorsIndex]),
        sourceSheet:
          clean_(row[sourceSheetIndex]),
        sourceRow:
          clean_(row[sourceRowIndex]),
      });

  if (variantOptionValues.length > 0) {
    const variantMetafieldData = {
      itemId: clean_(row[itemIdIndex]),
    };

    if (colorMode === 'GLITTER_POTION') {
      Object.assign(variantMetafieldData, {
        glitterPotionColor,
        glitterPotionSize,
      });
    }

    if (colorMode === 'PEN') {
      Object.assign(variantMetafieldData, {
        penBaseColor,
        penSize,
      });
    }

    setShopifyVariantMetafields_(
        accessToken,
        identity.variantId,
        variantMetafieldData);
  }

  const verifiedMetafields =
  verifyProductMetafields_(
      accessToken,
      identity.productId);

  const verifiedKeys = new Set(
      verifiedMetafields.map((metafield) => {
        return metafield.key;
      }));

  const requiredProductMetafieldKeys =
    colorMode === 'INK'
      ? [
        MYK_SHOPIFY.baseColorsMetafieldKey,
        MYK_SHOPIFY.glitterColorsMetafieldKey,
        MYK_SHOPIFY.sheenColorsMetafieldKey,
      ]
      : [];

  if (variantOptionValues.length === 0) {
    requiredProductMetafieldKeys.unshift(
        MYK_SHOPIFY.itemIdMetafieldKey);
  }

  requiredProductMetafieldKeys.forEach((key) => {
    if (!verifiedKeys.has(key)) {
      throw new Error(
          `Metafield verification failed: ${key} not found.`);
    }
  });

  let inventoryResultText =
    'INVENTORY_DISABLED';

  if (MYK_SHOPIFY.inventoryWriteEnabled) {
    const inventoryResult =
      setAndVerifyShopifyInventory_(
          accessToken,
          identity.inventoryItemId,
          locationId,
          Number(row[inventoryIndex]),
          clean_(row[itemIdIndex]));

    inventoryResultText =
      `INVENTORY_VERIFIED=${inventoryResult.quantity}`;
  }

  const productResult = isCreateProductAction_(effectiveAction)
    ? `CREATED_${desiredStatus}`
    : effectiveAction === 'CREATE_VARIANT'
      ? `CREATED_VARIANT_${desiredStatus}`
      : `UPDATED_${desiredStatus}`;

  const finalResult =
    `${productResult}; STATUS=${desiredStatus}; ${inventoryResultText}`;

  writeCell_(
      reviewSheet,
      sheetRow,
      productGidIndex,
      identity.productId);

  writeCell_(
      reviewSheet,
      sheetRow,
      variantGidIndex,
      identity.variantId);

  writeCell_(
      reviewSheet,
      sheetRow,
      inventoryItemGidIndex,
      identity.inventoryItemId);

  writeCell_(
      reviewSheet,
      sheetRow,
      approvalIndex,
      'UPLOADED');

  writeCell_(
      reviewSheet,
      sheetRow,
      statusIndex,
      desiredStatus);

  writeCell_(
      reviewSheet,
      sheetRow,
      resultIndex,
      finalResult);

  writeCell_(
      reviewSheet,
      sheetRow,
      uploadedAtIndex,
      new Date());

  writeSourceShopifyIdentity_(
      spreadsheet,
      clean_(row[sourceSheetIndex]),
      Number(row[sourceRowIndex]),
      identity);

  writeSourceItemId_(
      spreadsheet,
      clean_(row[sourceSheetIndex]),
      Number(row[sourceRowIndex]),
      clean_(row[itemIdIndex]));

  writeSourceUploadResult_(
      spreadsheet,
      clean_(row[sourceSheetIndex]),
      Number(row[sourceRowIndex]),
      finalResult,
      true,
      taxonomy,
      desiredStatus);
}

/** Creates one Shopify product with the reviewed source status. */
function createShopifyProduct_(accessToken, productInput) {
  const mutation = `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          handle
          status
          variants(first: 1) {
            nodes {
              id
              inventoryItem {
                id
                sku
                tracked
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {product: productInput});

  const result =
    payload.data &&
    payload.data.productCreate;

  if (!result) {
    throw new Error(
        'Shopify returned no productCreate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'productCreate failed');

  const product = result.product;

  const variants =
    product &&
    product.variants &&
    Array.isArray(product.variants.nodes)
      ? product.variants.nodes
      : [];

  const variant = variants[0];

  if (!product || !variant) {
    throw new Error(
        'Shopify did not return the created product identity.');
  }

  const expectedStatus = normalizeShopifyProductStatus_(
      productInput.status);

  if (normalize_(product.status) !== expectedStatus) {
    throw new Error(
        `Shopify created the product with status ${product.status}; ` +
        `expected ${expectedStatus}.`);
  }

  return {
    productId: product.id,
    variantId: variant.id,

    inventoryItemId:
      variant.inventoryItem &&
      variant.inventoryItem.id
        ? variant.inventoryItem.id
        : '',
  };
}

/**
 * Updates product-level fields.
 *
 * Existing products are moved to the status selected in the source sheet.
 */
function updateShopifyProduct_(
    accessToken,
    productId,
    productInput) {
  const mutation = `
    mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          handle
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = Object.assign(
      {},
      productInput,
      {id: productId});

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {product: input});

  const result =
    payload.data &&
    payload.data.productUpdate;

  if (!result) {
    throw new Error(
        'Shopify returned no productUpdate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'productUpdate failed');

  const expectedStatus = normalizeShopifyProductStatus_(
      productInput.status);

  if (
    !result.product ||
    normalize_(result.product.status) !== expectedStatus
  ) {
    throw new Error(
        `Shopify did not confirm status ${expectedStatus}.`);
  }
}

/**
 * Ensures an existing shared product has the option names required by a new
 * glitter-potion variant. Existing variants are left in place.
 */
function ensureShopifyProductOptions_(
    accessToken,
    productId,
    optionValues) {
  if (!Array.isArray(optionValues) || optionValues.length === 0) {
    return [];
  }

  let productOptions = getShopifyProductOptions_(
      accessToken,
      productId);

  const existingNames = new Set(
      productOptions.map((option) => {
        return normalize_(option.name);
      }));
  const missing = optionValues.filter((option) => {
    return !existingNames.has(normalize_(option.optionName));
  });

  if (missing.length === 0) {
    return productOptions;
  }

  const mutation = `
    mutation CreateProductOptions(
      $productId: ID!,
      $options: [OptionCreateInput!]!
    ) {
      productOptionsCreate(
        productId: $productId,
        options: $options,
        variantStrategy: LEAVE_AS_IS
      ) {
        product {
          id
          options {
            name
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
  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        productId,
        options: missing.map((option) => ({
          name: option.optionName,
          values: [{name: option.name}],
        })),
      });
  const result = payload.data && payload.data.productOptionsCreate;

  if (!result) {
    throw new Error(
        'Shopify returned no productOptionsCreate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'productOptionsCreate failed');

  // Fetch again so callers receive the permanent ProductOption and
  // ProductOptionValue GIDs created by Shopify.
  productOptions = getShopifyProductOptions_(
      accessToken,
      productId);

  return productOptions;
}

/**
 * Returns the permanent Shopify IDs for every option and option value on a
 * product. These IDs let later variants reuse an existing value instead of
 * attempting to create a second value with the same name.
 */
function getShopifyProductOptions_(accessToken, productId) {
  const query = `
    query ProductOptions($id: ID!) {
      product(id: $id) {
        id
        options {
          id
          name
          optionValues {
            id
            name
          }
        }
      }
    }
  `;
  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {id: productId});
  const product = payload.data && payload.data.product;

  if (!product) {
    throw new Error(
        'Cannot read variant options: Shopify product was not found.');
  }

  return Array.isArray(product.options)
    ? product.options
    : [];
}

/**
 * Converts editor/review values such as
 *   {optionName: 'Glitter Potion Color', name: 'Red Glitter'}
 * into Shopify identities.
 *
 * An existing same-name value is sent back by its original GID. A genuinely
 * new value is linked to the existing option by optionId and its new name.
 */
function resolveShopifyVariantOptionValues_(
    accessToken,
    productId,
    requestedOptionValues) {
  if (
    !Array.isArray(requestedOptionValues) ||
    requestedOptionValues.length === 0
  ) {
    return [];
  }

  const cleanRequests = requestedOptionValues
      .map((option) => ({
        optionName: clean_(option.optionName),
        name: clean_(option.name),
      }))
      .filter((option) => option.optionName && option.name);

  if (cleanRequests.length !== requestedOptionValues.length) {
    throw new Error(
        'Every variant option must contain both an option name and a value.');
  }

  const productOptions = ensureShopifyProductOptions_(
      accessToken,
      productId,
      cleanRequests);

  return cleanRequests.map((requested) => {
    const productOption = productOptions.find((option) => {
      return normalize_(option.name) === normalize_(requested.optionName);
    });

    if (!productOption || !productOption.id) {
      throw new Error(
          `Shopify option was not found after setup: ${requested.optionName}.`);
    }

    const originalValue = (productOption.optionValues || [])
        .find((optionValue) => {
          return normalize_(optionValue.name) === normalize_(requested.name);
        });

    if (originalValue && originalValue.id) {
      return {
        id: originalValue.id,
        optionId: productOption.id,
      };
    }

    return {
      optionId: productOption.id,
      name: requested.name,
    };
  });
}

/** Creates one new variant on an existing Shopify product. */
function createShopifyVariant_(
    accessToken,
    productId,
    sku,
    price,
    optionValues) {
  const mutation = `
    mutation CreateVariant(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkCreate(
        productId: $productId,
        variants: $variants
      ) {
        productVariants {
          id
          price
          inventoryItem {
            id
            sku
            tracked
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
  const input = {
    price: fixedPrice_(price),
    inventoryItem: {
      sku: normalizeSku_(sku),
      tracked: true,
    },
  };

  if (Array.isArray(optionValues) && optionValues.length > 0) {
    input.optionValues = resolveShopifyVariantOptionValues_(
        accessToken,
        productId,
        optionValues);
  }

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        productId,
        variants: [input],
      });
  const result = payload.data && payload.data.productVariantsBulkCreate;

  if (!result) {
    throw new Error(
        'Shopify returned no productVariantsBulkCreate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'productVariantsBulkCreate failed');

  const variant = result.productVariants && result.productVariants[0];

  if (!variant || !variant.inventoryItem || !variant.inventoryItem.id) {
    throw new Error(
        'Shopify did not return the created variant identity.');
  }

  return {
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
  };
}

/**
 * Updates SKU, price and inventory tracking for one variant.
 *
 * In Shopify Admin GraphQL 2026-07:
 *   - price is on ProductVariantsBulkInput;
 *   - sku and tracked are inside inventoryItem.
 */
function updateShopifyVariant_(
    accessToken,
    productId,
    variantId,
    sku,
    price,
    optionValues) {
  const normalizedSku = normalizeSku_(sku);
  const normalizedPrice = fixedPrice_(price);

  if (!productId) {
    throw new Error(
        'Cannot update variant: missing Product GID.');
  }

  if (!variantId) {
    throw new Error(
        'Cannot update variant: missing Variant GID.');
  }

  if (!normalizedSku) {
    throw new Error(
        'Cannot update variant: SKU is empty.');
  }

  const mutation = `
    mutation UpdateVariant(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(
        productId: $productId,
        variants: $variants,
        allowPartialUpdates: false
      ) {
        productVariants {
          id
          sku
          price
          inventoryItem {
            id
            sku
            tracked
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

  const variantInput = {
    id: variantId,
    price: normalizedPrice,
    inventoryItem: {
      sku: normalizedSku,
      tracked: true,
    },
  };

  if (Array.isArray(optionValues) && optionValues.length > 0) {
    variantInput.optionValues = resolveShopifyVariantOptionValues_(
        accessToken,
        productId,
        optionValues);
  }

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        productId,
        variants: [variantInput],
      });

  const result =
    payload.data &&
    payload.data.productVariantsBulkUpdate;

  if (!result) {
    throw new Error(
        'Shopify returned no productVariantsBulkUpdate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'productVariantsBulkUpdate failed');

  const variants =
    Array.isArray(result.productVariants)
      ? result.productVariants
      : [];

  if (variants.length !== 1) {
    throw new Error(
        `Shopify returned ${variants.length} updated variants; expected 1.`);
  }

  const variant = variants[0];

  if (
    !variant.inventoryItem ||
    !variant.inventoryItem.id
  ) {
    throw new Error(
        'Shopify returned no Inventory Item GID.');
  }

  const returnedSku =
    clean_(variant.inventoryItem.sku || variant.sku);

  if (normalizeSku_(returnedSku) !== normalizedSku) {
    throw new Error(
        `SKU verification failed. Expected ${normalizedSku}; ` +
        `Shopify returned ${returnedSku || '(blank)'}.`);
  }

  return {
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
    sku: returnedSku,
    price: clean_(variant.price),
  };
}

/**
 * Sets product metafields.
 */
function setShopifyProductMetafields_(
    accessToken,
    productId,
    data) {
  const mutation = `
    mutation SetProductMetafields(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const metafields = [];

  if (clean_(data.colorMode) === 'INK') {
    metafields.push(
        {
          ownerId: productId,
          namespace: MYK_SHOPIFY.metafieldNamespace,
          key: MYK_SHOPIFY.baseColorsMetafieldKey,
          type: 'list.single_line_text_field',
          value: JSON.stringify(data.baseColors || []),
        },
        {
          ownerId: productId,
          namespace: MYK_SHOPIFY.metafieldNamespace,
          key: MYK_SHOPIFY.glitterColorsMetafieldKey,
          type: 'list.single_line_text_field',
          value: JSON.stringify(data.glitterColors || []),
        },
        {
          ownerId: productId,
          namespace: MYK_SHOPIFY.metafieldNamespace,
          key: MYK_SHOPIFY.sheenColorsMetafieldKey,
          type: 'list.single_line_text_field',
          value: JSON.stringify(data.sheenColors || []),
        });
  }

  if (data.skipItemId !== true) {
    metafields.unshift({
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.itemIdMetafieldKey,
      type: 'single_line_text_field',
      value: data.itemId,
    });
  }

  [
    {
      property: 'chineseName',
      key: MYK_SHOPIFY.chineseNameMetafieldKey,
    },
    {
      property: 'storageLocation',
      key: MYK_SHOPIFY.storageLocationMetafieldKey,
    },
    {
      property: 'inkSize',
      key: MYK_SHOPIFY.inkSizeMetafieldKey,
    },
  ].forEach((definition) => {
    if (
      Object.prototype.hasOwnProperty.call(
          data,
          definition.property)
    ) {
      metafields.push({
        ownerId: productId,
        namespace: MYK_SHOPIFY.metafieldNamespace,
        key: definition.key,
        type: 'single_line_text_field',
        value: clean_(data[definition.property]),
      });
    }
  });

  if (clean_(data.sourceSheet)) {
    metafields.push({
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sourceSheetMetafieldKey,
      type: 'single_line_text_field',
      value: clean_(data.sourceSheet),
    });
  }

  if (clean_(data.sourceRow)) {
    metafields.push({
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sourceRowMetafieldKey,
      type: 'number_integer',
      value: String(data.sourceRow),
    });
  }

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {metafields});

  const result =
    payload.data &&
    payload.data.metafieldsSet;

  if (!result) {
    throw new Error(
        'Shopify returned no metafieldsSet payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'metafieldsSet failed');
}

/** Stores the managed item identity and sheet-specific variant attributes. */
function setShopifyVariantMetafields_(
    accessToken,
    variantId,
    data) {
  const mutation = `
    mutation SetVariantMetafields(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  const metafields = [{
    ownerId: variantId,
    namespace: MYK_SHOPIFY.metafieldNamespace,
    key: MYK_SHOPIFY.itemIdMetafieldKey,
    type: 'single_line_text_field',
    value: clean_(data.itemId),
  }];

  [
    {
      property: 'glitterPotionColor',
      key: MYK_SHOPIFY.glitterPotionColorMetafieldKey,
    },
    {
      property: 'glitterPotionSize',
      key: MYK_SHOPIFY.glitterPotionSizeMetafieldKey,
    },
    {
      property: 'penBaseColor',
      key: MYK_SHOPIFY.penBaseColorMetafieldKey,
    },
    {
      property: 'penSize',
      key: MYK_SHOPIFY.penSizeMetafieldKey,
    },
  ].forEach((definition) => {
    if (
      Object.prototype.hasOwnProperty.call(
          data,
          definition.property) &&
      clean_(data[definition.property])
    ) {
      metafields.push({
        ownerId: variantId,
        namespace: MYK_SHOPIFY.metafieldNamespace,
        key: definition.key,
        type: 'single_line_text_field',
        value: clean_(data[definition.property]),
      });
    }
  });
  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {metafields});
  const result = payload.data && payload.data.metafieldsSet;

  if (!result) {
    throw new Error(
        'Shopify returned no variant metafieldsSet payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'variant metafieldsSet failed');
}

/**
 * Sets and verifies an absolute Shopify available quantity.
 *
 * If no InventoryLevel exists at the location, inventoryActivate is used
 * with the requested initial quantity.
 *
 * If the level already exists, inventorySetQuantities is used.
 *
 * The quantity is always read back afterward. Success is based on the
 * verified final value, not the presence of inventoryAdjustmentGroup.
 */
function setAndVerifyShopifyInventory_(
    accessToken,
    inventoryItemId,
    locationId,
    quantity,
    itemId) {
  const parsedQuantity = Number(quantity);

  if (
    !Number.isInteger(parsedQuantity) ||
    parsedQuantity < 0
  ) {
    throw new Error(
        `Invalid inventory quantity: ${quantity}`);
  }

  if (!inventoryItemId) {
    throw new Error(
        'Cannot set inventory: Inventory Item GID is missing.');
  }

  if (!locationId) {
    throw new Error(
        'Cannot set inventory: Location GID is missing.');
  }

  const before = getShopifyInventoryState_(
      accessToken,
      inventoryItemId,
      locationId);

  let activated = false;

  if (!before.tracked) {
    throw new Error(
        'Shopify inventory tracking is not enabled after variant update.');
  }

  if (!before.levelExists) {
    activateShopifyInventory_(
        accessToken,
        inventoryItemId,
        locationId,
        parsedQuantity);

    activated = true;
  } else if (before.available !== parsedQuantity) {
    setShopifyInventoryQuantity_(
        accessToken,
        inventoryItemId,
        locationId,
        parsedQuantity,
        itemId);
  }

  const verified = getShopifyInventoryState_(
      accessToken,
      inventoryItemId,
      locationId);

  if (!verified.levelExists) {
    throw new Error(
        'Inventory verification failed: no inventory level exists.');
  }

  if (verified.available !== parsedQuantity) {
    throw new Error(
        `Inventory verification failed: requested ${parsedQuantity}, ` +
        `but Shopify reports ${verified.available}.`);
  }

  return {
    activated,
    quantity: verified.available,
    previousQuantity: before.levelExists
      ? before.available
      : null,
  };
}

/**
 * Activates an inventory item at a location.
 *
 * @idempotent is attached to the inventoryActivate field.
 */
function activateShopifyInventory_(
    accessToken,
    inventoryItemId,
    locationId,
    initialQuantity) {
  const idempotencyKey = Utilities.getUuid();

  const mutation = `
    mutation ActivateInventory(
      $inventoryItemId: ID!,
      $locationId: ID!,
      $available: Int!,
      $idempotencyKey: String!
    ) {
      inventoryActivate(
        inventoryItemId: $inventoryItemId,
        locationId: $locationId,
        available: $available
      ) @idempotent(key: $idempotencyKey) {
        inventoryLevel {
          id
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        inventoryItemId,
        locationId,
        available: initialQuantity,
        idempotencyKey,
      });

  const result =
    payload.data &&
    payload.data.inventoryActivate;

  if (!result) {
    throw new Error(
        'Shopify returned no inventoryActivate payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'inventoryActivate failed');

  if (!result.inventoryLevel) {
    throw new Error(
        'Shopify did not return the activated inventory level.');
  }
}

/**
 * Sets an absolute available quantity on an existing InventoryLevel.
 *
 * changeFromQuantity: null explicitly opts out of concurrency comparison.
 * The result's adjustment group is allowed to be null.
 */
function setShopifyInventoryQuantity_(
    accessToken,
    inventoryItemId,
    locationId,
    quantity,
    itemId) {
  const idempotencyKey = Utilities.getUuid();

  const mutation = `
    mutation SetInventory(
      $input: InventorySetQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventorySetQuantities(input: $input)
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

  const referenceDocumentUri =
    `gid://mouthyukyuk-sheet-sync/InventorySync/` +
    encodeURIComponent(itemId);

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        input: {
          name: MYK_SHOPIFY.inventoryQuantityName,
          reason: MYK_SHOPIFY.inventoryChangeReason,
          referenceDocumentUri,
          quantities: [
            {
              inventoryItemId,
              locationId,
              quantity,
              changeFromQuantity: null,
            },
          ],
        },
        idempotencyKey,
      });

  const result =
    payload.data &&
    payload.data.inventorySetQuantities;

  if (!result) {
    throw new Error(
        'Shopify returned no inventorySetQuantities payload.');
  }

  throwOnUserErrors_(
      result.userErrors,
      'inventorySetQuantities failed');

  // inventoryAdjustmentGroup may legitimately be null. The caller verifies
  // the final available quantity with a separate read-only query.
  return {
    inventoryAdjustmentGroup:
      result.inventoryAdjustmentGroup || null,
    idempotencyKey,
  };
}

/**
 * Reads tracking status and the available quantity at one location.
 */
function getShopifyInventoryState_(
    accessToken,
    inventoryItemId,
    locationId) {
  const query = `
    query ReadInventoryState(
      $inventoryItemId: ID!,
      $locationId: ID!
    ) {
      inventoryItem(id: $inventoryItemId) {
        id
        sku
        tracked
        inventoryLevel(locationId: $locationId) {
          id
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {
        inventoryItemId,
        locationId,
      });

  const inventoryItem =
    payload.data &&
    payload.data.inventoryItem;

  if (!inventoryItem) {
    throw new Error(
        'Shopify could not find the inventory item.');
  }

  const level = inventoryItem.inventoryLevel;

  if (!level) {
    return {
      tracked: Boolean(inventoryItem.tracked),
      levelExists: false,
      available: null,
    };
  }

  const quantities =
    Array.isArray(level.quantities)
      ? level.quantities
      : [];

  const available = quantities.find((entry) => {
    return entry.name === 'available';
  });

  if (!available) {
    throw new Error(
        'Shopify returned no available inventory quantity.');
  }

  return {
    tracked: Boolean(inventoryItem.tracked),
    levelExists: true,
    available: Number(available.quantity),
  };
}

/**
 * Lists Shopify locations and their complete GraphQL GIDs.
 */
function listShopifyLocations() {
  const accessToken = getCachedShopifyAccessToken_();

  const query = `
    query ListLocations {
      locations(first: 50, includeInactive: true) {
        nodes {
          id
          name
          isActive
          fulfillsOnlineOrders
          address {
            address1
            city
            province
            country
          }
        }
      }
    }
  `;

  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {});

  const locations =
    payload.data &&
    payload.data.locations &&
    Array.isArray(payload.data.locations.nodes)
      ? payload.data.locations.nodes
      : [];

  if (locations.length === 0) {
    SpreadsheetApp.getUi().alert(
        'Shopify returned no locations.');

    return;
  }

  const text = locations.map((location) => {
    const addressParts = [
      location.address && location.address.address1,
      location.address && location.address.city,
      location.address && location.address.province,
      location.address && location.address.country,
    ].filter(Boolean);

    return [
      location.name,
      location.id,
      location.isActive ? 'ACTIVE' : 'INACTIVE',
      location.fulfillsOnlineOrders
        ? 'FULFILLS ONLINE ORDERS'
        : 'DOES NOT FULFIL ONLINE ORDERS',
      addressParts.join(', '),
    ]
        .filter(Boolean)
        .join('\n');
  }).join('\n\n');

  SpreadsheetApp.getUi().alert(text);
}

/**
 * Sends a Shopify Admin GraphQL request.
 */
function callShopifyGraphql_(
    accessToken,
    query,
    variables) {
  const url =
    `https://${MYK_SHOPIFY.shopName}.myshopify.com/admin/api/` +
    `${MYK_SHOPIFY.apiVersion}/graphql.json`;

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Shopify-Access-Token': accessToken,
    },
    payload: JSON.stringify({
      query,
      variables: variables || {},
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();

  let payload;

  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
        `Shopify returned invalid JSON (${status}): ` +
        responseText.substring(0, 500));
  }

  if (status < 200 || status >= 300) {
    throw new Error(
        `Shopify HTTP ${status}: ${JSON.stringify(payload)}`);
  }

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
        `Shopify GraphQL error: ` +
        `${JSON.stringify(payload.errors)}`);
  }

  if (!payload.data) {
    throw new Error(
        'Shopify returned no GraphQL data.');
  }

  return payload;
}

/**
 * Fetches and caches a Shopify client-credentials access token.
 */
function getCachedShopifyAccessToken_() {
  const properties =
    PropertiesService.getScriptProperties();

  const now = Date.now();

  const cachedToken =
    properties.getProperty('SHOPIFY_ACCESS_TOKEN');

  const expiry = Number(
      properties.getProperty(
          'SHOPIFY_ACCESS_TOKEN_EXPIRES_AT') || 0);

  if (
    cachedToken &&
    expiry > now + (5 * 60 * 1000)
  ) {
    return cachedToken;
  }

  const clientId = requireScriptProperty_(
      'SHOPIFY_CLIENT_ID');

  const clientSecret = requireScriptProperty_(
      'SHOPIFY_CLIENT_SECRET');

  const response = UrlFetchApp.fetch(
      `https://${MYK_SHOPIFY.shopName}.myshopify.com/admin/oauth/access_token`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
        }),
        muteHttpExceptions: true,
      });

  const status = response.getResponseCode();
  const responseText = response.getContentText();

  let payload;

  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
        `Shopify token response was invalid JSON (${status}).`);
  }

  if (
    status < 200 ||
    status >= 300 ||
    !payload.access_token
  ) {
    throw new Error(
        `Shopify token request failed (${status}): ` +
        responseText.substring(0, 500));
  }

  const expiresIn = Number(payload.expires_in);

  const lifetime =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn * 1000
      : 55 * 60 * 1000;

  properties.setProperties({
    SHOPIFY_ACCESS_TOKEN: payload.access_token,
    SHOPIFY_ACCESS_TOKEN_EXPIRES_AT:
      String(now + lifetime),
  });

  return payload.access_token;
}

/**
 * Approval popup HTML.
 */
function buildApprovalDialogHtml_() {
  return `
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 10px;
      color: #202124;
    }

    .toolbar {
      display: flex;
      gap: 5px;
      align-items: center;
      margin-bottom: 7px;
    }

    button {
      padding: 5px 8px;
      cursor: pointer;
    }

    .primary {
      font-weight: bold;
    }

    .status {
      margin-left: auto;
      font-size: 13px;
    }

    .table-wrap {
      height: 490px;
      overflow: auto;
      border: 1px solid #dadce0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }

    th,
    td {
      border-bottom: 1px solid #e8eaed;
      padding: 4px 5px;
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      background: #f8f9fa;
      z-index: 1;
    }

    tr.blocked {
      opacity: 0.55;
    }

    .result {
      max-width: 220px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="selectAllValid()">Select all valid</button>
    <button onclick="clearAll()">Clear</button>
    <button class="primary" onclick="approve()">Approve selected</button>
    <span class="status" id="status">Loading…</span>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Select</th>
          <th>Action</th>
          <th>Status</th>
          <th>Item ID</th>
          <th>English name</th>
          <th>SKU</th>
          <th>Option</th>
          <th>Potion color</th>
          <th>Potion size</th>
          <th>Pen color</th>
          <th>Pen size</th>
          <th>Price</th>
          <th>Inventory</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>

  <script>
    function load() {
      google.script.run
        .withSuccessHandler(render)
        .withFailureHandler(showError)
        .getApprovalCandidates();
    }

    function render(rows) {
      const body = document.getElementById('rows');
      body.innerHTML = '';

      rows.forEach((row) => {
        const tr = document.createElement('tr');

        if (!row.selectable) {
          tr.className = 'blocked';
        }

        tr.innerHTML = [
          '<td><input type="checkbox" class="row-check" ',
          'data-row="' + row.sheetRow + '" ',
          row.selectable ? '' : 'disabled ',
          row.approved ? 'checked ' : '',
          '></td>',
          '<td>' + escapeHtml(row.action) + '</td>',
          '<td>' + escapeHtml(row.status) + '</td>',
          '<td>' + escapeHtml(row.itemId) + '</td>',
          '<td>' + escapeHtml(row.title) + '</td>',
          '<td>' + escapeHtml(row.sku) + '</td>',
          '<td>' + escapeHtml(row.option) + '</td>',
          '<td>' + escapeHtml(row.glitterPotionColor) + '</td>',
          '<td>' + escapeHtml(row.glitterPotionSize) + '</td>',
          '<td>' + escapeHtml(row.penBaseColor) + '</td>',
          '<td>' + escapeHtml(row.penSize) + '</td>',
          '<td>' + escapeHtml(row.price) + '</td>',
          '<td>' + escapeHtml(row.inventory) + '</td>',
          '<td class="result">' + escapeHtml(row.result) + '</td>',
        ].join('');

        body.appendChild(tr);
      });

      document.getElementById('status').textContent =
        rows.length + ' review rows';
    }

    function selectAllValid() {
      document
        .querySelectorAll('.row-check:not(:disabled)')
        .forEach((box) => {
          box.checked = true;
        });
    }

    function clearAll() {
      document
        .querySelectorAll('.row-check')
        .forEach((box) => {
          box.checked = false;
        });
    }

    function approve() {
      const selected = Array.from(
        document.querySelectorAll('.row-check:checked')
      ).map((box) => Number(box.dataset.row));

      document.getElementById('status').textContent =
        'Saving approval…';

      google.script.run
        .withSuccessHandler((result) => {
          document.getElementById('status').textContent =
            result.message;
        })
        .withFailureHandler(showError)
        .approveSelectedReviewRows(selected);
    }

    function showError(error) {
      document.getElementById('status').textContent =
        error && error.message
          ? error.message
          : String(error);
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    load();
  </script>
</body>
</html>
  `;
}

/**
 * Creates or replaces the review sheet.
 */
function writeReviewSheet_(spreadsheet, rows) {
  let sheet = spreadsheet.getSheetByName(
      MYK_SHOPIFY.reviewSheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
        MYK_SHOPIFY.reviewSheetName);
  }

  writeReviewRowsToSheet_(sheet, rows);
}

/** Writes and formats review rows on a supplied destination sheet. */
function writeReviewRowsToSheet_(sheet, rows) {

  // Remove the existing filter before clearing/rebuilding the sheet.
  const existingFilter = sheet.getFilter();

  if (existingFilter) {
    existingFilter.remove();
  }

  sheet.clear();

  const headers = MYK_SHOPIFY.resultHeaders;

  // A new Google sheet normally has only 26 columns, while the review has
  // more. Expand both dimensions before requesting the destination ranges.
  ensureSheetSize_(
      sheet,
      Math.max(1, rows.length + 1),
      headers.length);

  sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setVerticalAlignment('middle')
      .setWrap(false);

  if (rows.length > 0) {
    sheet
        .getRange(
            2,
            1,
            rows.length,
            headers.length)
        .setValues(rows)
        .setVerticalAlignment('middle')
        .setWrap(false);

    sheet
        .getRange(2, 1, rows.length, 1)
        .insertCheckboxes();

    sheet.setRowHeights(
        2,
        rows.length,
        24);
  }

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(4);
  sheet.setRowHeight(1, 28);

  const widths = {
    'Review Select': 72,
    'Approval': 90,
    'Validation': 170,
    'Upload Action': 120,
    'Source Sheet': 105,
    'Source Row': 70,
    'Item Type': 70,
    'Item ID': 145,
    'Handle': 150,
    'English Name': 180,
    'Collection': 160,
    'Chinese Name': 140,
    'Brand': 100,
    'Product Type': 110,
    'Status': 80,
    'Shopify Taxonomy ID': 160,
    'SKU': 125,
    'Price': 65,
    'Inventory': 70,
    'Ink Base Colors': 120,
    'Ink Glitter Colors': 120,
    'Ink Sheen Colors': 120,
    'Option': 120,
    'Glitter Potion Color': 130,
    'Glitter Potion Size': 110,
    'Pen Base Color': 120,
    'Pen Size': 90,
    'Tags': 150,
    'Body HTML': 180,
    'Image URL': 160,
    'Shopify Product GID': 175,
    'Shopify Variant GID': 175,
    'Shopify Inventory Item GID': 175,
    'Shopify Result': 220,
    'Uploaded At': 125,
  };

  headers.forEach((header, index) => {
    sheet.setColumnWidth(
        index + 1,
        widths[header] || 100);
  });

  sheet
      .getDataRange()
      .setWrapStrategy(
          SpreadsheetApp.WrapStrategy.CLIP);

  if (rows.length > 0) {
    sheet
        .getRange(
            1,
            1,
            rows.length + 1,
            headers.length)
        .createFilter();
  }
}

/**
 * Shows configured source-sheet names.
 */
function showSupportedSheets() {
  SpreadsheetApp.getUi().alert(
      'Supported source sheets:\n\n' +
      Object.keys(MYK_SHEET_PROFILES).join('\n'));
}

/**
 * Returns normalized zero-based column indices.
 */
function getColumnIndices(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn < 1) {
    throw new Error(
        `Sheet “${sheet.getName()}” has no headings.`);
  }

  const headers = sheet
      .getRange(1, 1, 1, lastColumn)
      .getDisplayValues()[0];

  const indices = {};

  headers.forEach((header, index) => {
    const key = formatHeaderKey_(header);

    if (!key) {
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(
          indices,
          key)
    ) {
      throw new Error(
          `Duplicate normalized heading “${key}” ` +
          `in “${sheet.getName()}”.`);
    }

    indices[key] = index;
  });

  return indices;
}

function formatHeaderKey_(header) {
  return clean_(header)
      .toLowerCase()
      .replace(/\s+/g, '_');
}

function requiredColumn_(indices, heading) {
  const key = formatHeaderKey_(heading);
  const index = indices[key];

  if (index === undefined) {
    throw new Error(
        `Required review heading is missing: ${heading}`);
  }

  return index;
}

function getAliasedValue_(
    row,
    sourceIndices,
    aliases) {
  if (!Array.isArray(aliases)) {
    return '';
  }

  for (let index = 0; index < aliases.length; index += 1) {
    const key = formatHeaderKey_(aliases[index]);
    const position = sourceIndices[key];

    if (position !== undefined) {
      const value = clean_(row[position]);

      // Some source sheets contain both an older and a newer alias (for
      // example, Image URL and Image URLs). Prefer the first non-empty value
      // instead of letting an empty legacy column hide populated data.
      if (value) {
        return value;
      }
    }
  }

  return '';
}

/**
 * Returns or creates the source-sheet column used for Shopify taxonomy GIDs.
 */
function ensureSourceTaxonomyColumn_(sheet, profile) {
  const aliases =
    profile &&
    profile.aliases &&
    Array.isArray(profile.aliases.taxonomyCategoryId)
      ? profile.aliases.taxonomyCategoryId
      : [];
  let indices = getColumnIndices(sheet);

  for (let index = 0; index < aliases.length; index += 1) {
    const position = indices[formatHeaderKey_(aliases[index])];

    if (position !== undefined) {
      return position;
    }
  }

  const column = sheet.getLastColumn() + 1;
  sheet
      .getRange(1, column)
      .setValue('Shopify Taxonomy ID')
      .setFontWeight('bold');

  indices = getColumnIndices(sheet);
  return requiredColumn_(indices, 'Shopify Taxonomy ID');
}

/**
 * Ensures the source product sheet can permanently store Shopify identities.
 * All returned positions are zero-based.
 */
function ensureSourceShopifyIdentityColumns_(sheet) {
  const headings = [
    'Shopify Product GID',
    'Shopify Variant GID',
    'Shopify Inventory Item GID',
  ];
  let indices = getColumnIndices(sheet);

  headings.forEach((heading) => {
    const key = formatHeaderKey_(heading);

    if (indices[key] !== undefined) {
      return;
    }

    const column = sheet.getLastColumn() + 1;
    sheet
        .getRange(1, column)
        .setValue(heading)
        .setFontWeight('bold');

    indices = getColumnIndices(sheet);
  });

  return {
    productGid: requiredColumn_(
        indices,
        'Shopify Product GID'),
    variantGid: requiredColumn_(
        indices,
        'Shopify Variant GID'),
    inventoryItemGid: requiredColumn_(
        indices,
        'Shopify Inventory Item GID'),
  };
}

/**
 * Writes only a verified Shopify identity to its exact source row.
 */
function writeSourceShopifyIdentity_(
    spreadsheet,
    sourceSheetName,
    sourceRow,
    identity) {
  if (!identity || !identity.productId || !identity.variantId) {
    return;
  }

  if (!sourceSheetName) {
    throw new Error(
        'Cannot write Shopify identity: source sheet name is missing.');
  }

  const rowNumber = Number(sourceRow);

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error(
        `Cannot write Shopify identity: invalid source row ${sourceRow}.`);
  }

  const sheet = requireSheet_(
      spreadsheet,
      sourceSheetName);
  const columns = ensureSourceShopifyIdentityColumns_(sheet);

  sheet
      .getRange(rowNumber, columns.productGid + 1)
      .setValue(clean_(identity.productId));
  sheet
      .getRange(rowNumber, columns.variantGid + 1)
      .setValue(clean_(identity.variantId));

  if (clean_(identity.inventoryItemId)) {
    sheet
        .getRange(rowNumber, columns.inventoryItemGid + 1)
        .setValue(clean_(identity.inventoryItemId));
  }
}

/**
 * Returns the source column that stores the internal Item ID. Existing source
 * sheets normally call this column "ID"; newer sheets may call it "Item ID".
 * A new Item ID column is added only when neither heading exists.
 */
function ensureSourceItemIdColumn_(sheet) {
  let indices = getColumnIndices(sheet);
  const aliases = ['ID', 'Item ID'];

  for (let index = 0; index < aliases.length; index += 1) {
    const position = indices[formatHeaderKey_(aliases[index])];

    if (position !== undefined) {
      return position;
    }
  }

  const column = sheet.getLastColumn() + 1;
  sheet
      .getRange(1, column)
      .setValue('Item ID')
      .setFontWeight('bold');

  indices = getColumnIndices(sheet);
  return requiredColumn_(indices, 'Item ID');
}

/** Writes the reviewed Item ID back to the exact original source row. */
function writeSourceItemId_(
    spreadsheet,
    sourceSheetName,
    sourceRow,
    itemId) {
  const normalizedItemId = clean_(itemId);

  if (!normalizedItemId) {
    throw new Error(
        'Cannot write source Item ID: the reviewed Item ID is empty.');
  }

  if (!sourceSheetName) {
    throw new Error(
        'Cannot write source Item ID: source sheet name is missing.');
  }

  const rowNumber = Number(sourceRow);

  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error(
        `Cannot write source Item ID: invalid source row ${sourceRow}.`);
  }

  const sheet = requireSheet_(
      spreadsheet,
      sourceSheetName);
  const itemIdColumn = ensureSourceItemIdColumn_(sheet);

  sheet
      .getRange(rowNumber, itemIdColumn + 1)
      .setValue(normalizedItemId);
}

function requireSheetProfile_(sheetName) {
  const profile = MYK_SHEET_PROFILES[sheetName];

  if (!profile) {
    throw new Error(
        `Unsupported source sheet: ${sheetName}. ` +
        'Add it to MYK_SHEET_PROFILES first.');
  }

  return profile;
}

function requireSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(`Missing sheet: ${sheetName}`);
  }

  return sheet;
}

function requireScriptProperty_(name) {
  const value = PropertiesService
      .getScriptProperties()
      .getProperty(name);

  if (!value) {
    throw new Error(
        `Missing Apps Script property: ${name}`);
  }

  return value;
}

function throwOnUserErrors_(errors, prefix) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return;
  }

  const message = errors
      .map((error) => {
        const field = Array.isArray(error.field)
          ? error.field.join('.')
          : clean_(error.field);

        const code = clean_(error.code);

        const parts = [
          field,
          code,
          error.message,
        ].filter(Boolean);

        return parts.join(': ');
      })
      .join(' | ');

  throw new Error(`${prefix}: ${message}`);
}

function writeSingleColumn_(sheet, zeroBasedColumn, values) {
  if (!values.length) {
    return;
  }

  sheet
      .getRange(
          2,
          zeroBasedColumn + 1,
          values.length,
          1)
      .setValues(values.map((value) => [value]));
}

function writeCell_(
    sheet,
    oneBasedRow,
    zeroBasedColumn,
    value) {
  sheet
      .getRange(
          oneBasedRow,
          zeroBasedColumn + 1)
      .setValue(value);
}

function slugifyHandle_(value) {
  return clean_(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
}

function normalizeCodePart_(value) {
  return clean_(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .trim();
}

function normalizeSku_(value) {
  return clean_(value)
      .toUpperCase()
      .replace(/\s+/g, '-')
      .replace(/_+/g, '-')
      .replace(/[^A-Z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
}

function isStructuredSku_(sku) {
  const parts = normalizeSku_(sku)
      .split('-')
      .filter(Boolean);

  return parts.length >= 3;
}

function parseList_(value) {
  return clean_(value)
      .split(/[,;\n|]+/)
      .map((item) => clean_(item))
      .filter(Boolean)
      .filter((item, index, list) => {
        return list.findIndex((candidate) => {
          return normalize_(candidate) === normalize_(item);
        }) === index;
      });
}

function parseMoney_(value) {
  const parsed = Number(
      clean_(value).replace(/[,HK$\s]/gi, ''));

  return Number.isFinite(parsed)
    ? parsed
    : NaN;
}

function fixedPrice_(value) {
  const parsed = parseMoney_(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid price: ${value}`);
  }

  return parsed.toFixed(2);
}

function parseWholeNumber_(value) {
  if (clean_(value) === '') {
    return null;
  }

  const parsed = Number(
      clean_(value).replace(/,/g, ''));

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return parsed;
}

function normalizeBodyHtml_(value) {
  const text = clean_(value);

  if (!text) {
    return '';
  }

  if (/<[a-z][\s\S]*>/i.test(text)) {
    return text;
  }

  return text
      .split(/\n{2,}/)
      .map((paragraph) => {
        return `<p>${escapeHtmlServer_(paragraph)
            .replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
}

function escapeHtmlServer_(value) {
  return clean_(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

function escapeShopifySearchValue_(value) {
  return clean_(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
}

function normalize_(value) {
  return clean_(value).toUpperCase();
}

function clean_(value) {
  return String(
      value == null ? '' : value
  ).trim();
}

function ensureSourceResultColumns_(sheet) {
  let indices = getColumnIndices(sheet);

  if (indices.shopify_taxonomy_id === undefined) {
    const column = sheet.getLastColumn() + 1;

    sheet
        .getRange(1, column)
        .setValue('Shopify Taxonomy ID')
        .setFontWeight('bold');

    indices = getColumnIndices(sheet);
  }

  if (indices.status === undefined) {
    const column = sheet.getLastColumn() + 1;

    sheet
        .getRange(1, column)
        .setValue('Status')
        .setFontWeight('bold');

    indices = getColumnIndices(sheet);
  }

  if (indices.upload_result === undefined) {
    const column = sheet.getLastColumn() + 1;

    sheet
        .getRange(1, column)
        .setValue('Upload Result')
        .setFontWeight('bold');

    indices = getColumnIndices(sheet);
  }

  if (indices.last_updated === undefined) {
    const column = sheet.getLastColumn() + 1;

    sheet
        .getRange(1, column)
        .setValue('Last Updated')
        .setFontWeight('bold');

    indices = getColumnIndices(sheet);
  }

  return indices;
}

function writeSourceUploadResult_(
    spreadsheet,
    sourceSheetName,
    sourceRow,
    result,
    wasSuccessful,
    taxonomyCategoryId,
    productStatus) {
  if (!sourceSheetName) {
    throw new Error(
        'Cannot write upload result: source sheet name is missing.');
  }

  if (!Number.isInteger(Number(sourceRow)) || Number(sourceRow) < 2) {
    throw new Error(
        `Cannot write upload result: invalid source row ${sourceRow}.`);
  }

  const sheet = requireSheet_(
      spreadsheet,
      sourceSheetName);

  const indices = ensureSourceResultColumns_(sheet);

  sheet
      .getRange(
          Number(sourceRow),
          indices.upload_result + 1)
      .setValue(result);

  if (wasSuccessful) {
    const reviewedStatus = normalizeShopifyProductStatus_(productStatus);

    if (!isValidShopifyProductStatus_(reviewedStatus)) {
      throw new Error(
          `Cannot write source result: invalid status ${productStatus}.`);
    }

    sheet
        .getRange(
            Number(sourceRow),
            indices.status + 1)
        .setValue(reviewedStatus);

    const taxonomy = normalizeTaxonomyCategoryId_(taxonomyCategoryId);

    if (taxonomy) {
      sheet
          .getRange(
              Number(sourceRow),
              indices.shopify_taxonomy_id + 1)
          .setValue(taxonomy);
    }

    sheet
        .getRange(
            Number(sourceRow),
            indices.last_updated + 1)
        .setValue(new Date())
        .setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

function scheduleUploadResume_() {
  deleteUploadResumeTriggers_();

  ScriptApp
      .newTrigger(
          MYK_UPLOAD_JOB.triggerFunctionName)
      .timeBased()
      .after(MYK_UPLOAD_JOB.resumeDelayMs)
      .create();
}

function deleteUploadResumeTriggers_() {
  ScriptApp
      .getProjectTriggers()
      .filter((trigger) => {
        return (
          trigger.getHandlerFunction() ===
          MYK_UPLOAD_JOB.triggerFunctionName
        );
      })
      .forEach((trigger) => {
        ScriptApp.deleteTrigger(trigger);
      });
}

function clearUploadJob_() {
  const properties =
    PropertiesService.getScriptProperties();

  properties.deleteProperty(
      MYK_UPLOAD_JOB.spreadsheetIdProperty);

  properties.deleteProperty(
      MYK_UPLOAD_JOB.nextRowProperty);

  properties.setProperties({
    [MYK_UPLOAD_JOB.runningProperty]:
      'false',

    [MYK_UPLOAD_JOB.finishedProperty]:
      'true',

    [MYK_UPLOAD_JOB.currentItemProperty]:
      '',
  });

  deleteUploadResumeTriggers_();
}

function cancelApprovedRowsUpload() {
  clearUploadJob_();

  SpreadsheetApp.getUi().alert(
      'Pending Shopify upload job cancelled.');
}

function incrementUploadJobCounter_(
    propertyName) {
  const properties =
    PropertiesService.getScriptProperties();

  const currentValue = Number(
      properties.getProperty(propertyName) || 0);

  properties.setProperty(
      propertyName,
      String(currentValue + 1));
}
