import test from "node:test";
import assert from "node:assert/strict";
import { resolveClientRoute } from "../../client-router.js";

// Vercel Hobby Function-count consolidation — verifies every old top-level
// API URL's request shape still maps to the intended consolidated
// resource after api/client-users.js and api/client-ai-behavior.js were
// folded into api/client-router.js. Network-free: resolveClientRoute is a
// pure function, no Supabase involved. api/client-integrations.js was
// deliberately NOT folded into this router (see api/client-router.js's
// header comment) and is therefore not covered here.

test("?resource=users routes to the former api/client-users.js logic", () => {
  assert.equal(resolveClientRoute({ query: { resource: "users", actor_user_id: "u1" } }), "users");
});

test("?resource=ai-behavior routes to the former api/client-ai-behavior.js logic", () => {
  assert.equal(resolveClientRoute({ query: { resource: "ai-behavior", actor_user_id: "u1" } }), "ai-behavior");
});

test("an unrecognized resource returns a controlled null (handler responds 400 'Unknown resource')", () => {
  assert.equal(resolveClientRoute({ query: { resource: "integrations" } }), null);
  assert.equal(resolveClientRoute({ query: { resource: "not_a_real_resource" } }), null);
});

test("a missing resource query param returns a controlled null (handler responds 400 'Unknown resource')", () => {
  assert.equal(resolveClientRoute({ query: {} }), null);
  assert.equal(resolveClientRoute({}), null);
});
