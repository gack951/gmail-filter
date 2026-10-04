export type CriteriaInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
  query: string;
};

export type ActionsInput = {
  markRead: boolean;
  archive: boolean;
  trash: boolean;
  star: boolean;
  important: boolean;
  labelId: string;
  newLabelName: string;
};

export type FilterSpec = {
  criteria: Record<string, string | boolean>;
  action: { addLabelIds: string[]; removeLabelIds: string[] };
  searchQuery: string;
};

export function buildFilterSpec(criteria: CriteriaInput, actions: ActionsInput): FilterSpec {
  const gmailCriteria: Record<string, string | boolean> = { excludeChats: true };
  const searchParts: string[] = [];
  if (criteria.from) {
    gmailCriteria.from = criteria.from;
    searchParts.push(`from:${gmailQuote(criteria.from)}`);
  }
  if (criteria.to) {
    gmailCriteria.to = criteria.to;
    searchParts.push(`to:${gmailQuote(criteria.to)}`);
  }
  if (criteria.subject) {
    gmailCriteria.subject = criteria.subject;
    searchParts.push(`subject:${gmailQuote(criteria.subject)}`);
  }
  const query = [criteria.body ? gmailQuote(criteria.body) : "", criteria.query].filter(Boolean).join(" ");
  if (query) gmailCriteria.query = query;
  if (criteria.body) searchParts.push(gmailQuote(criteria.body));
  if (criteria.query) searchParts.push(criteria.query);

  const addLabelIds = [
    actions.trash ? "TRASH" : "",
    actions.star ? "STARRED" : "",
    actions.important ? "IMPORTANT" : "",
    actions.labelId,
  ].filter(Boolean);
  const removeLabelIds = [actions.markRead ? "UNREAD" : "", actions.archive ? "INBOX" : ""].filter(Boolean);
  return { criteria: gmailCriteria, action: { addLabelIds, removeLabelIds }, searchQuery: searchParts.join(" ") };
}

function gmailQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
