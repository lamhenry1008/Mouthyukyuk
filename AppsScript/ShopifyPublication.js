/**
 * Shopify publication helpers shared by the editor and approved bulk sync.
 *
 * Product status and sales-channel publication are separate in Shopify.
 * These helpers publish ACTIVE products and variants to every active APP
 * publication, then verify the final state before reporting success.
 *
 * Optional Script Property:
 *   SHOPIFY_PUBLICATION_IDS
 *
 * When present, it is a comma/newline-separated allow-list of exact
 * gid://shopify/Publication/... IDs. When absent, every active APP catalog
 * publication is targeted. MARKET and COMPANY_LOCATION catalogs are never
 * selected automatically.
 */

const MYK_PUBLICATION_CONFIG = Object.freeze({
  publicationIdsProperty: 'SHOPIFY_PUBLICATION_IDS',
  cacheKey: 'MYK_ACTIVE_APP_PUBLICATIONS_2026_07_V1',
  cacheSeconds: 300,
  discoveryPageSize: 100,
  maximumDiscoveryPages: 20,
  verificationPublicationBatchSize: 10,
  verificationResourceBatchSize: 25,
  mutationPublicationBatchSize: 250,
});

/**
 * Publishes one ACTIVE product and its variants to the configured targets.
 *
 * options.callGraphql must return either GraphQL data directly (Editor) or
 * the complete {data: ...} response object (approved bulk sync).
 */
function mykEnsureActiveShopifyPublications_(options) {
  options = options || {};

  const status = mykPublicationClean_(options.status).toUpperCase();

  if (status !== 'ACTIVE') {
    return {
      skipped: true,
      publicationIds: [],
      resourceIds: [],
      publishedNow: 0,
      verified: true,
      message: `PUBLICATION_SKIPPED_STATUS=${status || 'UNKNOWN'}`,
    };
  }

  if (typeof options.callGraphql !== 'function') {
    throw new Error(
        'PUBLICATION_FAILED: no Shopify GraphQL transport was supplied.');
  }

  const productId = mykPublicationClean_(options.productId);

  if (!mykPublicationIsProductGid_(productId)) {
    throw new Error(
        `PUBLICATION_FAILED: invalid Shopify Product GID: ` +
        `${productId || '(blank)'}`);
  }

  const variantIds = mykPublicationUnique_(
      (options.variantIds || [])
          .map((id) => mykPublicationClean_(id))
          .filter(Boolean));

  variantIds.forEach((variantId) => {
    if (!mykPublicationIsVariantGid_(variantId)) {
      throw new Error(
          `PUBLICATION_FAILED: invalid Shopify Variant GID: ${variantId}`);
    }
  });

  const publications = mykPublicationTargetPublications_(
      options.callGraphql);
  const publicationIds = publications.map((publication) => publication.id);
  const resourceIds = [productId].concat(variantIds);

  const before = mykPublicationInspectResources_(
      options.callGraphql,
      productId,
      resourceIds,
      publicationIds);

  mykPublicationAssertActiveProduct_(
      before,
      productId,
      variantIds);

  const publishedNow = mykPublicationPublishMissing_(
      options.callGraphql,
      resourceIds,
      publicationIds,
      before);

  const after = publishedNow > 0
    ? mykPublicationInspectResources_(
        options.callGraphql,
        productId,
        resourceIds,
        publicationIds)
    : before;

  mykPublicationAssertActiveProduct_(
      after,
      productId,
      variantIds);

  const missing = mykPublicationMissingPairs_(
      resourceIds,
      publicationIds,
      after);

  if (missing.length > 0) {
    throw new Error(
        `PUBLICATION_FAILED: Shopify did not confirm ` +
        `${missing.slice(0, 8).join(', ')}` +
        `${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''}.`);
  }

  return {
    skipped: false,
    publicationIds,
    resourceIds,
    publishedNow,
    verified: true,
    message:
      `PUBLICATION_VERIFIED=${publicationIds.length}_CHANNELS; ` +
      `RESOURCES=${resourceIds.length}; NEW_LINKS=${publishedNow}`,
  };
}

/** Lists all APP publications and shows which ones automatic sync targets. */
function listShopifyPublications() {
  const ui = SpreadsheetApp.getUi();
  let publications;

  try {
    publications = mykPublicationDiscoverAll_(
        mykPublicationDefaultGraphql_,
        true);
  } catch (error) {
    throw new Error(
        `Unable to list Shopify publications. Add read_publications and ` +
        `write_publications to the custom app, update or reinstall it, clear ` +
        `the cached Shopify token properties, and try again. ` +
        `${error.message || error}`);
  }

  const overrideIds = mykPublicationOverrideIds_();
  const automaticIds = new Set(
      overrideIds.length > 0
        ? overrideIds
        : publications
            .filter(mykPublicationIsActiveAppPublication_)
            .map((publication) => publication.id));

  const lines = publications.map((publication) => {
    const catalog = publication.catalog || {};
    const channelNames = (publication.channels || [])
        .map((channel) => {
          return mykPublicationClean_(channel.name || channel.handle);
        })
        .filter(Boolean);
    const label =
      mykPublicationClean_(catalog.title) ||
      channelNames.join(', ') ||
      'Unnamed publication';
    const state = mykPublicationClean_(catalog.status) || 'NO_CATALOG';
    const selected = automaticIds.has(publication.id)
      ? 'TARGET'
      : 'NOT TARGETED';

    return [
      `[${selected}] ${label}`,
      publication.id,
      `Catalog=${state}`,
      `Auto publish=${publication.autoPublish === true ? 'YES' : 'NO'}`,
    ].join('\n');
  });

  overrideIds
      .filter((id) => {
        return !publications.some((publication) => publication.id === id);
      })
      .forEach((id) => {
        lines.push(
            `[TARGET — configured ID was not returned by discovery]\n${id}`);
      });

  const policy = overrideIds.length > 0
    ? `Using ${MYK_PUBLICATION_CONFIG.publicationIdsProperty}.`
    : 'Using every active APP publication automatically.';

  ui.alert(
      'Shopify sales-channel publications',
      `${policy}\n\n${lines.join('\n\n') || 'No APP publications found.'}`,
      ui.ButtonSet.OK);

  return publications;
}

function mykPublicationTargetPublications_(callGraphql) {
  const overrideIds = mykPublicationOverrideIds_();

  if (overrideIds.length > 0) {
    return overrideIds.map((id) => ({
      id,
      configured: true,
      catalog: null,
      channels: [],
    }));
  }

  let publications;

  try {
    publications = mykPublicationDiscoverAll_(callGraphql, false);
  } catch (error) {
    throw new Error(
        `PUBLICATION_SETUP_REQUIRED: Shopify sales channels could not be ` +
        `listed. Add read_publications and write_publications to the custom ` +
        `app, update or reinstall it, clear SHOPIFY_ACCESS_TOKEN and ` +
        `SHOPIFY_ACCESS_TOKEN_EXPIRES_AT, then retry. ` +
        `${error.message || error}`);
  }

  const active = publications.filter(
      mykPublicationIsActiveAppPublication_);

  if (active.length === 0) {
    throw new Error(
        `PUBLICATION_SETUP_REQUIRED: no active APP sales-channel ` +
        `publication was found. Run Shopify Sync → List Publications and ` +
        `confirm the Online Store or intended sales channels are active.`);
  }

  return active;
}

function mykPublicationDiscoverAll_(callGraphql, forceRefresh) {
  if (typeof callGraphql !== 'function') {
    throw new Error('No Shopify GraphQL transport was supplied.');
  }

  if (!forceRefresh) {
    const cached = mykPublicationReadCache_();

    if (cached) {
      return cached;
    }
  }

  const query = `
    query MykDiscoverAppPublications($after: String, $first: Int!) {
      publications(first: $first, after: $after, catalogType: APP) {
        nodes {
          id
          autoPublish
          supportsFuturePublishing
          catalog {
            id
            title
            status
          }
          channels(first: 20) {
            nodes {
              id
              name
              handle
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const publications = [];
  let after = null;
  let page = 0;

  do {
    page += 1;

    if (page > MYK_PUBLICATION_CONFIG.maximumDiscoveryPages) {
      throw new Error('Publication discovery exceeded its safe page limit.');
    }

    const data = mykPublicationGraphqlData_(
        callGraphql(query, {
          after,
          first: MYK_PUBLICATION_CONFIG.discoveryPageSize,
        }),
        'publication discovery');
    const connection = data.publications;

    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error(
          'Shopify returned no publications connection.');
    }

    connection.nodes.forEach((node) => {
      const id = mykPublicationClean_(node && node.id);

      if (!mykPublicationIsPublicationGid_(id)) {
        throw new Error(
            `Shopify returned an invalid Publication GID: ${id || '(blank)'}`);
      }

      const channelNodes =
        node && node.channels && Array.isArray(node.channels.nodes)
          ? node.channels.nodes
          : [];

      publications.push({
        id,
        autoPublish: node.autoPublish === true,
        supportsFuturePublishing:
          node.supportsFuturePublishing === true,
        catalog: node.catalog
          ? {
            id: mykPublicationClean_(node.catalog.id),
            title: mykPublicationClean_(node.catalog.title),
            status: mykPublicationClean_(node.catalog.status).toUpperCase(),
          }
          : null,
        channels: channelNodes.map((channel) => ({
          id: mykPublicationClean_(channel && channel.id),
          name: mykPublicationClean_(channel && channel.name),
          handle: mykPublicationClean_(channel && channel.handle),
        })),
      });
    });

    const pageInfo = connection.pageInfo || {};

    if (pageInfo.hasNextPage === true) {
      after = mykPublicationClean_(pageInfo.endCursor);

      if (!after) {
        throw new Error(
            'Shopify publication pagination returned no next cursor.');
      }
    } else {
      after = null;
    }
  } while (after);

  const unique = [];
  const seen = new Set();

  publications.forEach((publication) => {
    if (!seen.has(publication.id)) {
      seen.add(publication.id);
      unique.push(publication);
    }
  });

  mykPublicationWriteCache_(unique);
  return unique;
}

function mykPublicationInspectResources_(
    callGraphql,
    productId,
    resourceIds,
    publicationIds) {
  const states = {};

  resourceIds.forEach((id) => {
    states[id] = {
      id,
      type: '',
      status: '',
      parentId: '',
      parentStatus: '',
      published: {},
    };
  });

  mykPublicationChunks_(
      publicationIds,
      MYK_PUBLICATION_CONFIG.verificationPublicationBatchSize)
      .forEach((publicationBatch) => {
        const variableDefinitions = ['$ids: [ID!]!'];
        const publicationFields = [];
        const variables = {};

        publicationBatch.forEach((publicationId, index) => {
          const variableName = `publication${index}`;
          variableDefinitions.push(`$${variableName}: ID!`);
          publicationFields.push(
              `${variableName}: publishedOnPublication(` +
              `publicationId: $${variableName})`);
          variables[variableName] = publicationId;
        });

        const query = `
          query MykVerifyPublicationState(
            ${variableDefinitions.join(', ')}
          ) {
            nodes(ids: $ids) {
              id
              __typename
              ... on Publishable {
                ${publicationFields.join('\n')}
              }
              ... on Product {
                status
              }
              ... on ProductVariant {
                product {
                  id
                  status
                }
              }
            }
          }
        `;

        mykPublicationChunks_(
            resourceIds,
            MYK_PUBLICATION_CONFIG.verificationResourceBatchSize)
            .forEach((resourceBatch) => {
              const batchVariables = Object.assign(
                  {},
                  variables,
                  {ids: resourceBatch});
              const data = mykPublicationGraphqlData_(
                  callGraphql(query, batchVariables),
                  'publication verification');
              const nodes = Array.isArray(data.nodes) ? data.nodes : [];
              const returned = {};

              nodes.filter(Boolean).forEach((node) => {
                returned[mykPublicationClean_(node.id)] = node;
              });

              resourceBatch.forEach((resourceId) => {
                const node = returned[resourceId];

                if (!node) {
                  throw new Error(
                      `PUBLICATION_FAILED: Shopify did not return ` +
                      `${resourceId} during verification.`);
                }

                const state = states[resourceId];
                const type = mykPublicationClean_(node.__typename);

                if (type !== 'Product' && type !== 'ProductVariant') {
                  throw new Error(
                      `PUBLICATION_FAILED: ${resourceId} is ${type || 'unknown'}, ` +
                      `not a publishable product resource.`);
                }

                if (state.type && state.type !== type) {
                  throw new Error(
                      `PUBLICATION_FAILED: inconsistent resource type for ` +
                      `${resourceId}.`);
                }

                state.type = type;

                if (type === 'Product') {
                  state.status = mykPublicationClean_(node.status).toUpperCase();
                } else {
                  state.parentId = mykPublicationClean_(
                      node.product && node.product.id);
                  state.parentStatus = mykPublicationClean_(
                      node.product && node.product.status).toUpperCase();
                }

                publicationBatch.forEach((publicationId, index) => {
                  const key = `publication${index}`;

                  if (typeof node[key] !== 'boolean') {
                    throw new Error(
                        `PUBLICATION_FAILED: Shopify returned no publication ` +
                        `state for ${resourceId} on ${publicationId}.`);
                  }

                  state.published[publicationId] = node[key];
                });
              });
            });
      });

  if (!states[productId]) {
    throw new Error(
        `PUBLICATION_FAILED: product ${productId} was not inspected.`);
  }

  return states;
}

function mykPublicationAssertActiveProduct_(states, productId, variantIds) {
  const product = states[productId];

  if (!product || product.type !== 'Product') {
    throw new Error(
        `PUBLICATION_FAILED: ${productId} was not returned as a Product.`);
  }

  if (product.status !== 'ACTIVE') {
    throw new Error(
        `PUBLICATION_FAILED: Shopify product status is ` +
        `${product.status || 'UNKNOWN'}, expected ACTIVE.`);
  }

  variantIds.forEach((variantId) => {
    const variant = states[variantId];

    if (!variant || variant.type !== 'ProductVariant') {
      throw new Error(
          `PUBLICATION_FAILED: ${variantId} was not returned as a ` +
          `ProductVariant.`);
    }

    if (variant.parentId !== productId) {
      throw new Error(
          `PUBLICATION_FAILED: ${variantId} belongs to ` +
          `${variant.parentId || '(unknown product)'}, not ${productId}.`);
    }

    if (variant.parentStatus !== 'ACTIVE') {
      throw new Error(
          `PUBLICATION_FAILED: parent status for ${variantId} is ` +
          `${variant.parentStatus || 'UNKNOWN'}, expected ACTIVE.`);
    }
  });
}

function mykPublicationPublishMissing_(
    callGraphql,
    resourceIds,
    publicationIds,
    states) {
  const mutation = `
    mutation MykPublishResource(
      $id: ID!,
      $input: [PublicationInput!]!
    ) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          __typename
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  let publishedNow = 0;

  resourceIds.forEach((resourceId) => {
    const missing = publicationIds.filter((publicationId) => {
      return states[resourceId].published[publicationId] !== true;
    });

    mykPublicationChunks_(
        missing,
        MYK_PUBLICATION_CONFIG.mutationPublicationBatchSize)
        .forEach((publicationBatch) => {
          const data = mykPublicationGraphqlData_(
              callGraphql(mutation, {
                id: resourceId,
                input: publicationBatch.map((publicationId) => ({
                  publicationId,
                })),
              }),
              'publishablePublish');
          const result = data.publishablePublish;

          if (!result) {
            throw new Error(
                `PUBLICATION_FAILED: Shopify returned no ` +
                `publishablePublish payload for ${resourceId}.`);
          }

          mykPublicationThrowUserErrors_(
              result.userErrors,
              resourceId);

          if (!result.publishable) {
            throw new Error(
                `PUBLICATION_FAILED: Shopify returned no published resource ` +
                `for ${resourceId}.`);
          }

          publishedNow += publicationBatch.length;
        });
  });

  return publishedNow;
}

function mykPublicationMissingPairs_(resourceIds, publicationIds, states) {
  const missing = [];

  resourceIds.forEach((resourceId) => {
    publicationIds.forEach((publicationId) => {
      if (
        !states[resourceId] ||
        states[resourceId].published[publicationId] !== true
      ) {
        missing.push(`${resourceId} → ${publicationId}`);
      }
    });
  });

  return missing;
}

function mykPublicationThrowUserErrors_(errors, resourceId) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return;
  }

  const message = errors.map((error) => {
    const field = Array.isArray(error && error.field)
      ? error.field.join('.')
      : mykPublicationClean_(error && error.field);

    return [field, mykPublicationClean_(error && error.message)]
        .filter(Boolean)
        .join(': ');
  }).join(' | ');

  throw new Error(
      `PUBLICATION_FAILED: publishablePublish failed for ${resourceId}: ` +
      `${message}. Confirm write_publications and the installing user's ` +
      `catalog/product permissions.`);
}

function mykPublicationOverrideIds_() {
  const properties = PropertiesService.getScriptProperties();
  const raw = mykPublicationClean_(
      properties.getProperty(
          MYK_PUBLICATION_CONFIG.publicationIdsProperty));

  if (!raw) {
    return [];
  }

  const ids = mykPublicationUnique_(
      raw.split(/[\s,;|]+/)
          .map(mykPublicationClean_)
          .filter(Boolean));
  const invalid = ids.filter((id) => {
    return !mykPublicationIsPublicationGid_(id);
  });

  if (invalid.length > 0) {
    throw new Error(
        `${MYK_PUBLICATION_CONFIG.publicationIdsProperty} contains invalid ` +
        `Publication GID(s): ${invalid.join(', ')}`);
  }

  return ids;
}

function mykPublicationIsActiveAppPublication_(publication) {
  if (!publication || !mykPublicationIsPublicationGid_(publication.id)) {
    return false;
  }

  // Some legacy app publications have no Catalog object. They still represent
  // a sales channel and remain valid targets.
  return !publication.catalog || publication.catalog.status === 'ACTIVE';
}

function mykPublicationGraphqlData_(response, operation) {
  const data = response && response.data
    ? response.data
    : response;

  if (!data || typeof data !== 'object') {
    throw new Error(
        `Shopify returned no GraphQL data for ${operation}.`);
  }

  return data;
}

function mykPublicationDefaultGraphql_(query, variables) {
  if (
    typeof getCachedShopifyAccessToken_ === 'function' &&
    typeof callShopifyGraphql_ === 'function'
  ) {
    return callShopifyGraphql_(
        getCachedShopifyAccessToken_(),
        query,
        variables);
  }

  if (typeof shopifyGraphql_ === 'function') {
    return shopifyGraphql_(query, variables);
  }

  throw new Error(
      'No Shopify GraphQL client is available in this Apps Script project.');
}

function mykPublicationReadCache_() {
  try {
    if (typeof CacheService === 'undefined') {
      return null;
    }

    const raw = CacheService.getScriptCache().get(
        MYK_PUBLICATION_CONFIG.cacheKey);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function mykPublicationWriteCache_(publications) {
  try {
    if (typeof CacheService === 'undefined') {
      return;
    }

    CacheService.getScriptCache().put(
        MYK_PUBLICATION_CONFIG.cacheKey,
        JSON.stringify(publications),
        MYK_PUBLICATION_CONFIG.cacheSeconds);
  } catch (error) {
    // Cache failures must never prevent a product publication.
  }
}

function mykPublicationChunks_(values, size) {
  const chunks = [];

  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }

  return chunks;
}

function mykPublicationUnique_(values) {
  const seen = new Set();

  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });
}

function mykPublicationClean_(value) {
  return String(value == null ? '' : value).trim();
}

function mykPublicationIsProductGid_(value) {
  return /^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(value);
}

function mykPublicationIsVariantGid_(value) {
  return /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(value);
}

function mykPublicationIsPublicationGid_(value) {
  return /^gid:\/\/shopify\/Publication\/[1-9]\d*$/.test(value);
}
