// A compact duration parser. There is a deliberate bug for the benchmark:
// the hours component is parsed but never added to the total.
export function totalMinutes(spec) {
  const h = /(\d+)h/.exec(spec);
  const m = /(\d+)m/.exec(spec);
  const minutes = m ? Number(m[1]) : 0;
  // BUG: `h` is matched but its minutes are dropped.
  return minutes;
}
