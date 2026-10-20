const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const { transformSync } = require("esbuild");
const filename = path.resolve(__dirname, "../pack.ts");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(transformSync(fs.readFileSync(filename, "utf8"), {
  loader: "ts", target: "es2020", format: "cjs",
}).code, filename);
const { makeClayPersonInput, pack } = compiled.exports;

test("preserves full JSON and exposes common person fields", () => {
  const input = JSON.stringify({
    clay_id: "person_123", first_name: "Jane", last_name: "Doe",
    work_email: "jane@example.com", linkedin_url: "https://linkedin.com/in/jane-doe",
    job_title: "Engineer", company: { name: "Example", domain: "example.com" },
    location: "London", custom: { scores: [1, 2], active: true },
  });
  const person = makeClayPersonInput(input);
  for (const [key, value] of Object.entries({ display: "Jane Doe", identifier: "person_123",
    identifierType: "clay_id", email: "jane@example.com", title: "Engineer",
    company: "Example", location: "London", linkedinUrl: "https://linkedin.com/in/jane-doe", rawJson: input })) {
    assert.equal(person[key], value, key);
  }
});

test("supports envelopes without using envelope IDs", () => {
  for (const payload of [
    { id: "request_123", person: { full_name: "Jane Doe", id: "person_123" } },
    { id: "request_123", data: { full_name: "Jane Doe", id: "person_123" } },
    { data: { id: "request_123", person: { full_name: "Jane Doe", id: "person_123" } } },
  ]) {
    const person = makeClayPersonInput(JSON.stringify(payload));
    assert.equal(person.name, "Jane Doe");
    assert.equal(person.clayId, "person_123");
    assert.deepEqual(JSON.parse(person.rawJson), payload);
  }
});

test("keeps JSON without identifiers and prevents sending it as a Clay ID", async () => {
  const input = '{"email":"jane@example.com","extra":true}';
  assert.equal(makeClayPersonInput(input).display, "jane@example.com");
  assert.equal(makeClayPersonInput(input).identifier, "");
  const formula = pack.formulas.find(formula => formula.name === "EnrichClayPerson");
  await assert.rejects(() => formula.execute(["https://api.clay.com/webhook/test", input], {}), /no Clay ID or LinkedIn URL/);
});

test("retains URL and ID input behavior and rejects invalid inputs", () => {
  assert.deepEqual(makeClayPersonInput(" person_123 "), {
    display: "person_123", identifier: "person_123", identifierType: "clay_id",
  });
  assert.equal(makeClayPersonInput("linkedin.com/in/jane-doe").identifier, "https://linkedin.com/in/jane-doe");
  assert.throws(() => makeClayPersonInput("https://linkedin.com/company/example"), /\/in\//);
  assert.throws(() => makeClayPersonInput('{"name":'), /valid JSON/);
  assert.throws(() => makeClayPersonInput('[{"name":"Jane"}]'), /JSON object/);
  assert.throws(() => makeClayPersonInput(" "), /Enter a Clay ID/);
});

test("column formula parses JSON and both formulas expose the person schema", async () => {
  for (const name of ["ClayPersonInput", "EnrichClayPerson"]) {
    const formula = pack.formulas.find(formula => formula.name === name);
    const keys = Object.keys(formula.schema.properties).map(key => key.toLowerCase());
    assert.ok(keys.includes("rawjson"));
    assert.ok(keys.includes("email"));
  }
  const formula = pack.formulas.find(formula => formula.name === "ClayPersonInput");
  const input = '{"Name":"Jane Doe","LinkedIn URL":"https://linkedin.com/in/jane-doe"}';
  const result = await formula.execute([input], {});
  assert.equal(result.display, "Jane Doe");
  assert.equal(result.identifierType, "linkedin_url");
  assert.equal(result.rawJson, input);
});

test("enrichment retains stored JSON and sends only the resolved identifier", async () => {
  const formula = pack.formulas.find(formula => formula.name === "EnrichClayPerson");
  const input = '{"name":"Jane Doe","clayId":"person_123","extra":[1,2]}';
  let request;
  const result = await formula.execute(["https://api.clay.com/webhook/test", input], {
    fetcher: { fetch: async value => { request = value; return { status: 202, body: { accepted: true } }; } },
  });
  assert.deepEqual(JSON.parse(request.body), { entityType: "person", identifier: "person_123", identifierType: "clay_id" });
  assert.equal(result.rawJson, input);
  assert.equal(result.display, "Jane Doe");
});
