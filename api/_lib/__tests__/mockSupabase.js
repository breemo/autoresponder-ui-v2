// Minimal in-memory Supabase-js query-builder stand-in for tests.
//
// Originally written for Phase 3 (api/_lib/aiContext.js — read-only:
// select/eq/order/limit/maybeSingle). Extended in Phase 4A to also
// support insert/update/delete (api/_lib/knowledgeIngestion.js needs to
// actually mutate its fixture tables — mark a document processing/ready/
// failed, replace chunk rows). Purely additive: every Phase 3 test still
// only exercises the read path, unaffected by this extension.
export function createMockSupabase(tables) {
  return {
    from(table) {
      if (!tables[table]) tables[table] = [];
      const rows = tables[table];
      let filtered = rows;
      let mode = "select"; // "select" | "delete" | "update"
      let updatePayload = null;

      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filtered = filtered.filter((row) => row[col] === val);
          return builder;
        },
        order(col, opts) {
          const ascending = opts?.ascending !== false;
          filtered = [...filtered].sort((a, b) => {
            if (a[col] < b[col]) return ascending ? -1 : 1;
            if (a[col] > b[col]) return ascending ? 1 : -1;
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
