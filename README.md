# Clay Tables Pack

This is a starter Superhuman/Coda Pack for querying Clay tables through the Clay Public API.

The Packs SDK was renamed from Coda Packs to Superhuman Packs in 2026, but Coda Packs are still supported and the npm package is still `@codahq/packs-sdk`.

## What It Includes

- `QueryClayTables(queryJson, limit, cursor)`: runs a raw Clay structured query and returns JSON strings for rows, unwrapped values, field metadata, the next cursor, and truncation state.
- `ClayTableId(tableIdOrUrl)`: extracts `t_...` table IDs from Clay table URLs.
- `SendToClayWebhook(webhookUrl, payloadJson)`: action formula for a Coda button that sends a JSON object to a Clay table or workflow webhook.
- `ClayRows` sync table: syncs rows from one known Clay table into a document.
- `TypedClayTable` dynamic sync table: discovers Clay fields and syncs them into native Coda columns.
- `People` dynamic sync table: syncs a people-oriented Clay table with a distinct `ClayPerson` identity.
- `Companies` dynamic sync table: syncs a company-oriented Clay table with a distinct `ClayCompany` identity.

## Clay API Details Used

Clay table queries call:

```text
POST https://api.clay.com/public/v0/tables/query
```

Authentication uses the `clay-api-key` header. Clay table IDs must already be known; the current public table API does not expose a list-tables endpoint. You can find a table ID in Clay URLs after `/tables/`, for example:

```text
https://app.clay.com/workspaces/{workspaceId}/tables/t_0te9i4tZEHwc9hihBXu
```

Clay table query pages are capped at 100 rows. For normal scans, pass the returned top-level `cursor` into the next request. Clay notes that scans can reflect concurrent writes, so consumers that need each row once should deduplicate by a stable row ID.

## Setup

```bash
npm install
npm run validate
```

Authenticate locally before executing real API calls:

```bash
npm run auth
```

Then try a query:

```bash
npm run query -- '{"tables":[{"id":"t_..."}],"select":[{"field":"Domain","as":"domain"}],"field_mode":"names"}' 20
```

To publish:

```bash
npx packs register
npx packs create pack.ts --name "Clay Tables" --description "Query and sync Clay table data."
npx packs upload pack.ts --notes "Initial version."
```

## Query Examples

Basic selected fields:

```json
{
  "tables": [{ "id": "t_..." }],
  "select": [
    { "field": "Company Name", "as": "company_name" },
    { "field": "Domain", "as": "domain" }
  ],
  "filter": { "field": "Domain", "op": "is_not_empty" },
  "field_mode": "names"
}
```

Compound filter:

```json
{
  "tables": [{ "id": "t_..." }],
  "select": [{ "field": "Domain", "as": "domain" }],
  "filter": {
    "and": [
      { "field": "Domain", "op": "is_not_empty" },
      { "field": "Company Name", "op": "contains", "value": "Clay" }
    ]
  },
  "field_mode": "names"
}
```

`ClayRows` accepts `selectJson`, `filterJson`, and `orderByJson` as separate JSON strings. Use `idField` to point at a selected stable ID field whenever possible; otherwise the pack falls back to a hash of row values, which can change if the row changes.

## Flattened Sync Table

Add the `TypedClayTable` sync table and search using a full Clay table URL or a `t_...` table ID. The Pack samples the table to generate native Coda columns, flattens nested objects up to three levels, preserves primitive arrays, and keeps deeper objects or arrays of objects as JSON strings.

`People` and `Companies` are first-class sync entry points over the same typed engine. Choose the corresponding Clay table URL or ID when adding either sync table. People prefer person/contact IDs and names or emails for display; Companies prefer company/account IDs and company names or domains. Each uses a separate Coda identity so person and company references remain semantically distinct. Clay's Public API does not list tables or expose workspace Audiences directly, so the Pack cannot choose these source tables automatically.

## Clay Webhook Action

Use `SendToClayWebhook()` in a Coda button to push a row back into Clay. Copy the URL from a Clay table webhook source or a workflow's `On webhook call` trigger, then construct the payload with Coda's `JSON()` formula. For example:

```text
Clay::SendToClayWebhook(
  "https://api.clay.com/v3/sources/webhook/...",
  JSON({"email": thisRow.Email, "name": thisRow.Name, "sourceId": thisRow.Id})
)
```

The action accepts only HTTPS URLs hosted on `clay.com`. It sends the JSON object exactly once per button execution and returns the HTTP status and response body. Include a stable source ID in the payload when the Clay workflow needs to update or deduplicate an existing person or company; a webhook source otherwise commonly creates a new row.

Column types are inferred from Clay field metadata and sampled values. The Pack emits native numbers and booleans and applies Coda hints for ISO dates, date-times, URLs, and email addresses. Ambiguous identifiers such as phone numbers and postal codes remain text.

When a Clay value contains `optionsIds`, the Pack preserves the IDs. If the same cell value or its `fields` metadata includes an option dictionary, it also emits a sibling `optionsLabels` value with resolved labels. Unmapped IDs remain as fallbacks, so option data is never silently dropped.

The dynamic table includes `Raw JSON` and `Clay errors` fallback columns. It features at most 50 columns by default so very wide enrichment tables remain manageable; additional discovered columns remain available in Coda.

## Notes

- Clay table access is currently Enterprise-only.
- `order_by`, grouped, and aggregate queries may return `truncated: true` without a cursor, so the sync table may only receive the first page for those query shapes.
- Clay cell statuses are preserved in `cellsJson` and `statusesJson`; `valuesJson` unwraps only successful cells.
