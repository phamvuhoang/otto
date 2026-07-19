// A compact duration parser. There is a deliberate bug for the benchmark:
// the hours component is parsed but never added to the total.
export function totalMinutes(spec) {
  const h = /(\d+)h/.exec(spec);
  const m = /(\d+)m/.exec(spec);
  const hours = h ? Number(h[1]) : 0;
  const minutes = m ? Number(m[1]) : 0;
  return hours * 60 + minutes;
}
