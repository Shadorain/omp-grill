(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const tokenKey = `grill-token:${location.pathname}`;
  const fragmentToken = location.hash.slice(1);
  let token = fragmentToken || sessionStorage.getItem(tokenKey) || "";
  if (fragmentToken) {
    sessionStorage.setItem(tokenKey, fragmentToken);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  let state = null;
  let lastStateSignature = "";
  let revision = 0;
  let draftAnswers = {};
  let draftThreads = {};
  let selected = "";
  let renderedQuestion = "";
  let view = "questions";
  let polling = false;
  let sending = false;
  let saving = false;
  let dirty = false;
  let saveTimer = 0;
  let saveFailed = false;
  let localWarning = "";
  let conflict = null;
  let retryRequest = null;
  let restoredServerIds = new Set();
  let barNote = "";
  let diagramUrl = "";
  let prototypeUrl = "";
  let topicTitle = "Decision interview";
  let visualBusy = false;
  let expectingVisual = false;
  let intentDraft = null;
  let visualFeedbackDrafts = { prototype: "", diagram: "" };
  let visualKind = "diagram";
  let visualKindPinned = false;
  let loadedPrototypeVersion = null;
  let loadedDiagramVersion = null;
  let artifactSignature = "";
  const storagePrefix = "grill-drafts:v2:";
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const safeText = (value) => typeof value === "string" ? value : "";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uid = () => {
    const data = new Uint32Array(4);
    crypto.getRandomValues(data);
    return Array.from(data, (part) => part.toString(16).padStart(8, "0")).join("-");
  };
  const optionLetter = (q, optionId) => {
    const index = (q?.options || []).findIndex((option) => option.id === optionId);
    return index < 0 ? "" : LETTERS[index] || "?";
  };
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set("X-Grill-Token", token);
    if (options.body) headers.set("Content-Type", "application/json");
    return fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  };
  function showError(message, offline = false) {
    if (conflict) return;
    const box = $("banner");
    box.hidden = false;
    box.textContent = `${offline ? "Server unreachable" : "Request failed"}: ${message}. ${offline ? "Local drafts are retained; reconnect to sync." : "Review the response and retry when ready."}`;
  }
  function syncBanner() {
    if (conflict) return;
    const box = $("banner");
    if (state?.status === "error") {
      box.hidden = false;
      const err = safeText(state.error).trim();
      box.textContent = err || "Use /grill resume to retry the saved batch.";
    } else {
      box.hidden = true;
    }
  }
  function setBarNote(text) {
    barNote = safeText(text);
    renderBottomBar();
  }
  function interviewSettled() {
    const questions = state?.questions || [];
    return questions.length > 0 && questions.every((q) => q.status !== "open") && !state?.pending && !sending;
  }
  function finishBlocked() {
    return !state || sending || !!state.pending || ["working", "paused"].includes(state.status) || !!conflict;
  }
  function stagedCount() {
    return readyAnswers().length + readyThreads().length;
  }
  function statusLabel(value) {
    return ({ waiting: "Waiting for you", ready: "Ready to finish", working: "Agent thinking…", paused: "Paused", error: "Error", finished: "Finished", loading: "Connecting" })[value] || "Waiting for you";
  }
  function openCount() {
    return (state?.questions || []).filter((q) => q.status === "open").length;
  }
  function updateTitle() {
    const count = openCount();
    const badge = state?.status === "waiting" && count > 0 ? `(${count}) ` : "";
    document.title = `${badge}${topicTitle} — Grill`;
  }
  function notifyTurn(count) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const body = count > 0 ? `${count} question${count === 1 ? "" : "s"} waiting for an answer.` : "The interview is settled.";
    const ping = new Notification("Grill — your turn", { body, tag: "grill-turn", icon: "/favicon.svg" });
    ping.onclick = () => { window.focus(); ping.close(); };
  }
  function setStatus() {
    const value = state?.pending && state.status !== "error" ? "working" : interviewSettled() && state.status === "waiting" ? "ready" : state?.status || "loading";
    $("status").dataset.status = value;
    $("status-text").textContent = statusLabel(value);
    updateTitle();
  }
  function persistLocal() {
    if (!state?.id) return;
    try {
      localStorage.setItem(storagePrefix + state.id, JSON.stringify({ answers: draftAnswers, threads: draftThreads, revision }));
      localWarning = "";
    } catch (_) {
      localWarning = "Browser storage is unavailable or full. Keep this tab open until drafts sync.";
    }
    updateSync();
  }
  function updateSync() {
    $("sync-note").textContent = localWarning || (conflict ? "Conflict needs a choice" : saving || dirty ? "Saving…" : "");
  }
  function hasDraft(value) {
    return !!(value && (safeText(value.text).trim() || safeText(value.option).trim()));
  }
  // Canonical draft shape: omit empty fields, drop empty drafts. The server rejects `option: ""`.
  function setAnswerDraft(id, value) {
    const option = safeText(value?.option);
    const text = safeText(value?.text);
    if (option || text) draftAnswers[id] = { ...(option ? { option } : {}), ...(text ? { text } : {}) };
    else delete draftAnswers[id];
  }
  // A staged answer identical to the recorded one is not a change; drop it.
  function reconcileDraft(q) {
    const draft = draftAnswers[q.id];
    if (!q.answer || !draft) return;
    if ((draft.option || "") === (q.answer.option || "") && (draft.text || "") === (q.answer.text || "")) delete draftAnswers[q.id];
  }
  // On an answered question the recorded values are the base; an answer action
  // replaces the recorded answer wholesale, so edits must carry it forward.
  function stageOption(q, optionId) {
    const base = { ...(q.answer || {}), ...(draftAnswers[q.id] || {}) };
    setAnswerDraft(q.id, { ...base, option: base.option === optionId ? "" : optionId });
    reconcileDraft(q);
    markDirty();
    renderQuestion();
  }
  function stageText(q, text) {
    const base = { ...(q.answer || {}), ...(draftAnswers[q.id] || {}) };
    setAnswerDraft(q.id, { ...base, text });
    reconcileDraft(q);
    markDirty();
  }
  function markDirty() {
    dirty = true;
    barNote = "";
    persistLocal();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDrafts, 400);
    renderNavigation();
    renderStep();
    renderBottomBar();
    renderStagedBubble();
  }
  async function saveDrafts() {
    if (!state || !dirty || conflict) return false;
    saveFailed = false;
    while (saving) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!dirty || conflict) return !conflict;
    saving = true;
    updateSync();
    const sentAnswers = clone(draftAnswers);
    const sentThreads = clone(draftThreads);
    const answerPatch = {};
    const threadPatch = {};
    const answerIds = new Set([...Object.keys(sentAnswers), ...Object.keys(state.drafts?.answers || {})]);
    for (const id of answerIds) {
      if (JSON.stringify(sentAnswers[id] ?? null) !== JSON.stringify(state.drafts?.answers?.[id] ?? null)) answerPatch[id] = sentAnswers[id] ?? null;
    }
    const threadIds = new Set([...Object.keys(sentThreads), ...Object.keys(state.drafts?.threads || {})]);
    for (const id of threadIds) {
      if ((sentThreads[id] ?? null) !== (state.drafts?.threads?.[id] ?? null)) threadPatch[id] = sentThreads[id] ?? null;
    }
    if (!Object.keys(answerPatch).length && !Object.keys(threadPatch).length) {
      dirty = false;
      saving = false;
      updateSync();
      return true;
    }
    try {
      const response = await api("/api/drafts", { method: "POST", body: JSON.stringify({ revision, answers: answerPatch, threads: threadPatch }) });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        conflict = { local: { answers: sentAnswers, threads: sentThreads }, remote: result.drafts || {} };
        dirty = true;
        showConflict();
        return false;
      }
      if (!response.ok) throw new Error(result.error || `Draft save rejected (${response.status})`);
      revision = result.revision;
      state.drafts = result;
      dirty = JSON.stringify(draftAnswers) !== JSON.stringify(sentAnswers) || JSON.stringify(draftThreads) !== JSON.stringify(sentThreads);
      persistLocal();
      render();
      return !dirty;
    } catch (error) {
      saveFailed = true;
      dirty = true;
      showError(error.message || "Draft save failed", !navigator.onLine);
      return false;
    } finally {
      saving = false;
      updateSync();
      if (dirty && !conflict) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveDrafts, 500);
      }
    }
  }
  function showConflict() {
    const box = $("banner");
    box.hidden = false;
    box.replaceChildren();
    const text = document.createElement("span");
    text.textContent = "Drafts changed in another tab. Choose a copy; the other version will remain recoverable.";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn-secondary";
    keep.textContent = "Keep my drafts";
    keep.addEventListener("click", () => {
      const c = conflict;
      if (!c) return;
      const box = $("banner");
      box.hidden = true;
      const currentLocal = { answers: clone(draftAnswers), threads: clone(draftThreads) };
      stashDraftSet(c.remote, "Replaced by this tab's drafts");
      draftAnswers = currentLocal.answers;
      draftThreads = currentLocal.threads;
      revision = c.remote.revision || revision;
      state.drafts = c.remote;
      conflict = null;
      dirty = true;
      persistLocal();
      void saveDrafts();
      render();
    });
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn btn-ghost";
    use.textContent = "Use other tab's drafts";
    use.addEventListener("click", () => {
      const c = conflict;
      if (!c) return;
      const box = $("banner");
      box.hidden = true;
      const currentLocal = { answers: clone(draftAnswers), threads: clone(draftThreads) };
      stashDraftSet(currentLocal, "Replaced by the other tab's drafts");
      draftAnswers = clone(c.remote.answers || {});
      draftThreads = clone(c.remote.threads || {});
      revision = c.remote.revision || revision;
      state.drafts = c.remote;
      conflict = null;
      dirty = false;
      persistLocal();
      render();
    });
    box.append(text, keep, use);
  }
  const recoveryKey = () => `grill-recovery:${state?.id || "unknown"}`;
  function localRecovery() {
    try { return JSON.parse(localStorage.getItem(recoveryKey()) || "[]"); }
    catch (_) { return []; }
  }
  function stashDraftSet(drafts, reason) {
    const rows = localRecovery();
    for (const [q, value] of Object.entries(drafts.answers || {})) {
      if (hasDraft(value)) rows.push({ kind: "answer", q, option: safeText(value.option), text: safeText(value.text), reason });
    }
    for (const [q, text] of Object.entries(drafts.threads || {})) {
      if (safeText(text).trim()) rows.push({ kind: "thread", q, text, reason });
    }
    try { localStorage.setItem(recoveryKey(), JSON.stringify(rows)); } catch (_) { localWarning = "Could not save recovery copy."; }
    renderRecovery();
  }
  function renderRecovery() {
    const localRows = localRecovery();
    const serverRecs = (state?.drafts?.recovery || []).filter((r) => r && r.id && !restoredServerIds.has(r.id));
    const root = $("recovery-list");
    const has = localRows.length + serverRecs.length;
    $("recovery-block").hidden = !has;
    const sig = [localRows, serverRecs.map((r) => r.id)];
    rebuild(root, sig, () => {
      for (const [index, item] of localRows.entries()) {
        const li = document.createElement("li");
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "restore-item";
        restore.textContent = `Restore ${item.kind}: ${state?.questions?.find((q) => q.id === item.q)?.title || item.q}`;
        restore.title = item.reason || "Recoverable draft";
        restore.addEventListener("click", () => {
          if (item.kind === "answer") setAnswerDraft(item.q, item);
          else draftThreads[item.q] = item.text;
          localRows.splice(index, 1);
          try { localStorage.setItem(recoveryKey(), JSON.stringify(localRows)); } catch (_) {}
          markDirty();
          render();
        });
        li.append(restore);
        root.append(li);
      }
      for (const item of serverRecs) {
        const li = document.createElement("li");
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "restore-item";
        restore.textContent = `Restore ${item.kind}: ${state?.questions?.find((q) => q.id === item.q)?.title || item.q}`;
        restore.title = `Server recovery ${item.at || ""}`.trim();
        restore.addEventListener("click", () => {
          if (item.kind === "answer") {
            setAnswerDraft(item.q, item.answer || item);
          } else {
            draftThreads[item.q] = item.text;
          }
          if (item.id) restoredServerIds.add(item.id);
          markDirty();
          render();
        });
        li.append(restore);
        root.append(li);
      }
    });
  }
  function qSelected() { return state?.questions?.find((q) => q.id === selected) || state?.questions?.[0] || null; }
  function readyAnswers() { return (state?.questions || []).filter((q) => hasDraft(draftAnswers[q.id])); }
  function readyThreads() { return Object.entries(draftThreads).filter(([, text]) => safeText(text).trim()); }
  function actionsFromSnapshot(drafts) {
    const actions = [];
    for (const q of state?.questions || []) {
      const draft = drafts.answers[q.id];
      if (!hasDraft(draft)) continue;
      const action = { type: "answer", q: q.id };
      if (draft.option) action.option = draft.option;
      if (safeText(draft.text).trim()) action.text = draft.text.trim();
      actions.push(action);
    }
    for (const [q, text] of Object.entries(drafts.threads || {})) {
      if (safeText(text).trim()) actions.push({ type: "thread", q, text: text.trim() });
    }
    return actions;
  }
  function actionsFromDrafts() { return actionsFromSnapshot({ answers: draftAnswers, threads: draftThreads }); }
  function canSubmit() {
    return !!state && !sending && !state.pending && !["working", "paused", "finished"].includes(state.status) && !conflict;
  }
  // Rebuild a container only when its inputs change, so polling and autosave never swap nodes under the pointer.
  function rebuild(root, inputs, build) {
    const signature = JSON.stringify(inputs);
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature;
    root.replaceChildren();
    build();
  }
  function renderSegment() {
    $("seg-questions").classList.toggle("is-active", view === "questions");
    $("seg-visual").classList.toggle("is-active", view === "visual");
    const current = visualKind === "diagram" ? state?.diagram : state?.prototype;
    const other = visualKind === "diagram" ? state?.prototype : state?.diagram;
    const artifact = current || other;
    $("seg-visual-label").textContent = artifact ? `Visual v${artifact.version}` : "Visualize";
    $("visual-stale-dot").hidden = !artifact?.stale;
  }
  function renderNavigation() {
    const questions = state?.questions || [];
    $("progress-count").textContent = `${questions.filter((q) => q.status !== "open").length} / ${questions.length}`;
    const nav = $("question-nav");
    rebuild(nav, [selected, questions.map((q) => [q.id, q.title, q.status, draftAnswers[q.id]?.option || "", hasDraft(draftAnswers[q.id]), q.answer?.option || ""])], () => {
      for (const [index, q] of questions.entries()) {
        const draft = draftAnswers[q.id];
        const row = document.createElement("button");
        row.type = "button";
        row.className = `qrow${q.id === selected ? " is-selected" : ""}${q.status === "answered" && !hasDraft(draft) ? " is-answered" : ""}${q.status === "deferred" && !hasDraft(draft) ? " is-deferred" : ""}`;
        row.dataset.focusKey = `question:${q.id}`;
        const qid = document.createElement("span");
        qid.className = "qid mono";
        qid.textContent = `Q${index + 1}`;
        const title = document.createElement("span");
        title.className = "qrow-title";
        title.textContent = safeText(q.title) || "Untitled question";
        const mark = document.createElement("span");
        mark.className = "qmark mono";
        if (hasDraft(draft)) {
          mark.classList.add("is-staged");
          const dot = document.createElement("i");
          dot.className = "staged-dot";
          mark.append(dot, draft.option ? ` ${optionLetter(q, draft.option)}` : "");
          row.title = "Staged. Not sent yet.";
        } else if (q.status === "answered") {
          mark.classList.add("is-done");
          const check = document.createElement("span");
          check.className = "done-check";
          check.textContent = "✓";
          const letter = document.createElement("span");
          letter.textContent = q.answer?.option ? optionLetter(q, q.answer.option) : "txt";
          mark.append(check, letter);
          row.title = "Recorded. Click to stage a different answer.";
        } else if (q.status === "deferred") {
          mark.classList.add("is-later");
          mark.textContent = "later";
          row.title = "Deferred. Reopen when you want to answer it.";
        } else {
          mark.textContent = "open";
          row.title = "Not answered yet.";
        }
        row.append(qid, title, mark);
        row.addEventListener("click", () => selectQuestion(q.id));
        nav.append(row);
      }
    });
  }
  function selectQuestion(id) {
    selected = id;
    view = "questions";
    render();
    $("question-title")?.focus({ preventScroll: true });
  }
  function formatAnswer(question, answer) {
    const choice = (question.options || []).find((option) => option.id === answer?.option)?.label || answer?.option;
    return [choice, answer?.text].filter(Boolean).join(" — ") || "Answered";
  }
  function renderQuestion() {
    const q = qSelected();
    $("question-card").hidden = !q;
    $("empty-state").hidden = !!q;
    if (!q) {
      $("disc-title").textContent = "";
      $("thread-count").textContent = "0";
      $("thread-list").replaceChildren();
      $("staged-bubble").hidden = true;
      $("explore-results").hidden = true;
      $("history-details").hidden = true;
      return;
    }
    const questionChanged = q.id !== renderedQuestion;
    selected = q.id;
    renderedQuestion = q.id;
    const index = state.questions.indexOf(q);
    $("q-id").textContent = `Q${index + 1}`;
    $("q-state").textContent = q.status === "answered"
      ? " · answered"
      : q.status === "deferred"
        ? ` · deferred${q.deferUntil ? ` until ${q.deferUntil}` : ""}`
        : "";
    rebuild($("q-deps"), [q.id, q.dependsOn || []], () => {
      for (const dep of q.dependsOn || []) {
        const target = state.questions.find((item) => item.id === dep);
        const sep = document.createElement("span");
        sep.textContent = " · after ";
        const link = document.createElement("button");
        link.type = "button";
        link.className = "dep-link mono";
        link.textContent = `Q${state.questions.indexOf(target) + 1 || dep}`;
        link.title = target?.title || dep;
        link.addEventListener("click", () => selectQuestion(dep));
        $("q-deps").append(sep, link);
      }
    });
    $("question-title").textContent = safeText(q.title) || "Untitled question";
    $("question-body").textContent = safeText(q.body);
    $("question-body").hidden = !safeText(q.body).trim();
    const rec = q.recommendation;
    const recLetter = rec?.option ? optionLetter(q, rec.option) : "";
    $("why-line").textContent = rec?.reason ? `Why ${recLetter ? `${recLetter}.` : "this."} ${rec.reason}` : "";
    $("why-line").hidden = !rec?.reason;
    const answered = q.status === "answered" && !!q.answer;
    $("change-hint").hidden = !answered;
    const draft = draftAnswers[q.id];
    const chosen = draft?.option || (answered ? q.answer.option : "");
    const opts = $("options");
    const disabled = state.status === "finished";
    rebuild(opts, [q.id, q.options, chosen, rec?.option, q.answer?.option, disabled], () => {
      for (const option of q.options || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.focusKey = `option:${q.id}:${option.id}`;
        button.disabled = disabled;
        button.className = `opt-row${chosen === option.id ? " is-chosen" : ""}${rec?.option === option.id ? " is-recommended" : ""}`;
        button.setAttribute("aria-pressed", String(chosen === option.id));
        const letter = document.createElement("span");
        letter.className = "opt-letter mono";
        letter.textContent = optionLetter(q, option.id);
        const copy = document.createElement("span");
        copy.className = "opt-copy";
        copy.textContent = safeText(option.label);
        const meta = document.createElement("span");
        meta.className = "opt-meta";
        if (rec?.option === option.id) meta.append(tag("Recommended"));
        if (answered && q.answer.option === option.id && chosen !== option.id) meta.append(tag("Recorded"));
        const check = document.createElement("span");
        check.className = "opt-check";
        check.textContent = "✓";
        meta.append(check);
        button.append(letter, copy, meta);
        button.addEventListener("click", () => stageOption(q, option.id));
        opts.append(button);
      }
    });
    const answerText = $("answer-text");
    if (questionChanged || document.activeElement !== answerText) answerText.value = draft?.text ?? q.answer?.text ?? "";
    answerText.disabled = disabled;
    renderStep();
    $("defer-action").hidden = q.status !== "open";
    $("reopen-action").hidden = q.status !== "deferred";
    $("defer-action").disabled = $("reopen-action").disabled = $("explore-action").disabled = !canSubmit();
    renderDiscussion(q, questionChanged);
  }
  function renderStep() {
    const q = qSelected();
    const next = $("next-action");
    const back = $("back-action");
    if (!q || !next || !back) return;
    const index = state.questions.indexOf(q);
    const after = state.questions[index + 1];
    const count = stagedCount();
    const pending = sending || !!state?.pending;
    const firstOpen = state.questions.find((item) => item.status === "open");
    back.disabled = index <= 0;
    back.dataset.target = state.questions[index - 1]?.id || "";
    next.classList.remove("btn-primary", "btn-ghost");
    next.dataset.target = "";
    if (after) {
      next.classList.add(hasDraft(draftAnswers[q.id]) ? "btn-primary" : "btn-ghost");
      next.disabled = false;
      next.dataset.mode = "next";
      next.dataset.target = after.id;
      next.textContent = "Next →";
    } else if (pending) {
      next.classList.add("btn-ghost");
      next.disabled = true;
      next.dataset.mode = "wait";
      next.textContent = "Agent thinking…";
    } else if (count) {
      next.classList.add("btn-primary");
      next.disabled = !canSubmit();
      next.dataset.mode = "send";
      next.textContent = `Send ${count} →`;
    } else if (firstOpen && firstOpen.id !== q.id) {
      next.classList.add("btn-ghost");
      next.disabled = false;
      next.dataset.mode = "open";
      next.dataset.target = firstOpen.id;
      next.textContent = "Unanswered →";
    } else if (interviewSettled()) {
      next.classList.add("btn-primary");
      next.disabled = finishBlocked();
      next.dataset.mode = "finish";
      next.textContent = "Finish";
    } else {
      next.classList.add("btn-ghost");
      next.disabled = true;
      next.dataset.mode = "none";
      next.textContent = "Next →";
    }
  }
  function tag(text) {
    const span = document.createElement("span");
    span.className = `tag tag-${text.toLowerCase()}`;
    span.textContent = text.toUpperCase();
    return span;
  }
  function makeThreadEntry(item) {
    const row = document.createElement("div");
    row.className = `msg ${item.role === "user" ? "msg-you" : "msg-agent"}`;
    const role = document.createElement("span");
    role.className = "msg-role mono";
    role.textContent = item.role === "user" ? "You" : "Agent";
    const text = document.createElement("p");
    text.textContent = safeText(item.text);
    row.append(role, text);
    return row;
  }
  function renderDiscussion(q, questionChanged) {
    const index = state.questions.indexOf(q);
    $("disc-title").textContent = `Q${index + 1} · ${safeText(q.title) || "Untitled question"}`;
    const threadInput = $("thread-input");
    threadInput.disabled = state.status === "finished";
    threadInput.placeholder = `Ask about Q${index + 1}…`;
    if (questionChanged || document.activeElement !== threadInput) threadInput.value = draftThreads[q.id] || "";
    $("thread-count").textContent = String((q.thread || []).length);
    const list = $("thread-list");
    rebuild(list, [q.id, q.thread], () => {
      for (const item of q.thread || []) list.append(makeThreadEntry(item));
      if (!(q.thread || []).length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = "No messages yet.";
        list.append(p);
      }
      list.scrollTop = list.scrollHeight;
    });
    renderStagedBubble();
    renderExplore(q);
    renderHistory(q);
  }
  function renderStagedBubble() {
    const q = qSelected();
    const text = safeText(draftThreads[q?.id]).trim();
    $("staged-bubble").hidden = !text || !q;
    if (text) $("staged-bubble-text").textContent = draftThreads[q.id];
  }
  function renderHistory(q) {
    const history = q.history || [];
    $("history-details").hidden = !history.length;
    rebuild($("history-list"), [q.id, history], () => {
      for (const item of history) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = formatAnswer(q, item.answer || item);
        $("history-list").append(p);
      }
    });
  }
  function renderExplore(q) {
    const root = $("explore-results");
    if (!q.explore?.length) { root.hidden = true; root.dataset.signature = ""; return; }
    root.hidden = false;
    rebuild(root, [q.id, q.explore], () => {
      for (const row of q.explore) {
        const card = document.createElement("section");
        card.className = "explore-card";
        const title = document.createElement("h4");
        title.textContent = (q.options || []).find((option) => option.id === row.option)?.label || row.option;
        card.append(title);
        const columns = document.createElement("div");
        columns.className = "tradeoff-cols";
        for (const [label, values, className] of [["Upside", row.pros, "pros"], ["Tradeoffs", row.cons, "cons"]]) {
          const column = document.createElement("div");
          column.className = className;
          const caption = document.createElement("strong");
          caption.className = "mono";
          caption.textContent = label.toUpperCase();
          const ul = document.createElement("ul");
          for (const value of values || []) { const li = document.createElement("li"); li.textContent = safeText(value); ul.append(li); }
          column.append(caption, ul);
          columns.append(column);
        }
        card.append(columns);
        root.append(card);
      }
    });
  }
  function renderBottomBar() {
    const finished = state?.status === "finished";
    $("send-bar").hidden = finished;
    $("finished-bar").hidden = !finished;
    if (finished) return;
    const summary = $("staged-summary");
    const answers = readyAnswers();
    const threads = readyThreads();
    const count = answers.length + threads.length;
    const pending = sending || !!state?.pending;
    rebuild(summary, [pending, retryRequest?.body?.requestId || "", barNote, answers.map((q) => q.id), threads.map(([id]) => id), count], () => {
      if (sending || state?.pending) {
        summary.textContent = "Agent is thinking…";
        return;
      }
      if (barNote) {
        summary.textContent = barNote;
        return;
      }
      if (!count) {
        const note = safeText(state?.note).trim();
        summary.textContent = interviewSettled()
          ? (note || "All questions recorded. Change an answer, or Finish.")
          : "Nothing staged. Pick an option or write in the discussion.";
        return;
      }
      const lead = document.createElement("span");
      lead.className = "mono";
      lead.textContent = `${count} staged`;
      summary.append(lead);
      const items = [];
      for (const q of answers) items.push([q.id, `Q${state.questions.indexOf(q) + 1} answer`]);
      for (const [id] of threads) {
        const q = state.questions.find((item) => item.id === id);
        items.push([id, `Q${q ? state.questions.indexOf(q) + 1 : "?"} message`]);
      }
      const shown = items.slice(0, 4);
      for (const [id, label] of shown) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip mono";
        chip.textContent = label;
        chip.addEventListener("click", () => selectQuestion(id));
        summary.append(chip);
      }
      if (items.length > shown.length) {
        const more = document.createElement("span");
        more.className = "hint";
        more.textContent = `+${items.length - shown.length} more`;
        summary.append(more);
      }
    });
    const send = $("send-btn");
    send.textContent = retryRequest ? "Retry send" : `Send ${count || ""} to agent`.replace(/\s+/g, " ").trim();
    send.disabled = sending || !canSubmit() || (!retryRequest && !count);
    $("finish-btn").disabled = finishBlocked();
  }
  function renderKnowledge() {
    const context = state?.context || {};
    const locked = state?.status === "finished";
    if (intentDraft === null) intentDraft = safeText(context.intent);
    if (document.activeElement !== $("intent-input")) $("intent-input").value = intentDraft;
    $("intent-input").disabled = $("save-context").disabled = locked;
    const renderRows = (id, kind, rows, key) => {
      const root = $(id);
      rebuild(root, [kind, rows, locked], () => {
        for (const row of rows || []) {
          const item = document.createElement("div");
          item.className = "note-row";
          const copy = document.createElement("div");
          copy.className = "note-copy";
          if (kind === "terms") {
            const term = document.createElement("strong");
            term.textContent = row.term;
            const def = document.createElement("span");
            def.textContent = row.definition;
            copy.append(term, def);
            if (row.avoid?.length) {
              const avoid = document.createElement("span");
              avoid.className = "hint";
              avoid.textContent = `Avoid: ${row.avoid.join(", ")}`;
              copy.append(avoid);
            }
          } else {
            const text = document.createElement("span");
            text.textContent = row.text;
            copy.append(text);
            const extra = kind === "facts" ? row.source : row.mitigation;
            if (extra) {
              const sub = document.createElement("span");
              sub.className = "hint";
              sub.textContent = kind === "facts" ? extra : `Mitigation: ${extra}`;
              copy.append(sub);
            }
          }
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "note-x";
          remove.textContent = "×";
          remove.disabled = locked;
          remove.setAttribute("aria-label", `Remove ${kind === "terms" ? row.term : row.text}`);
          remove.addEventListener("click", () => updateContext({ [kind]: [{ ...key(row), remove: true }] }));
          item.append(copy, remove);
          root.append(item);
        }
        if (!(rows || []).length) {
          const p = document.createElement("p");
          p.className = "hint";
          p.textContent = "Nothing saved yet.";
          root.append(p);
        }
      });
    };
    renderRows("terms-list", "terms", context.terms, (row) => ({ term: row.term }));
    renderRows("facts-list", "facts", context.facts, (row) => ({ id: row.id }));
    renderRows("risks-list", "risks", context.risks, (row) => ({ id: row.id }));
    for (const id of ["term-input", "term-meaning", "term-avoid", "fact-input", "fact-source", "risk-input", "risk-mitigation"]) $(id).disabled = locked;
    for (const id of ["add-term", "add-fact", "add-risk"]) $(id).disabled = locked;
  }
  // ----- Visual view -----
  function safeSvg(text) {
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Diagram response is not valid SVG");
    const allowed = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "marker"]);
    const attrs = new Set(["viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width", "paint-order", "font-size", "font-family", "text-anchor", "marker-end", "id", "transform", "stroke-dasharray", "markerWidth", "markerHeight", "refX", "refY", "orient"]);
    for (const node of [...parsed.querySelectorAll("*")]) {
      if (!allowed.has(node.localName)) { node.remove(); continue; }
      for (const attr of [...node.attributes]) {
        const value = attr.value.trim().toLowerCase();
        if (!attrs.has(attr.name) || attr.name.startsWith("on") || value.includes("url(") && !value.startsWith("url(#")) node.removeAttribute(attr.name);
      }
    }
    return document.importNode(parsed.documentElement, true);
  }
  function renderVisual() {
    if (!visualKindPinned) visualKind = state?.diagram ? "diagram" : state?.prototype ? "prototype" : "diagram";
    const artifact = visualKind === "diagram" ? state?.diagram : state?.prototype;
    const anyArtifact = !!(state?.prototype || state?.diagram);
    const drawing = visualBusy || expectingVisual;
    $("seg-proto").classList.toggle("is-active", visualKind === "prototype");
    $("seg-diag").classList.toggle("is-active", visualKind === "diagram");
    $("visual-toolbar").hidden = !anyArtifact;
    $("visual-version").hidden = !artifact;
    $("visual-version").textContent = artifact ? `v${artifact.version}` : "";
    $("visual-stale").hidden = !artifact?.stale;
    $("visual-drawing").hidden = !drawing;
    $("regen-btn").hidden = !artifact;
    $("regen-btn").disabled = !canSubmit() || drawing;
    $("download-visual").disabled = visualKind === "prototype" ? !prototypeUrl : !diagramUrl;
    const open = (state?.questions || []).filter((question) => question.status === "open");
    const assumed = open.map((question) => {
      const rec = question.recommendation;
      const choice = (question.options || []).find((option) => option.id === rec?.option)?.label;
      return `${question.title} → ${choice ? `assumes “${choice}”` : "undecided"}`;
    });
    $("visual-assumed").hidden = !artifact || !open.length;
    $("visual-assumed").textContent = assumed.join(" · ");
    $("visual-empty").hidden = anyArtifact;
    $("visual-prompt").hidden = !anyArtifact || !!artifact;
    if (anyArtifact && !artifact) {
      $("visual-prompt-title").textContent = visualKind === "prototype" ? "Clickable prototype" : "Diagram";
      $("visual-prompt-desc").textContent = visualKind === "prototype"
        ? "A clickable screen. Skip this unless the interview is about something people will see."
        : "Flow, state, or how the parts connect. Works for any topic, not just a screen.";
    }
    $("artifact-holder").hidden = !artifact;
    $("gen-kind").disabled = $("gen-proto").disabled = $("gen-diag").disabled = !canSubmit() || drawing;
    renderVisualThread();
    renderRedraw();
  }
  function renderVisualThread() {
    const artifact = visualKind === "diagram" ? state?.diagram : state?.prototype;
    const entries = artifact?.thread || [];
    const list = $("visual-thread-list");
    rebuild(list, [visualKind, entries], () => {
      for (const entry of entries) list.append(makeThreadEntry(entry));
      if (!entries.length) {
        const p = document.createElement("p");
        p.className = "hint";
        p.textContent = artifact ? "No feedback sent yet." : "Generate a visual, then suggest changes here.";
        list.append(p);
      }
      list.scrollTop = list.scrollHeight;
    });
    $("visual-thread-count").textContent = String(entries.length);
  }
  function renderRedraw() {
    $("redraw-btn").disabled = !safeText($("visual-feedback").value).trim() || !canSubmit() || visualBusy;
    $("visual-feedback").disabled = state?.status === "finished";
  }
  async function loadPrototype() {
    if (loadedPrototypeVersion === state?.prototype?.version && $("artifact-holder").querySelector("iframe")) return;
    try {
      const response = await api("/api/prototype");
      if (!response.ok) throw new Error(response.status === 404 ? "No prototype yet. Generate one to explore." : `Prototype request failed (${response.status})`);
      const html = await response.text();
      if (prototypeUrl) URL.revokeObjectURL(prototypeUrl);
      prototypeUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      const frame = document.createElement("iframe");
      frame.title = "Interactive prototype preview";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = html;
      $("artifact-holder").replaceChildren(frame);
      loadedPrototypeVersion = state?.prototype?.version ?? null;
      $("visual-status").textContent = `Prototype v${loadedPrototypeVersion || "?"}${state?.prototype?.stale ? " — out of date; regenerate when ready" : ""}. Clicks stay inside the sandbox.`;
    } catch (error) {
      $("visual-status").textContent = error.message;
    }
  }
  async function loadDiagram() {
    if (loadedDiagramVersion === state?.diagram?.version && $("artifact-holder").querySelector("svg")) return;
    try {
      const response = await api("/api/diagram");
      if (!response.ok) throw new Error(response.status === 404 ? "No diagram yet. Generate one to inspect it." : `Diagram request failed (${response.status})`);
      const text = await response.text();
      const svg = safeSvg(text);
      if (svg.viewBox.baseVal.width > 960)
        svg.style.minWidth = `${svg.viewBox.baseVal.width}px`;
      $("artifact-holder").replaceChildren(svg);
      if (diagramUrl) URL.revokeObjectURL(diagramUrl);
      diagramUrl = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      loadedDiagramVersion = state?.diagram?.version ?? null;
      $("visual-status").textContent = `Diagram v${loadedDiagramVersion || "?"}${state?.diagram?.stale ? " — out of date; regenerate when ready" : ""}.`;
    } catch (error) {
      $("visual-status").textContent = error.message;
    }
  }
  async function loadSelectedArtifact() {
    const artifact = visualKind === "diagram" ? state?.diagram : state?.prototype;
    if (!artifact) {
      $("artifact-holder").replaceChildren();
      renderVisual();
      return;
    }
    if (visualKind === "prototype") await loadPrototype();
    else await loadDiagram();
    renderVisual();
  }
  function switchVisualKind(kind) {
    visualKindPinned = true;
    if (visualKind === kind) { renderVisual(); return; }
    visualFeedbackDrafts[visualKind] = $("visual-feedback").value;
    visualKind = kind;
    $("visual-feedback").value = visualFeedbackDrafts[kind] || "";
    renderVisual();
    void loadSelectedArtifact();
  }
  async function generateVisual(kind, feedback = "") {
    if (!canSubmit() || visualBusy) return false;
    visualBusy = true;
    $("visual-status").textContent = feedback ? `Requesting ${kind} update with feedback…` : `Requesting ${kind}…`;
    renderVisual();
    const action = feedback ? { type: "visual-feedback", kind, text: feedback } : { type: "visualize", kind };
    const sentFeedback = $("visual-feedback").value;
    const ok = await postActions([action]);
    if (ok) expectingVisual = true;
    visualBusy = false;
    if (ok && feedback && $("visual-feedback").value === sentFeedback) {
      visualFeedbackDrafts[kind] = "";
      $("visual-feedback").value = "";
    }
    await refresh();
    if (ok) await loadSelectedArtifact();
    renderVisual();
    return ok;
  }
  // ----- Report -----
  // Minimal markdown for the native report: headings, bullet lists (one nesting level), **bold**, paragraphs.
  // Built with DOM nodes and textContent only, so report text can never inject markup.
  function renderMarkdown(root, text) {
    root.replaceChildren();
    let list = null;
    const inline = (parent, line) => {
      line.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (!part) return;
        if (part.startsWith("**") && part.endsWith("**")) { const b = document.createElement("strong"); b.textContent = part.slice(2, -2); parent.append(b); }
        else parent.append(part);
      });
    };
    for (const raw of text.split("\n")) {
      const heading = /^(#{1,3}) (.*)$/.exec(raw);
      const item = /^(\s*)- (.*)$/.exec(raw);
      if (item) {
        if (!list) { list = document.createElement("ul"); root.append(list); }
        const li = document.createElement("li");
        if (item[1].length) li.className = "nested";
        inline(li, item[2]);
        list.append(li);
        continue;
      }
      list = null;
      if (!raw.trim()) continue;
      const node = document.createElement(heading ? `h${heading[1].length + 2}` : "p");
      inline(node, heading ? heading[2] : raw);
      root.append(node);
    }
  }
  async function loadReport() {
    try {
      const response = await api("/api/report");
      if (!response.ok) throw new Error(`Report request failed (${response.status})`);
      renderMarkdown($("report-preview"), await response.text());
    } catch (error) { $("report-preview").textContent = `Report unavailable: ${error.message}`; }
  }
  async function downloadReport() {
    try {
      const response = await api("/api/report");
      if (!response.ok) throw new Error(`Report download failed (${response.status})`);
      downloadBlob(await response.blob(), "decision-report.md");
    } catch (error) { showError(error.message, !navigator.onLine); }
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const exportDefaults = {
    report: "docs/grill-report.md",
    diagram: "docs/grill-diagram.svg",
    prototype: "docs/grill-prototype.html",
    adr: "docs/adr",
    beads: "docs/grill-beads.json",
  };
  function updateExportDestination() {
    const kind = $("export-kind").value;
    $("export-path").value = "";
    $("export-path").placeholder = exportDefaults[kind];
    $("export-path-label").textContent = kind === "adr" ? "Directory path" : "File path";
    $("export-feedback").textContent = "";
  }
  function exportFeedback(kind, result) {
    const paths = result.paths ?? [result.path];
    const message = `Exported ${kind} to ${paths.join(", ")}.`;
    $("export-feedback").textContent = kind === "beads"
      ? `${message} Import from the project with: bd create --graph ${JSON.stringify($("export-path").value.trim() || exportDefaults.beads)}`
      : message;
  }
  async function exportArtifact() {
    const kind = $("export-kind").value;
    const path = $("export-path").value.trim() || exportDefaults[kind];
    const attempt = async (overwrite) => {
      const response = await api("/api/export", { method: "POST", body: JSON.stringify({ kind, path, overwrite }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Export failed (${response.status})`);
      return result;
    };
    try {
      const result = await attempt(false);
      exportFeedback(kind, result);
    } catch (error) {
      if (/exists/i.test(error.message || "") && confirm(`${path} exists in the project. Overwrite it?`)) {
        try {
          const result = await attempt(true);
          exportFeedback(kind, result);
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      showError(error.message, !navigator.onLine);
      $("export-feedback").textContent = `Export failed: ${error.message}`;
    }
  }
  function renderReport() {
    const finished = state?.status === "finished";
    $("export-locked").hidden = finished;
    $("export-row").hidden = !finished;
    for (const option of $("export-kind").options) {
      option.disabled = option.value === "prototype" ? !state?.prototype
        : option.value === "diagram" ? !state?.diagram
        : option.value === "adr" ? !state?.questions.some((q) => q.durable && q.status === "answered")
        : option.value === "beads" ? !state?.questions.some((q) => q.status === "answered" || q.status === "deferred")
        : false;
    }
  }
  // ----- Drawers -----
  function openDrawer(which) {
    $("notes-drawer").hidden = which !== "notes";
    $("report-drawer").hidden = which !== "report";
    $("drawer-backdrop").hidden = false;
    if (which === "report") { renderReport(); void loadReport(); }
  }
  function closeDrawer() {
    $("notes-drawer").hidden = true;
    $("report-drawer").hidden = true;
    $("drawer-backdrop").hidden = true;
  }
  // ----- Render root -----
  function render() {
    if (!state) return;
    const focusKey = document.activeElement?.dataset?.focusKey || "";
    topicTitle = safeText(state.topic) || "Decision interview";
    $("topic-title").textContent = topicTitle;
    $("topic-note").textContent = safeText(state.note);
    $("topic-note").hidden = !safeText(state.note).trim();
    renderSegment();
    $("card-col").hidden = view !== "questions";
    $("qlist").hidden = view !== "questions";
    $("visual-main").hidden = view !== "visual";
    $("disc-panel").hidden = view !== "questions";
    $("vis-panel").hidden = view !== "visual";
    renderNavigation();
    renderQuestion();
    renderVisual();
    renderRecovery();
    setStatus();
    renderBottomBar();
    renderKnowledge();
    renderReport();
    updateSync();
    syncBanner();
    if (focusKey && !document.activeElement?.dataset?.focusKey) {
      const replacement = [...document.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey);
      replacement?.focus({ preventScroll: true });
    }
  }
  async function refresh() {
    if (polling || !token) return;
    polling = true;
    try {
      const response = await api("/api/state");
      if (!response.ok) throw new Error(`Session request failed (${response.status}).`);
      const next = await response.json();
      // Unchanged polls must not rebuild the DOM: rebuilding drops clicks mid-press, hover, and selection.
      // updatedAt moves on every autosave, so it is not part of the signature.
      const signature = JSON.stringify({ ...next, updatedAt: null });
      const changed = signature !== lastStateSignature;
      lastStateSignature = signature;
      // An unconfirmed send that the server did commit must not stay retryable.
      if (retryRequest && next.lastSubmission?.requestId === retryRequest.body.requestId) retryRequest = null;
      const pendingFinished = !!state?.pending && !next.pending;
      const wasBusy = !!state?.pending || state?.status === "working";
      const oldArtifactSignature = artifactSignature;
      if (next.id !== state?.id) {
        state = next;
        restoredServerIds = new Set();
        const current = next.drafts || { revision: 0, answers: {}, threads: {} };
        revision = current.revision || 0;
        draftAnswers = clone(current.answers || {});
        draftThreads = clone(current.threads || {});
        try {
          const cached = JSON.parse(localStorage.getItem(storagePrefix + next.id) || "null");
          if (cached && cached.revision === revision) {
            for (const [id, value] of Object.entries(cached.answers || {})) {
              if (next.questions?.some((q) => q.id === id)) setAnswerDraft(id, value);
            }
            Object.assign(draftThreads, cached.threads || {});
          } else if (cached) {
            const unsynced = {
              answers: Object.fromEntries(Object.entries(cached.answers || {}).filter(([id, value]) => hasDraft(value) && JSON.stringify(value) !== JSON.stringify(current.answers?.[id] ?? null))),
              threads: Object.fromEntries(Object.entries(cached.threads || {}).filter(([id, value]) => safeText(value).trim() && value !== current.threads?.[id])),
            };
            stashDraftSet(unsynced, "Unsynced browser draft");
            if (cached.revision > revision) localWarning = "Cached drafts are newer than server drafts; they remain recoverable.";
          }
        } catch (_) { localWarning = "Could not recover browser-cached drafts."; }
        if (!selected || !next.questions?.some((q) => q.id === selected)) selected = next.questions?.find((q) => q.status === "open")?.id || next.questions?.[0]?.id || "";
        dirty = JSON.stringify(draftAnswers) !== JSON.stringify(current.answers || {}) || JSON.stringify(draftThreads) !== JSON.stringify(current.threads || {});
        persistLocal();
      } else {
        const serverDraft = next.drafts || {};
        if (!dirty && !saving && !conflict) {
          revision = serverDraft.revision || revision;
          draftAnswers = clone(serverDraft.answers || {});
          draftThreads = clone(serverDraft.threads || {});
          persistLocal();
        }
        state = next;
      }
      // The agent released the turn while this tab was in the background.
      if (wasBusy && document.hidden && state.status === "waiting" && !state.pending) notifyTurn(openCount());
      artifactSignature = `${state.prototype?.version || 0}:${state.diagram?.version || 0}`;
      if (artifactSignature !== oldArtifactSignature || !state.pending) expectingVisual = false;
      if (changed) render();
      if (view === "visual" && artifactSignature !== oldArtifactSignature) void loadSelectedArtifact();
      if (pendingFinished && view === "questions") {
        const currentQuestion = state.questions?.find((question) => question.id === selected);
        const frontier = state.questions?.find((question) => question.status === "open" && !hasDraft(draftAnswers[question.id]));
        if (currentQuestion && currentQuestion.status !== "open" && frontier) {
          selected = frontier.id;
          render();
          $("question-title").focus({ preventScroll: true });
        }
      }
      syncBanner();
      if (dirty && !saving && !conflict) { clearTimeout(saveTimer); saveTimer = setTimeout(saveDrafts, 300); }
    } catch (error) {
      showError(error.message || "Unable to reach interview server.", !navigator.onLine);
    } finally { polling = false; }
  }
  // `drafts`: send every ready draft; `checkpoint`: save drafts first and let the server clear the sent ones;
  // `retry`: resend the unconfirmed request verbatim.
  async function postActions(actions, { finish = false, drafts = false, checkpoint = false, retry = false } = {}) {
    if (sending || !canSubmit()) return false;
    if (retryRequest && !retry) {
      setBarNote("A send response is unconfirmed. Retry that exact request before starting another send.");
      return false;
    }
    const consumesDrafts = drafts || checkpoint;
    if (!retry && consumesDrafts && dirty) {
      clearTimeout(saveTimer);
      do {
        const saved = await saveDrafts();
        if (!saved && saveFailed && !conflict) break;
        if (!saved && !conflict) await new Promise((resolve) => setTimeout(resolve, 30));
        if (conflict) break;
      } while (dirty);
    }
    if (!retry && consumesDrafts && (dirty || conflict)) {
      setBarNote("Draft checkpoint did not finish. Your drafts are preserved; resolve sync before sending.");
      return false;
    }
    if (!retry) {
      const snapshots = { answers: clone(draftAnswers), threads: clone(draftThreads) };
      const clearActions = drafts ? actionsFromSnapshot(snapshots) : actions || [];
      const outgoing = finish ? [...clearActions, { type: "finish" }] : clearActions;
      if (!outgoing.length) return false;
      // Only draft-consuming sends carry the revision; others must not race autosave into a false conflict.
      const body = { actions: outgoing, requestId: uid(), ...(consumesDrafts ? { draftRevision: revision } : {}) };
      retryRequest = { body, snapshots, clearActions, finish };
    }
    const request = retryRequest;
    sending = true;
    renderBottomBar();
    try {
      const response = await api("/api/send", { method: "POST", body: JSON.stringify(request.body) });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        retryRequest = null;
        if (result.drafts) {
          conflict = { remote: result.drafts };
          showConflict();
        }
        throw new Error(result.error || "Drafts changed; review current drafts before retrying.");
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          retryRequest = null;
        }
        throw new Error(result.error || `Submission rejected (${response.status}).`);
      }
      if (result.drafts) { revision = result.drafts.revision || revision; state.drafts = result.drafts; }
      for (const action of request.clearActions) {
        if (action.type === "answer" && JSON.stringify(draftAnswers[action.q] ?? null) === JSON.stringify(request.snapshots.answers[action.q] ?? null)) delete draftAnswers[action.q];
        if (action.type === "thread" && draftThreads[action.q] === request.snapshots.threads[action.q]) delete draftThreads[action.q];
      }
      retryRequest = null;
      persistLocal();
      setBarNote(""); // The pending state already reads "Agent is thinking…"; a sticky note would outlive it.
      $("finish-dialog").close();
      await refresh();
      dirty = JSON.stringify(draftAnswers) !== JSON.stringify(state?.drafts?.answers || {}) || JSON.stringify(draftThreads) !== JSON.stringify(state?.drafts?.threads || {});
      if (dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(saveDrafts, 300); }
      const currentQuestion = state?.questions?.find((question) => question.id === selected);
      const nextOpen = (state?.questions || []).find((question) => question.status === "open" && !hasDraft(draftAnswers[question.id]));
      if (!request.finish && nextOpen && currentQuestion?.status !== "open") {
        selected = nextOpen.id;
        render();
        if (view === "questions") $("question-title").focus({ preventScroll: true });
      }
      return true;
    } catch (error) {
      showError(error.message || "Submission failed", !navigator.onLine);
      if (retryRequest) {
        setBarNote(`Not confirmed: ${error.message}. Retry uses the exact saved request; drafts remain.`);
      } else {
        setBarNote("Submission rejected. Edit and resend a corrected request.");
      }
      return false;
    } finally {
      sending = false;
      renderBottomBar();
      renderQuestion();
    }
  }
  async function sendNative(actions) { if (canSubmit()) await postActions(actions); }
  async function updateContext(patch) {
    try {
      const response = await api("/api/context", { method: "POST", body: JSON.stringify(patch) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Context save failed (${response.status})`);
      state.context = result;
      renderKnowledge();
      $("context-status").textContent = "Saved.";
      return true;
    } catch (error) { showError(error.message, !navigator.onLine); $("context-status").textContent = `Not saved: ${error.message}`; return false; }
  }
  // ----- Events -----
  $("answer-text").addEventListener("input", (event) => {
    const q = qSelected();
    if (q) stageText(q, event.target.value);
  });
  $("thread-input").addEventListener("input", (event) => {
    const q = qSelected();
    if (!q) return;
    draftThreads[q.id] = event.target.value;
    markDirty();
  });
  $("staged-bubble-x").addEventListener("click", () => {
    const q = qSelected();
    if (!q) return;
    delete draftThreads[q.id];
    $("thread-input").value = "";
    markDirty();
    renderDiscussion(q, false);
  });
  $("intent-input").addEventListener("input", (event) => { intentDraft = event.target.value; });
  $("back-action").addEventListener("click", () => { if ($("back-action").dataset.target) selectQuestion($("back-action").dataset.target); });
  $("next-action").addEventListener("click", () => {
    const mode = $("next-action").dataset.mode;
    if (mode === "send") $("send-btn").click();
    else if (mode === "finish") $("finish-btn").click();
    else if ($("next-action").dataset.target) selectQuestion($("next-action").dataset.target);
  });
  $("send-btn").addEventListener("click", () => postActions(null, retryRequest ? { retry: true } : { drafts: true }));
  $("explore-action").addEventListener("click", () => { const q = qSelected(); if (q) sendNative([{ type: "explore", q: q.id }]); });
  $("defer-action").addEventListener("click", () => {
    const q = qSelected();
    if (!q) return;
    // A deferral is only actionable later if we record what unblocks it.
    const until = (prompt("Revisit this when… (optional)") || "").trim();
    sendNative([{ type: "defer", q: q.id, ...(until ? { until } : {}) }]);
  });
  $("reopen-action").addEventListener("click", () => { const q = qSelected(); if (q) sendNative([{ type: "reopen", q: q.id }]); });
  $("finish-btn").addEventListener("click", () => {
    const questions = state?.questions || [];
    const open = questions.filter((question) => question.status === "open");
    const staged = readyAnswers().length + readyThreads().length;
    $("finish-summary").textContent = `${open.length} open question${open.length === 1 ? "" : "s"} · ${staged} staged item${staged === 1 ? "" : "s"} will be sent and recorded.`;
    const root = $("finish-drafts");
    root.replaceChildren();
    for (const question of readyAnswers()) {
      const item = document.createElement("p");
      item.textContent = `${question.title}: ${formatAnswer(question, draftAnswers[question.id])}`;
      root.append(item);
    }
    for (const [id, text] of readyThreads()) {
      const item = document.createElement("p");
      item.textContent = `Message · ${state.questions.find((question) => question.id === id)?.title || id}: ${text}`;
      root.append(item);
    }
    for (const question of open) {
      if (hasDraft(draftAnswers[question.id])) continue;
      const item = document.createElement("p");
      item.className = "hint";
      item.textContent = `${question.title}: no answer draft; will remain unresolved`;
      root.append(item);
    }
    $("finish-dialog").showModal();
  });
  $("cancel-finish").addEventListener("click", () => $("finish-dialog").close());
  $("confirm-finish").addEventListener("click", () => postActions(null, { finish: true, drafts: true }));
  $("seg-questions").addEventListener("click", () => { view = "questions"; render(); });
  $("seg-visual").addEventListener("click", () => { view = "visual"; render(); void loadSelectedArtifact(); });
  $("seg-proto").addEventListener("click", () => switchVisualKind("prototype"));
  $("seg-diag").addEventListener("click", () => switchVisualKind("diagram"));
  $("gen-proto").addEventListener("click", () => { visualKindPinned = true; visualKind = "prototype"; renderVisual(); generateVisual("prototype"); });
  $("gen-diag").addEventListener("click", () => { visualKindPinned = true; visualKind = "diagram"; renderVisual(); generateVisual("diagram"); });
  $("gen-kind").addEventListener("click", () => generateVisual(visualKind));
  $("regen-btn").addEventListener("click", () => generateVisual(visualKind));
  $("redraw-btn").addEventListener("click", () => {
    const feedback = $("visual-feedback").value.trim();
    if (feedback) generateVisual(visualKind, feedback);
  });
  $("visual-feedback").addEventListener("input", () => {
    visualFeedbackDrafts[visualKind] = $("visual-feedback").value;
    renderRedraw();
  });
  $("download-visual").addEventListener("click", () => {
    const url = visualKind === "prototype" ? prototypeUrl : diagramUrl;
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = visualKind === "prototype" ? "prototype.html" : "diagram.svg";
    anchor.click();
  });
  $("notes-btn").addEventListener("click", () => openDrawer("notes"));
  $("report-btn").addEventListener("click", () => openDrawer("report"));
  $("open-report-btn").addEventListener("click", () => openDrawer("report"));
  $("notes-close").addEventListener("click", closeDrawer);
  $("report-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  $("save-context").addEventListener("click", async () => {
    const snapshot = $("intent-input").value;
    intentDraft = snapshot;
    if (await updateContext({ intent: snapshot }) && $("intent-input").value === snapshot) {
      intentDraft = null;
      renderKnowledge();
    }
  });
  $("add-term").addEventListener("click", async () => {
    const term = $("term-input").value.trim(); const meaning = $("term-meaning").value.trim();
    if (!term || !meaning) return;
    const avoid = $("term-avoid").value.split(",").map((value) => value.trim()).filter(Boolean);
    const snapshot = [term, meaning, $("term-avoid").value];
    if (await updateContext({ terms: [{ term, definition: meaning, ...(avoid.length ? { avoid } : {}) }] }) && $("term-input").value === snapshot[0] && $("term-meaning").value === snapshot[1] && $("term-avoid").value === snapshot[2]) $("term-input").value = $("term-meaning").value = $("term-avoid").value = "";
  });
  $("add-fact").addEventListener("click", async () => {
    const text = $("fact-input").value.trim(); if (!text) return;
    const source = $("fact-source").value; const snapshot = [text, source];
    if (await updateContext({ facts: [{ id: uid(), text, ...(source.trim() ? { source: source.trim() } : {}) }] }) && $("fact-input").value.trim() === snapshot[0] && $("fact-source").value === snapshot[1]) $("fact-input").value = $("fact-source").value = "";
  });
  $("add-risk").addEventListener("click", async () => {
    const text = $("risk-input").value.trim(); if (!text) return;
    const mitigation = $("risk-mitigation").value; const snapshot = [text, mitigation];
    if (await updateContext({ risks: [{ id: uid(), text, ...(mitigation.trim() ? { mitigation: mitigation.trim() } : {}) }] }) && $("risk-input").value.trim() === snapshot[0] && $("risk-mitigation").value === snapshot[1]) $("risk-input").value = $("risk-mitigation").value = "";
  });
  $("load-report").addEventListener("click", loadReport);
  $("report-download").addEventListener("click", downloadReport);
  $("export-kind").addEventListener("change", updateExportDestination);
  $("export-submit").addEventListener("click", exportArtifact);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (state?.status !== "finished") postActions(null, retryRequest ? { retry: true } : { drafts: true });
    }
  });
  window.addEventListener("online", () => { syncBanner(); updateSync(); });
  window.addEventListener("offline", () => { showError("The browser is offline.", true); updateSync(); });
  window.addEventListener("beforeunload", (event) => { if (dirty || saving || sending) { event.preventDefault(); event.returnValue = ""; } });
  document.addEventListener("click", () => {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }, { once: true });
  refresh();
  setInterval(refresh, 1800);
})();
