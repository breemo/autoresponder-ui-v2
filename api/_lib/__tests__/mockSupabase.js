// Minimal in-memory Supabase-js query-builder stand-in for tests.
//
// Originally written for Phase 3 (api/_lib/aiContext.js — read-only:
// select/eq/order/limit/maybeSingle). Extended in Phase 4A to also
// support insert/update/delete (api/_lib/knowledgeIngestion.js needs to
// actually mutate its fixture tables — mark a document processing/ready/
// failed, replace chunk rows). Purely additive: every Phase 3 test still
// only exercises the read path, unaffected by this extension.
//
// Message Pagination / Load Older Messages: added `.or()` (a small
// PostgREST filter-string evaluator, restricted to the shapes this
// codebase's own .or() callers actually build — a comma-separated list of
// `col.op."value"` and/or `and(col.op."value",col2.op."value2")` clauses)
// and made `.order()` accumulate multiple calls into one real multi-column
// sort (primary/secondary, matching `ORDER BY a, b` — a single `.order()`
// call anywhere else in this file's existing tests is unaffected, since a
// one-spec sort is exactly what it already did).
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of str) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseOrCondition(cond) {
  const m = cond.trim().match(/^([a-zA-Z_]+)\.([a-z]+)\."(.*)"$/);
  if (!m) return null;
  return { col: m[1], op: m[2], value: m[3] };
}

function compareForOr(rowVal, value) {
  const looksLikeDate = typeof rowVal === "string" && /^\d{4}-\d{2}-\d{2}/.test(rowVal);
  if (looksLikeDate) {
    const a = Date.parse(rowVal);
    const b = Date.parse(value);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  }
  const a = String(rowVal);
  const b = String(value);
  return a < b ? -1 : a > b ? 1 : 0;
}

function evalOrCondition(row, cond) {
  const parsed = parseOrCondition(cond);
  if (!parsed) return false;
  const cmp = compareForOr(row[parsed.col], parsed.value);
  if (parsed.op === "eq") return cmp === 0;
  if (parsed.op === "lt") return cmp < 0;
  if (parsed.op === "gt") return cmp > 0;
  return false;
}

function evalOrClause(row, clause) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("and(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(4, -1);
    return splitTopLevel(inner, ",").every((c) => evalOrCondition(row, c));
  }
  return evalOrCondition(row, trimmed);
}

export function createMockSupabase(tables) {
  return {
    from(table) {
      if (!tables[table]) tables[table] = [];
      const rows = tables[table];
      let filtered = rows;
      let mode = "select"; // "select" | "delete" | "update"
      let updatePayload = null;
      let sortSpecs = [];

      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        in(col, values) {
          const set = new Set(Array.isArray(values) ? values : []);
          filtered = filtered.filter((row) => set.has(row[col]));
          return builder;
        },
        or(filterStr) {
          const clauses = splitTopLevel(String(filterStr || ""), ",");
          filtered = filtered.filter((row) => clauses.some((clause) => evalOrClause(row, clause)));
          return builder;
        },
        order(col, opts) {
          const ascending = opts?.ascending !== false;
          sortSpecs = [...sortSpecs, { col, ascending }];
          filtered = [...filtered].sort((a, b) => {
            for (const spec of sortSpecs) {
              if (a[spec.col] < b[spec.col]) return spec.ascending ? -1 : 1;
              if (a[spec.col] > b[spec.col]) return spec.ascending ? 1 : -1;
            }
            return 0;
          });
          return builder;
        },
        limit(n) {
          filtered = filtered.slice(0, n);
          return builder;
        },
        async maybeSingle() {
          return { data: filtered[0] || null, error: null };
        },
        async single() {
          return filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "no rows found" } };
        },
        delete() {
          mode = "delete";
          return builder;
        },
        update(payload) {
          mode = "update";
          updatePayload = payload;
          return builder;
        },
        // Not part of the select/delete/update chain — called and
        // awaited directly, matching how every real call site in this
        // codebase uses it (`await supabase.from(x).insert(rows)`, never
        // further chained).
        async insert(rowsToInsert) {
          const toInsert = Array.isArray(rowsToInsert) ? rowsToInsert : [rowsToInsert];
          for (const row of toInsert) rows.push(row);
          return { data: toInsert, error: null };
        },
        // Thenable — lets `await supabase.from(x).select().eq(...)` (or
        // `.delete().eq(...)` / `.update(...).eq(...)`) resolve to
        // { data, error }, matching real supabase-js behavior. delete/
        // update mutate the underlying fixture array in place so a
        // later query in the same test sees the change.
        then(resolve, reject) {
          if (mode === "delete") {
            const toRemove = new Set(filtered);
            for (let i = rows.length - 1; i >= 0; i--) {
              if (toRemove.has(rows[i])) rows.splice(i, 1);
            }
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          }
          if (mode === "update") {
            for (const row of filtered) Object.assign(row, updatePayload);
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
      };

      return builder;
    },
  };
}
