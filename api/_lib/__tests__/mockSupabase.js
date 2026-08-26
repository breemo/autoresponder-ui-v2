// Minimal in-memory Supabase-js query-builder stand-in for tests. Only
// implements the exact chain shapes api/_lib/aiContext.js actually uses
// (select/eq/order/limit/maybeSingle, plus direct-await for multi-row
// results) — not a general-purpose Supabase mock.
export function createMockSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      let filtered = rows;

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
        // Thenable — lets `await supabase.from(x).select().eq(...)`
        // resolve to { data: [...], error: null } for the multi-row case,
        // matching real supabase-js behavior.
        then(resolve, reject) {
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
      };

      return builder;
    },
  };
}
