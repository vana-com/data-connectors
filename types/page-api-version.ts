/**
 * Runtime-accessible version constant for the connector page API.
 *
 * This is intentionally a separate module from connector.d.ts so that
 * .d.ts files can stay declaration-only.
 *
 * Contract: within a major version the page API is additive-only. Removals
 * or renames require bumping this constant AND the `page_api_version` field
 * in every connector manifest.
 */
export const PAGE_API_VERSION = 1 as const;
