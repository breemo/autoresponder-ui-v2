// src/components/FeatureSelector.jsx
import React from "react";

export default function FeatureSelector({
  allFeatures,      // [{id, name}, ...] من جدول features
  selectedIds,      // [featureId, ...]
  onChange,         // (newIds) => void
}) {
  const selectedSet = new Set(selectedIds || []);

  // الميزات المتاحة للاختيار (غير المختارة حاليًا)
  const available = (allFeatures || []).filter(
    (f) => !selectedSet.has(f.id)
  );

  function handleAdd(e) {
    const value = e.target.value;
    if (!value) return;

    const id = value; // uuid string
    if (selectedSet.has(id)) {
      e.target.value = "";
      return;
    }

    const next = [...selectedIds, id];
    onChange(next);
    e.target.value = "";
  }

  function remove(id) {
    const next = selectedIds.filter((x) => x !== id);
    onChange(next);
  }

  function selectAll() {
    const allIds = allFeatures.map((f) => f.id);
    onChange(allIds);
  }

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center gap-2 mb-3">
        <select
          onChange={handleAdd}
          className="border rounded px-3 py-2 w-full md:w-1/2"
          defaultValue=""
        >
          <option value="">اختر ميزة لإضافتها</option>
          {available.map((feat) => (
            <option key={feat.id} value={feat.id}>
              {feat.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={selectAll}
          className="border px-3 py-2 rounded text-sm hover:bg-gray-100"
        >
          تحديد كل الميزات
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(!selectedIds || selectedIds.length === 0) && (
          <span className="text-gray-400 text-sm">
            لا توجد ميزات مضافة بعد.
          </span>
        )}

        {selectedIds.map((id) => {
          const feat = allFeatures.find((f) => f.id === id);
          if (!feat) return null;
          return (
            <span
              key={id}
              className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-sm"
            >
              {feat.name}
              <button
                type="button"
                onClick={() => remove(id)}
                className="text-blue-500 hover:text-blue-700"
              >
                ✕
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
