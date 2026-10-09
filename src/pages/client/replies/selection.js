// Checkbox presentation of the former native <select multiple>, with the
// SAME options (every quick reply, value = its payload) and the SAME
// resulting value: after any change the array is rebuilt from the checked
// options in option order — exactly what Array.from(select.selectedOptions)
// produced. Untouched, the stored array is kept as-is.
export function nextHideAfterSelection(options, current, toggledIndex) {
  const selected = new Set(current || []);
  return options
    .filter((opt, i) => (i === toggledIndex ? !selected.has(opt.value) : selected.has(opt.value)))
    .map((opt) => opt.value);
}
