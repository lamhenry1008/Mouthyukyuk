function getFirebaseCredentials() {
  const fileName = "myy-firebase-firebase-adminsdk-fbsvc-30d684d827.json"; 
  
  const files = DriveApp.getFilesByName(fileName);
  
  if (files.hasNext()) {
    const file = files.next();
    const content = file.getBlob().getDataAsString();
    const credentials = JSON.parse(content);
    
    return credentials;
  } else {
    throw new Error("File not found: " + fileName);
  }
}

function initializeFirebase() {
  const creds = getFirebaseCredentials();
  const firestore = FirestoreApp.getFirestore(
    creds.client_email,
    creds.private_key,
    creds.project_id, 
    "v1"
  );
  const database_id = 'mouthyukyuk';
  firestore.baseUrl =
    `https://firestore.googleapis.com/v1/projects/` +
    `${creds.project_id}/databases/${database_id}/documents/`;
  return firestore;
}

/**
 * 核心同步函數：優化效能版
 */
/**
 * Synchronizes sheet data to Firebase with an auto-resume checkpoint system.
 */
function syncToFirebase() {
  const startTime = new Date().getTime();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("墨水/閃粉"); // Replace with your actual tab name
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  const idx = getFirebaseColumnIndices_(sheet);
  
  // Initialize Firestore & Properties
  const db = initializeFirebase();
  const props = PropertiesService.getScriptProperties();
  const startRow = parseInt(props.getProperty('SYNC_LAST_ROW')) || 1;
  const processedHandles = new Set();
  
  // Prepare timestamp array
  const lastUpdatedColumn = values.map(row => [row[idx.last_updated]]);

  // Pre-process variants mapping
  const variantsMap = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const currentName = row[idx.english_name].trim();
    const currentHandle = currentName
        .toLowerCase()                   
        .replace(/&/g, 'n')              
        .replace(/[^a-z0-9]+/g, '-')     
        .replace(/^-+|-+$/g, '');
    sheet.getRange(i + 1, idx.handle + 1).setValue(currentHandle);
    if (!variantsMap[currentHandle]) variantsMap[currentHandle] = [];
    variantsMap[currentHandle].push(row);
  }

  console.log(`🚀 Starting Sync from Row: ${startRow}`);

  // Start processing products
  for (let i = startRow; i < values.length; i++) {
    
    // --- TIME LIMIT CHECK (5.5 minutes) ---
    const currTime = new Date().getTime();
    if (currTime - startTime > 330000) { 
      saveSyncProgress(i, lastUpdatedColumn, idx.last_updated, sheet);
      createSyncTrigger();
      console.log(`⏰ Time limit nearing. Saved progress at row ${i}. Auto-restart set.`);
      return; 
    }

    const row = values[i];
    const currentHandle = row[idx.handle]?.toString().trim();
    const currentName = row[idx.english_name]?.toString().trim();
    const currentCollection = currentName.includes(" - ") ? currentName.split(" - ")[0].trim() : currentName;
    let currentStatus = row[idx.status]?.toString().trim();
    const currentPrice = row[idx.price];
    const currentImageURL =
      row[idx.image_url]
          ?.toString()
          .split(',')
          .map((text) => {
            return text.replace(/\s*拍照\s*/g, '').trim();
          })
          .filter(Boolean) ||
      [];

    // Initialize validation
    let failureReasons = [];
    let hasValidImage = false;

    if (currentImageURL) {
      const urls = currentImageURL.toString().split(/[,\n]+/).map(url => url.trim()).filter(url => url.length > 0);
      hasValidImage = urls.length > 0 && urls.every(url => url.includes("/uc?id="));
    }

    // Check conditions
    if (!currentHandle) failureReasons.push("Missing Handle");
    if (!currentPrice) failureReasons.push("Missing Price");
    if (!hasValidImage) failureReasons.push("Invalid or Missing Image");
    if (processedHandles.has(currentHandle)) failureReasons.push("Duplicate Handle");

    // Set Status and Result
    let uploadResult = "";
    if (failureReasons.length > 0) {
      currentStatus = "Draft";
      uploadResult = failureReasons.join(", ");
    } else {
      currentStatus = "Active";
      uploadResult = "Success";
    }

    // WRITE TO THE SHEET BEFORE CONTINUING
    sheet.getRange(i + 1, idx.upload_result + 1).setValue(uploadResult);
    sheet.getRange(i + 1, idx.status + 1).setValue(currentStatus);

    // NOW you can use continue to skip further processing (like syncing to an external store)
    if (currentStatus === "Draft" || processedHandles.has(currentHandle)) {
      continue; 
    }

    const variantRows = variantsMap[currentHandle] || [];
    
    const shopifyVariants = variantRows.map(vRow => ({
      option1: vRow[idx.option] || "Default Title", 
      sku: vRow[idx.sku]?.toString(),
      cost: vRow[idx.cost],
      price: vRow[idx.price],
      inventory_management: "shopify",
      inventory_quantity: Math.trunc(vRow[idx.inventory] || 0)
    }));

    const productData = {
      name_chi: row[idx.chinese_name]?.toString(),
      name_eng: row[idx.english_name]?.toString(),
      handle: currentHandle,
      id: row[idx.id]?.toString(),
      brand: row[idx.brand]?.toString(),
      product_type: row[idx.product_type]?.toString(),
      collection: currentCollection,
      ink_base_color: row[idx.ink_base_color]?.toString(),
      ink_glitter_color: row[idx.ink_glitter_color]?.toString(),
      ink_sheen_color: row[idx.ink_sheen_color]?.toString(),
      label_tag: row[idx.label_tag]?.toString().split(",").map(t => t.trim()).filter(t => t) || [],
      image_url:
        row[idx.image_url]
            ?.toString()
            .split(',')
            .map((text) => {
              return text.replace(/\s*拍照\s*/g, '').trim();
            })
            .filter(Boolean) ||
        [],
      desc_chi: row[idx.desc_chi]?.toString(),
      desc_eng: row[idx.desc_eng]?.toString(),
      status: currentStatus,
      variants: shopifyVariants,
      updated_at: new Date().toISOString(),
      upload_result: row[idx.upload_result]?.toString()
    };

    const docPath = `products/${productData.brand}/${productData.collection}/${productData.id}`;
    
    try {
      db.updateDocument(docPath, productData);
      
      processedHandles.add(currentHandle);
      const nowFormatted = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
      
      variantRows.forEach(vRow => {
        const rowIndex = values.indexOf(vRow);
        if (rowIndex !== -1) lastUpdatedColumn[rowIndex] = [nowFormatted];
      });

    } catch (error) {
      if (error.message.includes("404") || error.message.includes("not found")) {
        try {
          db.createDocument(docPath, productData);
        } catch (e) { console.error(`❌ Create failed: ${currentHandle}`); }
      }
    }

    // Refresh Sheet UI every 10 products
    if (processedHandles.size > 0 && processedHandles.size % 10 === 0) {
      sheet.getRange(1, idx.last_updated + 1, lastUpdatedColumn.length, 1).setValues(lastUpdatedColumn);
      SpreadsheetApp.flush();
      console.log(`📊 Checkpoint: Synced ${processedHandles.size} products...`);
    }
  }

  // 5. Finalize
  saveSyncProgress(0, lastUpdatedColumn, idx.last_updated, sheet);
  deleteSyncTriggers();
  console.log("🏁 All products successfully synced to Firebase!");
}

/**
 * --- HELPER FUNCTIONS FOR SYNC ---
 */

function saveSyncProgress(row, lastUpdatedData, colIdx, sheet) {
  // Write the timestamps we have so far
  sheet.getRange(1, colIdx + 1, lastUpdatedData.length, 1).setValues(lastUpdatedData);
  PropertiesService.getScriptProperties().setProperty('SYNC_LAST_ROW', row.toString());
}

function createSyncTrigger() {
  deleteSyncTriggers();
  ScriptApp.newTrigger('syncToFirebase')
    .timeBased()
    .after(60000)
    .create();
}

function deleteSyncTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'syncToFirebase') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

function resetSyncProgress() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_LAST_ROW');
  console.log("♻️ Sync progress reset to Row 1.");
}

/**
 * 輔助函數：獲取標題列索引
 */
function getFirebaseColumnIndices_(sheet) {
  const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0];

  const idx = {};

  headers.forEach((header, index) => {
    const key = header
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');

    idx[key] = index;
  });

  return idx;
}
