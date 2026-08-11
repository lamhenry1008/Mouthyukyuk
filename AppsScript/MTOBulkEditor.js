/**
 * MTO 32 bulk-copy service.
 *
 * Copies reviewed values from product sheets into `MTO 32 Summary`.
 * It never modifies source products, Shopify, or Shopify inventory.
 */
const MTO_BULK_CONFIG = Object.freeze({
  targetSheetName: 'MTO 32 Summary',
  orderSheetName: '訂單紀錄',
  maxSaveRows: 500,
  defaultStock: 0,
  defaultLocations: Object.freeze([
    '大篋',
    '細篋',
  ]),

  targetHeaders: Object.freeze([
    'MTO Item ID',
    'MTO English Name',
    'MTO Chinese Name',
    'MTO Item Option',
    'MTO Item Price',
    'MTO Item Location',
    'MTO Item Stock',
    'MTO Item Left',
    'MTO Item Sold',
    'MTO Image URL',
  ]),

  targetAliases: Object.freeze({
    itemId: Object.freeze([
      'MTO Item ID',
    ]),

    englishName: Object.freeze([
      'MTO English Name',
    ]),

    chineseName: Object.freeze([
      'MTO Chinese Name',
    ]),

    option: Object.freeze([
      'MTO Item Option',
    ]),

    price: Object.freeze([
      'MTO Item Price',
      'MTO Price',
    ]),

    location: Object.freeze([
      'MTO Item Location',
      'MTO Location',
    ]),

    stock: Object.freeze([
      'MTO Item Stock',
      'MTO Stock',
    ]),

    left: Object.freeze([
      'MTO Item Left',
      'MTO Left',
    ]),

    sold: Object.freeze([
      'MTO Item Sold',
      'MTO Sold',
    ]),

    imageUrl: Object.freeze([
      'MTO Image URL',
      'MTO Item Image URL',
    ]),
  }),

  sourceAliases: Object.freeze({
    itemId: Object.freeze([
      'ID',
      'Item ID',
    ]),

    englishName: Object.freeze([
      'English Name',
      'English',
      'Product English Name',
      'Title',
    ]),

    chineseName: Object.freeze([
      'Chinese Name',
      'Chinese',
      '中文名稱',
    ]),

    option: Object.freeze([
      'Option',
      'Variant Option',
      'Item Option',
    ]),

    price: Object.freeze([
      'Price',
      'Variant Price',
      '售價',
    ]),

    sku: Object.freeze([
      'SKU',
      'Variant SKU',
    ]),

    productType: Object.freeze([
      'Product Type',
      'Type',
      '產品類型',
    ]),

    inkSize: Object.freeze([
      'Ink Size',
      'Size',
    ]),

    glitterPotionColor: Object.freeze([
      'Glitter Potion Color',
      'Glitter Color',
    ]),

    glitterPotionSize: Object.freeze([
      'Glitter Potion Size',
      'Glitter Size',
      'Size',
    ]),

    penBaseColor: Object.freeze([
      'Pen Base Color',
    ]),

    penSize: Object.freeze([
      'Pen Size',
    ]),

    imageUrl: Object.freeze([
      'Image URL',
      'Image URLs',
      'Image Src',
      'Image',
    ]),
  }),
});

/**
 * Returns source sheets, saved locations, existing IDs, and editor limits.
 */
function getMtoBulkEditorBootstrap() {
  const spreadsheet = mtoBulkSpreadsheet_();
  const activeSheet = spreadsheet.getActiveSheet();

  const targetSheet = spreadsheet.getSheetByName(
      MTO_BULK_CONFIG.targetSheetName);

  const existingIds =
    targetSheet && targetSheet.getLastColumn() > 0
      ? mtoBulkReadTargetIdsAfterSchemaCheck_(targetSheet)
      : {};

  const sourceSheets = spreadsheet
      .getSheets()
      .filter((sheet) => {
        return mtoBulkIsUsableSourceSheet_(sheet);
      })
      .map((sheet) => {
        return {
          name: sheet.getName(),
          sheetId: sheet.getSheetId(),
          rowCount: Math.max(
              0,
              sheet.getLastRow() - 1),
        };
      })
      .sort((left, right) => {
        return left.name.localeCompare(
            right.name,
            undefined,
            {
              sensitivity: 'base',
            });
      });

  return {
    targetSheetName:
      MTO_BULK_CONFIG.targetSheetName,

    targetHeaders:
      MTO_BULK_CONFIG.targetHeaders.slice(),

    maxRows:
      MTO_BULK_CONFIG.maxSaveRows,

    defaultStock:
      MTO_BULK_CONFIG.defaultStock,

    sourceSheets,

    locations:
      mtoBulkLocationSuggestions_(spreadsheet),

    existingItemIds:
      Object.keys(existingIds),

    defaultSourceSheetName:
      activeSheet &&
      mtoBulkIsUsableSourceSheet_(activeSheet)
        ? activeSheet.getName()
        : '',
  };
}

/**
 * Reads editable MTO candidates from one product sheet.
 */
function getMtoBulkSourceRows(sheetName) {
  const spreadsheet = mtoBulkSpreadsheet_();

  const sheet = spreadsheet.getSheetByName(
      mtoBulkClean_(sheetName));

  if (
    !sheet ||
    !mtoBulkIsUsableSourceSheet_(sheet)
  ) {
    throw new Error(
        `Unsupported MTO bulk source sheet: ` +
        `${sheetName || '(blank)'}.`);
  }

  const data = mtoBulkReadSourceSheet_(sheet);
  const rows = [];

  for (
    let offset = 1;
    offset < data.displays.length;
    offset += 1
  ) {
    const displayRow = data.displays[offset];

    if (
      displayRow.every((value) => {
        return !mtoBulkClean_(value);
      })
    ) {
      continue;
    }

    rows.push(
        mtoBulkBuildCandidate_(
            sheet,
            offset + 1,
            data.values[offset],
            displayRow,
            data.columns));
  }

  return {
    sheetName: sheet.getName(),
    sheetId: sheet.getSheetId(),
    sourceSheetId: sheet.getSheetId(),
    rowCount: rows.length,
    maxRows: MTO_BULK_CONFIG.maxSaveRows,
    rows,
  };
}

/**
 * Validates and writes selected rows to MTO 32 Summary.
 *
 * Expected payload:
 *
 * {
 *   sourceSheetName: '墨水',
 *   sourceSheetId: 123,
 *   rows: [{
 *     sourceRow,
 *     sourceFingerprint,
 *     itemId,
 *     englishName,
 *     chineseName,
 *     option,
 *     price,
 *     location,
 *     stock,
 *     imageUrl
 *   }]
 * }
 */
function saveMtoBulkRows(payload) {
  const request = payload || {};

  const submittedRows =
    Array.isArray(request.rows)
      ? request.rows
      : [];

  if (submittedRows.length < 1) {
    throw new Error(
        'Select at least one source row to copy.');
  }

  if (
    submittedRows.length >
    MTO_BULK_CONFIG.maxSaveRows
  ) {
    throw new Error(
        `A maximum of ` +
        `${MTO_BULK_CONFIG.maxSaveRows} rows ` +
        'can be copied in one batch.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = mtoBulkSpreadsheet_();

    const sourceSheetName =
      mtoBulkClean_(
          request.sourceSheetName);

    const sourceSheet =
      spreadsheet.getSheetByName(
          sourceSheetName);

    if (
      !sourceSheet ||
      !mtoBulkIsUsableSourceSheet_(sourceSheet)
    ) {
      throw new Error(
          `Unsupported MTO bulk source sheet: ` +
          `${sourceSheetName || '(blank)'}.`);
    }

    const expectedSheetId =
      Number(request.sourceSheetId);

    if (
      !Number.isInteger(expectedSheetId) ||
      expectedSheetId !==
        sourceSheet.getSheetId()
    ) {
      throw new Error(
          'The selected source sheet changed. ' +
          'Reload the bulk editor.');
    }

    const sourceData =
      mtoBulkReadSourceSheet_(sourceSheet);

    const normalizedRows = [];
    const validationErrors = [];
    const rowErrors = [];
    const batchIds = {};
    const batchSourceRows = {};

    const addRowError = (
        selectedIndex,
        submitted,
        message,
        sourceRowValue) => {
      const sourceRow =
        Number(sourceRowValue);

      const itemId =
        mtoBulkClean_(
            submitted &&
            submitted.itemId);

      validationErrors.push(
          `Selected row ${selectedIndex + 1}: ` +
          message);

      rowErrors.push({
        selectedIndex: selectedIndex + 1,

        sourceRow:
          Number.isInteger(sourceRow) &&
          sourceRow >= 2
            ? sourceRow
            : '',

        itemId,
        message,
      });
    };

    submittedRows.forEach(
        (submitted, index) => {
          const sourceRow =
            Number(
                submitted &&
                submitted.sourceRow);

          if (
            !Number.isInteger(sourceRow) ||
            sourceRow < 2 ||
            sourceRow >
              sourceData.values.length
          ) {
            addRowError(
                index,
                submitted,
                'Invalid source row.',
                sourceRow);

            return;
          }

          if (batchSourceRows[sourceRow]) {
            addRowError(
                index,
                submitted,
                `Source row ${sourceRow} ` +
                'was selected more than once.',
                sourceRow);

            return;
          }

          batchSourceRows[sourceRow] = true;

          const currentCandidate =
            mtoBulkBuildCandidate_(
                sourceSheet,
                sourceRow,
                sourceData.values[
                    sourceRow - 1],
                sourceData.displays[
                    sourceRow - 1],
                sourceData.columns);

          const submittedFingerprint =
            mtoBulkClean_(
                submitted.sourceFingerprint);

          if (
            !submittedFingerprint ||
            submittedFingerprint !==
              currentCandidate
                  .sourceFingerprint
          ) {
            addRowError(
                index,
                submitted,
                `Source row ${sourceRow} ` +
                'changed. Reload it first.',
                sourceRow);

            return;
          }

          const normalized =
            mtoBulkNormalizeSubmittedRow_(
                submitted,
                sourceRow);

          const submittedErrors =
            mtoBulkValidateSubmittedRow_(
                normalized);

          submittedErrors.forEach(
              (error) => {
                addRowError(
                    index,
                    submitted,
                    error,
                    sourceRow);
              });

          const itemKey =
            normalized.itemId
                .toUpperCase();

          if (itemKey) {
            if (batchIds[itemKey]) {
              addRowError(
                  index,
                  submitted,
                  `Duplicate MTO Item ID ` +
                  `${normalized.itemId} ` +
                  'in this batch.',
                  sourceRow);
            } else {
              batchIds[itemKey] = true;
            }
          }

          normalized.selectedIndex = index;
          normalizedRows.push(normalized);
        });

    let targetSheet =
      spreadsheet.getSheetByName(
          MTO_BULK_CONFIG.targetSheetName);

    const targetNeedsHeaders =
      Boolean(
          targetSheet &&
          targetSheet.getLastColumn() === 0);

    if (
      targetSheet &&
      !targetNeedsHeaders
    ) {
      mtoBulkValidateTargetSchema_(
          targetSheet);
    }

    const existingIds =
      targetSheet &&
      !targetNeedsHeaders
        ? mtoBulkReadTargetIds_(
            targetSheet)
        : {};

    normalizedRows.forEach(
        (row, index) => {
          if (
            row.itemId &&
            existingIds[
                row.itemId.toUpperCase()]
          ) {
            addRowError(
                Number.isInteger(
                    row.selectedIndex)
                  ? row.selectedIndex
                  : index,
                row,
                `MTO Item ID ${row.itemId} ` +
                'already exists in ' +
                'MTO 32 Summary.',
                row.sourceRow);
          }
        });

    if (validationErrors.length > 0) {
      return {
        ok: false,

        message:
          'Nothing was copied. ' +
          'Fix these problems:\n' +
          validationErrors
              .slice(0, 25)
              .join('\n') +
          (
            validationErrors.length > 25
              ? `\n…and ` +
                `${validationErrors.length - 25} ` +
                'more.'
              : ''
          ),

        rowErrors,
      };
    }

    const returnedLocations =
      mtoBulkUniqueLocations_([
        ...mtoBulkLocationSuggestions_(
            spreadsheet),

        ...normalizedRows.map(
            (row) => row.location),
      ]);

    /*
     * Check the Advanced Sheets service before
     * creating or modifying the target sheet.
     */
    mtoBulkRequireSheetsService_();

    let createdTargetSheet = false;

    try {
      if (!targetSheet) {
        targetSheet =
          spreadsheet.insertSheet(
              MTO_BULK_CONFIG
                  .targetSheetName);

        createdTargetSheet = true;
      }

      const initializeHeaders =
        targetNeedsHeaders ||
        targetSheet.getLastColumn() === 0;

      const targetSchema =
        initializeHeaders
          ? mtoBulkCanonicalTargetSchema_()
          : mtoBulkValidateTargetSchema_(
              targetSheet);

      const startRow =
        initializeHeaders
          ? 2
          : Math.max(
              2,
              mtoBulkLastTargetDataRow_(
                  targetSheet,
                  targetSchema) + 1);

      mtoBulkWriteTargetRows_(
          spreadsheet,
          targetSheet,
          startRow,
          normalizedRows,
          targetSchema,
          initializeHeaders);

      return {
        ok: true,

        createdCount:
          normalizedRows.length,

        targetSheetName:
          targetSheet.getName(),

        targetRows:
          normalizedRows.map(
              (row, index) => {
                return {
                  row: startRow + index,
                  itemId: row.itemId,
                };
              }),

        locations:
          returnedLocations,
      };
    } catch (error) {
      /*
       * The actual write is atomic.
       * Remove a newly created empty target
       * when setup or writing fails.
       */
      if (
        createdTargetSheet &&
        targetSheet
      ) {
        spreadsheet.deleteSheet(
            targetSheet);
      }

      throw error;
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the active spreadsheet.
 */
function mtoBulkSpreadsheet_() {
  const spreadsheet =
    SpreadsheetApp
        .getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
        'Unable to access the active spreadsheet.');
  }

  return spreadsheet;
}

/**
 * Determines whether a sheet is a valid product source.
 */
function mtoBulkIsUsableSourceSheet_(sheet) {
  if (
    !sheet ||
    sheet.getLastColumn() < 1
  ) {
    return false;
  }

  const name =
    mtoBulkClean_(sheet.getName());

  if (
    !name ||
    name ===
      MTO_BULK_CONFIG.targetSheetName ||
    name ===
      MTO_BULK_CONFIG.orderSheetName ||
    name.indexOf('__MYK_REVIEW_') === 0 ||
    /^shopify\s/i.test(name) ||
    /(?:review|preview|import)/i
        .test(name)
  ) {
    return false;
  }

  const headers = sheet
      .getRange(
          1,
          1,
          1,
          sheet.getLastColumn())
      .getDisplayValues()[0];

  const index =
    mtoBulkHeaderIndex_(headers);

  const aliases =
    MTO_BULK_CONFIG.sourceAliases;

  return (
    mtoBulkHasAlias_(
        index,
        aliases.englishName) &&
    mtoBulkHasAlias_(
        index,
        aliases.price) &&
    (
      mtoBulkHasAlias_(
          index,
          aliases.itemId) ||
      mtoBulkHasAlias_(
          index,
          aliases.sku)
    )
  );
}

/**
 * Reads source values and display values.
 */
function mtoBulkReadSourceSheet_(sheet) {
  const lastRow =
    Math.max(
        1,
        sheet.getLastRow());

  const lastColumn =
    sheet.getLastColumn();

  const range =
    sheet.getRange(
        1,
        1,
        lastRow,
        lastColumn);

  const values =
    range.getValues();

  const displays =
    range.getDisplayValues();

  return {
    values,
    displays,

    columns:
      mtoBulkResolveSourceColumns_(
          mtoBulkHeaderIndex_(
              displays[0])),
  };
}

/**
 * Resolves all source aliases to zero-based columns.
 */
function mtoBulkResolveSourceColumns_(index) {
  const result = {};

  Object.keys(
      MTO_BULK_CONFIG.sourceAliases)
      .forEach((field) => {
        result[field] =
          mtoBulkAliasColumns_(
              index,
              MTO_BULK_CONFIG
                  .sourceAliases[field]);
      });

  return result;
}

/**
 * Converts a source row into an editable MTO candidate.
 */
function mtoBulkBuildCandidate_(
    sheet,
    sourceRow,
    rawRow,
    displayRow,
    columns) {
  const sourceId =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.itemId);

  const sku =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.sku);

  const productType =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.productType) ||
    mtoBulkProfileItemType_(
        sheet.getName());

  const itemId =
    sourceId ||
    mtoBulkBuildItemId_(
        sheet.getName(),
        productType,
        sku);

  const englishName =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.englishName);

  const chineseName =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.chineseName);

  const option =
    mtoBulkOption_(
        sheet.getName(),
        rawRow,
        displayRow,
        columns);

  const priceValue =
    mtoBulkReadValue_(
        rawRow,
        displayRow,
        columns.price);

  const price =
    mtoBulkMoney_(
        priceValue.value);

  /*
   * Event stock always starts at zero.
   * The cashier must explicitly allocate stock.
   */
  const stock =
    MTO_BULK_CONFIG.defaultStock;

  const imageValue =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.imageUrl);

  const imageUrl =
    mtoBulkFirstImageUrl_(
        imageValue);

  const errors = [];
  const warnings = [];

  if (!itemId) {
    errors.push(
        'Missing Item ID and unable to derive ' +
        'one from Product Type + SKU.');
  }

  if (!englishName) {
    errors.push(
        'Missing English Name.');
  }

  if (!chineseName) {
    errors.push(
        'Missing Chinese Name.');
  }

  if (
    !Number.isFinite(price) ||
    price < 0
  ) {
    errors.push(
        'Missing or invalid Price.');
  }

  if (!imageUrl) {
    warnings.push(
        'Missing image URL. ' +
        'You may still copy this item.');
  }

  const fingerprintValues = [
    sheet.getSheetId(),
    sourceRow,
    itemId,
    englishName,
    chineseName,
    option,

    Number.isFinite(price)
      ? price
      : String(
          priceValue.display || ''),

    stock,
    imageUrl,
  ];

  return {
    sourceSheetName:
      sheet.getName(),

    sourceSheetId:
      sheet.getSheetId(),

    sourceRow,

    sourceFingerprint:
      mtoBulkFingerprint_(
          fingerprintValues),

    itemId,
    englishName,
    chineseName,
    option,

    price:
      Number.isFinite(price)
        ? price
        : '',

    stock,
    imageUrl,

    // Blank means the UI displays
    // “Choose from...”.
    location: '',

    warnings,
    errors,
    valid: errors.length === 0,
  };
}

/**
 * Returns the sheet-specific MTO option.
 *
 * Explicit Option always takes priority.
 */
function mtoBulkOption_(
    sheetName,
    rawRow,
    displayRow,
    columns) {
  const direct =
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.option);

  if (direct) {
    return direct;
  }

  const sourceSheetName =
    mtoBulkClean_(sheetName);

  if (sourceSheetName === '閃粉') {
    return [
      mtoBulkReadText_(
          rawRow,
          displayRow,
          columns.glitterPotionColor),

      mtoBulkReadText_(
          rawRow,
          displayRow,
          columns.glitterPotionSize),
    ]
        .filter(Boolean)
        .join(' / ');
  }

  if (
    sourceSheetName === '鋼筆' ||
    sourceSheetName === '原子筆/鉛筆'
  ) {
    return [
      mtoBulkReadText_(
          rawRow,
          displayRow,
          columns.penBaseColor),

      mtoBulkReadText_(
          rawRow,
          displayRow,
          columns.penSize),
    ]
        .filter(Boolean)
        .join(' / ');
  }

  if (sourceSheetName === '墨水') {
    return mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.inkSize);
  }

  return '';
}

/**
 * Normalizes a submitted editor row.
 */
function mtoBulkNormalizeSubmittedRow_(
    submitted,
    sourceRow) {
  const row = submitted || {};

  return {
    sourceRow,

    itemId:
      mtoBulkClean_(row.itemId),

    englishName:
      mtoBulkClean_(row.englishName),

    chineseName:
      mtoBulkClean_(row.chineseName),

    option:
      mtoBulkClean_(row.option),

    price:
      mtoBulkMoney_(row.price),

    location:
      mtoBulkClean_(row.location),

    stock:
      mtoBulkWholeNumber_(row.stock),

    imageUrl:
      mtoBulkFirstImageUrl_(
          row.imageUrl),
  };
}

/**
 * Validates a row before any target write.
 */
function mtoBulkValidateSubmittedRow_(row) {
  const errors = [];

  if (!row.itemId) {
    errors.push(
        'MTO Item ID is required.');
  }

  if (!row.englishName) {
    errors.push(
        'English Name is required.');
  }

  if (!row.chineseName) {
    errors.push(
        'Chinese Name is required.');
  }

  if (
    !Number.isFinite(row.price) ||
    row.price < 0
  ) {
    errors.push(
        'Price must be zero or a positive number.');
  }

  if (
    mtoBulkIsUnsetLocation_(
        row.location)
  ) {
    errors.push(
        'MTO Item Location is required.');
  }

  if (
    !Number.isInteger(row.stock) ||
    row.stock < 0
  ) {
    errors.push(
        'Stock must be a non-negative whole number.');
  }

  [
    ['MTO Item ID', row.itemId],
    ['English Name', row.englishName],
    ['Chinese Name', row.chineseName],
    ['Option', row.option],
    ['Location', row.location],
  ].forEach((entry) => {
    if (
      mtoBulkLooksLikeFormula_(
          entry[1])
    ) {
      errors.push(
          `${entry[0]} cannot begin with ` +
          '=, +, -, or @.');
    }
  });

  return errors;
}

/**
 * Blocks spreadsheet formula injection.
 */
function mtoBulkLooksLikeFormula_(value) {
  return /^[=+\-@]/.test(
      mtoBulkClean_(value));
}

/**
 * Requires the Advanced Google Sheets service.
 */
function mtoBulkRequireSheetsService_() {
  if (
    typeof Sheets === 'undefined' ||
    !Sheets.Spreadsheets ||
    typeof Sheets.Spreadsheets
        .batchUpdate !== 'function'
  ) {
    throw new Error(
        'The Advanced Google Sheets service ' +
        'is required for safe MTO bulk writes. ' +
        'Enable Sheets API v4 in Apps Script Services.');
  }
}

/**
 * Finds the last occupied row using only MTO fields.
 *
 * Extra helper columns and formulas do not affect
 * the next MTO append row.
 */
function mtoBulkLastTargetDataRow_(
    sheet,
    schema) {
  const lastSheetRow =
    sheet.getLastRow();

  if (lastSheetRow < 2) {
    return 1;
  }

  let lastTargetRow = 1;

  const uniqueColumns =
    Array.from(
        new Set(
            Object.keys(schema.columns)
                .map((field) => {
                  return schema.columns[field];
                })));

  uniqueColumns.forEach((column) => {
    const range =
      sheet.getRange(
          2,
          column,
          lastSheetRow - 1,
          1);

    const displays =
      range.getDisplayValues();

    const formulas =
      range.getFormulas();

    for (
      let offset = displays.length - 1;
      offset >= 0;
      offset -= 1
    ) {
      if (
        mtoBulkClean_(
            displays[offset][0]) ||
        mtoBulkClean_(
            formulas[offset][0])
      ) {
        lastTargetRow =
          Math.max(
              lastTargetRow,
              offset + 2);

        break;
      }
    }
  });

  return lastTargetRow;
}

/**
 * Writes the resolved MTO columns in one atomic
 * Advanced Sheets API request.
 *
 * Extra target columns and formulas are untouched.
 */
function mtoBulkWriteTargetRows_(
    spreadsheet,
    sheet,
    startRow,
    rows,
    schema,
    initializeHeaders) {
  if (!rows.length) {
    return;
  }

  mtoBulkRequireSheetsService_();

  const requiredLastRow =
    startRow + rows.length - 1;

  const fieldValues = {
    itemId:
      rows.map((row) => row.itemId),

    englishName:
      rows.map((row) => row.englishName),

    chineseName:
      rows.map((row) => row.chineseName),

    option:
      rows.map((row) => row.option),

    price:
      rows.map((row) => row.price),

    location:
      rows.map((row) => row.location),

    stock:
      rows.map((row) => row.stock),

    left:
      rows.map((row) => row.stock),

    sold:
      rows.map(() => 0),

    imageUrl:
      rows.map((row) => row.imageUrl),
  };

  const requests = [];

  if (
    requiredLastRow >
    sheet.getMaxRows()
  ) {
    requests.push({
      appendDimension: {
        sheetId:
          sheet.getSheetId(),

        dimension: 'ROWS',

        length:
          requiredLastRow -
          sheet.getMaxRows(),
      },
    });
  }

  if (initializeHeaders) {
    requests.push({
      updateCells: {
        range: {
          sheetId:
            sheet.getSheetId(),

          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,

          endColumnIndex:
            MTO_BULK_CONFIG
                .targetHeaders.length,
        },

        rows: [{
          values:
            MTO_BULK_CONFIG
                .targetHeaders
                .map((header) => {
                  return {
                    userEnteredValue: {
                      stringValue: header,
                    },

                    userEnteredFormat: {
                      textFormat: {
                        bold: true,
                      },
                    },
                  };
                }),
        }],

        fields:
          'userEnteredValue,' +
          'userEnteredFormat.textFormat.bold',
      },
    });

    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId:
            sheet.getSheetId(),

          gridProperties: {
            frozenRowCount: 1,
          },
        },

        fields:
          'gridProperties.frozenRowCount',
      },
    });
  }

  Object.keys(fieldValues)
      .forEach((field) => {
        const columnIndex =
          schema.columns[field] - 1;

        requests.push({
          updateCells: {
            range: {
              sheetId:
                sheet.getSheetId(),

              startRowIndex:
                startRow - 1,

              endRowIndex:
                requiredLastRow,

              startColumnIndex:
                columnIndex,

              endColumnIndex:
                columnIndex + 1,
            },

            rows:
              fieldValues[field]
                  .map((value) => {
                    return {
                      values: [{
                        userEnteredValue:
                          mtoBulkExtendedValue_(
                              value),
                      }],
                    };
                  }),

            fields:
              'userEnteredValue',
          },
        });
      });

  Sheets.Spreadsheets.batchUpdate(
      {
        requests,
      },
      spreadsheet.getId());
}

/**
 * Converts a value to an Advanced Sheets cell value.
 */
function mtoBulkExtendedValue_(value) {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return {
      numberValue: value,
    };
  }

  if (typeof value === 'boolean') {
    return {
      boolValue: value,
    };
  }

  return {
    stringValue:
      String(
          value == null
            ? ''
            : value),
  };
}

/**
 * Returns the canonical A:J schema for a new sheet.
 */
function mtoBulkCanonicalTargetSchema_() {
  const fields =
    Object.keys(
        MTO_BULK_CONFIG.targetAliases);

  const columns = {};

  fields.forEach((field, index) => {
    columns[field] = index + 1;
  });

  return {
    columns,

    headers:
      MTO_BULK_CONFIG
          .targetHeaders
          .slice(),

    lastColumn:
      MTO_BULK_CONFIG
          .targetHeaders
          .length,
  };
}

/**
 * Resolves the required target columns.
 *
 * Required columns can be in any order.
 * Additional columns are allowed.
 */
function mtoBulkValidateTargetSchema_(sheet) {
  const lastColumn =
    sheet.getLastColumn();

  if (lastColumn === 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} ` +
        'exists but has no headers.');
  }

  const headers = sheet
      .getRange(
          1,
          1,
          1,
          lastColumn)
      .getDisplayValues()[0]
      .map(mtoBulkClean_);

  const headerIndex =
    mtoBulkHeaderIndex_(headers);

  const columns = {};
  const missingHeaders = [];
  const ambiguousHeaders = [];

  Object.keys(
      MTO_BULK_CONFIG.targetAliases)
      .forEach((field) => {
        const aliases =
          MTO_BULK_CONFIG
              .targetAliases[field];

        const matches =
          mtoBulkAliasColumns_(
              headerIndex,
              aliases);

        if (matches.length === 0) {
          missingHeaders.push(
              aliases[0]);

          return;
        }

        if (matches.length > 1) {
          ambiguousHeaders.push(
              `${aliases[0]} (` +
              matches
                  .map((position) => {
                    return headers[position];
                  })
                  .join(', ') +
              ')');

          return;
        }

        // Spreadsheet columns are one-based.
        columns[field] =
          matches[0] + 1;
      });

  if (missingHeaders.length > 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} ` +
        'is missing required column(s): ' +
        `${missingHeaders.join(' | ')}. ` +
        'Columns may be in any order, and ' +
        'additional columns are allowed.');
  }

  if (ambiguousHeaders.length > 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} ` +
        'has duplicate or ambiguous columns: ' +
        `${ambiguousHeaders.join(' | ')}. ` +
        'Keep only one heading for each MTO field.');
  }

  return {
    columns,
    headers,
    lastColumn,
  };
}

/**
 * Reads existing MTO IDs case-insensitively.
 */
function mtoBulkReadTargetIds_(
    sheet,
    schema) {
  const ids = {};

  const lastRow =
    sheet.getLastRow();

  if (lastRow < 2) {
    return ids;
  }

  const targetSchema =
    schema ||
    mtoBulkValidateTargetSchema_(sheet);

  sheet
      .getRange(
          2,
          targetSchema.columns.itemId,
          lastRow - 1,
          1)
      .getDisplayValues()
      .forEach((row, offset) => {
        const id =
          mtoBulkClean_(row[0]);

        if (!id) {
          return;
        }

        const key =
          id.toUpperCase();

        if (ids[key]) {
          throw new Error(
              'Duplicate MTO Item ID already ' +
              'exists in ' +
              `${MTO_BULK_CONFIG.targetSheetName}: ` +
              `${id}.`);
        }

        ids[key] = offset + 2;
      });

  return ids;
}

/**
 * Validates target schema before reading IDs.
 */
function mtoBulkReadTargetIdsAfterSchemaCheck_(
    sheet) {
  const schema =
    mtoBulkValidateTargetSchema_(sheet);

  return mtoBulkReadTargetIds_(
      sheet,
      schema);
}

/**
 * Returns default and previously used locations.
 */
function mtoBulkLocationSuggestions_(
    spreadsheet) {
  const result = [];
  const seen = {};

  const add = (value) => {
    const location =
      mtoBulkClean_(value);

    const key =
      location.toUpperCase();

    if (
      mtoBulkIsUnsetLocation_(location) ||
      seen[key]
    ) {
      return;
    }

    seen[key] = true;
    result.push(location);
  };

  MTO_BULK_CONFIG
      .defaultLocations
      .forEach(add);

  const sheet =
    spreadsheet.getSheetByName(
        MTO_BULK_CONFIG.targetSheetName);

  if (
    !sheet ||
    sheet.getLastRow() < 2 ||
    sheet.getLastColumn() < 1
  ) {
    return result;
  }

  const schema =
    mtoBulkValidateTargetSchema_(sheet);

  const locationColumn =
    schema.columns.location;

  sheet
      .getRange(
          2,
          locationColumn,
          sheet.getLastRow() - 1,
          1)
      .getDisplayValues()
      .forEach((row) => {
        add(row[0]);
      });

  return result;
}

/**
 * Deduplicates location suggestions.
 */
function mtoBulkUniqueLocations_(values) {
  const result = [];
  const seen = {};

  (values || []).forEach((value) => {
    const location =
      mtoBulkClean_(value);

    const key =
      location.toUpperCase();

    if (
      mtoBulkIsUnsetLocation_(location) ||
      seen[key]
    ) {
      return;
    }

    seen[key] = true;
    result.push(location);
  });

  return result;
}

/**
 * Blank or “Choose from...” is not a real location.
 */
function mtoBulkIsUnsetLocation_(value) {
  const location =
    mtoBulkClean_(value);

  return (
    !location ||
    location.toLowerCase() ===
      'choose from...'
  );
}

/**
 * Builds a normalized header index.
 */
function mtoBulkHeaderIndex_(headers) {
  const index = {};

  (headers || [])
      .forEach((header, position) => {
        const key =
          mtoBulkHeaderKey_(header);

        if (!key) {
          return;
        }

        if (!index[key]) {
          index[key] = [];
        }

        index[key].push(position);
      });

  return index;
}

/**
 * Converts a header to a comparison key.
 */
function mtoBulkHeaderKey_(value) {
  return mtoBulkClean_(value)
      .toLowerCase()
      .replace(/\s+/g, '_');
}

/**
 * Returns true when an alias exists.
 */
function mtoBulkHasAlias_(index, aliases) {
  return (
    mtoBulkAliasColumns_(
        index,
        aliases).length > 0
  );
}

/**
 * Finds all unique matching alias columns.
 */
function mtoBulkAliasColumns_(index, aliases) {
  const columns = [];
  const seen = {};

  (aliases || []).forEach((alias) => {
    const key =
      mtoBulkHeaderKey_(alias);

    const matching =
      index[key] || [];

    matching.forEach((column) => {
      if (!seen[column]) {
        seen[column] = true;
        columns.push(column);
      }
    });
  });

  return columns;
}

/**
 * Reads the first non-empty matching source value.
 */
function mtoBulkReadValue_(
    rawRow,
    displayRow,
    columns) {
  for (
    let offset = 0;
    offset < (columns || []).length;
    offset += 1
  ) {
    const column =
      columns[offset];

    const display =
      mtoBulkClean_(
          displayRow[column]);

    if (display !== '') {
      return {
        present: true,
        value: rawRow[column],
        display,
        column,
      };
    }
  }

  return {
    present: false,
    value: '',
    display: '',
    column: -1,
  };
}

/**
 * Reads one source value as displayed text.
 */
function mtoBulkReadText_(
    rawRow,
    displayRow,
    columns) {
  return mtoBulkReadValue_(
      rawRow,
      displayRow,
      columns).display;
}

/**
 * Returns a configured item type where available.
 */
function mtoBulkProfileItemType_(sheetName) {
  if (
    typeof MYK_SHEET_PROFILES !==
      'undefined' &&
    MYK_SHEET_PROFILES[
        mtoBulkClean_(sheetName)]
  ) {
    return mtoBulkClean_(
        MYK_SHEET_PROFILES[
            mtoBulkClean_(sheetName)]
            .itemType);
  }

  return '';
}

/**
 * Builds a sheet-specific Item ID.
 */
function mtoBulkBuildItemId_(
    sheetName,
    productType,
    sku) {
  const sourceSheetName =
    mtoBulkClean_(sheetName);

  const effectiveType =
    sourceSheetName === '閃粉'
      ? 'GP'
      : (
        sourceSheetName === '墨水'
          ? 'INK'
          : (
            sourceSheetName === '鋼筆' ||
            sourceSheetName === '原子筆/鉛筆'
              ? 'PEN'
              : productType
          )
      );

  if (
    typeof buildEditorItemIdForSheet_ ===
      'function'
  ) {
    return mtoBulkClean_(
        buildEditorItemIdForSheet_(
            sheetName,
            productType,
            sku));
  }

  if (
    typeof buildEditorItemId_ ===
      'function'
  ) {
    return mtoBulkClean_(
        buildEditorItemId_(
            effectiveType,
            sku));
  }

  const type =
    mtoBulkClean_(effectiveType)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

  const normalizedSku =
    mtoBulkClean_(sku)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

  return (
    type &&
    normalizedSku
  )
    ? `${type}-${normalizedSku}`
    : '';
}

/**
 * Parses a monetary value.
 *
 * Supported examples:
 * 195
 * $195
 * HK$195
 * HKD 195
 * HK$1,095.50
 */
function mtoBulkMoney_(value) {
  const text =
    String(
        value == null
          ? ''
          : value)
        .replace(/HKD/gi, '')
        .replace(/HK\$/gi, '')
        .replace(/[,$\s]/g, '');

  if (text === '') {
    return NaN;
  }

  const number =
    Number(text);

  return Number.isFinite(number)
    ? Math.round(
        (number + Number.EPSILON) *
        100) / 100
    : NaN;
}

/**
 * Parses non-negative whole-number stock.
 */
function mtoBulkWholeNumber_(value) {
  const text =
    mtoBulkClean_(value)
        .replace(/,/g, '');

  const number =
    Number(text);

  return (
    text !== '' &&
    Number.isInteger(number) &&
    number >= 0
  )
    ? number
    : NaN;
}

/**
 * Returns the first valid image URL.
 */
function mtoBulkFirstImageUrl_(value) {
  const first =
    mtoBulkClean_(value)
        .split(/[\r\n;|]+/)
        .map(mtoBulkClean_)
        .filter(Boolean)[0] || '';

  if (
    !/^https?:\/\/[^\s]+$/i
        .test(first)
  ) {
    return '';
  }

  return mtoBulkNormalizeImageUrl_(
      first);
}

/**
 * Converts Google Drive share URLs to direct URLs.
 */
function mtoBulkNormalizeImageUrl_(value) {
  const url =
    mtoBulkClean_(value);

  if (
    !url ||
    !/^https?:\/\//i.test(url)
  ) {
    return url;
  }

  if (
    !/^https?:\/\/(?:www\.)?drive\.google\.com\//i
        .test(url)
  ) {
    return url;
  }

  const pathMatch =
    url.match(
        /\/file\/d\/([^/?#]+)/i);

  const queryMatch =
    url.match(
        /[?&]id=([^&#]+)/i);

  const encodedId =
    (
      pathMatch &&
      pathMatch[1]
    ) ||
    (
      queryMatch &&
      queryMatch[1]
    ) ||
    '';

  if (!encodedId) {
    return url;
  }

  let fileId = encodedId;

  try {
    fileId =
      decodeURIComponent(encodedId);
  } catch (error) {
    /*
     * Keep the original encoded ID when
     * an old URL is malformed.
     */
  }

  return (
    'https://drive.google.com/uc?id=' +
    encodeURIComponent(fileId)
  );
}

/**
 * Builds a source-row fingerprint.
 */
function mtoBulkFingerprint_(values) {
  const bytes =
    Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        JSON.stringify(values),
        Utilities.Charset.UTF_8);

  return bytes
      .map((byte) => {
        const unsigned =
          byte < 0
            ? byte + 256
            : byte;

        return (
          `0${unsigned.toString(16)}`
        ).slice(-2);
      })
      .join('');
}

/**
 * Converts a value to trimmed text.
 */
function mtoBulkClean_(value) {
  return String(
      value == null
        ? ''
        : value
  ).trim();
}