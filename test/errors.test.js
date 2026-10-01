import test from "node:test";
import assert from "node:assert/strict";
import { normalizeError } from "../src/errors.js";

test("safe application errors keep their useful message", () => {
  const result = normalizeError(new Error("Panel not found."));
  assert.equal(result.code, "EVIX_ERROR");
  assert.equal(result.message, "Panel not found.");
  assert.match(result.reference, /^EVX-/);
});

test("infrastructure details are hidden from users", () => {
  const result = normalizeError(new Error("password=super-secret; connection failed"));
  assert.equal(result.message, "Something went wrong while processing your request.");
});

test("known database conflicts become friendly errors", () => {
  const result = normalizeError({ code: "23505", message: "duplicate key" });
  assert.equal(result.code, "EVIX_CONFLICT");
  assert.equal(result.message, "This item already exists.");
});
