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
 *   Creates an ACTIVE Shopify product after explicit review approval.
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
  syncProductStatus: 'ACTIVE',

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

      imageUrl: [
        'Image URL',
        'Image Src',
        'Image',
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
      definition.key);

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
    key) {
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
          ownerType: 'PRODUCT',
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
    ownerType: 'PRODUCT',

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
 * Builds the review sheet from the currently active source sheet.
 *
 * The build performs read-only taxonomy lookups against Shopify so the review
 * and source sheet contain the current category GID before approval.
 */
function buildReviewFromActiveSheet() {
  const spreadsheet = SpreadsheetApp.getActive();
  const sourceSheet = spreadsheet.getActiveSheet();
  const sourceSheetName = sourceSheet.getName();

  if (sourceSheetName === MYK_SHOPIFY.reviewSheetName) {
    throw new Error(
        'Select a source product sheet before building the review.');
  }

  const profile = requireSheetProfile_(sourceSheetName);
  const taxonomyColumnIndex = ensureSourceTaxonomyColumn_(
      sourceSheet,
      profile);
  // Keep permanent Shopify identities on the source sheet. Existing values
  // are copied into the review; missing values are filled by preflight or by
  // a successful create/upload later in the workflow.
  ensureSourceShopifyIdentityColumns_(sourceSheet);
  const sourceValues = sourceSheet.getDataRange().getDisplayValues();

  if (sourceValues.length < 2) {
    throw new Error(
        `The source sheet “${sourceSheetName}” has no data rows.`);
  }

  const sourceIndices = getColumnIndices(sourceSheet);
  const reviewRows = [];
  const taxonomyColumnValues = sourceValues
      .slice(1)
      .map((row) => [clean_(row[taxonomyColumnIndex])]);

  for (let offset = 1; offset < sourceValues.length; offset += 1) {
    const sourceRowValues = sourceValues[offset];

    if (sourceRowValues.every((value) => !clean_(value))) {
      continue;
    }

    const sourceRowNumber = offset + 1;

    const product = buildNormalizedProduct_(
        sourceSheetName,
        sourceRowNumber,
        sourceRowValues,
        sourceIndices,
        profile);

    const validation = validateNormalizedProduct_(product);
    const sourceProductGid = getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Product GID']);
    const sourceVariantGid = getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Variant GID']);
    const sourceInventoryItemGid = getAliasedValue_(
        sourceRowValues,
        sourceIndices,
        ['Shopify Inventory Item GID']);

    if (product.taxonomyCategoryId) {
      taxonomyColumnValues[offset - 1][0] =
        product.taxonomyCategoryId;
    }

    reviewRows.push([
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
      product.chineseName,
      product.brand,
      product.productType,
      'PENDING',
      product.taxonomyCategoryId,
      product.sku,
      product.price,
      product.inventory,
      product.baseColors.join(', '),
      product.glitterColors.join(', '),
      product.sheenColors.join(', '),
      product.tags.join(', '),
      product.bodyHtml,
      product.imageUrl,
      sourceProductGid,
      sourceVariantGid,
      sourceInventoryItemGid,
      'NOT_UPLOADED',
      '',
    ]);
  }

  if (taxonomyColumnValues.length > 0) {
    sourceSheet
        .getRange(
            2,
            taxonomyColumnIndex + 1,
            taxonomyColumnValues.length,
            1)
        .setValues(taxonomyColumnValues);
  }

  writeReviewSheet_(spreadsheet, reviewRows);

  SpreadsheetApp.getUi().alert(
      `Built ${reviewRows.length} review row(s) from “${sourceSheetName}”.\n\n` +
      'Shopify GID columns and latest taxonomy IDs are now present in the ' +
      'source sheet. Existing GIDs were copied into the review. Run the ' +
      'Shopify check next to fill missing GIDs for existing products.');
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

  const existingTaxonomyCategoryId =
    normalizeTaxonomyCategoryId_(
        getAliasedValue_(
            row,
            sourceIndices,
            profile.aliases.taxonomyCategoryId));

  const taxonomyCategoryId =
    resolveTaxonomyCategoryForProductType_(
        productType,
        existingTaxonomyCategoryId);

  return {
    sourceSheetName,
    sourceRowNumber,
    itemType,
    itemId,
    handle: slugifyHandle_(englishName),
    englishName,
    chineseName,
    title: englishName || chineseName,
    brand,
    productType,
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
    taxonomyCategoryId,
    colorMode: profile.colorMode || '',
    tags,
    bodyHtml: normalizeBodyHtml_(desc),

    imageUrl: getAliasedValue_(
        row,
        sourceIndices,
        profile.aliases.imageUrl),
  };
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

  try {
    selected = selectBestTaxonomyCategory_(
        searchShopifyTaxonomyCategories_(searchTerm),
        searchTerm);
  } catch (error) {
    console.warn(
        `Live Shopify taxonomy lookup failed for “${productType}”: ` +
        `${error.message}`);
  }

  if (!selected) {
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

  if (
    product.colorMode === 'INK' &&
    product.baseColors.length === 0
  ) {
    errors.push('MISSING_INK_BASE_COLOR');
  }

  if (
    product.colorMode === 'GLITTER_POTION' &&
    product.glitterColors.length === 0
  ) {
    errors.push('MISSING_GLITTER_COLOR');
  }

  return errors.length
    ? `BLOCKED: ${errors.join(', ')}`
    : 'READY_FOR_SHOPIFY_CHECK';
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

  for (let offset = 1; offset < values.length; offset += 1) {
    const row = values[offset];

    let action = clean_(row[actionIndex]);
    let productGid = clean_(row[productGidIndex]);
    let variantGid = clean_(row[variantGidIndex]);
    let inventoryItemGid = clean_(row[inventoryItemGidIndex]);
    let result = clean_(row[resultIndex]);

    const sourceSheetName = clean_(row[sourceSheetIndex]);
    const sourceRow = Number(row[sourceRowIndex]);

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

    try {
      const resolution =
        resolveShopifyProductIdentity_(
            accessToken,
            clean_(row[skuIndex]),
            clean_(row[handleIndex]));

      action = resolution.action;
      result = resolution.message;

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
      'CREATE_ACTIVE: no matching SKU or handle exists.\n' +
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
    handle) {
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
        validation: row[validationIndex],
        action: row[actionIndex],
        result: row[resultIndex],

        approved:
          normalize_(row[approvalIndex]) === 'APPROVED',

        selectable:
          normalize_(row[validationIndex]) ===
            'READY_FOR_SHOPIFY_CHECK' &&
          (
            normalize_(row[actionIndex]) === 'CREATE_ACTIVE' ||
            normalize_(row[actionIndex]) === 'CREATE_DRAFT' ||
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
      action === 'CREATE_ACTIVE' ||
      action === 'CREATE_DRAFT' ||
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

    const statusIndex =
      requiredColumn_(indices, 'Status');

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
            statusIndex,
            'FAILED');

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
  const isCreateAction =
    action === 'CREATE_ACTIVE' ||
    action === 'CREATE_DRAFT';

  writeCell_(
      reviewSheet,
      sheetRow,
      approvalIndex,
      'PROCESSING');

  writeCell_(
      reviewSheet,
      sheetRow,
      statusIndex,
      'PROCESSING');

  const productInput = {
    handle: clean_(row[handleIndex]),
    title: clean_(row[englishNameIndex]),
    vendor: clean_(row[brandIndex]),
    productType: clean_(row[typeIndex]),
    status: MYK_SHOPIFY.syncProductStatus,
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

  let identity = {
    productId: clean_(row[productGidIndex]),
    variantId: clean_(row[variantGidIndex]),
    inventoryItemId:
      clean_(row[inventoryItemGidIndex]),
  };

  if (
    isCreateAction &&
    identity.productId
  ) {
    // A previous attempt already created the product. Complete its product
    // fields and ACTIVE status instead of creating a duplicate.
    updateShopifyProduct_(
        accessToken,
        identity.productId,
        productInput);
  } else if (isCreateAction) {

    identity = createShopifyProduct_(
        accessToken,
        productInput);

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
  } else if (action === 'UPDATE_EXISTING') {
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

  // Continue with your existing updateShopifyVariant_,
  // setShopifyProductMetafields_ and inventory code here.

  const variantResult = updateShopifyVariant_(
      accessToken,
      identity.productId,
      identity.variantId,
      clean_(row[skuIndex]),
      fixedPrice_(row[priceIndex]));

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

  const verifiedMetafields =
  verifyProductMetafields_(
      accessToken,
      identity.productId);

  const verifiedKeys = new Set(
      verifiedMetafields.map((metafield) => {
        return metafield.key;
      }));

  [
    MYK_SHOPIFY.itemIdMetafieldKey,
    MYK_SHOPIFY.baseColorsMetafieldKey,
    MYK_SHOPIFY.glitterColorsMetafieldKey,
    MYK_SHOPIFY.sheenColorsMetafieldKey,
  ].forEach((key) => {
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

  const productResult = isCreateAction
    ? 'CREATED_ACTIVE'
    : 'UPDATED_ACTIVE';

  const finalResult =
    `${productResult}; STATUS=ACTIVE; ${inventoryResultText}`;

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
      MYK_SHOPIFY.syncProductStatus);

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

  writeSourceUploadResult_(
      spreadsheet,
      clean_(row[sourceSheetIndex]),
      Number(row[sourceRowIndex]),
      finalResult,
      true,
      taxonomy);
}

/**
 * Creates one ACTIVE Shopify product after review approval.
 */
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

  if (normalize_(product.status) !== MYK_SHOPIFY.syncProductStatus) {
    throw new Error(
        `Shopify created the product with status ${product.status}; ` +
        `expected ${MYK_SHOPIFY.syncProductStatus}.`);
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
 * Existing approved products are explicitly moved to ACTIVE.
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

  if (
    !result.product ||
    normalize_(result.product.status) !== MYK_SHOPIFY.syncProductStatus
  ) {
    throw new Error(
        `Shopify did not confirm status ${MYK_SHOPIFY.syncProductStatus}.`);
  }
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
    price) {
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

  const payload = callShopifyGraphql_(
      accessToken,
      mutation,
      {
        productId,
        variants: [
          {
            id: variantId,
            price: normalizedPrice,
            inventoryItem: {
              sku: normalizedSku,
              tracked: true,
            },
          },
        ],
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

  const metafields = [
    {
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.itemIdMetafieldKey,
      type: 'single_line_text_field',
      value: data.itemId,
    },
    {
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.baseColorsMetafieldKey,
      type: 'list.single_line_text_field',
      value: JSON.stringify(data.baseColors),
    },
    {
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.glitterColorsMetafieldKey,
      type: 'list.single_line_text_field',
      value: JSON.stringify(data.glitterColors),
    },
    {
      ownerId: productId,
      namespace: MYK_SHOPIFY.metafieldNamespace,
      key: MYK_SHOPIFY.sheenColorsMetafieldKey,
      type: 'list.single_line_text_field',
      value: JSON.stringify(data.sheenColors),
    },
  ];

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
          <th>Item ID</th>
          <th>English name</th>
          <th>SKU</th>
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
          '<td>' + escapeHtml(row.itemId) + '</td>',
          '<td>' + escapeHtml(row.title) + '</td>',
          '<td>' + escapeHtml(row.sku) + '</td>',
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

  // Remove the existing filter before clearing/rebuilding the sheet.
  const existingFilter = sheet.getFilter();

  if (existingFilter) {
    existingFilter.remove();
  }

  sheet.clear();

  const headers = MYK_SHOPIFY.resultHeaders;

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
      return clean_(row[position]);
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
    taxonomyCategoryId) {
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
    sheet
        .getRange(
            Number(sourceRow),
            indices.status + 1)
        .setValue(MYK_SHOPIFY.syncProductStatus);

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
