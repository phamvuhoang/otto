// Summarize a list of {name, bytes} files. The benchmark feature is to render
// each size human-readably (e.g. "1.0 KB") using a new helper in units.mjs.
export function summarize(files) {
  return files.map((f) => `${f.name}: ${f.bytes} bytes`).join("\n");
}
