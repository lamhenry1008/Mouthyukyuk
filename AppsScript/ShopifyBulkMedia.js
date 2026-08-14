/**
 * Conservative, resumable product-image sync for Shopify Direct Sync.
 *
 * This module deliberately adds media only when the Shopify product has no
 * READY or still-processing media. It never removes or replaces media.
 * Google Drive and remote HTTP(S) images are copied through Shopify staged
 * uploads; Shopify performs its own image processing and optimization.
 *
 * All globals in this file use the mykBulkMedia prefix because every Apps
 * Script source file shares one global namespace.
 */

const mykBulkMediaConfig_ = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  processingTimeoutMs: 15 * 60 * 1000,
  allowedReviewStates: Object.freeze([
    'APPROVED',
    'PROCESSING',
    'IMAGE_PROCESSING',
    'UPLOADED',
  ]),
  allowedMimeTypes: Object.freeze([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
  ]),
  sourceAliases: Object.freeze({
    sku: Object.freeze(['SKU', 'Variant SKU']),
    handle: Object.freeze(['Handle']),
    productGid: Object.freeze(['Shopify Product GID']),
    imageUrls: Object.freeze([
      'Image URL',
      'Image URLs',
      'Image Src',
      'Image',
    ]),
  }),
});

/**
 * Adds source-sheet images only when the product currently has no usable
 * Shopify media.
 *
 * Required context:
 *   accessToken   Shopify Admin access token.
 *   spreadsheet   Spreadsheet containing the source and review sheets.
 *   reviewSheet   Shopify Direct Sync Review sheet.
 *   indices       Zero-based normalized review heading indices.
 *   row           Current review-row values.
 *   productId     Shopify Product GID.
 *   altText       Product image alt text.
 *   previousResult Previous Shopify Result text, used to preserve the first
 *                  observed processing timestamp across resumptions.
 *
 * @param {Object} context Sync context.
 * @return {{complete:boolean,pending:boolean,failed:boolean,code:string,
 *   message:string,mediaIds:Array<string>,processingSince:string}}
 */
function mykBulkEnsureMissingProductImages_(context) {
  const input = context || {};
  const accessToken = mykBulkMediaClean_(input.accessToken);
  const spreadsheet = input.spreadsheet;
  const reviewSheet = input.reviewSheet;
  const indices = input.indices || {};
  const currentRow = Array.isArray(input.row) ? input.row : [];
  const productId = mykBulkMediaClean_(input.productId);
  const altText = mykBulkMediaClean_(input.altText);
  const previousResult = mykBulkMediaClean_(input.previousResult);

  if (!accessToken) {
    throw new Error(
        'Bulk media sync requires a Shopify access token.');
  }

  if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') {
    throw new Error(
        'Bulk media sync requires the source spreadsheet.');
  }

  if (!reviewSheet || typeof reviewSheet.getDataRange !== 'function') {
    throw new Error(
        'Bulk media sync requires the review sheet.');
  }

  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    throw new Error(
        `Bulk media sync received an invalid Product GID: ` +
        `${productId || '(blank)'}.`);
  }

  /*
   * Capture the approved image set before evaluating Shopify media. Besides
   * preventing live source-sheet changes from bypassing review, its count lets
   * a watchdog distinguish a complete multi-image upload from a partial
   * mutation whose result marker was lost to an Apps Script hard timeout.
   */
  const sourceReferences = mykBulkMediaCollectReviewedReferences_({
    reviewSheet,
    indices,
    currentRow,
    productId,
    reviewImageUrl: input.reviewImageUrl,
  });
  const approvalIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Approval');
  const reviewState = mykBulkMediaClean_(
      currentRow[approvalIndex]).toUpperCase();
  const isRecovery =
    reviewState === 'IMAGE_PROCESSING' ||
    /(?:IMAGE_ATTACHING|IMAGE_PROCESSING_SINCE|IMAGE_MEDIA_IDS|IMAGE_EXPECTED_COUNT)/i
        .test(previousResult);
  const expectedImageCount = sourceReferences.length;
  const initialMedia = mykBulkMediaQueryProductMedia_(
      accessToken,
      productId);
  const initialState = mykBulkMediaEvaluateExistingMedia_(
      initialMedia,
      previousResult,
      expectedImageCount,
      isRecovery);

  // Existing READY or in-flight media is authoritative. Do not create a
  // second copy merely because a source sheet also contains image URLs.
  if (initialState) {
    return initialState;
  }

  if (sourceReferences.length === 0) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'MISSING_SOURCE_IMAGE',
        'MISSING_SOURCE_IMAGE: Shopify has no READY image and the approved ' +
        'review contains no source Image URL.',
        [],
        '');
  }

  const sources = sourceReferences.map((reference) => {
    return mykBulkMediaResolveSource_(reference);
  });

  /*
   * Persist a media-specific checkpoint immediately before the first Shopify
   * staging mutation. Generic PROCESSING starts much earlier in the product
   * workflow and therefore cannot safely prove that media attachment began.
   */
  if (typeof input.onBeforeAttach === 'function') {
    input.onBeforeAttach({
      expectedCount: expectedImageCount,
      message:
        `IMAGE_ATTACHING; ` +
        `${mykBulkMediaExpectedCountMarker_(expectedImageCount)}`,
    });
  }

  const stagedSources = mykBulkMediaStageSources_(
      accessToken,
      sources);

  // Close the race between the first query and the staged upload. Staged
  // targets are temporary; leaving them unused is safer than duplicating media.
  const preAttachMedia = mykBulkMediaQueryProductMedia_(
      accessToken,
      productId);
  const preAttachState = mykBulkMediaEvaluateExistingMedia_(
      preAttachMedia,
      previousResult,
      expectedImageCount,
      true);

  if (preAttachState) {
    return preAttachState;
  }

  const beforeIds = new Set(
      preAttachMedia.map((media) => media.id));
  const processingSince = new Date().toISOString();
  let attachError = null;
  let mutationMedia = [];

  try {
    mutationMedia = mykBulkMediaAttachStagedSources_(
        accessToken,
        productId,
        stagedSources,
        altText);
  } catch (error) {
    // The network can fail after Shopify has accepted a mutation. Re-query
    // before throwing so a blind retry cannot create a duplicate image.
    attachError = error;
  }

  const afterMedia = mykBulkMediaQueryProductMedia_(
      accessToken,
      productId);
  const mediaById = {};

  mutationMedia.concat(afterMedia).forEach((media) => {
    if (media && media.id) {
      mediaById[media.id] = media;
    }
  });

  const createdMedia = Object.keys(mediaById)
      .filter((mediaId) => !beforeIds.has(mediaId))
      .map((mediaId) => mediaById[mediaId]);

  if (createdMedia.length === 0) {
    if (attachError) {
      throw attachError;
    }

    throw new Error(
        'Shopify accepted the image request but returned no new product media.');
  }

  return mykBulkMediaEvaluateCreatedMedia_(
      createdMedia,
      processingSince,
      attachError,
      stagedSources.length);
}

/** Returns a stable public result object. */
function mykBulkMediaResult_(
    complete,
    pending,
    failed,
    code,
    message,
    mediaIds,
    processingSince) {
  return {
    complete: complete === true,
    pending: pending === true,
    failed: failed === true,
    code: mykBulkMediaClean_(code),
    message: mykBulkMediaClean_(message),
    mediaIds: Array.from(new Set(
        (Array.isArray(mediaIds) ? mediaIds : [])
            .map((id) => mykBulkMediaClean_(id))
            .filter(Boolean))),
    processingSince: mykBulkMediaClean_(processingSince),
  };
}

/** Queries all product media statuses used by this conservative policy. */
function mykBulkMediaQueryProductMedia_(accessToken, productId) {
  const query = `
    query MykBulkProductMedia($id: ID!) {
      product(id: $id) {
        id
        media(first: 250) {
          nodes {
            id
            status
            mediaContentType
          }
        }
      }
    }
  `;
  const payload = callShopifyGraphql_(
      accessToken,
      query,
      {id: productId});
  const product = payload && payload.data && payload.data.product;

  if (!product) {
    throw new Error(
        `Shopify product was not found during image sync: ${productId}.`);
  }

  const nodes = product.media && Array.isArray(product.media.nodes)
    ? product.media.nodes
    : [];

  return nodes
      .map((media) => ({
        id: mykBulkMediaClean_(media && media.id),
        status: mykBulkMediaClean_(media && media.status).toUpperCase(),
        mediaContentType: mykBulkMediaClean_(
            media && media.mediaContentType).toUpperCase(),
      }))
      .filter((media) => media.id);
}

/**
 * Applies the missing-only policy to media that existed before this call.
 * FAILED media is not usable and does not block a new source image.
 */
function mykBulkMediaEvaluateExistingMedia_(
    media,
    previousResult,
    expectedCountHint,
    isRecovery) {
  const list = (Array.isArray(media) ? media : [])
      .filter((item) => item.mediaContentType === 'IMAGE');
  const trackedIds = mykBulkMediaParseMediaIds_(previousResult);
  const recordedExpectedCount =
    mykBulkMediaParseExpectedCount_(previousResult);
  const expectedCount = recordedExpectedCount > 0
    ? recordedExpectedCount
    : Number(expectedCountHint) > 0
      ? Number(expectedCountHint)
      : 0;
  const expectedMarker = mykBulkMediaExpectedCountMarker_(expectedCount);

  if (trackedIds.length > 0) {
    const byId = list.reduce((index, item) => {
      index[item.id] = item;
      return index;
    }, {});
    const missingIds = trackedIds.filter((id) => !byId[id]);
    const tracked = trackedIds
        .map((id) => byId[id])
        .filter(Boolean);
    const failed = tracked.filter((item) => item.status === 'FAILED');
    const processing = tracked.filter((item) => {
      return item.status !== 'READY' && item.status !== 'FAILED';
    });
    const parsedSince = mykBulkMediaParseProcessingSince_(previousResult);
    const sinceMs = parsedSince ? Date.parse(parsedSince) : Date.now();
    const processingSince = Number.isFinite(sinceMs)
      ? new Date(sinceMs).toISOString()
      : new Date().toISOString();

    if (
      expectedCount > 0 &&
      trackedIds.length !== expectedCount
    ) {
      return mykBulkMediaResult_(
          false,
          false,
          true,
          'IMAGE_PARTIAL',
          `IMAGE_PARTIAL: ${trackedIds.length} Shopify media item(s) were ` +
          `tracked for ${expectedCount} reviewed source image(s); ` +
          `${mykBulkMediaIdsMarker_(trackedIds)}; ${expectedMarker}. ` +
          'Use Shopify Editor to inspect the product.',
          trackedIds,
          '');
    }

    if (missingIds.length > 0 || failed.length > 0) {
      return mykBulkMediaResult_(
          false,
          false,
          true,
          'IMAGE_FAILED',
          `IMAGE_FAILED: ${failed.length} tracked image(s) failed and ` +
          `${missingIds.length} tracked image(s) are missing; ` +
          `${mykBulkMediaIdsMarker_(trackedIds)}; ${expectedMarker}. ` +
          'Use Shopify Editor to ' +
          'inspect the product.',
          trackedIds,
          '');
    }

    if (processing.length > 0) {
      const timedOut = Date.now() - sinceMs >=
        mykBulkMediaConfig_.processingTimeoutMs;

      if (timedOut) {
        return mykBulkMediaResult_(
            false,
            false,
            true,
            'MEDIA_PROCESSING_TIMEOUT',
            `MEDIA_PROCESSING_TIMEOUT; ` +
            `IMAGE_PROCESSING_SINCE=${processingSince}; ` +
            `${mykBulkMediaIdsMarker_(trackedIds)}; ${expectedMarker}; ` +
            'Shopify media did not ' +
            'become READY within 15 minutes.',
            trackedIds,
            processingSince);
      }

      return mykBulkMediaResult_(
          false,
          true,
          false,
          'IMAGE_PROCESSING',
          `IMAGE_PROCESSING; IMAGE_PROCESSING_SINCE=${processingSince}; ` +
          `${mykBulkMediaIdsMarker_(trackedIds)}; ${expectedMarker}; ` +
          `${processing.length} tracked image(s) are still processing.`,
          trackedIds,
          processingSince);
    }

    return mykBulkMediaResult_(
        true,
        false,
        false,
        'IMAGE_READY',
        `IMAGE_READY: every tracked source image is READY; ` +
        `${mykBulkMediaIdsMarker_(trackedIds)}; ${expectedMarker}.`,
        trackedIds,
        '');
  }

  const ready = list.filter((item) => item.status === 'READY');
  const failed = list.filter((item) => item.status === 'FAILED');
  const processing = list.filter((item) => {
    return item.status !== 'READY' && item.status !== 'FAILED';
  });

  /*
   * A watchdog can resume after Shopify accepted media but before this script
   * saved IMAGE_MEDIA_IDS. In that recovery state, any observed but incomplete
   * set must fail closed instead of treating the first READY image as success.
   */
  if (
    isRecovery === true &&
    expectedCount > 0 &&
    list.length > 0 &&
    list.length !== expectedCount
  ) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'IMAGE_SYNC_NEEDS_EDITOR',
        `IMAGE_SYNC_NEEDS_EDITOR: Shopify has ${list.length} image media ` +
        `item(s), but the approved review expected ${expectedCount}; ` +
        `${mykBulkMediaIdsMarker_(list.map((item) => item.id))}; ` +
        `${expectedMarker}. Use Shopify Editor to inspect the product.`,
        list.map((item) => item.id),
        '');
  }

  if (
    failed.length > 0 &&
    (isRecovery === true || ready.length > 0 || processing.length > 0)
  ) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'IMAGE_SYNC_NEEDS_EDITOR',
        `IMAGE_SYNC_NEEDS_EDITOR: Shopify has mixed image states ` +
        `(${ready.length} READY, ${processing.length} PROCESSING, ` +
        `${failed.length} FAILED); ` +
        `${mykBulkMediaIdsMarker_(list.map((item) => item.id))}; ` +
        `${expectedMarker}. Use Shopify Editor to inspect the product.`,
        list.map((item) => item.id),
        '');
  }

  if (processing.length > 0) {
    const trackedMedia = ready.concat(processing);
    const trackedMediaIds = trackedMedia.map((item) => item.id);
    const now = Date.now();
    const parsedSince = mykBulkMediaParseProcessingSince_(previousResult);
    const sinceMs = parsedSince ? Date.parse(parsedSince) : now;
    const processingSince = Number.isFinite(sinceMs)
      ? new Date(sinceMs).toISOString()
      : new Date(now).toISOString();
    const timedOut = now - (Number.isFinite(sinceMs) ? sinceMs : now) >=
      mykBulkMediaConfig_.processingTimeoutMs;
    const recoveryExpectedCount = expectedCount > 0
      ? expectedCount
      : trackedMediaIds.length;
    const recoveryExpectedMarker =
      mykBulkMediaExpectedCountMarker_(recoveryExpectedCount);

    if (timedOut) {
      return mykBulkMediaResult_(
          false,
          false,
          true,
          'MEDIA_PROCESSING_TIMEOUT',
          `MEDIA_PROCESSING_TIMEOUT; ` +
          `IMAGE_PROCESSING_SINCE=${processingSince}; ` +
          `${mykBulkMediaIdsMarker_(trackedMediaIds)}; ` +
          `${recoveryExpectedMarker}; Shopify media did not become READY ` +
          'within 15 minutes.',
          trackedMediaIds,
          processingSince);
    }

    return mykBulkMediaResult_(
        false,
        true,
        false,
        'IMAGE_PROCESSING',
        `IMAGE_PROCESSING; IMAGE_PROCESSING_SINCE=${processingSince}; ` +
        `${mykBulkMediaIdsMarker_(trackedMediaIds)}; ` +
        `${recoveryExpectedMarker}; ${processing.length} Shopify media ` +
        'item(s) are still processing.',
        trackedMediaIds,
        processingSince);
  }

  if (ready.length > 0) {
    if (/IMAGE_(?:UPLOAD_)?FAILED|IMAGE_PARTIAL/i.test(previousResult)) {
      return mykBulkMediaResult_(
          false,
          false,
          true,
          'IMAGE_SYNC_NEEDS_EDITOR',
          'IMAGE_SYNC_NEEDS_EDITOR: Shopify has a READY image, but an ' +
          'earlier bulk attempt did not attach every reviewed source image. ' +
          'Use Shopify Editor to inspect and retry the missing image.',
          list.map((item) => item.id),
          '');
    }

    return mykBulkMediaResult_(
        true,
        false,
        false,
        'SKIPPED_EXISTING_READY_MEDIA',
        'SKIPPED_EXISTING_READY_MEDIA: Shopify already has READY product ' +
        'media; safe bulk mode did not append or replace the gallery.',
        list.map((item) => item.id),
        '');
  }

  // FAILED-only legacy media is unusable and does not block a fresh source
  // upload. Mixed states were handled above so they cannot false-complete.
  return null;
}

/** Evaluates only media created by the current attachment mutation. */
function mykBulkMediaEvaluateCreatedMedia_(
    media,
    processingSince,
    attachError,
    expectedCount) {
  const list = Array.isArray(media) ? media : [];
  const mediaIds = list.map((item) => item.id);
  const ready = list.filter((item) => item.status === 'READY');
  const failed = list.filter((item) => item.status === 'FAILED');
  const processing = list.filter((item) => {
    return item.status !== 'READY' && item.status !== 'FAILED';
  });
  const expectedMarker = mykBulkMediaExpectedCountMarker_(expectedCount);

  if (
    Number.isInteger(Number(expectedCount)) &&
    Number(expectedCount) > 0 &&
    list.length !== Number(expectedCount)
  ) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'IMAGE_PARTIAL',
        `IMAGE_PARTIAL: Shopify attached ${list.length} of ` +
        `${Number(expectedCount)} reviewed source image(s). Use Shopify ` +
        `Editor to inspect the product before retrying; ` +
        `${mykBulkMediaIdsMarker_(mediaIds)}; ${expectedMarker}.`,
        mediaIds,
        '');
  }

  if (attachError) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'IMAGE_PARTIAL',
        `IMAGE_PARTIAL: Shopify returned an attachment error even though ` +
        `${list.length} new media item(s) were observed; ` +
        `${mykBulkMediaIdsMarker_(mediaIds)}. Use Shopify Editor to inspect ` +
        `the product; ${expectedMarker}. ` +
        `${mykBulkMediaClean_(attachError.message || attachError)}`,
        mediaIds,
        '');
  }

  if (
    list.length > 0 &&
    ready.length === list.length
  ) {
    return mykBulkMediaResult_(
        true,
        false,
        false,
        'IMAGE_READY',
        `IMAGE_READY: Shopify has ${ready.length} READY product image(s); ` +
        `${mykBulkMediaIdsMarker_(mediaIds)}; ${expectedMarker}.`,
        mediaIds,
        '');
  }

  if (failed.length > 0) {
    return mykBulkMediaResult_(
        false,
        false,
        true,
        'IMAGE_FAILED',
        `IMAGE_FAILED: ${failed.length} of ${list.length} newly attached ` +
        `image(s) failed Shopify processing; ` +
        `${mykBulkMediaIdsMarker_(mediaIds)}; ${expectedMarker}.`,
        mediaIds,
        '');
  }

  if (processing.length > 0) {
    return mykBulkMediaResult_(
        false,
        true,
        false,
        'IMAGE_PROCESSING',
        `IMAGE_PROCESSING; IMAGE_PROCESSING_SINCE=${processingSince}; ` +
        `${mykBulkMediaIdsMarker_(mediaIds)}; ${expectedMarker}; ` +
        `${processing.length} Shopify media item(s) are still processing.`,
        mediaIds,
        processingSince);
  }

  return mykBulkMediaResult_(
      false,
      false,
      true,
      'IMAGE_FAILED',
      'IMAGE_FAILED: Shopify returned no usable status for the newly ' +
      'attached images.',
      mediaIds,
      '');
}

/** Parses only this module's durable timestamp marker. */
function mykBulkMediaParseProcessingSince_(previousResult) {
  const match = mykBulkMediaClean_(previousResult).match(
      /(?:^|[;\s])IMAGE_PROCESSING_SINCE=([^;\s]+)/i);

  if (!match) {
    return '';
  }

  let timestamp = match[1];

  try {
    timestamp = decodeURIComponent(timestamp);
  } catch (error) {
    return '';
  }
  const parsed = Date.parse(timestamp);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : '';
}

/** Persists exact created MediaImage GIDs inside the resumable row result. */
function mykBulkMediaIdsMarker_(mediaIds) {
  const ids = Array.from(new Set(
      (Array.isArray(mediaIds) ? mediaIds : [])
          .map((id) => mykBulkMediaClean_(id))
          .filter((id) => {
            return /^gid:\/\/shopify\/MediaImage\/\d+$/.test(id);
          })));

  return `IMAGE_MEDIA_IDS=${ids.join(',')}`;
}

function mykBulkMediaParseMediaIds_(previousResult) {
  const match = mykBulkMediaClean_(previousResult).match(
      /(?:^|[;\s])IMAGE_MEDIA_IDS=([^;\s]+)/i);

  if (!match) {
    return [];
  }

  return Array.from(new Set(
      match[1]
          .split(',')
          .map((id) => mykBulkMediaClean_(id))
          .filter((id) => {
            return /^gid:\/\/shopify\/MediaImage\/\d+$/.test(id);
          })));
}

/** Persists the approved source-image count across resumable attempts. */
function mykBulkMediaExpectedCountMarker_(value) {
  const count = Number(value);

  return Number.isInteger(count) && count > 0
    ? `IMAGE_EXPECTED_COUNT=${count}`
    : 'IMAGE_EXPECTED_COUNT=0';
}

function mykBulkMediaParseExpectedCount_(previousResult) {
  const match = mykBulkMediaClean_(previousResult).match(
      /(?:^|[;\s])IMAGE_EXPECTED_COUNT=(\d+)(?:[;\s.]|$)/i);

  if (!match) {
    return 0;
  }

  const count = Number(match[1]);

  return Number.isInteger(count) && count > 0
    ? count
    : 0;
}

/**
 * Collects only the immutable image URLs that were placed in the approved
 * review. The live source sheet is deliberately not re-read here: changing a
 * source Image URL after review must require rebuilding/reapproving the row.
 *
 * Shared-variant siblings are included only when the configured source profile
 * explicitly supports them and the review rows have the same source sheet,
 * handle, and collection. This lets one approved product upload all reviewed
 * variant-row images without mixing similarly named products across sheets.
 */
function mykBulkMediaCollectReviewedReferences_(context) {
  const reviewSheet = context.reviewSheet;
  const indices = context.indices || {};
  const currentRow = Array.isArray(context.currentRow)
    ? context.currentRow
    : [];
  const productId = mykBulkMediaClean_(context.productId);
  const approvalIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Approval');
  const handleIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Handle');
  const collectionIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Collection');
  const sourceSheetIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Source Sheet');
  const sourceRowIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Source Row');
  const productGidIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Shopify Product GID');
  const imageUrlIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Image URL');
  const currentHandle = mykBulkMediaNormalizeHandle_(
      currentRow[handleIndex]);
  const currentCollection = mykBulkMediaClean_(
      currentRow[collectionIndex]).toUpperCase();
  const currentSourceSheetName = mykBulkMediaClean_(
      currentRow[sourceSheetIndex]);
  const currentSourceRowNumber = Number(
      currentRow[sourceRowIndex]);
  const currentReviewProductId = mykBulkMediaClean_(
      currentRow[productGidIndex]);

  if (
    !currentHandle ||
    !currentSourceSheetName ||
    !Number.isInteger(currentSourceRowNumber) ||
    currentSourceRowNumber < 2
  ) {
    throw new Error(
        'Current review row has invalid Handle, Source Sheet, or Source Row.');
  }

  if (
    currentReviewProductId &&
    currentReviewProductId !== productId
  ) {
    throw new Error(
        `Current review row belongs to ${currentReviewProductId}, not ` +
        `${productId}.`);
  }

  const sourceProfile =
    typeof MYK_SHEET_PROFILES !== 'undefined'
      ? MYK_SHEET_PROFILES[currentSourceSheetName]
      : null;
  const includeSharedVariantRows = Boolean(
      sourceProfile &&
      sourceProfile.supportsSharedProductVariants === true);
  const reviewValues = includeSharedVariantRows
    ? reviewSheet.getDataRange().getDisplayValues()
    : [];
  const candidateRows = [currentRow];

  if (includeSharedVariantRows) {
    for (let offset = 1; offset < reviewValues.length; offset += 1) {
      const reviewRow = reviewValues[offset];

      if (reviewRow === currentRow) {
        continue;
      }

      const approval = mykBulkMediaClean_(
          reviewRow[approvalIndex]).toUpperCase();
      const rowProductId = mykBulkMediaClean_(
          reviewRow[productGidIndex]);

      if (
        mykBulkMediaConfig_.allowedReviewStates.indexOf(approval) === -1 ||
        mykBulkMediaClean_(reviewRow[sourceSheetIndex]) !==
          currentSourceSheetName ||
        mykBulkMediaNormalizeHandle_(reviewRow[handleIndex]) !==
          currentHandle ||
        mykBulkMediaClean_(reviewRow[collectionIndex]).toUpperCase() !==
          currentCollection ||
        (rowProductId && rowProductId !== productId)
      ) {
        continue;
      }

      candidateRows.push(reviewRow);
    }
  }

  const references = [];
  const seen = new Set();

  candidateRows.forEach((reviewRow, index) => {
    const sourceSheetName = mykBulkMediaClean_(
        reviewRow[sourceSheetIndex]);
    const sourceRowNumber = Number(reviewRow[sourceRowIndex]);
    const raw = index === 0
      ? mykBulkMediaClean_(reviewRow[imageUrlIndex]) ||
        mykBulkMediaClean_(context.reviewImageUrl)
      : mykBulkMediaClean_(reviewRow[imageUrlIndex]);

    mykBulkMediaSplitReferences_(raw).forEach((value) => {
      const reference = {
        value,
        sourceSheetName,
        sourceRowNumber,
      };
      const key = mykBulkMediaReferenceKey_(reference);

      if (!key || seen.has(key)) {
        return;
      }

      seen.add(key);
      references.push(reference);
    });
  });

  return references;
}

/**
 * Collects exact source rows for the current review row and eligible sibling
 * variant rows sharing its exact normalized handle.
 */
function mykBulkMediaCollectSourceReferences_(context) {
  const spreadsheet = context.spreadsheet;
  const reviewSheet = context.reviewSheet;
  const indices = context.indices;
  const currentRow = context.currentRow;
  const productId = context.productId;
  const approvalIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Approval');
  const handleIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Handle');
  const skuIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'SKU');
  const sourceSheetIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Source Sheet');
  const sourceRowIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Source Row');
  const productGidIndex = mykBulkMediaRequiredReviewColumn_(
      indices,
      'Shopify Product GID');
  const currentHandle = mykBulkMediaNormalizeHandle_(
      currentRow[handleIndex]);
  const currentSourceSheetName = mykBulkMediaClean_(
      currentRow[sourceSheetIndex]);

  if (!currentHandle || !currentSourceSheetName) {
    throw new Error(
        'Cannot resolve source images because the review Handle or Source ' +
        'Sheet is blank.');
  }

  const currentReviewProductId = mykBulkMediaClean_(
      currentRow[productGidIndex]);

  if (
    currentReviewProductId &&
    currentReviewProductId !== productId
  ) {
    throw new Error(
        `Current review row belongs to ${currentReviewProductId}, not ` +
        `${productId}.`);
  }

  const candidates = [];
  const seenSourceRows = new Set();
  const addCandidate = (reviewRow, isCurrent) => {
    const sourceSheetName = mykBulkMediaClean_(
        reviewRow[sourceSheetIndex]);
    const sourceRowNumber = Number(
        reviewRow[sourceRowIndex]);
    const reviewSku = mykBulkMediaNormalizeSku_(
        reviewRow[skuIndex]);
    const reviewHandle = mykBulkMediaNormalizeHandle_(
        reviewRow[handleIndex]);
    const reviewProductId = mykBulkMediaClean_(
        reviewRow[productGidIndex]);

    if (
      !sourceSheetName ||
      !Number.isInteger(sourceRowNumber) ||
      sourceRowNumber < 2 ||
      !reviewSku ||
      sourceSheetName !== currentSourceSheetName ||
      reviewHandle !== currentHandle ||
      (reviewProductId && reviewProductId !== productId)
    ) {
      if (isCurrent) {
        throw new Error(
            'Current review row has invalid source identity fields.');
      }

      return;
    }

    const sourceKey = `${sourceSheetName}:${sourceRowNumber}`;

    if (seenSourceRows.has(sourceKey)) {
      return;
    }

    seenSourceRows.add(sourceKey);
    candidates.push({
      sourceSheetName,
      sourceRowNumber,
      reviewSku,
      reviewHandle,
      productId,
    });
  };

  addCandidate(currentRow, true);

  const reviewValues = reviewSheet
      .getDataRange()
      .getDisplayValues();

  for (let offset = 1; offset < reviewValues.length; offset += 1) {
    const reviewRow = reviewValues[offset];
    const approval = mykBulkMediaClean_(
        reviewRow[approvalIndex]).toUpperCase();

    if (
      mykBulkMediaConfig_.allowedReviewStates.indexOf(approval) === -1 ||
      mykBulkMediaNormalizeHandle_(reviewRow[handleIndex]) !== currentHandle
    ) {
      continue;
    }

    addCandidate(reviewRow, false);
  }

  const references = [];
  const seenReferences = new Set();

  candidates.forEach((candidate) => {
    const rowReferences = mykBulkMediaReadVerifiedSourceRow_(
        spreadsheet,
        candidate);

    rowReferences.forEach((reference) => {
      const key = mykBulkMediaReferenceKey_(reference);

      if (!key || seenReferences.has(key)) {
        return;
      }

      seenReferences.add(key);
      references.push(reference);
    });
  });

  return references;
}

/** Reads and verifies one exact source row before accepting its image links. */
function mykBulkMediaReadVerifiedSourceRow_(spreadsheet, candidate) {
  const sheet = spreadsheet.getSheetByName(
      candidate.sourceSheetName);

  if (!sheet) {
    throw new Error(
        `Source sheet does not exist: ${candidate.sourceSheetName}.`);
  }

  if (candidate.sourceRowNumber > sheet.getLastRow()) {
    throw new Error(
        `${candidate.sourceSheetName} row ${candidate.sourceRowNumber} ` +
        'no longer exists.');
  }

  const lastColumn = sheet.getLastColumn();

  if (lastColumn < 1) {
    throw new Error(
        `Source sheet has no headings: ${candidate.sourceSheetName}.`);
  }

  const headers = sheet
      .getRange(1, 1, 1, lastColumn)
      .getDisplayValues()[0];
  const sourceIndices = mykBulkMediaBuildHeaderIndex_(headers);
  const skuColumn = mykBulkMediaFindAliasColumn_(
      sourceIndices,
      mykBulkMediaConfig_.sourceAliases.sku);
  const handleColumn = mykBulkMediaFindAliasColumn_(
      sourceIndices,
      mykBulkMediaConfig_.sourceAliases.handle);
  const productGidColumn = mykBulkMediaFindAliasColumn_(
      sourceIndices,
      mykBulkMediaConfig_.sourceAliases.productGid);
  const imageColumns = mykBulkMediaFindAliasColumns_(
      sourceIndices,
      mykBulkMediaConfig_.sourceAliases.imageUrls);

  if (skuColumn < 0) {
    throw new Error(
        `${candidate.sourceSheetName} must contain a SKU column ` +
        'before its images can be synced.');
  }

  const rowValues = sheet
      .getRange(
          candidate.sourceRowNumber,
          1,
          1,
          lastColumn)
      .getDisplayValues()[0];
  const sourceSku = mykBulkMediaNormalizeSku_(
      rowValues[skuColumn]);
  const sourceHandle = handleColumn >= 0
    ? mykBulkMediaNormalizeHandle_(rowValues[handleColumn])
    : '';
  const sourceProductId = productGidColumn >= 0
    ? mykBulkMediaClean_(rowValues[productGidColumn])
    : '';

  if (sourceSku !== candidate.reviewSku) {
    throw new Error(
        `${candidate.sourceSheetName} row ${candidate.sourceRowNumber} ` +
        `SKU changed from ${candidate.reviewSku} to ` +
        `${sourceSku || '(blank)'}. Rebuild the review.`);
  }

  if (sourceHandle && sourceHandle !== candidate.reviewHandle) {
    throw new Error(
        `${candidate.sourceSheetName} row ${candidate.sourceRowNumber} ` +
        `Handle changed from ${candidate.reviewHandle} to ` +
        `${sourceHandle || '(blank)'}. Rebuild the review.`);
  }

  if (sourceProductId && sourceProductId !== candidate.productId) {
    throw new Error(
        `${candidate.sourceSheetName} row ${candidate.sourceRowNumber} ` +
        `belongs to ${sourceProductId}, not ${candidate.productId}.`);
  }

  const references = [];

  imageColumns.forEach((imageColumn) => {
    const range = sheet.getRange(
        candidate.sourceRowNumber,
        imageColumn + 1);

    mykBulkMediaReadCellReferences_(range).forEach((value) => {
      references.push({
        value,
        sourceSheetName: candidate.sourceSheetName,
        sourceRowNumber: candidate.sourceRowNumber,
        sku: candidate.reviewSku,
      });
    });
  });

  return references;
}

/** Reads plain values, rich-text links, and HYPERLINK formulas. */
function mykBulkMediaReadCellReferences_(range) {
  const references = [];
  let foundEmbeddedLink = false;
  const add = (value) => {
    mykBulkMediaSplitReferences_(value).forEach((reference) => {
      if (references.indexOf(reference) === -1) {
        references.push(reference);
      }
    });
  };

  try {
    const richText = range.getRichTextValue();

    if (richText) {
      const linkUrl = richText.getLinkUrl();

      if (linkUrl) {
        foundEmbeddedLink = true;
        add(linkUrl);
      }

      if (typeof richText.getRuns === 'function') {
        richText.getRuns().forEach((run) => {
          const runLink = run.getLinkUrl();

          if (runLink) {
            foundEmbeddedLink = true;
            add(runLink);
          }
        });
      }
    }
  } catch (error) {
    // Fall back to formula/display text for ordinary cells and test doubles.
  }

  try {
    const formula = mykBulkMediaClean_(range.getFormula());
    const match = formula.match(
        /^=HYPERLINK\(\s*"([^"]+)"/i);

    if (match) {
      foundEmbeddedLink = true;
      add(match[1].replace(/""/g, '"'));
    }
  } catch (error) {
    // Formula access is optional for test doubles.
  }

  if (!foundEmbeddedLink) {
    add(range.getDisplayValue());
  }

  return references;
}

function mykBulkMediaSplitReferences_(value) {
  return String(value == null ? '' : value)
      .split(/[\r\n;,|]+/)
      .map((part) => mykBulkMediaClean_(part))
      .filter(Boolean);
}

/**
 * Captures the exact image-link snapshot used when a review row is built.
 * This includes rich-text and HYPERLINK targets that getDisplayValues() alone
 * would reduce to a label.
 */
function mykBulkMediaReadReviewedImageReferences_(
    sheet,
    rowNumber,
    sourceIndices,
    aliases) {
  const columns = mykBulkMediaFindAliasColumns_(
      sourceIndices || {},
      Array.isArray(aliases) ? aliases : []);
  const references = [];
  const seen = new Set();

  columns.forEach((column) => {
    mykBulkMediaReadCellReferences_(
        sheet.getRange(Number(rowNumber), column + 1))
        .forEach((reference) => {
          const value = mykBulkMediaClean_(reference);

          if (!value || seen.has(value)) {
            return;
          }

          seen.add(value);
          references.push(value);
        });
  });

  return references;
}

/** Resolves and validates one Drive or HTTP(S) image into a staged blob. */
function mykBulkMediaResolveSource_(reference) {
  const rawValue = mykBulkMediaClean_(reference && reference.value);
  const sourceLabel = reference
    ? `${reference.sourceSheetName} row ${reference.sourceRowNumber}`
    : 'source row';
  const driveFileId = mykBulkMediaExtractDriveFileId_(rawValue);

  if (driveFileId) {
    let file;

    try {
      file = DriveApp.getFileById(driveFileId);
    } catch (error) {
      throw new Error(
          `${sourceLabel}: Drive image cannot be opened (${driveFileId}).`);
    }

    if (file.isTrashed()) {
      throw new Error(
          `${sourceLabel}: Drive image is in the trash (${file.getName()}).`);
    }

    const mimeType = mykBulkMediaClean_(file.getMimeType()).toLowerCase();
    const size = Number(file.getSize());

    mykBulkMediaValidateImage_(
        mimeType,
        size,
        `${sourceLabel}: ${file.getName()}`);

    const name = mykBulkMediaSafeFilename_(
        file.getName(),
        mimeType);
    const blob = file.getBlob().setName(name);

    return {
      key: `DRIVE:${driveFileId}`,
      originalReference: rawValue,
      name,
      mimeType,
      size,
      blob,
    };
  }

  if (mykBulkMediaLooksLikeDriveReference_(rawValue)) {
    throw new Error(
        `${sourceLabel}: invalid Google Drive image URL (${rawValue}).`);
  }

  if (!/^https?:\/\//i.test(rawValue)) {
    throw new Error(
        `${sourceLabel}: unsupported image reference (${rawValue}).`);
  }

  mykBulkMediaValidateRemoteUrl_(rawValue, sourceLabel);

  let response;

  try {
    response = UrlFetchApp.fetch(rawValue, {
      method: 'get',
      // Reject redirects so a reviewed public URL cannot redirect the worker
      // to a private/local destination after the hostname check above.
      followRedirects: false,
      muteHttpExceptions: true,
    });
  } catch (error) {
    throw new Error(
        `${sourceLabel}: remote image download failed (${rawValue}): ` +
        `${error.message || error}`);
  }

  const status = response.getResponseCode();

  if (status < 200 || status >= 300) {
    throw new Error(
        `${sourceLabel}: remote image returned HTTP ${status} (${rawValue}).`);
  }

  const blob = response.getBlob();
  const bytes = blob.getBytes();
  const mimeType = mykBulkMediaClean_(
      blob.getContentType()).toLowerCase();
  const size = bytes.length;

  mykBulkMediaValidateImage_(
      mimeType,
      size,
      `${sourceLabel}: ${rawValue}`);

  const name = mykBulkMediaFilenameFromUrl_(
      rawValue,
      mimeType);
  blob.setName(name);

  return {
    key: `URL:${rawValue}`,
    originalReference: rawValue,
    name,
    mimeType,
    size,
    blob,
  };
}

function mykBulkMediaValidateImage_(mimeType, size, label) {
  if (mykBulkMediaConfig_.allowedMimeTypes.indexOf(mimeType) === -1) {
    throw new Error(
        `${label} uses unsupported image format ` +
        `${mimeType || '(blank)'}. Use JPEG, PNG, GIF, WEBP, or HEIC.`);
  }

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
        `${label} has an invalid or empty file size.`);
  }

  if (size >= mykBulkMediaConfig_.maxBytes) {
    throw new Error(
        `${label} must be smaller than the 20 MB sync limit.`);
  }
}

/** Rejects obvious local/private URL targets before UrlFetchApp is invoked. */
function mykBulkMediaValidateRemoteUrl_(value, sourceLabel) {
  const match = mykBulkMediaClean_(value).match(
      /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i);

  if (!match) {
    throw new Error(
        `${sourceLabel}: invalid remote image URL (${value}).`);
  }

  const authority = match[1]
      .replace(/^[^@]+@/, '')
      .replace(/:\d+$/, '');
  const hostname = mykBulkMediaClean_(authority)
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
  const isPrivateIpv4 =
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);

  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === 'metadata.google.internal' ||
    hostname.indexOf(':') !== -1 ||
    isPrivateIpv4
  ) {
    throw new Error(
        `${sourceLabel}: private or local image URLs are not allowed.`);
  }
}

/** Creates staged Shopify upload targets and uploads every validated blob. */
function mykBulkMediaStageSources_(accessToken, sources) {
  const mutation = `
    mutation MykBulkStageProductImages($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
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
        input: sources.map((source) => ({
          filename: source.name,
          mimeType: source.mimeType,
          resource: 'PRODUCT_IMAGE',
          httpMethod: 'POST',
        })),
      });
  const result = payload && payload.data && payload.data.stagedUploadsCreate;

  if (!result) {
    throw new Error(
        'Shopify returned no stagedUploadsCreate result.');
  }

  mykBulkMediaThrowUserErrors_(
      result.userErrors,
      'stagedUploadsCreate');

  const targets = Array.isArray(result.stagedTargets)
    ? result.stagedTargets
    : [];

  if (targets.length !== sources.length) {
    throw new Error(
        `Shopify returned ${targets.length} staged target(s) for ` +
        `${sources.length} image(s).`);
  }

  return targets.map((target, index) => {
    const source = sources[index];
    const form = {};

    (target.parameters || []).forEach((parameter) => {
      form[parameter.name] = parameter.value;
    });
    form.file = source.blob;

    const response = UrlFetchApp.fetch(target.url, {
      method: 'post',
      payload: form,
      muteHttpExceptions: true,
    });
    const status = response.getResponseCode();

    if (status < 200 || status >= 300) {
      throw new Error(
          `Shopify staged upload failed for ${source.name} (HTTP ${status}).`);
    }

    if (!mykBulkMediaClean_(target.resourceUrl)) {
      throw new Error(
          `Shopify returned no staged resource URL for ${source.name}.`);
    }

    return {
      key: source.key,
      name: source.name,
      resourceUrl: target.resourceUrl,
    };
  });
}

/**
 * Adds staged images through the supported 2026-07 productUpdate media input.
 * The mutation is additive; no existing media list is supplied or replaced.
 */
function mykBulkMediaAttachStagedSources_(
    accessToken,
    productId,
    stagedSources,
    altText) {
  const mutation = `
    mutation MykBulkAttachProductImages(
      $product: ProductUpdateInput!,
      $media: [CreateMediaInput!]
    ) {
      productUpdate(product: $product, media: $media) {
        product {
          id
          media(first: 250) {
            nodes {
              id
              status
              mediaContentType
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
      {
        product: {id: productId},
        media: stagedSources.map((source) => ({
          originalSource: source.resourceUrl,
          mediaContentType: 'IMAGE',
          alt: altText || source.name,
        })),
      });
  const result = payload && payload.data && payload.data.productUpdate;

  if (!result || !result.product) {
    throw new Error(
        'Shopify returned no productUpdate result while attaching images.');
  }

  mykBulkMediaThrowUserErrors_(
      result.userErrors,
      'productUpdate media');

  const nodes = result.product.media &&
    Array.isArray(result.product.media.nodes)
    ? result.product.media.nodes
    : [];

  return nodes
      .map((media) => ({
        id: mykBulkMediaClean_(media && media.id),
        status: mykBulkMediaClean_(media && media.status).toUpperCase(),
        mediaContentType: mykBulkMediaClean_(
            media && media.mediaContentType).toUpperCase(),
      }))
      .filter((media) => media.id);
}

function mykBulkMediaThrowUserErrors_(errors, operation) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return;
  }

  const messages = errors.map((error) => {
    const field = Array.isArray(error && error.field)
      ? error.field.join('.')
      : mykBulkMediaClean_(error && error.field);
    const message = mykBulkMediaClean_(error && error.message) ||
      'Unknown Shopify error';

    return field ? `${field}: ${message}` : message;
  });

  throw new Error(`${operation} failed: ${messages.join(' | ')}`);
}

function mykBulkMediaRequiredReviewColumn_(indices, heading) {
  const key = mykBulkMediaHeaderKey_(heading);
  const index = indices[key];

  if (index === undefined) {
    throw new Error(
        `Bulk media sync requires review heading: ${heading}.`);
  }

  return index;
}

function mykBulkMediaBuildHeaderIndex_(headers) {
  return (Array.isArray(headers) ? headers : [])
      .reduce((index, header, position) => {
        const key = mykBulkMediaHeaderKey_(header);

        if (key && index[key] === undefined) {
          index[key] = position;
        }

        return index;
      }, {});
}

function mykBulkMediaFindAliasColumn_(indices, aliases) {
  const columns = mykBulkMediaFindAliasColumns_(indices, aliases);
  return columns.length > 0 ? columns[0] : -1;
}

function mykBulkMediaFindAliasColumns_(indices, aliases) {
  const columns = [];

  (Array.isArray(aliases) ? aliases : []).forEach((alias) => {
    const column = indices[mykBulkMediaHeaderKey_(alias)];

    if (column !== undefined && columns.indexOf(column) === -1) {
      columns.push(column);
    }
  });

  return columns;
}

function mykBulkMediaHeaderKey_(value) {
  return mykBulkMediaClean_(value)
      .toLowerCase()
      .replace(/\s+/g, '_');
}

function mykBulkMediaClean_(value) {
  return String(value == null ? '' : value).trim();
}

function mykBulkMediaNormalizeSku_(value) {
  return mykBulkMediaClean_(value)
      .toUpperCase()
      .replace(/\s+/g, '-')
      .replace(/_+/g, '-')
      .replace(/[^A-Z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
}

function mykBulkMediaNormalizeHandle_(value) {
  return mykBulkMediaClean_(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
}

function mykBulkMediaReferenceKey_(reference) {
  const value = mykBulkMediaClean_(reference && reference.value);
  const driveFileId = mykBulkMediaExtractDriveFileId_(value);

  if (driveFileId) {
    return `DRIVE:${driveFileId}`;
  }

  return /^https?:\/\//i.test(value)
    ? `URL:${value}`
    : value;
}

function mykBulkMediaExtractDriveFileId_(value) {
  const text = mykBulkMediaClean_(value);

  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) {
    return text;
  }

  if (!mykBulkMediaLooksLikeDriveReference_(text)) {
    return '';
  }

  const pathMatch = text.match(
      /\/(?:file\/)?d\/([A-Za-z0-9_-]{20,})/i);
  const queryMatch = text.match(
      /[?&]id=([A-Za-z0-9_%.-]{20,})/i);
  const encoded = pathMatch && pathMatch[1] ||
    queryMatch && queryMatch[1] ||
    '';

  if (!encoded) {
    return '';
  }

  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    return encoded;
  }
}

function mykBulkMediaLooksLikeDriveReference_(value) {
  return /^(?:https?:\/\/)?(?:[\w-]+\.)?(?:drive\.google\.com|drive\.usercontent\.google\.com)\//i
      .test(mykBulkMediaClean_(value));
}

function mykBulkMediaSafeFilename_(name, mimeType) {
  const extensionByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
  };
  let safe = mykBulkMediaClean_(name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .substring(0, 180);

  if (!safe) {
    safe = 'source-image';
  }

  if (!/\.[A-Za-z0-9]{2,5}$/.test(safe)) {
    safe += `.${extensionByMime[mimeType] || 'img'}`;
  }

  return safe;
}

function mykBulkMediaFilenameFromUrl_(value, mimeType) {
  let filename = '';
  const pathMatch = mykBulkMediaClean_(value).match(
      /^https?:\/\/[^/?#]+([^?#]*)/i);

  if (pathMatch) {
    const pathParts = pathMatch[1].split('/').filter(Boolean);

    if (pathParts.length > 0) {
      try {
        filename = decodeURIComponent(pathParts[pathParts.length - 1]);
      } catch (error) {
        filename = pathParts[pathParts.length - 1];
      }
    }
  }

  return mykBulkMediaSafeFilename_(filename, mimeType);
}
