/**
 * MTO 32 bulk-copy service.
 *
 * This module copies reviewed values from an existing product sheet into
 * `MTO 32 Summary`. It deliberately contains no Shopify API calls and never
 * changes the source sheet, Shopify inventory, or the normal product ledger.
 */
const MTO_BULK_CONFIG = Object.freeze({
  targetSheetName: 'MTO 32 Summary',
  orderSheetName: '訂單紀錄',
  maxSaveRows: 500,
  defaultLocations: Object.freeze(['大篋', '細篋']),
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
    itemId: Object.freeze(['MTO Item ID']),
    englishName: Object.freeze([
      'MTO English Name',
      'English Name',
    ]),
    chineseName: Object.freeze([
      'MTO Chinese Name',
      'Chinese Name',
    ]),
    option: Object.freeze([
      'MTO Item Option',
      'Option',
    ]),
    price: Object.freeze([
      'MTO Item Price',
      'MTO Price',
      'Price',
    ]),
    location: Object.freeze([
      'MTO Item Location',
      'MTO Location',
      'Location',
    ]),
    stock: Object.freeze([
      'MTO Item Stock',
      'MTO Stock',
      'Stock',
    ]),
    left: Object.freeze([
      'MTO Item Left',
      'MTO Left',
      'Left',
    ]),
    sold: Object.freeze([
      'MTO Item Sold',
      'MTO Sold',
      'Sold',
    ]),
    imageUrl: Object.freeze([
      'MTO Image URL',
      'MTO Item Image URL',
      'Image URL',
    ]),
  }),
  sourceAliases: Object.freeze({
    itemId: Object.freeze(['ID', 'Item ID']),
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
    sku: Object.freeze(['SKU', 'Variant SKU']),
    productType: Object.freeze([
      'Product Type',
      'Type',
      '產品類型',
    ]),
    inventory: Object.freeze(['Inventory', '庫存']),
    stock: Object.freeze(['Stock', '存貨']),
    purchased: Object.freeze(['Purchased', '入貨']),
    sold: Object.freeze(['Sold', '已售']),
    inkSize: Object.freeze(['Ink Size', 'Size']),
    glitterPotionColor: Object.freeze([
      'Glitter Potion Color',
      'Glitter Color',
    ]),
    glitterPotionSize: Object.freeze([
      'Glitter Potion Size',
      'Glitter Size',
      'Size',
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
 * Returns source-sheet choices, location suggestions, and UI limits.
 */
function getMtoBulkEditorBootstrap() {
  const spreadsheet = mtoBulkSpreadsheet_();
  const activeSheet = spreadsheet.getActiveSheet();
  const targetSheet = spreadsheet.getSheetByName(
      MTO_BULK_CONFIG.targetSheetName);
  const existingIds = targetSheet && targetSheet.getLastColumn() > 0
    ? mtoBulkReadTargetIdsAfterSchemaCheck_(targetSheet)
    : {};
  const sourceSheets = spreadsheet.getSheets()
      .filter((sheet) => mtoBulkIsUsableSourceSheet_(sheet))
      .map((sheet) => ({
        name: sheet.getName(),
        sheetId: sheet.getSheetId(),
        rowCount: Math.max(0, sheet.getLastRow() - 1),
      }))
      .sort((left, right) => {
        return left.name.localeCompare(
            right.name,
            undefined,
            {sensitivity: 'base'});
      });

  return {
    targetSheetName: MTO_BULK_CONFIG.targetSheetName,
    targetHeaders: MTO_BULK_CONFIG.targetHeaders.slice(),
    maxRows: MTO_BULK_CONFIG.maxSaveRows,
    sourceSheets,
    locations: mtoBulkLocationSuggestions_(spreadsheet),
    existingItemIds: Object.keys(existingIds),
    defaultSourceSheetName:
      activeSheet && mtoBulkIsUsableSourceSheet_(activeSheet)
        ? activeSheet.getName()
        : '',
  };
}

/**
 * Reads every non-empty row from one eligible product sheet.
 *
 * Returned values are editable candidates. `sourceFingerprint` represents
 * only the source values used by this mapping and is verified again on save.
 */
function getMtoBulkSourceRows(sheetName) {
  const spreadsheet = mtoBulkSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(mtoBulkClean_(sheetName));

  if (!sheet || !mtoBulkIsUsableSourceSheet_(sheet)) {
    throw new Error(
        `Unsupported MTO bulk source sheet: ${sheetName || '(blank)'}.`);
  }

  const data = mtoBulkReadSourceSheet_(sheet);
  const rows = [];

  for (let offset = 1; offset < data.displays.length; offset += 1) {
    if (data.displays[offset].every((value) => !mtoBulkClean_(value))) {
      continue;
    }

    rows.push(mtoBulkBuildCandidate_(
        sheet,
        offset + 1,
        data.values[offset],
        data.displays[offset],
        data.columns));
  }

  return {
    sheetName: sheet.getName(),
    sheetId: sheet.getSheetId(),
    rowCount: rows.length,
    maxRows: MTO_BULK_CONFIG.maxSaveRows,
    rows,
  };
}

/**
 * Validates and appends reviewed MTO rows in one batch.
 *
 * Expected payload:
 * {
 *   sourceSheetName: '墨水',
 *   sourceSheetId: 123,
 *   rows: [{
 *     sourceRow, sourceFingerprint, itemId, englishName, chineseName,
 *     option, price, location, stock, imageUrl
 *   }]
 * }
 */
function saveMtoBulkRows(payload) {
  const request = payload || {};
  const submittedRows = Array.isArray(request.rows)
    ? request.rows
    : [];

  if (submittedRows.length < 1) {
    throw new Error('Select at least one source row to copy.');
  }

  if (submittedRows.length > MTO_BULK_CONFIG.maxSaveRows) {
    throw new Error(
        `A maximum of ${MTO_BULK_CONFIG.maxSaveRows} rows can be copied ` +
        'in one batch.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = mtoBulkSpreadsheet_();
    const sourceSheetName = mtoBulkClean_(request.sourceSheetName);
    const sourceSheet = spreadsheet.getSheetByName(sourceSheetName);

    if (!sourceSheet || !mtoBulkIsUsableSourceSheet_(sourceSheet)) {
      throw new Error(
          `Unsupported MTO bulk source sheet: ` +
          `${sourceSheetName || '(blank)'}.`);
    }

    const expectedSheetId = Number(request.sourceSheetId);

    if (
      !Number.isInteger(expectedSheetId) ||
      expectedSheetId !== sourceSheet.getSheetId()
    ) {
      throw new Error(
          'The selected source sheet changed. Reload the bulk editor.');
    }

    const sourceData = mtoBulkReadSourceSheet_(sourceSheet);
    const normalizedRows = [];
    const validationErrors = [];
    const rowErrors = [];
    const batchIds = {};
    const batchSourceRows = {};
    const addRowError = (selectedIndex, submitted, message, sourceRowValue) => {
      const sourceRow = Number(sourceRowValue);
      const itemId = mtoBulkClean_(submitted && submitted.itemId);

      validationErrors.push(
          `Selected row ${selectedIndex + 1}: ${message}`);
      rowErrors.push({
        selectedIndex: selectedIndex + 1,
        sourceRow:
          Number.isInteger(sourceRow) && sourceRow >= 2
            ? sourceRow
            : '',
        itemId,
        message,
      });
    };

    submittedRows.forEach((submitted, index) => {
      const sourceRow = Number(submitted && submitted.sourceRow);

      if (
        !Number.isInteger(sourceRow) ||
        sourceRow < 2 ||
        sourceRow > sourceData.values.length
      ) {
        addRowError(index, submitted, 'Invalid source row.', sourceRow);
        return;
      }

      if (batchSourceRows[sourceRow]) {
        addRowError(
            index,
            submitted,
            `Source row ${sourceRow} was selected more than once.`,
            sourceRow);
        return;
      }

      batchSourceRows[sourceRow] = true;
      const currentCandidate = mtoBulkBuildCandidate_(
          sourceSheet,
          sourceRow,
          sourceData.values[sourceRow - 1],
          sourceData.displays[sourceRow - 1],
          sourceData.columns);
      const submittedFingerprint = mtoBulkClean_(
          submitted.sourceFingerprint);

      if (
        !submittedFingerprint ||
        submittedFingerprint !== currentCandidate.sourceFingerprint
      ) {
        addRowError(
            index,
            submitted,
            `Source row ${sourceRow} changed. Reload it first.`,
            sourceRow);
        return;
      }

      const normalized = mtoBulkNormalizeSubmittedRow_(
          submitted,
          sourceRow);
      const submittedErrors = mtoBulkValidateSubmittedRow_(normalized);

      submittedErrors.forEach((error) => {
        addRowError(index, submitted, error, sourceRow);
      });

      const itemKey = normalized.itemId.toUpperCase();

      if (itemKey) {
        if (batchIds[itemKey]) {
          addRowError(
              index,
              submitted,
              `Duplicate MTO Item ID ${normalized.itemId} in this batch.`,
              sourceRow);
        } else {
          batchIds[itemKey] = true;
        }
      }

      normalized.selectedIndex = index;
      normalizedRows.push(normalized);
    });

    let targetSheet = spreadsheet.getSheetByName(
        MTO_BULK_CONFIG.targetSheetName);
    const targetNeedsHeaders = Boolean(
        targetSheet && targetSheet.getLastColumn() === 0);

    if (targetSheet && !targetNeedsHeaders) {
      mtoBulkValidateTargetSchema_(targetSheet);
    }

    const existingIds = targetSheet && !targetNeedsHeaders
      ? mtoBulkReadTargetIds_(targetSheet)
      : {};

    normalizedRows.forEach((row, index) => {
      if (row.itemId && existingIds[row.itemId.toUpperCase()]) {
        addRowError(
            Number.isInteger(row.selectedIndex) ? row.selectedIndex : index,
            row,
            `MTO Item ID ${row.itemId} already exists in ` +
              'MTO 32 Summary.',
            row.sourceRow);
      }
    });

    if (validationErrors.length > 0) {
      return {
        ok: false,
        message:
          'Nothing was copied. Fix these problems:\n' +
          validationErrors.slice(0, 25).join('\n') +
          (
            validationErrors.length > 25
              ? `\n…and ${validationErrors.length - 25} more.`
              : ''
          ),
        rowErrors,
      };
    }

    if (!targetSheet) {
      targetSheet = spreadsheet.insertSheet(
          MTO_BULK_CONFIG.targetSheetName);
    }

    if (targetNeedsHeaders || targetSheet.getLastColumn() === 0) {
      targetSheet
          .getRange(1, 1, 1, MTO_BULK_CONFIG.targetHeaders.length)
          .setValues([MTO_BULK_CONFIG.targetHeaders.slice()])
          .setFontWeight('bold');
      targetSheet.setFrozenRows(1);
    }

    const startRow = Math.max(2, targetSheet.getLastRow() + 1);
    const requiredLastRow = startRow + normalizedRows.length - 1;

    if (targetSheet.getMaxRows() < requiredLastRow) {
      targetSheet.insertRowsAfter(
          targetSheet.getMaxRows(),
          requiredLastRow - targetSheet.getMaxRows());
    }

    const targetSchema = mtoBulkValidateTargetSchema_(targetSheet);

    mtoBulkWriteTargetRows_(
        spreadsheet,
        targetSheet,
        startRow,
        normalizedRows,
        targetSchema);
    SpreadsheetApp.flush();

    return {
      ok: true,
      createdCount: normalizedRows.length,
      targetSheetName: targetSheet.getName(),
      targetRows: normalizedRows.map((row, index) => ({
        row: startRow + index,
        itemId: row.itemId,
      })),
      locations: mtoBulkLocationSuggestions_(spreadsheet),
    };
  } finally {
    lock.releaseLock();
  }
}

function mtoBulkSpreadsheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error('Unable to access the active spreadsheet.');
  }

  return spreadsheet;
}

function mtoBulkIsUsableSourceSheet_(sheet) {
  if (!sheet || sheet.getLastColumn() < 1) {
    return false;
  }

  const name = mtoBulkClean_(sheet.getName());

  if (
    !name ||
    name === MTO_BULK_CONFIG.targetSheetName ||
    name === MTO_BULK_CONFIG.orderSheetName ||
    name.indexOf('__MYK_REVIEW_') === 0 ||
    /^shopify\s/i.test(name) ||
    /(?:review|preview|import)/i.test(name)
  ) {
    return false;
  }

  const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0];
  const index = mtoBulkHeaderIndex_(headers);
  const aliases = MTO_BULK_CONFIG.sourceAliases;

  return (
    mtoBulkHasAlias_(index, aliases.englishName) &&
    mtoBulkHasAlias_(index, aliases.price) &&
    (
      mtoBulkHasAlias_(index, aliases.itemId) ||
      mtoBulkHasAlias_(index, aliases.sku)
    )
  );
}

function mtoBulkReadSourceSheet_(sheet) {
  const lastRow = Math.max(1, sheet.getLastRow());
  const lastColumn = sheet.getLastColumn();
  const range = sheet.getRange(1, 1, lastRow, lastColumn);
  const values = range.getValues();
  const displays = range.getDisplayValues();

  return {
    values,
    displays,
    columns: mtoBulkResolveSourceColumns_(
        mtoBulkHeaderIndex_(displays[0])),
  };
}

function mtoBulkResolveSourceColumns_(index) {
  const result = {};

  Object.keys(MTO_BULK_CONFIG.sourceAliases).forEach((field) => {
    result[field] = mtoBulkAliasColumns_(
        index,
        MTO_BULK_CONFIG.sourceAliases[field]);
  });

  return result;
}

function mtoBulkBuildCandidate_(
    sheet,
    sourceRow,
    rawRow,
    displayRow,
    columns) {
  const sourceId = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.itemId);
  const sku = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.sku);
  const productType = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.productType) ||
    mtoBulkProfileItemType_(sheet.getName());
  const itemId = sourceId ||
    mtoBulkBuildItemId_(productType, sku);
  const englishName = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.englishName);
  const chineseName = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.chineseName);
  const option = mtoBulkOption_(
      rawRow,
      displayRow,
      columns);
  const priceValue = mtoBulkReadValue_(
      rawRow,
      displayRow,
      columns.price);
  const price = mtoBulkMoney_(priceValue.value);
  const stockResult = mtoBulkSourceStock_(
      rawRow,
      displayRow,
      columns);
  const imageValue = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.imageUrl);
  const imageUrl = mtoBulkFirstImageUrl_(imageValue);
  const errors = [];
  const warnings = [];

  if (!itemId) {
    errors.push('Missing Item ID and unable to derive one from Product Type + SKU.');
  }

  if (!englishName) {
    errors.push('Missing English Name.');
  }

  if (!chineseName) {
    errors.push('Missing Chinese Name.');
  }

  if (!Number.isFinite(price) || price < 0) {
    errors.push('Missing or invalid Price.');
  }

  if (stockResult.error) {
    errors.push(stockResult.error);
  }

  if (!imageUrl) {
    warnings.push('Missing image URL. You may still copy this item.');
  }

  const fingerprintValues = [
    sheet.getSheetId(),
    sourceRow,
    itemId,
    englishName,
    chineseName,
    option,
    Number.isFinite(price) ? price : String(priceValue.display || ''),
    stockResult.stock,
    imageUrl,
  ];

  return {
    sourceSheetName: sheet.getName(),
    sourceSheetId: sheet.getSheetId(),
    sourceRow,
    sourceFingerprint: mtoBulkFingerprint_(fingerprintValues),
    itemId,
    englishName,
    chineseName,
    option,
    price: Number.isFinite(price) ? price : '',
    stock:
      Number.isInteger(stockResult.stock)
        ? stockResult.stock
        : '',
    imageUrl,
    location: '',
    warnings,
    errors,
    valid: errors.length === 0,
  };
}

function mtoBulkOption_(rawRow, displayRow, columns) {
  const direct = mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.option);

  if (direct) {
    return direct;
  }

  const glitterValues = [
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.glitterPotionColor),
    mtoBulkReadText_(
        rawRow,
        displayRow,
        columns.glitterPotionSize),
  ].filter(Boolean);

  if (glitterValues.length > 0) {
    return glitterValues.join(' / ');
  }

  return mtoBulkReadText_(
      rawRow,
      displayRow,
      columns.inkSize);
}

function mtoBulkSourceStock_(rawRow, displayRow, columns) {
  const inventory = mtoBulkReadValue_(
      rawRow,
      displayRow,
      columns.inventory);

  if (inventory.present) {
    const number = mtoBulkWholeNumber_(inventory.value);

    return Number.isInteger(number)
      ? {stock: number, source: 'Inventory', error: ''}
      : {
        stock: '',
        source: 'Inventory',
        error: 'Inventory must be a non-negative whole number.',
      };
  }

  const stockValue = mtoBulkReadValue_(
      rawRow,
      displayRow,
      columns.stock);

  if (!stockValue.present) {
    return {
      stock: '',
      source: '',
      error: 'Missing Inventory and Stock.',
    };
  }

  const stock = mtoBulkWholeNumber_(stockValue.value);

  if (!Number.isInteger(stock)) {
    return {
      stock: '',
      source: 'Stock',
      error: 'Stock must be a non-negative whole number.',
    };
  }

  const hasPurchasedColumn = columns.purchased.length > 0;
  const hasSoldColumn = columns.sold.length > 0;

  if (hasPurchasedColumn && hasSoldColumn) {
    const purchasedValue = mtoBulkReadValue_(
        rawRow,
        displayRow,
        columns.purchased);
    const soldValue = mtoBulkReadValue_(
        rawRow,
        displayRow,
        columns.sold);
    const purchased = purchasedValue.present
      ? mtoBulkWholeNumber_(purchasedValue.value)
      : 0;
    const sold = soldValue.present
      ? mtoBulkWholeNumber_(soldValue.value)
      : 0;

    if (!Number.isInteger(purchased) || !Number.isInteger(sold)) {
      return {
        stock: '',
        source: 'Stock + Purchased - Sold',
        error: 'Purchased and Sold must be non-negative whole numbers.',
      };
    }

    const calculated = stock + purchased - sold;

    if (!Number.isInteger(calculated) || calculated < 0) {
      return {
        stock: '',
        source: 'Stock + Purchased - Sold',
        error: 'Stock + Purchased - Sold cannot be negative.',
      };
    }

    return {
      stock: calculated,
      source: 'Stock + Purchased - Sold',
      error: '',
    };
  }

  return {stock, source: 'Stock', error: ''};
}

function mtoBulkNormalizeSubmittedRow_(submitted, sourceRow) {
  const row = submitted || {};

  return {
    sourceRow,
    itemId: mtoBulkClean_(row.itemId),
    englishName: mtoBulkClean_(row.englishName),
    chineseName: mtoBulkClean_(row.chineseName),
    option: mtoBulkClean_(row.option),
    price: mtoBulkMoney_(row.price),
    location: mtoBulkClean_(row.location),
    stock: mtoBulkWholeNumber_(row.stock),
    imageUrl: mtoBulkFirstImageUrl_(row.imageUrl),
  };
}

function mtoBulkValidateSubmittedRow_(row) {
  const errors = [];

  if (!row.itemId) {
    errors.push('MTO Item ID is required.');
  }

  if (!row.englishName) {
    errors.push('English Name is required.');
  }

  if (!row.chineseName) {
    errors.push('Chinese Name is required.');
  }

  if (!Number.isFinite(row.price) || row.price < 0) {
    errors.push('Price must be zero or a positive number.');
  }

  if (!row.location) {
    errors.push('MTO Item Location is required.');
  }

  if (!Number.isInteger(row.stock) || row.stock < 0) {
    errors.push('Stock must be a non-negative whole number.');
  }

  [
    ['MTO Item ID', row.itemId],
    ['English Name', row.englishName],
    ['Chinese Name', row.chineseName],
    ['Option', row.option],
    ['Location', row.location],
  ].forEach((entry) => {
    if (mtoBulkLooksLikeFormula_(entry[1])) {
      errors.push(
          `${entry[0]} cannot begin with =, +, -, or @.`);
    }
  });

  return errors;
}

function mtoBulkLooksLikeFormula_(value) {
  return /^[=+\-@]/.test(mtoBulkClean_(value));
}

/**
 * Writes only the ten resolved MTO columns in one Sheets API request.
 * Extra columns and their formulas are deliberately left untouched.
 */
function mtoBulkWriteTargetRows_(
    spreadsheet,
    sheet,
    startRow,
    rows,
    schema) {
  if (!rows.length) {
    return;
  }

  if (
    typeof Sheets === 'undefined' ||
    !Sheets.Spreadsheets ||
    !Sheets.Spreadsheets.Values ||
    typeof Sheets.Spreadsheets.Values.batchUpdate !== 'function'
  ) {
    throw new Error(
        'The Advanced Google Sheets service is required for safe MTO ' +
        'bulk writes. Enable Sheets API v4 in Apps Script Services.');
  }

  const endRow = startRow + rows.length - 1;
  const sheetName = String(sheet.getName()).replace(/'/g, "''");
  const fieldValues = {
    itemId: rows.map((row) => row.itemId),
    englishName: rows.map((row) => row.englishName),
    chineseName: rows.map((row) => row.chineseName),
    option: rows.map((row) => row.option),
    price: rows.map((row) => row.price),
    location: rows.map((row) => row.location),
    stock: rows.map((row) => row.stock),
    left: rows.map((row) => row.stock),
    sold: rows.map(() => 0),
    imageUrl: rows.map((row) => row.imageUrl),
  };
  const data = Object.keys(fieldValues).map((field) => {
    const column = mtoBulkColumnLetter_(schema.columns[field]);

    return {
      range: `'${sheetName}'!${column}${startRow}:${column}${endRow}`,
      majorDimension: 'ROWS',
      values: fieldValues[field].map((value) => [value]),
    };
  });

  Sheets.Spreadsheets.Values.batchUpdate(
      {
        valueInputOption: 'RAW',
        includeValuesInResponse: false,
        data,
      },
      spreadsheet.getId());
}

function mtoBulkColumnLetter_(columnNumber) {
  let number = Number(columnNumber);
  let result = '';

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Invalid target column number: ${columnNumber}.`);
  }

  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }

  return result;
}

function mtoBulkValidateTargetSchema_(sheet) {
  const lastColumn = sheet.getLastColumn();

  if (lastColumn === 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} exists but has no headers.`);
  }

  const headers = sheet
      .getRange(1, 1, 1, lastColumn)
      .getDisplayValues()[0]
      .map(mtoBulkClean_);
  const headerIndex = mtoBulkHeaderIndex_(headers);
  const columns = {};
  const missingHeaders = [];
  const ambiguousHeaders = [];

  Object.keys(MTO_BULK_CONFIG.targetAliases).forEach((field) => {
    const aliases = MTO_BULK_CONFIG.targetAliases[field];
    const matches = mtoBulkAliasColumns_(headerIndex, aliases);

    if (matches.length === 0) {
      missingHeaders.push(aliases[0]);
      return;
    }

    if (matches.length > 1) {
      ambiguousHeaders.push(
          `${aliases[0]} ` +
          `(${matches.map((position) => headers[position]).join(', ')})`);
      return;
    }

    // Spreadsheet ranges use one-based column positions.
    columns[field] = matches[0] + 1;
  });

  if (missingHeaders.length > 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} is missing required column(s): ` +
        `${missingHeaders.join(' | ')}. Columns may be in any order, and ` +
        'additional columns are allowed.');
  }

  if (ambiguousHeaders.length > 0) {
    throw new Error(
        `${MTO_BULK_CONFIG.targetSheetName} has duplicate or ambiguous ` +
        `columns: ${ambiguousHeaders.join(' | ')}. Keep only one heading ` +
        'for each MTO field.');
  }

  return {columns, headers, lastColumn};
}

function mtoBulkReadTargetIds_(sheet, schema) {
  const ids = {};
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return ids;
  }

  const targetSchema = schema || mtoBulkValidateTargetSchema_(sheet);

  sheet
      .getRange(
          2,
          targetSchema.columns.itemId,
          lastRow - 1,
          1)
      .getDisplayValues()
      .forEach((row, offset) => {
        const id = mtoBulkClean_(row[0]);

        if (!id) {
          return;
        }

        const key = id.toUpperCase();

        if (ids[key]) {
          throw new Error(
              `Duplicate MTO Item ID already exists in ` +
              `${MTO_BULK_CONFIG.targetSheetName}: ${id}.`);
        }

        ids[key] = offset + 2;
      });

  return ids;
}

function mtoBulkReadTargetIdsAfterSchemaCheck_(sheet) {
  const schema = mtoBulkValidateTargetSchema_(sheet);
  return mtoBulkReadTargetIds_(sheet, schema);
}

function mtoBulkLocationSuggestions_(spreadsheet) {
  const result = [];
  const seen = {};
  const add = (value) => {
    const location = mtoBulkClean_(value);
    const key = location.toUpperCase();

    if (!location || seen[key]) {
      return;
    }

    seen[key] = true;
    result.push(location);
  };

  MTO_BULK_CONFIG.defaultLocations.forEach(add);
  const sheet = spreadsheet.getSheetByName(
      MTO_BULK_CONFIG.targetSheetName);

  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) {
    return result;
  }

  const schema = mtoBulkValidateTargetSchema_(sheet);
  const locationColumn = schema.columns.location;

  sheet
      .getRange(2, locationColumn, sheet.getLastRow() - 1, 1)
      .getDisplayValues()
      .forEach((row) => add(row[0]));

  return result;
}

function mtoBulkHeaderIndex_(headers) {
  const index = {};

  (headers || []).forEach((header, position) => {
    const key = mtoBulkHeaderKey_(header);

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

function mtoBulkHeaderKey_(value) {
  return mtoBulkClean_(value)
      .toLowerCase()
      .replace(/\s+/g, '_');
}

function mtoBulkHasAlias_(index, aliases) {
  return mtoBulkAliasColumns_(index, aliases).length > 0;
}

function mtoBulkAliasColumns_(index, aliases) {
  const columns = [];
  const seen = {};

  (aliases || []).forEach((alias) => {
    (index[mtoBulkHeaderKey_(alias)] || []).forEach((column) => {
      if (!seen[column]) {
        seen[column] = true;
        columns.push(column);
      }
    });
  });

  return columns;
}

function mtoBulkReadValue_(rawRow, displayRow, columns) {
  for (let offset = 0; offset < (columns || []).length; offset += 1) {
    const column = columns[offset];
    const display = mtoBulkClean_(displayRow[column]);

    if (display !== '') {
      return {
        present: true,
        value: rawRow[column],
        display,
        column,
      };
    }
  }

  return {present: false, value: '', display: '', column: -1};
}

function mtoBulkReadText_(rawRow, displayRow, columns) {
  return mtoBulkReadValue_(rawRow, displayRow, columns).display;
}

function mtoBulkProfileItemType_(sheetName) {
  if (
    typeof MYK_SHEET_PROFILES !== 'undefined' &&
    MYK_SHEET_PROFILES[mtoBulkClean_(sheetName)]
  ) {
    return mtoBulkClean_(
        MYK_SHEET_PROFILES[mtoBulkClean_(sheetName)].itemType);
  }

  return '';
}

function mtoBulkBuildItemId_(productType, sku) {
  if (typeof buildEditorItemId_ === 'function') {
    return mtoBulkClean_(buildEditorItemId_(productType, sku));
  }

  const type = mtoBulkClean_(productType)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const normalizedSku = mtoBulkClean_(sku)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  return type && normalizedSku
    ? `${type}-${normalizedSku}`
    : '';
}

function mtoBulkMoney_(value) {
  const text = String(value == null ? '' : value)
      .replace(/[,HK$\s]/gi, '');

  if (text === '') {
    return NaN;
  }

  const number = Number(text);

  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100
    : NaN;
}

function mtoBulkWholeNumber_(value) {
  const text = mtoBulkClean_(value).replace(/,/g, '');
  const number = Number(text);

  return text !== '' && Number.isInteger(number) && number >= 0
    ? number
    : NaN;
}

function mtoBulkFirstImageUrl_(value) {
  const first = mtoBulkClean_(value)
      .split(/[\r\n;|]+/)
      .map(mtoBulkClean_)
      .filter(Boolean)[0] || '';

  if (!/^https?:\/\/[^\s]+$/i.test(first)) {
    return '';
  }

  return mtoBulkNormalizeImageUrl_(first);
}

function mtoBulkNormalizeImageUrl_(value) {
  const url = mtoBulkClean_(value);

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
    // Preserve the original encoded ID when an old URL is malformed.
  }

  return `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`;
}

function mtoBulkFingerprint_(values) {
  const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify(values),
      Utilities.Charset.UTF_8);

  return bytes.map((byte) => {
    return (`0${(byte < 0 ? byte + 256 : byte).toString(16)}`).slice(-2);
  }).join('');
}

function mtoBulkClean_(value) {
  return String(value == null ? '' : value).trim();
}
