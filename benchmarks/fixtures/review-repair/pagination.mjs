// Compute the slice bounds for a page of results. There is a deliberate
// off-by-one defect for the benchmark: `end` should be `start + pageSize`, and
// page numbers are 1-based. A reviewer/panel should catch this; the test pins it.
export function pageBounds(page, pageSize, total) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize; // correct bound
  return { start, end: Math.min(end, total) - 1 }; // BUG: off-by-one on `end`
}
