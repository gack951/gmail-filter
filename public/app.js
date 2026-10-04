const loading = document.querySelector("#loading");
const login = document.querySelector("#login");
const app = document.querySelector("#app");
const account = document.querySelector("#account");
const form = document.querySelector("#filter-form");
const submitButton = document.querySelector("#submit-button");
const labelSelect = document.querySelector("#label-select");
const newLabel = document.querySelector("#new-label");
const inbox = document.querySelector("#inbox");
const rules = document.querySelector("#rules");
const toast = document.querySelector("#toast");
const subjectInput = document.querySelector("#subject-input");
const bodyInput = document.querySelector("#body-input");
let labels = [];
let selectedMessage = null;

const criteriaNames = { from: "差出人", to: "宛先", subject: "件名", query: "本文・検索", negatedQuery: "含まない" };
const systemActions = {
  "add:TRASH": "削除", "add:STARRED": "スター", "add:IMPORTANT": "重要",
  "remove:INBOX": "アーカイブ", "remove:UNREAD": "既読", "remove:SPAM": "迷惑メールにしない",
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  if (response.status === 401) throw Object.assign(new Error("ログインが必要です。"), { unauthorized: true });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `エラーが発生しました (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

async function load() {
  try {
    const data = await request("/api/bootstrap");
    labels = data.labels;
    document.querySelector("#account-email").textContent = data.user.email;
    renderLabelOptions();
    renderInbox(data.inbox);
    renderRules(data.filters);
    loading.hidden = true;
    account.hidden = false;
    app.hidden = false;
  } catch (error) {
    loading.hidden = true;
    login.hidden = false;
    if (!error.unauthorized) showToast(error.message, true);
    showQueryError();
  }
}

function renderInbox(messages) {
  inbox.replaceChildren();
  if (!messages.length) {
    inbox.append(element("p", "empty", "受信トレイにメールがありません。"));
    return;
  }
  for (const message of messages) {
    const button = element("button", "mail-row");
    button.type = "button";
    button.dataset.id = message.id;
    const top = element("span", "mail-top");
    top.append(element("strong", "", displaySender(message.from)), element("time", "", shortDate(message.date)));
    button.append(top, element("span", "mail-subject", message.subject), element("small", "", message.snippet));
    button.addEventListener("click", () => selectMessage(message, button));
    inbox.append(button);
  }
}

async function selectMessage(message, button) {
  document.querySelectorAll(".mail-row.selected").forEach((row) => row.classList.remove("selected"));
  button.classList.add("selected");
  selectedMessage = { ...message, text: message.snippet, loading: true, truncated: false };
  form.elements.from.value = message.fromAddress;
  document.querySelector("#selected-mail").hidden = false;
  document.querySelector("#selected-subject").textContent = message.subject;
  document.querySelector("#selected-from").textContent = message.from;
  document.querySelector("#content-status").textContent = "本文を取得中…";
  updateMatches();
  const requestedId = message.id;
  try {
    const content = await request(`/api/messages/${encodeURIComponent(message.id)}/content`);
    if (selectedMessage?.id !== requestedId) return;
    selectedMessage = { ...content, loading: false };
    document.querySelector("#content-status").textContent = selectedMessage.truncated ? "本文先頭200,000文字で照合" : "件名・本文を照合できます";
  } catch (error) {
    if (selectedMessage?.id !== requestedId) return;
    selectedMessage.loading = false;
    document.querySelector("#content-status").textContent = "本文を取得できませんでした";
    showToast(error.message, true);
  }
  updateMatches();
}

document.querySelector("#clear-selected").addEventListener("click", () => {
  selectedMessage = null;
  document.querySelector("#selected-mail").hidden = true;
  document.querySelectorAll(".mail-row.selected").forEach((row) => row.classList.remove("selected"));
  updateMatches();
});

document.querySelector("#refresh-inbox").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    renderInbox((await request("/api/inbox")).inbox);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function updateMatches() {
  showMatch("#subject-match", subjectInput.value, selectedMessage?.subject, false, false);
  showMatch("#body-match", bodyInput.value, selectedMessage?.text, Boolean(selectedMessage?.truncated), Boolean(selectedMessage?.loading));
}

function showMatch(selector, word, target, truncated, isLoading) {
  const output = document.querySelector(selector);
  output.className = "match";
  if (!word.trim() || !selectedMessage) {
    output.textContent = "";
    return;
  }
  if (isLoading) {
    output.textContent = "照合中…";
    return;
  }
  const matched = normalize(target).includes(normalize(word));
  output.textContent = matched ? "選択メールに一致" : truncated ? "取得範囲では不一致" : "選択メールに不一致";
  output.classList.add(matched ? "ok" : "ng");
}

subjectInput.addEventListener("input", updateMatches);
bodyInput.addEventListener("input", updateMatches);

function renderLabelOptions() {
  labelSelect.replaceChildren(new Option("なし", ""));
  for (const label of labels.filter((item) => item.type === "user")) labelSelect.append(new Option(label.name, label.id));
}

function renderRules(filters) {
  document.querySelector("#rule-count").textContent = String(filters.length);
  rules.replaceChildren();
  if (!filters.length) {
    rules.append(element("p", "empty", "登録済みフィルタはありません。"));
    return;
  }
  for (const filter of filters) rules.append(ruleRow(filter));
}

function ruleRow(filter) {
  const row = element("div", "rule-row");
  const text = element("span", "rule-text");
  const conditions = Object.entries(filter.criteria)
    .filter(([key]) => !["excludeChats", "sizeComparison"].includes(key))
    .map(([key, value]) => `${criteriaNames[key] || key}:${value}`);
  const actions = [
    ...filter.action.addLabelIds.map((id) => actionName("add", id)),
    ...filter.action.removeLabelIds.map((id) => actionName("remove", id)),
  ];
  text.textContent = `${conditions.join(" / ")} → ${actions.join(" / ")}`;
  const button = element("button", "delete-button", "削除");
  button.type = "button";
  button.addEventListener("click", () => deleteFilter(filter.id, button));
  row.append(text, button);
  return row;
}

function actionName(operation, id) {
  const known = systemActions[`${operation}:${id}`];
  if (known) return known;
  const label = labels.find((item) => item.id === id);
  return operation === "add" ? `ラベル:${label?.name || id}` : `${label?.name || id}を外す`;
}

async function deleteFilter(id, button) {
  if (!window.confirm("このフィルタを削除しますか？\n処理済みメールは元に戻りません。")) return;
  button.disabled = true;
  try {
    await request(`/api/filters/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("フィルタを削除しました。");
    await refreshRules();
  } catch (error) {
    button.disabled = false;
    showToast(error.message, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(form);
  const payload = {
    criteria: Object.fromEntries(["from", "to", "subject", "body", "query"].map((key) => [key, values.get(key)])),
    actions: {
      markRead: values.has("markRead"), archive: values.has("archive"), trash: values.has("trash"),
      star: values.has("star"), important: values.has("important"), labelId: values.get("labelId"), newLabelName: values.get("newLabelName"),
    },
    applyExisting: values.has("applyExisting"),
  };
  setSubmitting(true);
  try {
    const result = await request("/api/filters", { method: "POST", body: JSON.stringify(payload) });
    let message = payload.applyExisting ? `作成完了。既存メール ${result.appliedCount} 件に適用しました。` : "フィルタを作成しました。";
    if (result.truncated) message += " 10,000件で停止しています。";
    if (result.warning) message = result.warning;
    showToast(message, Boolean(result.warning));
    form.reset();
    form.elements.applyExisting.checked = true;
    labelSelect.disabled = false;
    newLabel.disabled = false;
    updateMatches();
    await refreshRules();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setSubmitting(false);
  }
});

async function refreshRules() {
  const data = await request("/api/filters");
  labels = data.labels;
  renderLabelOptions();
  renderRules(data.filters);
}

function setSubmitting(value) {
  submitButton.disabled = value;
  submitButton.textContent = value ? "作成中…" : "フィルタを作成";
}

labelSelect.addEventListener("change", () => {
  newLabel.disabled = Boolean(labelSelect.value);
  if (labelSelect.value) newLabel.value = "";
});
newLabel.addEventListener("input", () => {
  labelSelect.disabled = Boolean(newLabel.value.trim());
  if (newLabel.value.trim()) labelSelect.value = "";
});

function displaySender(value) {
  return value.replace(/\s*<[^>]+>\s*$/, "") || value;
}

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(date);
}

function normalize(value = "") {
  return value.normalize("NFKC").toLocaleLowerCase("ja");
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => { toast.hidden = true; }, 6000);
}

function showQueryError() {
  const error = new URLSearchParams(location.search).get("error");
  if (error) {
    showToast(error, true);
    history.replaceState(null, "", "/");
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

load();
