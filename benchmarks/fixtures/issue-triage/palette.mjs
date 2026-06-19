const PALETTE = {
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
};

export function colour(name) {
  return PALETTE[name] ?? null;
}
