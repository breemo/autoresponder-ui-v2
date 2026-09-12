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

// Conversation List Pagination extended this to also recognize
// `col.is.null` and `col.in.(v1,v2,v3)` (the null-last_message_at bucket
// filter and the search fan-out's trusted-uuid-list translation query) and
// `col.ilike."pattern"` (SQL LIKE-style % / _ wildcards, case-insensitive
// — the search fan-out's free-text conditions).
function parseOrCondition(cond) {
  const trimmed = cond.trim();
  const isNullMatch = trimmed.match(/^([a-zA-Z_]+)\.is\.null$/);
  if (isNullMatch) return { col: isNullMatch[1], op: "isnull" };
  const inMatch = trimmed.match(/^([a-zA-Z_]+)\.in\.\((.*)\)$/);
  if (inMatch) {
    return {
      col: inMatch[1],
      op: "in",
      values: inMatch[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  const m = trimmed.match(/^([a-zA-Z_]+)\.([a-z]+)\."(.*)"$/);
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

function likePatternToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function evalOrCondition(row, cond) {
  const parsed = parseOrCondition(cond);
  if (!parsed) return false;
  if (parsed.op === "isnull") return row[parsed.col] === null || row[parsed.col] === undefined;
  if (parsed.op === "in") return row[parsed.col] !== undefined && parsed.values.includes(String(row[parsed.col]));
  if (parsed.op === "ilike") return typeof row[parsed.col] === "string" && likePatternToRegex(parsed.value).test(row[parsed.col]);
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
      // Conversation List Pagination (total_count): { count: "exact", head:
      // true } support, matching the precedent already established in
      // api/_lib/__tests__/dashboardSummary.test.js's own local mock —
      // count reflects the fully-filtered row set regardless of any
      // subsequent .limit() (real Postgres head:true behavior); head:true
      // returns null data (no rows transferred).
      let wantCount = false;
      let wantHead = false;
      let preLimitCount = null;

      const builder = {
        select(_col, opts) {
          if (opts && opts.count) wantCount = true;
          if (opts && opts.head) wantHead = true;
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
        is(col, value) {
          filtered =
            value === null
              ? filtered.filter((row) => row[col] === null || row[col] === undefined)
              : filtered.filter((row) => row[col] === value);
          return builder;
        },
        lt(col, value) {
          filtered = filtered.filter((row) => compareForOr(row[col], value) < 0);
          return builder;
        },
        gt(col, value) {
          filtered = filtered.filter((row) => compareForOr(row[col], value) > 0);
          return builder;
        },
        ilike(col, pattern) {
          const regex = likePatternToRegex(pattern);
          filtered = filtered.filter((row) => typeof row[col] === "string" && regex.test(row[col]));
          return builder;
        },
        or(filterStr) {
          const clauses = splitTopLevel(String(filterStr || ""), ",");
          filtered = filtered.filter((row) => clauses.some((clause) => evalOrClause(row, clause)));
          return builder;
        },
        // Conversation List Pagination: null-aware, matching Postgres's own
        // NULLS FIRST/LAST semantics (default nullsFirst = !ascending, same
        // as real Postgres, unless the caller passes an explicit value —
        // this codebase's new callers always do). A pre-existing
        // single-column .order() call with no nulls in its fixture data is
        // completely unaffected.
        order(col, opts) {
          const ascending = opts?.ascending !== false;
          const nullsFirst = opts?.nullsFirst !== undefined ? opts.nullsFirst : !ascending;
          sortSpecs = [...sortSpecs, { col, ascending, nullsFirst }];
          filtered = [...filtered].sort((a, b) => {
            for (const spec of sortSpecs) {
              const av = a[spec.col];
              const bv = b[spec.col];
              const aNull = av === null || av === undefined;
              const bNull = bv === null || bv === undefined;
              if (aNull && bNull) continue;
              if (aNull) return spec.nullsFirst ? -1 : 1;
              if (bNull) return spec.nullsFirst ? 1 : -1;
              if (av < bv) return spec.ascending ? -1 : 1;
              if (av > bv) return spec.ascending ? 1 : -1;
            }
            return 0;
          });
          return builder;
        },
        limit(n) {
          preLimitCount = filtered.length;
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
          const result = { data: wantHead ? null : filtered, error: null };
          if (wantCount) result.count = preLimitCount !== null ? preLimitCount : filtered.length;
          return Promise.resolve(result).then(resolve, reject);
        },
      };

      return builder;
    },
  };
}
