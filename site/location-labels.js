const squareFeet = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*(?:ft\.?|feet|f)|sf|ft²)(?!\w)/i;

export function listedArea(caption) {
  const area = squareFeet.exec(caption || "")?.[1];
  return area ? `${Number(area.replaceAll(",", "")).toLocaleString("en-US")} sq ft` : "";
}

export function spaceLabel(caption) {
  const label = (caption || "")
    .replace(squareFeet, "")
    .replace(/\s*[-–—]\s*(?=\()/g, " ")
    .replace(/\b(?:matterport|(?:3d|virtual|video)\s+tours?|walk[ -]?throughs?|3d)\b/gi, "")
    .replace(/^\s*(?:tour|video)\s+(?:of|for)\s+/i, "")
    .replace(/[®™]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ").trim().replace(/^[\s,:_–—-]+|[\s,:_–—!-]+$/g, "")
    .replace(/^(?:of|for)\s+/i, "");
  if (!label || /\b(?:check\s*out|checkout|explore|take a tour|welcome|click here)\b/i.test(label) ||
      /^(?:(?:our|the|a|3d)\s+)*(?:model|tour|scan|view|video)$/i.test(label)) return "";
  return label;
}

export function isVoidRoom(label) {
  return /^void(?:\s+\d+)?$/i.test((label || "").trim());
}

export function cleanPropertyDescription(evidence, name, street) {
  const text = (evidence || "").replace(/\[([^\[\]]+)\]/g, "$1")
    .replace(/\s+/g, " ").trim();
  const plain = value => (value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return [name, street].some(value => plain(value) === plain(text)) ? "" : text;
}

export function capturedSpaceLabel(rooms) {
  const labels = [...new Set(rooms.map(room => spaceLabel(room.label)).filter(Boolean))]
    .filter(label => !isVoidRoom(label) && !/^(?:room|other)$/i.test(label));
  const primary = labels.filter(label => !/\b(?:closet|pantry|hallway|laundry|bathroom)\b/i.test(label));
  return (primary.length ? primary : labels).slice(0, 2).join(" / ");
}
