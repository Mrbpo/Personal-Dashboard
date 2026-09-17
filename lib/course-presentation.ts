export function presentCourse(code: string, name: string) {
  const raw = `${code} ${name}`.toUpperCase();
  const match = raw.match(/\b([A-Z]{3,5})(\d{2,3})(H\d)\b/);
  const displayCode = match ? `${match[1]} ${match[2]} ${match[3]}` : code.replace(/\s+(?:F|S)\b.*$/i, "").trim();
  const colon = name.indexOf(":");
  const rawTitle = colon >= 0 ? name.slice(colon + 1).trim() : name.trim();
  const courseTitle = rawTitle
    .replace(/^\s*[A-Z]{3,5}\d{2,3}H\d.*?:\s*/i, "")
    .replace(/\bI\b/g, "1")
    .replace(/\bII\b/g, "2")
    .replace(/\bIII\b/g, "3")
    .trim();
  return { displayCode, courseTitle: courseTitle || displayCode };
}
