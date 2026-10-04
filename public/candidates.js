export function subjectCandidates(subject) {
  const full = subject.trim();
  if (!full || full === "（件名なし）") return [];
  const cleaned = full
    .normalize("NFKC")
    .replace(/\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?(?:の)?/g, " ")
    .replace(/\d{1,2}月(?:\d{1,2}日)?(?:の)?/g, " ")
    .replace(/(?:ご)?(?:注文|受付|予約|伝票|請求|管理)(?:番号|No\.?|ID)?\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{3,}/gi, " ")
    .replace(/(?:No\.?|ID)\s*[:#-]?\s*[A-Z0-9-]{4,}/gi, " ")
    .replace(/[#]\s*[A-Z0-9-]{4,}|\b\d{4,}\b/gi, " ")
    .replace(/[\s\-–—:()[\]{}【】]+/g, " ")
    .trim()
    .replace(/^の/, "");
  return cleaned && cleaned !== full ? [full, cleaned] : [full];
}
