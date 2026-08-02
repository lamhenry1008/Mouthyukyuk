/**
 * Mouthyukyuk checkout and receipt manager.
 *
 * The module records one sheet row per purchased Shopify variant. It does not
 * create Shopify Admin orders; Shopify is used as the catalog and inventory
 * source, while the bound spreadsheet is the auditable order ledger.
 */
const CHECKOUT_CONFIG = Object.freeze({
  sheetName: '訂單紀錄',
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
  statuses: Object.freeze({
    active: 'ACTIVE',
    cancelled: 'CANCELLED',
  }),
  headers: Object.freeze([
    '訂單編號',
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
    '訂單總額',
    '最後操作',
  ]),
});

function showCheckoutDialog() {
  const html = HtmlService
      .createTemplateFromFile('Checkout')
      .evaluate()
      .setWidth(1180)
      .setHeight(780);

  SpreadsheetApp.getUi().showModalDialog(
      html,
      'Checkout');
}

function getCheckoutBootstrap() {
  checkoutEnsureSheet_();

  return {
    order: checkoutBlankOrder_(),
    paymentMethods:
      CHECKOUT_CONFIG.paymentMethods.slice(),
    cashiers: checkoutGetCashierOptions_(),
    recentOrders: findCheckoutOrders(''),
  };
}

function getBlankCheckoutOrder() {
  checkoutEnsureSheet_();
  return checkoutBlankOrder_();
}

function checkoutBlankOrder_() {
  return {
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
  };
}

/**
 * Searches Shopify and returns exact variant identities for the cart.
 */
function checkoutSearchCatalog(searchText) {
  const term = checkoutClean_(searchText);

  if (!term) {
    return [];
  }

  const locationId = getRequiredScriptProperty_(
      CHECKOUT_CONFIG.locationProperty);

  const escaped = term
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

  const query = `
    query CheckoutCatalogSearch(
      $query: String!,
      $locationId: ID!
    ) {
      products(first: 10, query: $query) {
        nodes {
          id
          title
          handle
          vendor
          status
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
    }
  `;

  const data = shopifyGraphql_(
      query,
      {
        query:
          `title:*${escaped}* OR ` +
          `sku:*${escaped}* OR ` +
          `handle:*${escaped}*`,
        locationId,
      });

  const products =
    data.products &&
    Array.isArray(data.products.nodes)
      ? data.products.nodes
      : [];

  const results = [];

  products.forEach((product) => {
    const productImage =
      product.featuredMedia &&
      product.featuredMedia.image &&
      product.featuredMedia.image.url ||
      '';

    const variants =
      product.variants &&
      Array.isArray(product.variants.nodes)
        ? product.variants.nodes
        : [];

    variants.forEach((variant) => {
      const inventoryItem =
        variant.inventoryItem || {};

      const level =
        inventoryItem.inventoryLevel || null;

      const available =
        checkoutAvailableFromLevel_(level);

      results.push({
        productId: product.id,
        variantId: variant.id,
        inventoryItemId: inventoryItem.id || '',
        productTitle: product.title,
        variantTitle:
          variant.title === 'Default Title'
            ? ''
            : variant.title,
        sku: variant.sku || '',
        price: checkoutMoney_(variant.price),
        available,
        tracked: Boolean(inventoryItem.tracked),
        vendor: product.vendor || '',
        productStatus: product.status || '',
        imageUrl:
          variant.image && variant.image.url ||
          productImage,
      });
    });
  });

  return results.slice(0, 100);
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
                  item.productTitle,
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
      : checkoutOrderId_(transactionDate, draftKey);

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
          incoming.items),
      receiptImages: [],
      receiptUrl: '',
      receiptFileId: '',
      receiptFolderId: '',
      inventoryResult: '',
      orderTotal: 0,
      lastAction:
        previous ? 'UPDATED' : 'CREATED',
    };

    checkoutValidateOrderHeader_(order);
    checkoutHydrateTrustedVariants_(order);
    checkoutCalculateTotals_(order);

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

    try {
      inventoryResult =
        checkoutApplyInventoryTransition_(
            previous,
            order,
            'save');

      order.inventoryResult = inventoryResult.message;

      const receipt = checkoutCreateReceiptPdf_(
          folder,
          order);

      order.receiptFileId = receipt.id;
      order.receiptUrl = receipt.url;

      checkoutWriteOrder_(sheet, order);
      ledgerWritten = true;
      checkoutRefreshSheetFilter_(sheet);
    } catch (error) {
      if (
        inventoryResult &&
        inventoryResult.changes.length > 0 &&
        !ledgerWritten
      ) {
        try {
          checkoutCompensateInventory_(
              inventoryResult,
              order,
              'save',
              requestKey);
        } catch (compensationError) {
          throw new Error(
              `${error.message} CRITICAL: inventory rollback also failed: ` +
              compensationError.message);
        }

        return {
          ok: false,
          message:
            `${error.message} Shopify inventory was rolled back; ` +
            'you can safely try saving again.',
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
          lastAction: 'CANCELLED',
        });

    const folder = checkoutGetOrderFolder_(
        cancelled,
        previous.receiptFolderId);

    let inventoryResult = null;
    let ledgerWritten = false;

    try {
      inventoryResult =
        checkoutApplyInventoryTransition_(
            previous,
            null,
            'cancel',
            cancellationRequestKey);

      cancelled.inventoryResult =
        inventoryResult.message;

      const receipt = checkoutCreateReceiptPdf_(
          folder,
          cancelled);

      cancelled.receiptFileId = receipt.id;
      cancelled.receiptUrl = receipt.url;

      const sheet = checkoutEnsureSheet_();
      checkoutWriteOrder_(sheet, cancelled);
      ledgerWritten = true;
      checkoutRefreshSheetFilter_(sheet);
    } catch (error) {
      if (
        inventoryResult &&
        inventoryResult.changes.length > 0 &&
        !ledgerWritten
      ) {
        try {
          checkoutCompensateInventory_(
              inventoryResult,
              cancelled,
              'cancel',
              cancellationRequestKey);
        } catch (compensationError) {
          throw new Error(
              `${error.message} CRITICAL: inventory rollback also failed: ` +
              compensationError.message);
        }

        return {
          ok: false,
          message:
            `${error.message} Shopify inventory was rolled back; ` +
            'you can safely try cancelling again.',
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

function checkoutNormalizeOrderItems_(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
        'Add at least one Shopify variant.');
  }

  const seen = {};

  return items.map((raw, index) => {
    const item = raw || {};
    const variantId =
      checkoutClean_(item.variantId);

    if (!variantId) {
      throw new Error(
          `Item ${index + 1} has no Shopify Variant GID. ` +
          'Choose it from catalog search.');
    }

    if (seen[variantId]) {
      throw new Error(
          `The same variant appears more than once: ` +
          `${checkoutClean_(item.sku) || variantId}`);
    }

    seen[variantId] = true;

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
      productId: checkoutClean_(item.productId),
      variantId,
      inventoryItemId:
        checkoutClean_(item.inventoryItemId),
      sku: checkoutClean_(item.sku),
      productTitle:
        checkoutClean_(item.productTitle),
      variantTitle:
        checkoutClean_(item.variantTitle),
      quantity,
      unitPrice,
      discountType,
      discountValue,
      lineTotal: 0,
      tracked: item.tracked !== false,
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
            };

            if (
              Number.isFinite(
                  Number(change.changeFromQuantity))
            ) {
              input.changeFromQuantity =
                Number(change.changeFromQuantity);
            }

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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
        'Checkout must run from the bound spreadsheet.');
  }

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

  const rowsByVariant = {};

  existingRows.forEach((entry) => {
    const key = checkoutClean_(entry.variantId);

    if (!rowsByVariant[key]) {
      rowsByVariant[key] = [];
    }

    rowsByVariant[key].push(entry);
  });

  const usedRows = {};
  const rowsToAppend = [];

  records.forEach((record) => {
    const variantId = checkoutClean_(
        record['Shopify Variant GID']);

    const candidates = rowsByVariant[variantId] || [];
    const target = candidates.shift() || null;

    if (target) {
      const currentRow = sheet
          .getRange(target.rowNumber, 1, 1, sheet.getLastColumn())
          .getValues()[0];

      const currentOrderId = checkoutClean_(
          currentRow[target.orderColumn]);

      const currentVariantId = checkoutClean_(
          currentRow[target.variantColumn]);

      if (
        currentOrderId !== order.orderId ||
        currentVariantId !== target.variantId
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
  }

  existingRows
      .filter((entry) => !usedRows[entry.rowNumber])
      .sort((left, right) => right.rowNumber - left.rowNumber)
      .forEach((entry) => {
        sheet.deleteRow(entry.rowNumber);
      });
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
      variantId: checkoutClean_(row[variantColumn]),
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
  return groups[id]
    ? checkoutOrderFromRows_(groups[id])
    : null;
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

  const order = {
    orderId:
      checkoutClean_(get(base, '訂單編號')),
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
    orderTotal:
      checkoutMoney_(get(base, '訂單總額')),
    lastAction:
      checkoutClean_(get(base, '最後操作')),
    items: [],
    _rowNumbers: rows.map((entry) => {
      return entry.rowNumber;
    }),
  };

  order.items = rows.map((entry) => {
    const row = entry.values;

    return {
      productId:
        checkoutClean_(get(row, 'Shopify Product GID')),
      variantId:
        checkoutClean_(get(row, 'Shopify Variant GID')),
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
  const values = [];
  const activeEmail =
    Session.getActiveUser().getEmail();

  if (activeEmail) {
    values.push(activeEmail);
  }

  const groups = checkoutReadOrderGroups_();

  Object.keys(groups).forEach((orderId) => {
    const order = checkoutOrderFromRows_(
        groups[orderId]);

    if (order && order.cashier) {
      values.push(order.cashier);
    }
  });

  return checkoutUnique_(values).sort();
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

function checkoutOrderId_(date, draftKey) {
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

