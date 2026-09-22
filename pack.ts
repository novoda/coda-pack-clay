import * as sdk from "@codahq/packs-sdk";

export const pack = sdk.newPack();

const ClayApiBaseUrl = "https://api.clay.com/public/v0";
const MaxPageSize = 100;
const DefaultPageSize = 50;
const DynamicSchemaSampleSize = 5;
const MaxFlattenDepth = 3;
const MaxFeaturedColumns = 50;

const DynamicRowKeys = {
  id: "clayRowId",
  display: "clayDisplay",
  rawJson: "clayRawJson",
  errorsJson: "clayErrorsJson",
} as const;

pack.addNetworkDomain("clay.com");

pack.setUserAuthentication({
  type: sdk.AuthenticationType.CustomHeaderToken,
  headerName: "clay-api-key",
  instructionsUrl: "https://app.clay.com/settings/account",
  getConnectionName: async function (context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${ClayApiBaseUrl}/me`,
    });
    const body = response.body as ClayMeResponse;
    const userName = body.user.name || body.user.email || body.user.id;
    const workspaceName = body.workspace.name || body.workspace.id;
    return `${userName} (${workspaceName})`;
  },
});

const QueryResultSchema = sdk.makeObjectSchema({
  properties: {
    summary: {
      type: sdk.ValueType.String,
      description: "A compact summary of the query result.",
    },
    rowsJson: {
      type: sdk.ValueType.String,
      description: "The raw data array returned by Clay, encoded as JSON.",
    },
    valuesJson: {
      type: sdk.ValueType.String,
      description: "The same rows with successful cell values unwrapped, encoded as JSON.",
    },
    fieldsJson: {
      type: sdk.ValueType.String,
      description: "Field metadata returned by Clay, encoded as JSON.",
    },
    cursor: {
      type: sdk.ValueType.String,
      description: "Cursor to pass into the next request, if Clay returned one.",
    },
    truncated: {
      type: sdk.ValueType.Boolean,
      description: "Whether Clay found more rows but could not issue a cursor.",
    },
  },
  displayProperty: "summary",
});

const ClayWebhookResultSchema = sdk.makeObjectSchema({
  properties: {
    summary: {
      type: sdk.ValueType.String,
      required: true,
      description: "A compact delivery result.",
    },
    statusCode: {
      type: sdk.ValueType.Number,
      required: true,
      description: "HTTP status returned by the Clay webhook.",
    },
    responseJson: {
      type: sdk.ValueType.String,
      required: true,
      description: "The response returned by Clay, encoded as JSON or text.",
    },
  },
  displayProperty: "summary",
});

const ClayRowSchema = sdk.makeObjectSchema({
  properties: {
    id: {
      type: sdk.ValueType.String,
      required: true,
      description: "Stable row identifier. Select an ID field for best results.",
    },
    display: {
      type: sdk.ValueType.String,
      required: true,
      description: "Human-readable display value for the row.",
    },
    valuesJson: {
      type: sdk.ValueType.String,
      description: "Successful cell values unwrapped into a plain JSON object.",
    },
    cellsJson: {
      type: sdk.ValueType.String,
      description: "Raw Clay cell objects for this row.",
    },
    statusesJson: {
      type: sdk.ValueType.String,
      description: "Clay cell statuses by field.",
    },
    errorsJson: {
      type: sdk.ValueType.String,
      description: "Errored Clay cells by field.",
    },
    fieldsJson: {
      type: sdk.ValueType.String,
      description: "Field metadata returned by Clay for this sync page.",
    },
  },
  displayProperty: "display",
  idProperty: "id",
  featuredProperties: ["display", "valuesJson", "errorsJson"],
});

const FlattenedClayRowPlaceholderSchema = sdk.makeObjectSchema({
  properties: {
    [DynamicRowKeys.id]: {
      type: sdk.ValueType.String,
      required: true,
      displayName: "Clay row ID",
    },
    [DynamicRowKeys.display]: {
      type: sdk.ValueType.String,
      required: true,
      displayName: "Clay row",
    },
    [DynamicRowKeys.rawJson]: {
      type: sdk.ValueType.String,
      displayName: "Raw JSON",
      description: "Successful Clay values before flattening, encoded as JSON.",
    },
    [DynamicRowKeys.errorsJson]: {
      type: sdk.ValueType.String,
      displayName: "Clay errors",
      description: "Errored Clay cells for this row, encoded as JSON.",
    },
  },
  idProperty: DynamicRowKeys.id,
  displayProperty: DynamicRowKeys.display,
  featuredProperties: [DynamicRowKeys.display],
});

pack.addFormula({
  name: "QueryClayTables",
  description: "Runs a structured query across one or more Clay tables.",
  parameters: [
    sdk.makeParameter({
      type: sdk.ParameterType.String,
      name: "queryJson",
      description: "StructuredQuery JSON. Include tables, select, filter, joins, grouping, and ordering here.",
    }),
    sdk.makeParameter({
      type: sdk.ParameterType.Number,
      name: "limit",
      description: "Rows to return, from 1 to 100. Defaults to 50.",
      optional: true,
    }),
    sdk.makeParameter({
      type: sdk.ParameterType.String,
      name: "cursor",
      description: "Cursor from a previous response.",
      optional: true,
    }),
  ],
  resultType: sdk.ValueType.Object,
  schema: QueryResultSchema,
  execute: async function ([queryJson, limit, cursor], context) {
    const query = parseJsonObject(queryJson, "queryJson");
    const response = await runClayTableQuery(context, {
      query,
      limit: normalizeLimit(limit),
      cursor: cleanOptionalString(cursor),
    });
    return toQueryResult(response);
  },
});

pack.addFormula({
  name: "ClayTableId",
  description: "Extracts a Clay table ID from a Clay table URL or returns the ID unchanged.",
  parameters: [
    sdk.makeParameter({
      type: sdk.ParameterType.String,
      name: "tableIdOrUrl",
      description: "Clay table ID or URL containing /tables/{tableId}.",
    }),
  ],
  resultType: sdk.ValueType.String,
  execute: async function ([tableIdOrUrl]) {
    return extractTableId(tableIdOrUrl);
  },
});

pack.addFormula({
  name: "SendToClayWebhook",
  description: "Posts a JSON object to a Clay table or workflow webhook. Use this formula in a Coda button.",
  parameters: [
    sdk.makeParameter({
      type: sdk.ParameterType.String,
      name: "webhookUrl",
      description: "The HTTPS webhook URL copied from a Clay webhook source or workflow trigger.",
    }),
    sdk.makeParameter({
      type: sdk.ParameterType.String,
      name: "payloadJson",
      description: "A JSON object to send to Clay. Use JSON() in Coda to construct it from row values.",
    }),
  ],
  resultType: sdk.ValueType.Object,
  schema: ClayWebhookResultSchema,
  isAction: true,
  connectionRequirement: sdk.ConnectionRequirement.None,
  execute: async function ([webhookUrl, payloadJson], context) {
    const url = validateClayWebhookUrl(webhookUrl);
    const payload = parseJsonObject(payloadJson, "payloadJson");
    try {
      const response = await context.fetcher.fetch({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cacheTtlSecs: 0,
      });
      return {
        summary: `Sent to Clay (${response.status}).`,
        statusCode: response.status,
        responseJson: serializeResponseBody(response.body),
      };
    } catch (error) {
      throw new sdk.UserVisibleError(formatClayError(error));
    }
  },
});

pack.addSyncTable({
  name: "ClayRows",
  description: "Syncs rows from a known Clay table.",
  identityName: "ClayRow",
  schema: ClayRowSchema,
  formula: {
    name: "SyncClayRows",
    description: "Syncs rows from a Clay table query.",
    parameters: [
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "tableIdOrUrl",
        description: "Clay table ID or URL containing /tables/{tableId}.",
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "selectJson",
        description: "Optional JSON array of select entries. Example: [{\"field\":\"Domain\",\"as\":\"domain\"}].",
        optional: true,
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "filterJson",
        description: "Optional Clay filter expression JSON.",
        optional: true,
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "orderByJson",
        description: "Optional JSON array of order_by entries. Custom ordering does not support cursor pagination in Clay.",
        optional: true,
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "idField",
        description: "Selected field alias/name to use as the stable row ID. Defaults to id if present.",
        optional: true,
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "displayField",
        description: "Selected field alias/name to use as the row display value.",
        optional: true,
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.String,
        name: "fieldMode",
        description: "Use names or ids when referring to Clay fields. Defaults to names.",
        optional: true,
        autocomplete: ["names", "ids"],
      }),
      sdk.makeParameter({
        type: sdk.ParameterType.Number,
        name: "pageSize",
        description: "Rows to fetch per sync invocation, from 1 to 100. Defaults to 100.",
        optional: true,
      }),
    ],
    execute: async function (args, context) {
      const [
        tableIdOrUrl,
        selectJson,
        filterJson,
        orderByJson,
        idField,
        displayField,
        fieldMode,
        pageSize,
      ] = args;

      const query = buildSingleTableQuery({
        tableIdOrUrl,
        selectJson,
        filterJson,
        orderByJson,
        fieldMode,
      });
      const cursor = context.sync.continuation?.cursor as string | undefined;
      const response = await runClayTableQuery(context, {
        query,
        limit: normalizeLimit(pageSize, MaxPageSize),
        cursor,
      });

      const rows = response.data.map((record, index) => toSyncRow({
        record,
        fields: response.fields || {},
        idField: cleanOptionalString(idField) || "id",
        displayField: cleanOptionalString(displayField),
        fallbackIndex: index,
      }));

      const continuation = response.cursor ? { cursor: response.cursor } : undefined;
      return {
        result: rows,
        continuation,
      };
    },
  },
});

addTypedClaySyncTable({
  name: "TypedClayTable",
  formulaName: "SyncFlattenedClayTable",
  description: "Syncs a Clay table into native typed Coda columns, flattening nested values automatically.",
  identityName: "FlattenedClayRow",
  entityName: "Clay row",
  sourceLabel: "Clay table",
  syncedNamePrefix: "Clay",
  idKeys: ["id", "rowId", "recordId", "clayId"],
  displayKeys: ["fullName", "name", "companyName", "domain", "email", "title"],
});

addTypedClaySyncTable({
  name: "People",
  formulaName: "SyncClayPeople",
  description: "Syncs a Clay people table into typed, flattened Coda columns.",
  identityName: "ClayPerson",
  entityName: "Person",
  sourceLabel: "Clay people table",
  syncedNamePrefix: "Clay People",
  idKeys: ["personId", "contactId", "id", "rowId", "recordId", "clayId", "email"],
  displayKeys: ["fullName", "name", "email", "title", "companyName"],
});

addTypedClaySyncTable({
  name: "Companies",
  formulaName: "SyncClayCompanies",
  description: "Syncs a Clay companies table into typed, flattened Coda columns.",
  identityName: "ClayCompany",
  entityName: "Company",
  sourceLabel: "Clay companies table",
  syncedNamePrefix: "Clay Companies",
  idKeys: ["companyId", "accountId", "id", "rowId", "recordId", "clayId", "domain"],
  displayKeys: ["companyName", "name", "domain", "website"],
});

interface ClayMeResponse {
  user: {
    id: string;
    name: string | null;
    email?: string | null;
  };
  workspace: {
    id: string;
    name?: string | null;
  };
}

interface StructuredQueryRequest {
  query: Record<string, unknown>;
  cursor?: string;
  limit?: number;
}

interface ClayQueryResponse {
  data: Array<Record<string, ClayCell>>;
  cursor?: string;
  fields?: Record<string, ClayFieldMeta>;
  truncated?: boolean;
}

interface ClayFieldMeta {
  id: string;
  name: string;
  type: string;
}

type ClayCell = ClaySuccessCell | ClayErrorCell | ClayPendingCell | ClayEmptyCell;

interface ClaySuccessCell {
  status: "success";
  value?: unknown;
  fields: unknown;
  is_stale?: true;
}

interface ClayErrorCell {
  status: "error";
  error?: string;
}

interface ClayPendingCell {
  status: "running" | "queued" | "retry" | "rate_limited" | "awaiting_callback";
}

interface ClayEmptyCell {
  status: "empty";
}

interface BuildSingleTableQueryArgs {
  tableIdOrUrl: string;
  selectJson?: string;
  filterJson?: string;
  orderByJson?: string;
  fieldMode?: string;
}

interface ToSyncRowArgs {
  record: Record<string, ClayCell>;
  fields: Record<string, ClayFieldMeta>;
  idField: string;
  displayField?: string;
  fallbackIndex: number;
}

interface FlattenedClaySyncRow extends Record<string, unknown> {
  clayRowId: string;
  clayDisplay: string;
  clayRawJson: string;
  clayErrorsJson: string;
}

interface TypedClaySyncTableConfig {
  name: string;
  formulaName: string;
  description: string;
  identityName: string;
  entityName: string;
  sourceLabel: string;
  syncedNamePrefix: string;
  idKeys: string[];
  displayKeys: string[];
}

function addTypedClaySyncTable(config: TypedClaySyncTableConfig) {
  pack.addDynamicSyncTable({
    name: config.name,
    description: config.description,
    identityName: config.identityName,
    entityName: config.entityName,
    placeholderSchema: FlattenedClayRowPlaceholderSchema,
    defaultAddDynamicColumns: true,
    searchDynamicUrls: async function (_context, search) {
      const input = cleanOptionalString(search);
      if (!input) {
        return [];
      }
      try {
        const tableId = extractTableId(input);
        return [{
          display: `${config.sourceLabel} ${tableId}`,
          value: normalizeClayTableUrl(input, tableId),
        }];
      } catch {
        return [];
      }
    },
    getName: async function (context) {
      return `${config.syncedNamePrefix} ${getDynamicTableId(context)}`;
    },
    getDisplayUrl: async function (context) {
      const dynamicUrl = context.sync.dynamicUrl;
      const tableId = getDynamicTableId(context);
      return normalizeClayTableUrl(dynamicUrl || tableId, tableId);
    },
    getSchema: async function (context) {
      const tableId = getDynamicTableId(context);
      const response = await runClayTableQuery(context, {
        query: buildDynamicTableQuery(tableId),
        limit: DynamicSchemaSampleSize,
      });
      return makeFlattenedClaySchema(response);
    },
    formula: {
      name: config.formulaName,
      description: config.description,
      parameters: [
        sdk.makeParameter({
          type: sdk.ParameterType.String,
          name: "filterJson",
          description: "Optional Clay filter expression JSON.",
          optional: true,
        }),
        sdk.makeParameter({
          type: sdk.ParameterType.String,
          name: "orderByJson",
          description: "Optional JSON array of order_by entries. Custom ordering does not support cursor pagination in Clay.",
          optional: true,
        }),
        sdk.makeParameter({
          type: sdk.ParameterType.Number,
          name: "pageSize",
          description: "Rows to fetch per sync invocation, from 1 to 100. Defaults to 100.",
          optional: true,
        }),
      ],
      execute: async function ([filterJson, orderByJson, pageSize], context) {
        const tableId = getDynamicTableId(context);
        const query = buildDynamicTableQuery(
          tableId,
          parseOptionalJsonObject(filterJson, "filterJson"),
          parseOptionalJsonArray(orderByJson, "orderByJson"),
        );
        const cursor = context.sync.continuation?.cursor as string | undefined;
        const response = await runClayTableQuery(context, {
          query,
          limit: normalizeLimit(pageSize, MaxPageSize),
          cursor,
        });
        const rows = response.data.map((record, index) =>
          toFlattenedSyncRow(
            record,
            response.fields || {},
            index,
            config.idKeys,
            config.displayKeys,
          ),
        );
        return {
          result: rows,
          continuation: response.cursor ? { cursor: response.cursor } : undefined,
        };
      },
    },
  });
}

async function runClayTableQuery(
  context: sdk.ExecutionContext,
  request: StructuredQueryRequest,
): Promise<ClayQueryResponse> {
  try {
    const response = await context.fetcher.fetch({
      method: "POST",
      url: `${ClayApiBaseUrl}/tables/query`,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stripUndefined(request)),
      cacheTtlSecs: 0,
    });
    return response.body as ClayQueryResponse;
  } catch (error) {
    throw new sdk.UserVisibleError(formatClayError(error));
  }
}

function buildSingleTableQuery(args: BuildSingleTableQueryArgs): Record<string, unknown> {
  const fieldMode = cleanOptionalString(args.fieldMode) || "names";
  if (fieldMode !== "names" && fieldMode !== "ids") {
    throw new sdk.UserVisibleError("fieldMode must be either names or ids.");
  }

  const query: Record<string, unknown> = {
    tables: [{ id: extractTableId(args.tableIdOrUrl) }],
    field_mode: fieldMode,
  };

  const select = parseOptionalJsonArray(args.selectJson, "selectJson");
  if (select) {
    query.select = select;
  }

  const filter = parseOptionalJsonObject(args.filterJson, "filterJson");
  if (filter) {
    query.filter = filter;
  }

  const orderBy = parseOptionalJsonArray(args.orderByJson, "orderByJson");
  if (orderBy) {
    query.order_by = orderBy;
  }

  return query;
}

function buildDynamicTableQuery(
  tableId: string,
  filter?: Record<string, unknown>,
  orderBy?: unknown[],
): Record<string, unknown> {
  return stripUndefined({
    tables: [{ id: tableId }],
    field_mode: "names",
    filter,
    order_by: orderBy,
  });
}

function makeFlattenedClaySchema(response: ClayQueryResponse): sdk.GenericObjectSchema {
  const sampleValues = response.data.map(record => unwrapRecord(record));
  const fields = response.fields || {};
  const flattenedSamples = sampleValues.map(values =>
    normalizeFlattenedRecord(flattenRecord(values), fields),
  );
  const paths = new Map<string, unknown[]>();

  for (const flattened of flattenedSamples) {
    for (const [path, value] of Object.entries(flattened)) {
      const values = paths.get(path) || [];
      values.push(value);
      paths.set(path, values);
    }
  }

  for (const [fieldKey, field] of Object.entries(response.fields || {})) {
    const path = sampleValues.some(values => fieldKey in values)
      ? fieldKey
      : field.name || fieldKey;
    if (!hasPathOrDescendant(paths, path)) {
      paths.set(path, []);
    }
  }

  const properties: sdk.ObjectSchemaProperties = {
    ...FlattenedClayRowPlaceholderSchema.properties,
  };
  const dynamicPropertyKeys: string[] = [];
  for (const path of [...paths.keys()].sort((left, right) => left.localeCompare(right))) {
    const propertyKey = flattenedPropertyKey(path);
    properties[propertyKey] = {
      ...inferFlattenedSchema(path, paths.get(path) || [], findFieldMeta(path, fields)),
      displayName: path,
      description: `Flattened from Clay field path ${path}.`,
    };
    dynamicPropertyKeys.push(propertyKey);
  }

  return sdk.makeObjectSchema({
    properties,
    idProperty: DynamicRowKeys.id,
    displayProperty: DynamicRowKeys.display,
    featuredProperties: [
      DynamicRowKeys.display,
      ...dynamicPropertyKeys.slice(0, MaxFeaturedColumns - 1),
    ],
  });
}

function toFlattenedSyncRow(
  record: Record<string, ClayCell>,
  fields: Record<string, ClayFieldMeta>,
  fallbackIndex: number,
  idKeys: string[] = ["id", "rowId", "recordId", "clayId"],
  displayKeys: string[] = ["fullName", "name", "companyName", "domain", "email", "title"],
): FlattenedClaySyncRow {
  const values = unwrapRecord(record);
  const flattened = normalizeFlattenedRecord(flattenRecord(values), fields);
  const row: FlattenedClaySyncRow = {
    clayRowId: "",
    clayDisplay: "",
    clayRawJson: "",
    clayErrorsJson: "",
  };
  for (const [path, value] of Object.entries(flattened)) {
    row[flattenedPropertyKey(path)] = value;
  }

  const idValue = findPreferredValue(values, idKeys);
  const id = valueToString(idValue) || `row_${hashString(stableStringify(values))}_${fallbackIndex}`;
  const displayValue = findPreferredValue(values, displayKeys);
  row[DynamicRowKeys.id] = id;
  row[DynamicRowKeys.display] = valueToString(displayValue) || firstDisplayValue(values) || id;
  row[DynamicRowKeys.rawJson] = stableStringify(values);
  row[DynamicRowKeys.errorsJson] = stableStringify(recordErrors(record));
  return row;
}

function flattenRecord(record: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    flattenValue(value, [key], 1, flattened);
  }
  return flattened;
}

function flattenValue(
  value: unknown,
  path: string[],
  depth: number,
  output: Record<string, unknown>,
) {
  if (isPlainObject(value) && Object.keys(value).length > 0 && depth < MaxFlattenDepth) {
    for (const [key, child] of Object.entries(value)) {
      flattenValue(child, [...path, key], depth + 1, output);
    }
    return;
  }

  const pathKey = path.join(".");
  if (isPlainObject(value) || isObjectArray(value)) {
    output[pathKey] = stableStringify(value);
    return;
  }
  output[pathKey] = value;
}

function inferFlattenedSchema(
  path: string,
  values: unknown[],
  field?: ClayFieldMeta,
): sdk.Schema {
  const definedValues = values.filter(value => value !== null && value !== undefined);
  const sample = definedValues[0];
  if (typeof sample === "boolean" && definedValues.every(value => typeof value === "boolean")) {
    return { type: sdk.ValueType.Boolean };
  }
  if (typeof sample === "number" && definedValues.every(value => typeof value === "number")) {
    return { type: sdk.ValueType.Number };
  }
  if (Array.isArray(sample) && definedValues.every(value => isPrimitiveArray(value))) {
    const arrayItems = definedValues.flatMap(value => value as unknown[]);
    return {
      type: sdk.ValueType.Array,
      items: inferArrayItemSchema(path, arrayItems),
    };
  }
  if (typeof sample === "string" && definedValues.every(value => typeof value === "string")) {
    return inferStringSchema(path, definedValues as string[], field);
  }
  return schemaFromClayField(path, field);
}

function inferArrayItemSchema(path: string, values: unknown[]): sdk.Schema {
  const definedValues = values.filter(value => value !== null && value !== undefined);
  if (definedValues.length > 0 && definedValues.every(value => typeof value === "boolean")) {
    return { type: sdk.ValueType.Boolean };
  }
  if (definedValues.length > 0 && definedValues.every(value => typeof value === "number")) {
    return { type: sdk.ValueType.Number };
  }
  if (definedValues.length > 0 && definedValues.every(value => typeof value === "string")) {
    return inferStringSchema(path, definedValues as string[]);
  }
  return { type: sdk.ValueType.String };
}

function inferStringSchema(
  path: string,
  values: string[],
  field?: ClayFieldMeta,
): sdk.Schema {
  if (values.length > 0 && values.every(isIsoDateTime)) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.DateTime };
  }
  if (values.length > 0 && values.every(isIsoDate)) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Date };
  }
  if (values.length > 0 && values.every(isEmail)) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Email };
  }
  if (values.length > 0 && values.every(isHttpUrl)) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Url };
  }
  return schemaFromClayField(path, field);
}

function schemaFromClayField(path: string, field?: ClayFieldMeta): sdk.Schema {
  const type = normalizeFieldLookupKey(field?.type || "");
  const pathKey = normalizeFieldLookupKey(path);
  if (type.includes("datetime") || type.includes("timestamp")) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.DateTime };
  }
  if (type.includes("date")) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Date };
  }
  if (isNumericFieldType(type)) {
    return { type: sdk.ValueType.Number };
  }
  if (type.includes("boolean") || type.includes("checkbox")) {
    return { type: sdk.ValueType.Boolean };
  }
  if (type.includes("email") || pathKey.endsWith("email")) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Email };
  }
  if (
    type.includes("url") ||
    type.includes("website") ||
    pathKey.endsWith("url") ||
    pathKey.endsWith("website")
  ) {
    return { type: sdk.ValueType.String, codaType: sdk.ValueHintType.Url };
  }
  if (type.includes("array") || type.includes("list") || type.includes("multi")) {
    return {
      type: sdk.ValueType.Array,
      items: { type: sdk.ValueType.String },
    };
  }
  return { type: sdk.ValueType.String };
}

function normalizeFlattenedRecord(
  record: Record<string, unknown>,
  fields: Record<string, ClayFieldMeta>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(record)) {
    normalized[path] = normalizeFlattenedValue(value, findFieldMeta(path, fields));
  }
  return normalized;
}

function normalizeFlattenedValue(value: unknown, field?: ClayFieldMeta): unknown {
  const fieldType = normalizeFieldLookupKey(field?.type || "");
  if (typeof value === "string") {
    if (isNumericFieldType(fieldType) && isNumericString(value)) {
      return Number(value);
    }
    if (fieldType.includes("boolean") || fieldType.includes("checkbox")) {
      if (value.toLowerCase() === "true") {
        return true;
      }
      if (value.toLowerCase() === "false") {
        return false;
      }
    }
  }
  if (isPrimitiveArray(value)) {
    const itemTypes = new Set(
      value
        .filter(item => item !== null && item !== undefined)
        .map(item => typeof item),
    );
    if (itemTypes.size > 1) {
      return value.map(item => item === null || item === undefined ? item : String(item));
    }
  }
  return value;
}

function findFieldMeta(
  path: string,
  fields: Record<string, ClayFieldMeta>,
): ClayFieldMeta | undefined {
  const topLevelPath = normalizeFieldLookupKey(path.split(".")[0]);
  return Object.entries(fields).find(([key, field]) =>
    normalizeFieldLookupKey(key) === topLevelPath ||
    normalizeFieldLookupKey(field.name) === topLevelPath,
  )?.[1];
}

function normalizeFieldLookupKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isNumericFieldType(type: string): boolean {
  return ["number", "numeric", "integer", "float", "double", "decimal", "currency", "percent"]
    .some(candidate => type.includes(candidate));
}

function isNumericString(value: string): boolean {
  return /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i.test(value) && !Number.isNaN(Date.parse(value));
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

function isPrimitiveArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(item =>
    item === null || ["string", "number", "boolean"].includes(typeof item),
  );
}

function isObjectArray(value: unknown): boolean {
  return Array.isArray(value) && !isPrimitiveArray(value);
}

function hasPathOrDescendant(paths: Map<string, unknown[]>, path: string): boolean {
  return [...paths.keys()].some(candidate => candidate === path || candidate.startsWith(`${path}.`));
}

function flattenedPropertyKey(path: string): string {
  const readable = path
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "value";
  return `field_${readable}_${hashString(path)}`;
}

function findPreferredValue(
  values: Record<string, unknown>,
  preferredKeys: string[],
): unknown {
  const entries = Object.entries(values);
  for (const preferredKey of preferredKeys) {
    const match = entries.find(([key]) =>
      key.replace(/[^A-Za-z0-9]/g, "").toLowerCase() === preferredKey.toLowerCase(),
    );
    if (match && match[1] !== null && match[1] !== undefined && match[1] !== "") {
      return match[1];
    }
  }
  return undefined;
}

function getDynamicTableId(context: sdk.SyncExecutionContext): string {
  const dynamicUrl = context.sync.dynamicUrl;
  if (!dynamicUrl) {
    throw new sdk.UserVisibleError("Choose a Clay table URL or table ID.");
  }
  return extractTableId(dynamicUrl);
}

function normalizeClayTableUrl(input: string, tableId: string): string {
  const trimmed = input.trim();
  if (/^https:\/\/[^/]*clay\.com\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://app.clay.com/tables/${tableId}`;
}

function toQueryResult(response: ClayQueryResponse) {
  const values = response.data.map(row => unwrapRecord(row));
  const rowCount = response.data.length;
  const cursorSuffix = response.cursor ? " Cursor returned." : "";
  const truncatedSuffix = response.truncated ? " Result was truncated." : "";

  return {
    summary: `${rowCount} row${rowCount === 1 ? "" : "s"}.${cursorSuffix}${truncatedSuffix}`,
    rowsJson: stableStringify(response.data),
    valuesJson: stableStringify(values),
    fieldsJson: stableStringify(response.fields || {}),
    cursor: response.cursor,
    truncated: Boolean(response.truncated),
  };
}

function toSyncRow(args: ToSyncRowArgs) {
  const values = unwrapRecord(args.record);
  const statuses = recordStatuses(args.record);
  const errors = recordErrors(args.record);
  const idValue = valueToString(values[args.idField]);
  const fallbackId = `row_${hashString(stableStringify(values))}_${args.fallbackIndex}`;
  const id = idValue || fallbackId;
  const displayValue =
    valueToString(args.displayField ? values[args.displayField] : undefined) ||
    firstDisplayValue(values) ||
    id;

  return {
    id,
    display: displayValue,
    valuesJson: stableStringify(values),
    cellsJson: stableStringify(args.record),
    statusesJson: stableStringify(statuses),
    errorsJson: stableStringify(errors),
    fieldsJson: stableStringify(args.fields),
  };
}

function unwrapRecord(record: Record<string, ClayCell>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, cell] of Object.entries(record)) {
    values[key] = unwrapCell(cell);
  }
  return values;
}

function unwrapCell(cell: ClayCell): unknown {
  if (cell.status === "success") {
    return enrichClayOptionIds(cell.value ?? null, cell.fields);
  }
  return null;
}

export function enrichClayOptionIds(value: unknown, metadata?: unknown): unknown {
  const labels = new Map<string, string>();
  collectOptionLabels(value, labels);
  collectOptionLabels(metadata, labels);
  return addResolvedOptionLabels(value, labels);
}

function collectOptionLabels(
  value: unknown,
  labels: Map<string, string>,
  depth = 0,
) {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOptionLabels(item, labels, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }

  const optionId = firstPrimitiveProperty(value, ["id", "optionId", "option_id", "key", "value"]);
  const optionLabel = firstPrimitiveProperty(value, ["label", "name", "display", "text", "title"]);
  if (optionId !== undefined && optionLabel !== undefined) {
    labels.set(String(optionId), String(optionLabel));
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeFieldLookupKey(key);
    if (
      ["options", "choices", "optionvalues", "optionsbyid", "choicesbyid"].includes(normalizedKey) &&
      isPlainObject(child)
    ) {
      for (const [candidateId, candidate] of Object.entries(child)) {
        const candidateLabel = optionLabelFromValue(candidate);
        if (candidateLabel !== undefined) {
          labels.set(candidateId, candidateLabel);
        }
      }
    }
    collectOptionLabels(child, labels, depth + 1);
  }
}

function addResolvedOptionLabels(
  value: unknown,
  labels: Map<string, string>,
  depth = 0,
): unknown {
  if (depth > 20 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => addResolvedOptionLabels(item, labels, depth + 1));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const enriched: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    enriched[key] = addResolvedOptionLabels(child, labels, depth + 1);
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeFieldLookupKey(key);
    if (!["optionsids", "optionids", "optionid"].includes(normalizedKey)) {
      continue;
    }
    const ids = toOptionIdList(child);
    if (ids.length === 0) {
      continue;
    }
    const resolved = ids.map(id => labels.get(id));
    if (!resolved.some(Boolean)) {
      continue;
    }
    const labelKey = key.replace(/ids?$/i, "Labels");
    if (labelKey in enriched) {
      continue;
    }
    const values = ids.map((id, index) => resolved[index] || id);
    enriched[labelKey] = Array.isArray(child) ? values : values[0];
  }
  return enriched;
}

function firstPrimitiveProperty(
  value: Record<string, unknown>,
  keys: string[],
): string | number | boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (["string", "number", "boolean"].includes(typeof candidate)) {
      return candidate as string | number | boolean;
    }
  }
  return undefined;
}

function optionLabelFromValue(value: unknown): string | undefined {
  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value);
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const label = firstPrimitiveProperty(value, ["label", "name", "display", "text", "title", "value"]);
  return label === undefined ? undefined : String(label);
}

function toOptionIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter(item => ["string", "number", "boolean"].includes(typeof item))
      .map(String);
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return [String(value)];
  }
  return [];
}

function recordStatuses(record: Record<string, ClayCell>): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [key, cell] of Object.entries(record)) {
    statuses[key] = cell.status;
  }
  return statuses;
}

function recordErrors(record: Record<string, ClayCell>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, cell] of Object.entries(record)) {
    if (cell.status === "error") {
      errors[key] = cell.error || "Unknown Clay cell error.";
    }
  }
  return errors;
}

function extractTableId(tableIdOrUrl: string): string {
  const trimmed = tableIdOrUrl.trim();
  const match = trimmed.match(/(?:^|\/)(t_[A-Za-z0-9_-]+)(?:[/?#]|$)/);
  if (match) {
    return match[1];
  }
  if (/^t_[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  throw new sdk.UserVisibleError("Enter a Clay table ID like t_... or a Clay URL containing /tables/t_...");
}

export function validateClayWebhookUrl(webhookUrl: string): string {
  let url: URL;
  try {
    url = new URL(webhookUrl.trim());
  } catch {
    throw new sdk.UserVisibleError("webhookUrl must be a valid URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    throw new sdk.UserVisibleError("Clay webhook URLs must use HTTPS.");
  }
  if (hostname !== "clay.com" && !hostname.endsWith(".clay.com")) {
    throw new sdk.UserVisibleError("webhookUrl must point to a clay.com host.");
  }
  if (url.username || url.password) {
    throw new sdk.UserVisibleError("webhookUrl must not contain URL credentials.");
  }
  return url.toString();
}

function serializeResponseBody(body: unknown): string {
  if (body === undefined || body === null || body === "") {
    return "{}";
  }
  return typeof body === "string" ? body : stableStringify(body);
}

function parseJsonObject(input: string, label: string): Record<string, unknown> {
  const parsed = parseJson(input, label);
  if (!isPlainObject(parsed)) {
    throw new sdk.UserVisibleError(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseOptionalJsonObject(input: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!cleanOptionalString(input)) {
    return undefined;
  }
  return parseJsonObject(input!, label);
}

function parseOptionalJsonArray(input: string | undefined, label: string): unknown[] | undefined {
  if (!cleanOptionalString(input)) {
    return undefined;
  }
  const parsed = parseJson(input!, label);
  if (!Array.isArray(parsed)) {
    throw new sdk.UserVisibleError(`${label} must be a JSON array.`);
  }
  return parsed;
}

function parseJson(input: string, label: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new sdk.UserVisibleError(`${label} must be valid JSON.`);
  }
}

function normalizeLimit(limit: number | undefined, defaultValue = DefaultPageSize): number {
  if (limit === undefined || limit === null) {
    return defaultValue;
  }
  if (!Number.isFinite(limit)) {
    throw new sdk.UserVisibleError("limit/pageSize must be a number.");
  }
  const integerLimit = Math.floor(limit);
  if (integerLimit < 1 || integerLimit > MaxPageSize) {
    throw new sdk.UserVisibleError("limit/pageSize must be between 1 and 100.");
  }
  return integerLimit;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function stripUndefined(input: object): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDisplayValue(values: Record<string, unknown>): string | undefined {
  for (const value of Object.values(values)) {
    const display = valueToString(value);
    if (display) {
      return display;
    }
  }
  return undefined;
}

function valueToString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function formatClayError(error: unknown): string {
  const candidate = error as {
    message?: string;
    statusCode?: number;
    status?: number;
    body?: { message?: string } | string;
  };
  const status = candidate.statusCode || candidate.status;
  const bodyMessage =
    typeof candidate.body === "string" ? candidate.body : candidate.body?.message;
  const message = bodyMessage || candidate.message || "Clay API request failed.";
  return status ? `Clay API request failed (${status}): ${message}` : message;
}
