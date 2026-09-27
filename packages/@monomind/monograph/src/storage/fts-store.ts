/**
 * FTS5 search, intent-extraction, and hybrid search over the monograph nodes
 * table.
 *
 * File-size sweep: split into sibling modules — stopwords + intent-to-
 * identifier extraction in fts-store-terms.ts, the FTS5/LIKE search path in
 * fts-store-search.ts, and hybrid (FTS + LIKE + fuzzy) search in
 * fts-store-hybrid.ts. Re-exported here so every existing import path
 * (`./fts-store.js`) keeps working unchanged.
 */

export type { HybridSearchResult } from './fts-store-hybrid.js';
export { hybridSearch } from './fts-store-hybrid.js';
export type { FtsResult } from './fts-store-search.js';
export { ftsSearch, relevanceFromFtsRank } from './fts-store-search.js';
export { extractSearchTerms } from './fts-store-terms.js';
