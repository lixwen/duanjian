import "./styles.css";
import "@phosphor-icons/webcomponents/PhCaretRight";
import "@phosphor-icons/webcomponents/PhArchive";
import "@phosphor-icons/webcomponents/PhDotsThree";
import "@phosphor-icons/webcomponents/PhGlobeSimple";
import "@phosphor-icons/webcomponents/PhPlugsConnected";
import "@phosphor-icons/webcomponents/PhPulse";
import { applyStaticTranslations, createTranslator, detectLocale, translateServerError } from "./i18n.js";
import { createConversationTurnAnchors, hashText, normalizeConversationSearch } from "./conversation-reader.js";
import {
  managedShareFromPublish,
  normalizeManagedShare,
  readManagedShares,
  removeManagedShare,
  upsertManagedShare,
} from "./share-management.js";

const $ = (selector) => document.querySelector(selector);
const DRAFT_KEY = "duanjian-draft-v1";
const TOC_COLLAPSED_KEY = "duanjian-toc-collapsed-v1";
const LOCALE_KEY = "duanjian-locale-v1";
const MANAGED_EDIT_KEY = "notelet-managed-edit-v1";
const FORK_DRAFT_KEY = "notelet-fork-draft-v1";
let storedLocale = null;
try {
  storedLocale = localStorage.getItem(LOCALE_KEY);
} catch {
  // The bootstrap locale still works when browser storage is unavailable.
}
const locale = detectLocale(document.documentElement.dataset.locale || storedLocale, navigator.language);
const t = createTranslator(locale);
applyStaticTranslations(locale);
document.documentElement.dataset.locale = locale;
document.documentElement.dataset.i18nReady = "true";
document.documentElement.removeAttribute("data-i18n-pending");

const elements = {
  editorView: $("#editorView"),
  readerView: $("#readerView"),
  conversationView: $("#conversationView"),
  conversationFeed: $("#conversationFeed"),
  conversationSearch: $("#conversationSearch"),
  conversationSearchClear: $("#conversationSearchClear"),
  conversationSearchStatus: $("#conversationSearchStatus"),
  conversationNoResults: $("#conversationNoResults"),
  conversationNoResultsText: $("#conversationNoResultsText"),
  conversationAnswerToggle: $("#conversationAnswerToggle"),
  conversationDisclosureToggle: $("#conversationDisclosureToggle"),
  statusView: $("#statusView"),
  systemStatusView: $("#systemStatusView"),
  agentSetupView: $("#agentSetupView"),
  managedSharesView: $("#managedSharesView"),
  managedSharesList: $("#managedSharesList"),
  managedSharesEmpty: $("#managedSharesEmpty"),
  titleInput: $("#titleInput"),
  authorInput: $("#authorInput"),
  markdownInput: $("#markdownInput"),
  visualEditor: $("#visualEditor"),
  editorLoading: $("#editorLoading"),
  dropZone: $("#dropZone"),
  publishDialog: $("#publishDialog"),
  successDialog: $("#successDialog"),
  manageShareDialog: $("#manageShareDialog"),
  publishButton: $("#publishButton"),
  confirmPublishButton: $("#confirmPublishButton"),
  ttlSelect: $("#ttlSelect"),
  slugInput: $("#slugInput"),
  tocPanel: $("#tocPanel"),
  tocToggle: $("#tocToggle"),
  tocLabel: $("#tocLabel"),
  tocNav: $("#tocNav"),
  toast: $("#toast"),
  forkDocumentButton: $("#forkDocumentButton"),
};

let crepe = null;
let replaceAllCommand = null;
let currentMarkdown = "";
let currentMode = "visual";
let toastTimer;
let draftTimer;
let tocScrollHandler = null;
let editorTocTimer;
let currentManagedShare = null;
let managedSettingsEntry = null;
let currentManageToken = "";
let conversationSearchTimer;
let conversationSearchQuery = "";
let conversationAnswerOnly = false;
let conversationTurns = [];
let conversationAnchorTargets = new Map();
let conversationLegacyTargets = new Map();
let mermaidRendererPromise;
let mermaidRendererFrame;
let mermaidRequestId = 0;
const mermaidRequests = new Map();
const AGENT_SKILL_URL = "/skills/notelet-publish/SKILL.md";
const AGENT_SKILL_NAME = "notelet-publish";
const AGENT_SKILL_FILES = [
  { path: "SKILL.md", url: AGENT_SKILL_URL },
  { path: "scripts/notelet.mjs", url: "/skills/notelet-publish/scripts/notelet.mjs" },
  { path: "scripts/publish.mjs", url: "/skills/notelet-publish/scripts/publish.mjs" },
];
const agentDirectories = {
  codex: { user: "~/.agents/skills", project: ".agents/skills" },
  claude: { user: "~/.claude/skills", project: ".claude/skills" },
  cursor: { user: "~/.cursor/skills", project: ".cursor/skills" },
};
let selectedAgent = "codex";
let selectedAgentScope = "user";

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function resizeTextarea() {
  const input = elements.markdownInput;
  input.style.height = "auto";
  input.style.height = `${Math.max(window.innerHeight * 0.52, input.scrollHeight)}px`;
}

function normalizeMarkdown(markdown) {
  return markdown.replace(/^[ \t]*<br[ \t]*\/?>[ \t]*$/gim, "");
}

function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {
    return null;
  }
}

function readSessionState(key, { remove = false } = {}) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (remove) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

function editorBootstrapState() {
  const params = new URLSearchParams(location.search);
  const editingSlug = params.get("editing");
  if (editingSlug) {
    const state = readSessionState(MANAGED_EDIT_KEY);
    const entry = normalizeManagedShare(state?.entry);
    if (
      state?.version === 1
      && state.mode === "manage"
      && entry?.slug === editingSlug
      && typeof state.content === "string"
    ) return { ...state, entry };
  }
  if (params.get("fork") === "1") {
    const state = readSessionState(FORK_DRAFT_KEY, { remove: true });
    history.replaceState(null, "", "/");
    if (state?.version === 1 && state.mode === "fork" && typeof state.content === "string") return state;
  }
  return null;
}

function saveDraft() {
  const draft = {
    version: 1,
    title: elements.titleInput.value,
    author: elements.authorInput.value,
    content: currentMarkdown,
    ttl: elements.ttlSelect.value,
    slug: elements.slugInput.value,
    updatedAt: Date.now(),
  };
  try {
    if (currentManagedShare) {
      sessionStorage.setItem(MANAGED_EDIT_KEY, JSON.stringify({
        ...draft,
        mode: "manage",
        entry: currentManagedShare,
      }));
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Draft persistence is best effort; publishing and editing continue to work.
  }
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 450);
}

function setMarkdownContent(content) {
  currentMarkdown = normalizeMarkdown(content);
  elements.markdownInput.value = currentMarkdown;
  resizeTextarea();
  if (crepe && replaceAllCommand) crepe.editor.action(replaceAllCommand(currentMarkdown));
  scheduleEditorTableOfContents();
  scheduleDraftSave();
}

function focusCurrentEditor() {
  if (currentMode === "source") elements.markdownInput.focus();
  else elements.visualEditor.querySelector(".ProseMirror")?.focus();
}

function setMode(mode) {
  if (mode !== "visual" && mode !== "source") return;
  if (mode === "source" && crepe) {
    currentMarkdown = normalizeMarkdown(crepe.getMarkdown());
    elements.markdownInput.value = currentMarkdown;
  }
  if (mode === "visual" && currentMode === "source") {
    currentMarkdown = elements.markdownInput.value;
    if (crepe && replaceAllCommand) crepe.editor.action(replaceAllCommand(currentMarkdown));
  }

  currentMode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  elements.visualEditor.hidden = mode !== "visual";
  elements.markdownInput.hidden = mode !== "source";
  if (mode === "source") resizeTextarea();
  scheduleEditorTableOfContents();
  focusCurrentEditor();
}

function inferTitleFromMarkdown(content, fallback) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return fallback || heading || "";
}

function importMarkdown(file) {
  if (!file.name.toLowerCase().endsWith(".md") && file.type !== "text/markdown") {
    showToast(t("chooseMarkdown"));
    return;
  }
  if (file.size > 1_000_000) {
    showToast(t("markdownTooLarge"));
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const content = String(reader.result || "");
    setMarkdownContent(content);
    elements.titleInput.value = inferTitleFromMarkdown(content, elements.titleInput.value)
      || file.name.replace(/\.md$/i, "");
    scheduleDraftSave();
    showToast(t("markdownImported"));
  };
  reader.readAsText(file);
}

function safeImageAlt(file) {
  const stem = (file.name || t("image")).replace(/\.[^.]+$/, "").replace(/[\[\]\\]/g, "").trim();
  return stem || t("image");
}

function replaceSourceText(search, replacement) {
  const index = elements.markdownInput.value.indexOf(search);
  if (index === -1) return;
  elements.markdownInput.setRangeText(replacement, index, index + search.length, "end");
  elements.markdownInput.dispatchEvent(new Event("input", { bubbles: true }));
}

async function uploadImage(file) {
  if (!file.type.startsWith("image/")) throw new Error(t("noImage"));
  if (file.size > 10_000_000) throw new Error(t("imageTooLarge"));

  const response = await fetch("/api/images", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(translateServerError(data.error, locale) || t("imageUploadFailed"));
  return data;
}

async function uploadImageForVisualEditor(file) {
  const uploaded = await uploadImage(file);
  return uploaded.url;
}

async function insertImagesInSource(files) {
  const images = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, 10);
  if (images.length === 0) return false;

  const placeholders = images.map(() => `![${t("imageUploading")}](#duanjian-upload-${crypto.randomUUID()})`);
  const placeholderBlock = placeholders.join("\n\n");
  const start = elements.markdownInput.selectionStart;
  const end = elements.markdownInput.selectionEnd;
  const before = start > 0 && elements.markdownInput.value[start - 1] !== "\n" ? "\n\n" : "";
  const after = end < elements.markdownInput.value.length && elements.markdownInput.value[end] !== "\n" ? "\n\n" : "";
  elements.markdownInput.setRangeText(`${before}${placeholderBlock}${after}`, start, end, "end");
  elements.markdownInput.dispatchEvent(new Event("input", { bubbles: true }));
  showToast(images.length === 1 ? t("uploadingOneImage") : t("uploadingImages", { count: images.length }));

  await Promise.all(images.map(async (file, index) => {
    try {
      const uploaded = await uploadImage(file);
      replaceSourceText(placeholders[index], `![${safeImageAlt(file)}](${uploaded.url})`);
    } catch (error) {
      replaceSourceText(placeholders[index], "");
      throw error;
    }
  }));

  showToast(images.length === 1 ? t("imageInserted") : t("imagesInserted", { count: images.length }));
  elements.markdownInput.focus();
  return true;
}

function updateEditorShareMode() {
  const editing = Boolean(currentManagedShare);
  elements.publishButton.textContent = t(editing ? "saveChanges" : "publish");
  elements.slugInput.disabled = editing;
  if (editing) document.title = `${currentManagedShare.title || t("managedSharesTitle")} — ${t("brandName")}`;
}

async function initializeVisualEditor() {
  const bootstrap = editorBootstrapState();
  const draft = bootstrap ?? readDraft();
  currentManagedShare = bootstrap?.mode === "manage" ? bootstrap.entry : null;
  if (draft?.version === 1) {
    elements.titleInput.value = typeof draft.title === "string" ? draft.title : "";
    elements.authorInput.value = typeof draft.author === "string" ? draft.author : "";
    elements.ttlSelect.value = typeof draft.ttl === "string" ? draft.ttl : "604800";
    elements.slugInput.value = typeof draft.slug === "string" ? draft.slug : "";
    currentMarkdown = typeof draft.content === "string" ? draft.content : "";
  }
  elements.markdownInput.value = currentMarkdown;
  updateEditorShareMode();

  try {
    const [
      { CrepeBuilder },
      { cursor },
      { listItem },
      { linkTooltip },
      { imageBlock },
      { blockEdit },
      { toolbar },
      { placeholder },
      { table },
      { replaceAll, $prose },
      { Plugin, PluginKey },
      { Decoration, DecorationSet },
    ] = await Promise.all([
      import("@milkdown/crepe/builder"),
      import("@milkdown/crepe/feature/cursor"),
      import("@milkdown/crepe/feature/list-item"),
      import("@milkdown/crepe/feature/link-tooltip"),
      import("@milkdown/crepe/feature/image-block"),
      import("@milkdown/crepe/feature/block-edit"),
      import("@milkdown/crepe/feature/toolbar"),
      import("@milkdown/crepe/feature/placeholder"),
      import("@milkdown/crepe/feature/table"),
      import("@milkdown/kit/utils"),
      import("@milkdown/kit/prose/state"),
      import("@milkdown/kit/prose/view"),
      import("@milkdown/crepe/theme/common/prosemirror.css"),
      import("@milkdown/crepe/theme/common/reset.css"),
      import("@milkdown/crepe/theme/common/block-edit.css"),
      import("@milkdown/crepe/theme/common/cursor.css"),
      import("@milkdown/crepe/theme/common/image-block.css"),
      import("@milkdown/crepe/theme/common/link-tooltip.css"),
      import("@milkdown/crepe/theme/common/list-item.css"),
      import("@milkdown/crepe/theme/common/placeholder.css"),
      import("@milkdown/crepe/theme/common/toolbar.css"),
      import("@milkdown/crepe/theme/common/table.css"),
      import("@milkdown/crepe/theme/frame.css"),
    ]);
    replaceAllCommand = replaceAll;
    const mermaidPreview = createMermaidPreviewFeature({ $prose, Plugin, PluginKey, Decoration, DecorationSet });
    crepe = new CrepeBuilder({
      root: elements.visualEditor,
      defaultValue: currentMarkdown,
    })
      .addFeature(cursor)
      .addFeature(listItem)
      .addFeature(linkTooltip, { inputPlaceholder: t("pasteLink") })
      .addFeature(imageBlock, {
        onUpload: uploadImageForVisualEditor,
        inlineOnUpload: uploadImageForVisualEditor,
        blockOnUpload: uploadImageForVisualEditor,
        inlineUploadButton: t("upload"),
        blockUploadButton: t("chooseImage"),
        blockConfirmButton: t("confirm"),
        inlineUploadPlaceholderText: t("pasteImageUrl"),
        blockUploadPlaceholderText: t("pasteImageUrl"),
        blockCaptionPlaceholderText: t("imageCaption"),
      })
      .addFeature(blockEdit, {
        textGroup: {
          label: t("text"),
          text: { label: t("paragraph") },
          h1: { label: t("heading1") },
          h2: { label: t("heading2") },
          h3: { label: t("heading3") },
          h4: { label: t("heading4") },
          h5: { label: t("heading5") },
          h6: { label: t("heading6") },
          quote: { label: t("quote") },
          divider: { label: t("divider") },
        },
        listGroup: {
          label: t("list"),
          bulletList: { label: t("bulletList") },
          orderedList: { label: t("orderedList") },
          taskList: { label: t("taskList") },
        },
        advancedGroup: {
          label: t("insert"),
          image: { label: t("image") },
          codeBlock: { label: t("codeBlock") },
          table: { label: t("table") },
          math: null,
        },
      })
      .addFeature(toolbar)
      .addFeature(placeholder, {
        text: t("editorPlaceholder"),
        mode: "block",
      })
      .addFeature(table)
      .addFeature(mermaidPreview);
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        currentMarkdown = normalizeMarkdown(markdown);
        elements.markdownInput.value = currentMarkdown;
        scheduleEditorTableOfContents();
        scheduleDraftSave();
      });
    });
    await crepe.create();
    elements.editorLoading?.remove();
    elements.visualEditor.classList.add("is-ready");
    scheduleEditorTableOfContents();
  } catch (error) {
    console.error(error);
    elements.editorLoading?.remove();
    setMode("source");
    showToast(t("visualEditorFailed"));
  }
}

async function publish() {
  const content = normalizeMarkdown(
    currentMode === "visual" && crepe ? crepe.getMarkdown() : elements.markdownInput.value,
  );
  currentMarkdown = content;
  if (!content.trim()) {
    focusCurrentEditor();
    showToast(t("writeSomething"));
    return;
  }

  const editing = Boolean(currentManagedShare);
  const title = inferTitleFromMarkdown(content, elements.titleInput.value);
  elements.confirmPublishButton.disabled = true;
  elements.confirmPublishButton.textContent = t(editing ? "savingChanges" : "publishing");
  try {
    const response = await fetch(
      editing ? `/api/shares/${encodeURIComponent(currentManagedShare.slug)}` : "/api/docs",
      {
        method: editing ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(editing ? { Authorization: `Bearer ${currentManagedShare.manageToken}` } : {}),
        },
        body: JSON.stringify(editing
          ? { title, author: elements.authorInput.value, content }
          : {
            title,
            author: elements.authorInput.value,
            content,
            slug: elements.slugInput.value,
            ttl: Number(elements.ttlSelect.value),
          }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(translateServerError(data.error, locale) || t(editing ? "manageFailed" : "publishFailed"));
    }

    let managementSaved = true;
    if (editing) {
      currentManagedShare = {
        ...currentManagedShare,
        title: data.title,
        author: data.author,
        updatedAt: data.updatedAt ?? Date.now(),
        expiresAt: data.expiresAt,
      };
      managementSaved = upsertManagedShare(currentManagedShare);
      currentManageToken = currentManagedShare.manageToken;
    } else {
      const entry = managedShareFromPublish(data, {
        kind: "document",
        title: title || t("publishedTitle"),
        author: elements.authorInput.value,
      });
      managementSaved = Boolean(entry && upsertManagedShare(entry));
      currentManageToken = typeof data.manageToken === "string" ? data.manageToken : "";
    }

    saveDraft();
    $("#shareUrlInput").value = data.url;
    $("#openDocumentLink").href = data.url;
    $("#successDialog h2").textContent = t(editing ? "savedTitle" : "publishedTitle");
    $("#successDialog > p:not(.success-management-note)").textContent = t(editing ? "savedHelp" : "publishedHelp");
    $("#successManagementNote").textContent = t(managementSaved ? "managementStored" : "managementStorageFailed");
    $("#copyManageTokenButton").hidden = !currentManageToken;
    elements.publishDialog.close();
    elements.successDialog.showModal();
    if (editing) {
      updateEditorShareMode();
      showToast(t("shareUpdated"));
    }
  } catch (error) {
    showToast(error.message || t(editing ? "manageFailed" : "publishFailed"));
  } finally {
    elements.confirmPublishButton.disabled = false;
    elements.confirmPublishButton.textContent = t(editing ? "saveConfirm" : "confirmPublish");
  }
}

function openPublishDialog() {
  const content = normalizeMarkdown(
    currentMode === "visual" && crepe ? crepe.getMarkdown() : elements.markdownInput.value,
  );
  currentMarkdown = content;
  if (!content.trim()) {
    focusCurrentEditor();
    showToast(t("writeSomething"));
    return;
  }
  saveDraft();
  const editing = Boolean(currentManagedShare);
  $("#publishCreateFields").hidden = editing;
  $("#publishDialog .eyebrow").textContent = t(editing ? "saveConfirm" : "publishEyebrow");
  $("#publishDialog h2").textContent = t(editing ? "saveConfirm" : "publishConfirm");
  $("#publishDialog .dialog-description").textContent = t(editing ? "saveConfirmHelp" : "publishConfirmHelp");
  elements.confirmPublishButton.textContent = t(editing ? "saveConfirm" : "confirmPublish");
  elements.publishDialog.showModal();
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(timestamp));
}

function formatExpiry(timestamp) {
  if (!timestamp) return t("neverExpires");
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return t("expired");
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours < 24) return t("expiresHours", { count: hours });
  const days = Math.ceil(hours / 24);
  return t("expiresDays", { count: days });
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setTocCollapsed(collapsed, { persist = false } = {}) {
  elements.tocPanel.classList.toggle("is-collapsed", collapsed);
  document.body.classList.toggle("has-expanded-toc", !collapsed && !elements.tocPanel.hidden);
  elements.tocToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.tocToggle.setAttribute("aria-label", collapsed ? t("expandToc") : t("collapseToc"));
  if (persist) localStorage.setItem(TOC_COLLAPSED_KEY, String(collapsed));
}

function hideTableOfContents() {
  if (tocScrollHandler) window.removeEventListener("scroll", tocScrollHandler);
  tocScrollHandler = null;
  elements.tocNav.replaceChildren();
  elements.tocPanel.hidden = true;
  document.body.classList.remove("has-expanded-toc");
}

function renderTableOfContents(items, { label, prefix, navigate, assignElementIds = false, getScrollHeadings }) {
  hideTableOfContents();
  if (items.length < 2) return;

  const tocItems = items.map((item, index) => ({ ...item, tocId: item.tocId || `${prefix}-${index + 1}` }));
  const links = new Map();
  const elementIds = new Map();
  const fragment = document.createDocumentFragment();
  tocItems.forEach((item) => {
    if (assignElementIds && item.element) item.element.id = item.tocId;
    if (item.element) elementIds.set(item.element, item.tocId);
    const link = document.createElement("a");
    link.href = `#${item.tocId}`;
    link.dataset.level = String(item.level);
    if (item.isConversationTurn) link.dataset.conversationTurn = item.tocId;
    link.textContent = item.text;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setActive(item.tocId);
      navigate(item);
    });
    links.set(item.tocId, link);
    fragment.append(link);
  });

  elements.tocNav.append(fragment);
  elements.tocLabel.textContent = label;
  elements.tocPanel.hidden = false;
  const stored = localStorage.getItem(TOC_COLLAPSED_KEY);
  const compactViewport = window.matchMedia("(max-width: 720px)").matches;
  setTocCollapsed(compactViewport || (stored === null ? window.matchMedia("(max-width: 1180px)").matches : stored === "true"));

  const setActive = (id) => {
    links.forEach((link, key) => link.classList.toggle("is-active", key === id));
  };
  let initialHash = "";
  try {
    initialHash = decodeURIComponent(location.hash.slice(1));
  } catch {
    initialHash = location.hash.slice(1);
  }
  setActive(links.has(initialHash) ? initialHash : tocItems[0].tocId);
  const getHeadings = getScrollHeadings ?? (() => tocItems.map((item) => item.element).filter(Boolean));
  tocScrollHandler = () => {
    const headings = getHeadings();
    if (headings.length === 0) return;
    const marker = window.innerHeight * 0.3;
    const current = headings.reduce((active, heading) => {
      const distance = Math.abs(heading.getBoundingClientRect().top - marker);
      const activeDistance = Math.abs(active.getBoundingClientRect().top - marker);
      return distance < activeDistance ? heading : active;
    }, headings[0]);
    setActive(elementIds.get(current) || current.id);
  };
  window.addEventListener("scroll", tocScrollHandler, { passive: true });
  tocScrollHandler();
}

function buildReaderTableOfContents() {
  const headings = [...$("#readerBody").querySelectorAll("h1, h2, h3")]
    .filter((heading) => heading.textContent.trim())
    .map((element) => ({
      element,
      level: Number(element.tagName.slice(1)),
      text: element.textContent.trim(),
    }));
  renderTableOfContents(headings, {
    label: t("documentToc"),
    prefix: "section",
    assignElementIds: true,
    navigate: (item) => {
      scrollToHeading(item.element);
      history.replaceState(null, "", `#${item.tocId}`);
    },
  });
}

function createRenderedBlock(className, html) {
  const block = document.createElement("div");
  block.className = className;
  block.innerHTML = html;
  return block;
}

function createDiagramError(source) {
  const error = document.createElement("div");
  error.className = "diagram-error";
  const message = document.createElement("p");
  message.textContent = t("diagramError");
  const fallback = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  fallback.append(code);
  error.append(message, fallback);
  return error;
}

function handleMermaidRendererMessage(event) {
  if (event.origin !== location.origin || event.source !== mermaidRendererFrame?.contentWindow) return;
  const data = event.data;
  if (!data || data.channel !== "notelet-mermaid") return;
  if (data.type === "ready") {
    mermaidRendererPromise?.resolve?.();
    return;
  }
  const request = mermaidRequests.get(data.id);
  if (!request) return;
  clearTimeout(request.timeout);
  mermaidRequests.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.svg);
}

function loadMermaidRenderer() {
  if (mermaidRendererPromise) return mermaidRendererPromise.promise;
  let resolveReady;
  let rejectReady;
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  mermaidRendererPromise = { promise, resolve: resolveReady, reject: rejectReady };
  window.addEventListener("message", handleMermaidRendererMessage);
  mermaidRendererFrame = document.createElement("iframe");
  mermaidRendererFrame.className = "mermaid-renderer-frame";
  mermaidRendererFrame.src = "/mermaid-renderer.html";
  mermaidRendererFrame.title = t("diagramRenderer");
  mermaidRendererFrame.tabIndex = -1;
  mermaidRendererFrame.setAttribute("aria-hidden", "true");
  mermaidRendererFrame.addEventListener("error", () => rejectReady(new Error(t("diagramRendererFailed"))), { once: true });
  document.body.append(mermaidRendererFrame);
  setTimeout(() => rejectReady(new Error(t("diagramRendererFailed"))), 10_000);
  return promise;
}

async function renderMermaidSvg(source) {
  await loadMermaidRenderer();
  const id = ++mermaidRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      mermaidRequests.delete(id);
      reject(new Error(t("diagramRendererFailed")));
    }, 10_000);
    mermaidRequests.set(id, { resolve, reject, timeout });
    mermaidRendererFrame.contentWindow.postMessage({
      channel: "notelet-mermaid",
      type: "render",
      id,
      source,
    }, location.origin);
  });
}

async function createMermaidDiagram(source) {
  const svg = await renderMermaidSvg(source);
  const diagram = document.createElement("div");
  diagram.className = "mermaid-diagram";
  const image = document.createElement("img");
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  image.alt = t("diagram");
  diagram.append(image);
  return diagram;
}

function createMermaidEditorPreview(source) {
  const preview = document.createElement("section");
  preview.className = "mermaid-editor-preview";
  preview.contentEditable = "false";

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-editor-preview-toolbar";
  const label = document.createElement("span");
  label.textContent = "Mermaid";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = t("showDiagramOnly");
  toggle.addEventListener("mousedown", (event) => event.preventDefault());
  toggle.addEventListener("click", () => {
    const previewOnly = preview.classList.toggle("is-preview-only");
    toggle.textContent = t(previewOnly ? "editDiagramSource" : "showDiagramOnly");
  });
  toolbar.append(label, toggle);

  const canvas = document.createElement("div");
  canvas.className = "mermaid-editor-preview-canvas";
  const loading = document.createElement("p");
  loading.className = "diagram-loading";
  loading.textContent = t("diagramLoading");
  canvas.append(loading);
  preview.append(toolbar, canvas);

  createMermaidDiagram(source)
    .then((diagram) => canvas.replaceChildren(diagram))
    .catch((error) => {
      console.error(error);
      canvas.replaceChildren(createDiagramError(source));
    });
  return preview;
}

function createMermaidPreviewFeature({ $prose, Plugin, PluginKey, Decoration, DecorationSet }) {
  const key = new PluginKey("notelet-mermaid-preview");
  const plugin = $prose(() => new Plugin({
    key,
    state: {
      init: (_, state) => buildMermaidDecorations(state.doc, Decoration, DecorationSet),
      apply: (transaction, decorations) => transaction.docChanged
        ? buildMermaidDecorations(transaction.doc, Decoration, DecorationSet)
        : decorations.map(transaction.mapping, transaction.doc),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  }));
  return (editor) => editor.use(plugin);
}

function buildMermaidDecorations(doc, Decoration, DecorationSet) {
  const decorations = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "code_block" || node.attrs.language?.toLowerCase() !== "mermaid") return;
    const source = node.textContent;
    decorations.push(Decoration.widget(
      position + node.nodeSize,
      () => createMermaidEditorPreview(source),
      { side: -1, key: `mermaid-${position}-${hashText(source)}`, ignoreSelection: true },
    ));
  });
  return DecorationSet.create(doc, decorations);
}

async function enhanceRenderedMarkdown(root) {
  const mermaidCodeBlocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  const regularCodeBlocks = [...root.querySelectorAll("pre > code:not(.language-mermaid)")];

  if (regularCodeBlocks.length) {
    const { default: highlight } = await import("highlight.js/lib/common");
    regularCodeBlocks.forEach((code) => {
      const languageClass = [...code.classList].find((name) => name.startsWith("language-"));
      const language = languageClass?.slice("language-".length) ?? "";
      if (language && !highlight.getLanguage(language)) {
        const result = highlight.highlightAuto(code.textContent ?? "");
        code.innerHTML = result.value;
        code.classList.add("hljs");
        if (result.language) code.dataset.detectedLanguage = result.language;
        return;
      }
      highlight.highlightElement(code);
    });
  }

  if (!mermaidCodeBlocks.length) return;
  await Promise.all(mermaidCodeBlocks.map(async (code) => {
    const source = code.textContent ?? "";
    const placeholder = document.createElement("div");
    code.parentElement.replaceWith(placeholder);
    try {
      placeholder.replaceWith(await createMermaidDiagram(source));
    } catch (error) {
      console.error(error);
      placeholder.replaceWith(createDiagramError(source));
    }
  }));
}

function createDisclosure(label, className, children) {
  const details = document.createElement("details");
  details.className = `conversation-disclosure ${className}`;
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary, ...children);
  details.addEventListener("toggle", updateConversationDisclosureControl);
  return details;
}

function clearConversationHighlights(article) {
  article.querySelectorAll("mark.conversation-search-match").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
  article.normalize();
}

function isConversationSearchText(node) {
  if (!node.data.trim()) return false;
  const parent = node.parentElement;
  if (!parent || parent.closest("button, script, style, .conversation-turn-index")) return false;
  if (conversationAnswerOnly && parent.closest(".conversation-user, .conversation-disclosure")) return false;
  return Boolean(parent.closest(".conversation-turn-head, .conversation-message, .conversation-disclosure, .conversation-no-answer"));
}

function highlightConversationTurn(article, query) {
  clearConversationHighlights(article);
  if (!query) return 0;

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => isConversationSearchText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  let matches = 0;

  textNodes.forEach((node) => {
    const text = node.data;
    const searchable = text.toLocaleLowerCase("en");
    let cursor = 0;
    let matchIndex = searchable.indexOf(query);
    if (matchIndex === -1) return;

    const fragment = document.createDocumentFragment();
    while (matchIndex !== -1) {
      if (matchIndex > cursor) fragment.append(document.createTextNode(text.slice(cursor, matchIndex)));
      const mark = document.createElement("mark");
      mark.className = "conversation-search-match";
      mark.textContent = text.slice(matchIndex, matchIndex + query.length);
      fragment.append(mark);
      matches += 1;
      cursor = matchIndex + query.length;
      matchIndex = searchable.indexOf(query, cursor);
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  });

  return matches;
}

function updateConversationTocVisibility() {
  elements.tocNav.querySelectorAll("a[data-conversation-turn]").forEach((link) => {
    const article = conversationAnchorTargets.get(link.dataset.conversationTurn);
    link.hidden = Boolean(article?.hidden);
  });
  tocScrollHandler?.();
}

function updateConversationDisclosureControl() {
  const disclosures = [...elements.conversationFeed.querySelectorAll(".conversation-disclosure")];
  const allOpen = disclosures.length > 0 && disclosures.every((details) => details.open);
  elements.conversationDisclosureToggle.disabled = disclosures.length === 0 || conversationAnswerOnly;
  elements.conversationDisclosureToggle.textContent = t(allOpen ? "collapseProgress" : "expandProgress");
  elements.conversationDisclosureToggle.setAttribute("aria-expanded", String(allOpen));
  elements.conversationDisclosureToggle.setAttribute("aria-label", t(allOpen ? "collapseProgressAria" : "expandProgressAria"));
}

function applyConversationSearch(rawQuery = elements.conversationSearch.value) {
  const query = normalizeConversationSearch(rawQuery);
  const disclosures = [...elements.conversationFeed.querySelectorAll(".conversation-disclosure")];
  if (!conversationSearchQuery && query) {
    disclosures.forEach((details) => { details.dataset.searchPreviousOpen = String(details.open); });
  }
  if (conversationSearchQuery && !query) {
    disclosures.forEach((details) => {
      details.open = details.dataset.searchPreviousOpen === "true";
      delete details.dataset.searchPreviousOpen;
    });
  }
  conversationSearchQuery = query;

  let visibleTurns = 0;
  let matches = 0;
  conversationTurns.forEach(({ article }) => {
    const turnMatches = highlightConversationTurn(article, query);
    const visible = !query || turnMatches > 0;
    article.hidden = !visible;
    if (visible) visibleTurns += 1;
    matches += turnMatches;
    if (query && !conversationAnswerOnly) {
      article.querySelectorAll(".conversation-disclosure").forEach((details) => {
        details.open = Boolean(details.querySelector("mark.conversation-search-match"))
          || details.dataset.searchPreviousOpen === "true";
      });
    }
  });

  const totalTurns = conversationTurns.length;
  elements.conversationSearchClear.hidden = !query;
  elements.conversationNoResults.hidden = !query || visibleTurns > 0;
  elements.conversationNoResultsText.textContent = t("conversationNoResults", { query: rawQuery.trim() });
  elements.conversationSearchStatus.textContent = query
    ? t("conversationSearchResults", { matches, visible: visibleTurns, total: totalTurns })
    : t("conversationVisibleTurns", { visible: visibleTurns, total: totalTurns });
  updateConversationTocVisibility();
  updateConversationDisclosureControl();
}

function clearConversationSearch({ focus = false } = {}) {
  clearTimeout(conversationSearchTimer);
  elements.conversationSearch.value = "";
  applyConversationSearch("");
  if (focus) elements.conversationSearch.focus();
}

function toggleAllConversationDisclosures() {
  const disclosures = [...elements.conversationFeed.querySelectorAll(".conversation-disclosure")];
  const shouldOpen = !disclosures.every((details) => details.open);
  disclosures.forEach((details) => {
    details.open = shouldOpen;
    if (Object.hasOwn(details.dataset, "searchPreviousOpen")) {
      details.dataset.searchPreviousOpen = String(shouldOpen);
    }
  });
  updateConversationDisclosureControl();
}

function setConversationAnswerOnly(answerOnly) {
  conversationAnswerOnly = answerOnly;
  elements.conversationFeed.classList.toggle("is-answer-only", answerOnly);
  elements.conversationAnswerToggle.setAttribute("aria-pressed", String(answerOnly));
  applyConversationSearch();
}

function resetConversationReader() {
  clearTimeout(conversationSearchTimer);
  conversationSearchQuery = "";
  conversationAnswerOnly = false;
  conversationTurns = [];
  conversationAnchorTargets = new Map();
  conversationLegacyTargets = new Map();
  elements.conversationSearch.value = "";
  elements.conversationSearchClear.hidden = true;
  elements.conversationNoResults.hidden = true;
  elements.conversationSearchStatus.textContent = "";
  elements.conversationFeed.classList.remove("is-answer-only");
  elements.conversationAnswerToggle.setAttribute("aria-pressed", "false");
  elements.conversationDisclosureToggle.disabled = true;
}

function focusConversationTurn(article) {
  scrollToHeading(article);
  article.focus({ preventScroll: true });
}

function readLocationHash() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return location.hash.slice(1);
  }
}

function navigateToConversationHash() {
  if (elements.conversationView.hidden || !location.hash) return false;
  const hash = readLocationHash();
  const canonicalTarget = conversationAnchorTargets.get(hash);
  const article = canonicalTarget || conversationLegacyTargets.get(hash);
  if (!article) return false;
  if (article.hidden) clearConversationSearch();
  if (!canonicalTarget) history.replaceState(null, "", `#${article.id}`);
  focusConversationTurn(article);
  return true;
}

function renderConversation(data) {
  resetConversationReader();
  elements.conversationFeed.replaceChildren();
  const navigation = [];
  const anchors = createConversationTurnAnchors(data.turns);

  data.turns.forEach((turn, index) => {
    const anchor = anchors[index];
    const legacyAnchor = `turn-${index + 1}`;
    const article = document.createElement("article");
    article.className = "conversation-turn";
    article.id = anchor;
    article.tabIndex = -1;
    article.dataset.turn = String(index + 1);
    article.dataset.turnId = turn.id;

    const turnHead = document.createElement("header");
    turnHead.className = "conversation-turn-head";
    const turnContext = document.createElement("div");
    turnContext.className = "conversation-turn-context";
    const turnIndex = document.createElement("span");
    turnIndex.className = "conversation-turn-index";
    turnIndex.setAttribute("aria-hidden", "true");
    turnIndex.textContent = String(index + 1).padStart(2, "0");
    const turnTitle = document.createElement("h2");
    turnTitle.className = "conversation-turn-title";
    turnTitle.id = `${anchor}-title`;
    turnTitle.textContent = turn.label;
    article.setAttribute("aria-labelledby", turnTitle.id);
    turnContext.append(turnIndex, turnTitle);
    const turnLink = document.createElement("button");
    turnLink.className = "conversation-turn-link";
    turnLink.type = "button";
    turnLink.textContent = t("copyTurnLink");
    turnLink.setAttribute("aria-label", t("copyTurnLinkAria", { index: index + 1, label: turn.label }));
    turnLink.addEventListener("click", () => {
      const url = new URL(location.href);
      url.hash = anchor;
      copyText(url.href);
    });
    turnHead.append(turnContext, turnLink);
    article.append(turnHead);

    const user = document.createElement("section");
    user.className = "conversation-message conversation-user";
    const userLabel = document.createElement("p");
    userLabel.className = "conversation-role";
    userLabel.textContent = t("you");
    user.append(userLabel);
    turn.user.forEach((block) => {
      if (block.type === "text") user.append(createRenderedBlock("markdown-body conversation-user-text", block.html));
      if (block.type === "image") {
        const figure = document.createElement("figure");
        figure.className = "conversation-image";
        const image = document.createElement("img");
        image.src = block.url;
        image.alt = block.alt;
        image.loading = "lazy";
        figure.append(image);
        user.append(figure);
      }
    });
    article.append(user);

    if (turn.reasoningSummaries.length) {
      const summaries = turn.reasoningSummaries.map((summary) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = summary;
        return paragraph;
      });
      article.append(createDisclosure(t("reasoningSummary"), "conversation-reasoning", summaries));
    }

    if (turn.commentary.length || turn.activities.length) {
      const process = turn.commentary.map((item) => createRenderedBlock("markdown-body conversation-commentary", item.html));
      turn.activities.forEach((activity) => {
        const item = document.createElement("p");
        item.className = "conversation-activity";
        item.textContent = [activity.label, activity.status].filter(Boolean).join(" · ");
        process.push(item);
      });
      article.append(createDisclosure(t("process"), "conversation-process", process));
    }

    turn.answers.forEach((answer) => {
      const assistant = document.createElement("section");
      assistant.className = "conversation-message conversation-assistant";
      const assistantLabel = document.createElement("p");
      assistantLabel.className = "conversation-role";
      assistantLabel.textContent = "Codex";
      assistant.append(assistantLabel, createRenderedBlock("markdown-body conversation-answer", answer.html));
      article.append(assistant);
    });

    if (turn.answers.length === 0) {
      article.classList.add("has-no-answer");
      const noAnswer = document.createElement("p");
      noAnswer.className = "conversation-no-answer";
      noAnswer.textContent = t("noFinalAnswer");
      article.append(noAnswer);
    }

    elements.conversationFeed.append(article);
    conversationTurns.push({ article, anchor, legacyAnchor });
    conversationAnchorTargets.set(anchor, article);
    if (!conversationLegacyTargets.has(legacyAnchor)) conversationLegacyTargets.set(legacyAnchor, article);
    navigation.push({
      element: article,
      level: 1,
      text: `${String(index + 1).padStart(2, "0")}  ${turn.label}`,
      tocId: anchor,
      isConversationTurn: true,
    });
  });

  renderTableOfContents(navigation, {
    label: t("conversationToc"),
    prefix: "turn",
    assignElementIds: true,
    getScrollHeadings: () => conversationTurns.map(({ article }) => article).filter((article) => !article.hidden),
    navigate: (item) => {
      history.replaceState(null, "", `#${item.tocId}`);
      focusConversationTurn(item.element);
    },
  });
  applyConversationSearch("");
}

function getMarkdownHeadings(markdown) {
  const headings = [];
  let inFence = false;
  let offset = 0;
  let lineNumber = 0;

  for (const rawLine of markdown.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!rawLine) continue;
    const line = rawLine.replace(/\r?\n$/, "");
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = line.match(/^(#{1,3})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
      if (match) {
        const text = match[2]
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/[`*_~]/g, "")
          .trim();
        if (text) headings.push({ level: match[1].length, text, offset, lineNumber });
      }
    }
    offset += rawLine.length;
    lineNumber += 1;
  }
  return headings;
}

function scrollSourceToHeading(heading) {
  const input = elements.markdownInput;
  input.focus({ preventScroll: true });
  input.setSelectionRange(heading.offset, heading.offset);
  const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight) || 27;
  const target = input.getBoundingClientRect().top + window.scrollY + heading.lineNumber * lineHeight - window.innerHeight * 0.24;
  window.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function scrollToHeading(heading) {
  if (!heading) return;
  const target = heading.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, target), behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function getVisualEditorHeadings() {
  return [...elements.visualEditor.querySelectorAll(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3")]
    .filter((heading) => heading.textContent.trim());
}

function buildEditorTableOfContents() {
  if (elements.editorView.hidden) return;
  if (currentMode === "source") {
    renderTableOfContents(getMarkdownHeadings(elements.markdownInput.value), {
      label: t("writingToc"),
      prefix: "editor-source",
      navigate: (heading) => scrollSourceToHeading(heading),
    });
    return;
  }

  const headings = getVisualEditorHeadings()
    .map((element, index) => ({
      element,
      index,
      level: Number(element.tagName.slice(1)),
      text: element.textContent.trim(),
    }));
  renderTableOfContents(headings, {
    label: t("writingToc"),
    prefix: "editor",
    getScrollHeadings: getVisualEditorHeadings,
    navigate: (item) => scrollToHeading(getVisualEditorHeadings()[item.index]),
  });
}

function scheduleEditorTableOfContents() {
  clearTimeout(editorTocTimer);
  editorTocTimer = setTimeout(buildEditorTableOfContents, 120);
}

function formatStatusNumber(value) {
  if (!Number.isFinite(value)) return t("notAvailable");
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return t("notAvailable");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1000 && index < units.length - 1) {
    size /= 1000;
    index += 1;
  }
  return `${new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", { maximumFractionDigits: index ? 2 : 0 }).format(size)} ${units[index]}`;
}

function statusValue(value, unit) {
  return unit === "bytes" ? formatBytes(value) : formatStatusNumber(value);
}

function overviewCard(label, value, detail) {
  const card = document.createElement("article");
  card.className = "overview-card";
  const labelNode = document.createElement("p");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = formatStatusNumber(value);
  const detailNode = document.createElement("span");
  detailNode.textContent = detail;
  card.append(labelNode, valueNode, detailNode);
  return card;
}

function quotaCard(metric) {
  const card = document.createElement("article");
  card.className = "quota-card";
  const head = document.createElement("div");
  head.className = "quota-card-head";
  const title = document.createElement("h3");
  title.textContent = t(metric.id);
  const period = document.createElement("span");
  period.textContent = t(`period_${metric.period}`);
  head.append(title, period);

  const values = document.createElement("p");
  values.className = "quota-values";
  const used = document.createElement("strong");
  used.textContent = `${metric.estimated ? "≈ " : ""}${statusValue(metric.used, metric.unit)}`;
  const limit = document.createElement("span");
  limit.textContent = ` / ${statusValue(metric.limit, metric.unit)}`;
  values.append(used, limit);

  const progress = document.createElement("div");
  progress.className = "quota-progress";
  progress.setAttribute("role", "progressbar");
  const percentage = Number.isFinite(metric.used) ? Math.min(100, Math.max(0, metric.used / metric.limit * 100)) : 0;
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", String(Math.round(percentage)));
  const fill = document.createElement("span");
  fill.style.width = `${percentage}%`;
  if (percentage >= 80) fill.className = "is-warning";
  progress.append(fill);

  const source = document.createElement("a");
  source.href = metric.source;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.textContent = t("officialQuotaSource");
  card.append(head, values, progress);
  if (metric.estimated) {
    const estimate = document.createElement("p");
    estimate.className = "quota-note";
    estimate.textContent = t("estimatedLowerBound");
    card.append(estimate);
  }
  card.append(source);
  return card;
}

function resourceCard(resource) {
  const card = document.createElement("article");
  card.className = "resource-card";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = t(resource.id);
  const detail = document.createElement("p");
  detail.textContent = t(`${resource.id}Detail`, { count: resource.value });
  copy.append(title, detail);
  const source = document.createElement("a");
  source.href = resource.source;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.textContent = t("officialResourceSource");
  card.append(copy, source);
  return card;
}

async function loadSystemStatus() {
  document.querySelectorAll(".editor-only, .reader-only").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".status-only").forEach((el) => { el.hidden = false; });
  elements.editorView.hidden = true;
  elements.readerView.hidden = true;
  elements.conversationView.hidden = true;
  elements.statusView.hidden = true;
  elements.systemStatusView.hidden = false;
  document.title = t("statusPageTitle");
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $("#systemHealthText").textContent = t("operational");
    $("#statusOverview").replaceChildren(
      overviewCard(t("totalShares"), data.documents.total, t("currentTotal")),
      overviewCard(t("markdownDocuments"), data.documents.markdown, t("currentTotal")),
      overviewCard(t("codexConversations"), data.documents.conversations, t("currentTotal")),
      overviewCard(t("storedImages"), data.images.objects, formatBytes(data.images.bytes)),
    );
    $("#quotaGrid").replaceChildren(...data.metrics.map(quotaCard));
    $("#resourceGrid").replaceChildren(...(data.resources || []).map(resourceCard));
    $("#quotaUpdated").textContent = t("updatedAt", { date: formatDate(data.generatedAt) });
    if (!data.analyticsAvailable) {
      $("#statusNotice").hidden = false;
      $("#statusNotice").textContent = t(data.analyticsConfigured ? "analyticsPartial" : "analyticsUnavailable");
    }
  } catch {
    $("#systemHealthText").textContent = t("statusLoadFailed");
    $("#statusOverview").replaceChildren();
    $("#quotaGrid").replaceChildren();
    $("#resourceGrid").replaceChildren();
  }
}

async function managedShareRequest(entry, { method = "GET", body } = {}) {
  const response = await fetch(
    `/api/shares/${encodeURIComponent(entry.slug)}${method === "GET" ? "?manage=1" : ""}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${entry.manageToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(translateServerError(data?.error, locale) || t("manageFailed"));
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function managedEntryFromResponse(entry, data) {
  return {
    ...entry,
    kind: data.kind === "conversation" ? "conversation" : "document",
    title: data.title,
    author: data.author ?? "",
    createdAt: data.createdAt ?? entry.createdAt,
    updatedAt: data.updatedAt ?? Date.now(),
    expiresAt: data.expiresAt,
  };
}

function removeUnavailableManagedEntry(entry, error) {
  if (error?.status !== 404 && error?.status !== 410) return;
  removeManagedShare(entry.slug);
  renderManagedShares();
}

function managedActionButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

async function editManagedDocument(entry) {
  try {
    const data = await managedShareRequest(entry);
    if (data.kind !== "document" || typeof data.content !== "string") throw new Error(t("manageLoadFailed"));
    const currentEntry = managedEntryFromResponse(entry, data);
    if (!upsertManagedShare(currentEntry)) throw new Error(t("managementStorageFailed"));
    sessionStorage.setItem(MANAGED_EDIT_KEY, JSON.stringify({
      version: 1,
      mode: "manage",
      entry: currentEntry,
      title: data.title,
      author: data.author,
      content: data.content,
      updatedAt: data.updatedAt ?? Date.now(),
    }));
    location.href = `/?editing=${encodeURIComponent(entry.slug)}`;
  } catch (error) {
    removeUnavailableManagedEntry(entry, error);
    showToast(error?.message || t("manageLoadFailed"));
  }
}

function openManagedShareSettings(entry) {
  managedSettingsEntry = entry;
  $("#manageTitleInput").value = entry.title;
  $("#manageAuthorInput").value = entry.author;
  $("#manageAuthorField").hidden = entry.kind === "conversation";
  $("#manageTtlSelect").value = "";
  elements.manageShareDialog.showModal();
}

async function saveManagedShareSettings() {
  if (!managedSettingsEntry) return;
  const entry = managedSettingsEntry;
  const button = $("#saveManageShareButton");
  const body = { title: $("#manageTitleInput").value };
  if (entry.kind === "document") body.author = $("#manageAuthorInput").value;
  if ($("#manageTtlSelect").value !== "") body.ttl = Number($("#manageTtlSelect").value);
  button.disabled = true;
  button.textContent = t("savingSettings");
  try {
    const data = await managedShareRequest(entry, { method: "PATCH", body });
    const updated = managedEntryFromResponse(entry, data);
    if (!upsertManagedShare(updated)) throw new Error(t("managementStorageFailed"));
    elements.manageShareDialog.close();
    managedSettingsEntry = null;
    renderManagedShares();
    showToast(t("settingsSaved"));
  } catch (error) {
    removeUnavailableManagedEntry(entry, error);
    showToast(error?.message || t("manageFailed"));
  } finally {
    button.disabled = false;
    button.textContent = t("saveSettings");
  }
}

async function deleteManagedEntry(entry) {
  if (!window.confirm(t("confirmDeleteShare", { title: entry.title || entry.slug }))) return;
  try {
    await managedShareRequest(entry, { method: "DELETE" });
    removeManagedShare(entry.slug);
    renderManagedShares();
    showToast(t("shareDeleted"));
  } catch (error) {
    removeUnavailableManagedEntry(entry, error);
    showToast(error?.message || t("manageFailed"));
  }
}

function forgetManagedEntry(entry) {
  if (!window.confirm(t("confirmForgetShare", { title: entry.title || entry.slug }))) return;
  removeManagedShare(entry.slug);
  renderManagedShares();
  showToast(t("shareForgotten"));
}

function managedShareCard(entry) {
  const card = document.createElement("article");
  card.className = "managed-share-card";

  const head = document.createElement("div");
  head.className = "managed-share-card-head";
  const identity = document.createElement("div");
  identity.className = "managed-share-identity";
  const kind = document.createElement("p");
  kind.className = "managed-share-kind";
  kind.textContent = t(entry.kind === "conversation" ? "managedConversation" : "managedDocument");
  const title = document.createElement("h2");
  const titleLink = document.createElement("a");
  titleLink.href = `/${encodeURIComponent(entry.slug)}`;
  titleLink.textContent = entry.title || entry.slug;
  title.append(titleLink);
  identity.append(kind, title);
  const expiry = document.createElement("span");
  expiry.className = "managed-share-expiry";
  expiry.textContent = formatExpiry(entry.expiresAt);
  head.append(identity, expiry);

  const meta = document.createElement("p");
  meta.className = "managed-share-meta";
  meta.textContent = `/${entry.slug} · ${t("managedUpdated", { date: formatDate(entry.updatedAt) })}`;

  const actions = document.createElement("div");
  actions.className = "managed-share-actions";
  const open = document.createElement("a");
  open.className = "managed-share-action is-primary";
  open.href = `/${encodeURIComponent(entry.slug)}`;
  open.textContent = t("managedOpen");
  actions.append(open);
  if (entry.kind === "document") {
    actions.append(managedActionButton(t("managedEdit"), "managed-share-action", () => editManagedDocument(entry)));
  }
  actions.append(
    managedActionButton(t("managedSettings"), "managed-share-action", () => openManagedShareSettings(entry)),
    managedActionButton(t("managedDelete"), "managed-share-action is-danger", () => deleteManagedEntry(entry)),
    managedActionButton(t("managedForget"), "managed-share-action is-quiet", () => forgetManagedEntry(entry)),
  );
  card.append(head, meta, actions);
  return card;
}

function renderManagedShares() {
  const entries = readManagedShares();
  elements.managedSharesList.replaceChildren(...entries.map(managedShareCard));
  elements.managedSharesList.hidden = entries.length === 0;
  elements.managedSharesEmpty.hidden = entries.length !== 0;
}

function loadManagedShares() {
  hideTableOfContents();
  document.querySelectorAll(".editor-only, .reader-only").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".status-only").forEach((el) => { el.hidden = false; });
  elements.editorView.hidden = true;
  elements.readerView.hidden = true;
  elements.conversationView.hidden = true;
  elements.statusView.hidden = true;
  elements.systemStatusView.hidden = true;
  elements.agentSetupView.hidden = true;
  elements.managedSharesView.hidden = false;
  document.title = t("managedPageTitle");
  renderManagedShares();
}

function agentInstallPath() {
  return agentDirectories[selectedAgent][selectedAgentScope];
}

function agentInstallCommand() {
  const root = agentInstallPath().replace(/^~/, "$HOME");
  const target = `${root}/${AGENT_SKILL_NAME}`;
  const downloads = AGENT_SKILL_FILES.map(({ path, url }) => (
    `curl -fsSL "${location.origin}${url}" -o "${target}/${path}"`
  ));
  return [`mkdir -p "${target}/scripts"`, ...downloads].join(" && ");
}

function updateAgentInstaller() {
  document.querySelectorAll("[data-agent]").forEach((button) => {
    const selected = button.dataset.agent === selectedAgent;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-scope]").forEach((button) => {
    const selected = button.dataset.scope === selectedAgentScope;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#agentTargetPath").textContent = agentInstallPath();
  $("#agentInstallCommand").textContent = agentInstallCommand();
  $("#agentInstallStatus").textContent = "";
  $("#agentInstallStatus").classList.remove("is-success");
}

async function fetchAgentSkillFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(t("agentSkillLoadFailed"));
  return response.text();
}

async function writeAgentSkillFile(root, path, content) {
  const parts = path.split("/");
  const filename = parts.pop();
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

async function installAgentSkill() {
  const status = $("#agentInstallStatus");
  if (!("showDirectoryPicker" in window)) {
    status.textContent = t("agentPickerUnsupported");
    $("#agentManualTitle").closest("details").open = true;
    return;
  }

  const button = $("#agentInstallButton");
  button.disabled = true;
  status.textContent = t("agentChooseDirectory", { path: agentInstallPath() });
  try {
    const [files, root] = await Promise.all([
      Promise.all(AGENT_SKILL_FILES.map(async ({ path, url }) => ({
        path,
        content: await fetchAgentSkillFile(url),
      }))),
      window.showDirectoryPicker({ mode: "readwrite" }),
    ]);
    const directory = await root.getDirectoryHandle(AGENT_SKILL_NAME, { create: true });
    for (const file of files) await writeAgentSkillFile(directory, file.path, file.content);
    status.textContent = t("agentInstallSuccess", { agent: document.querySelector(`[data-agent="${selectedAgent}"] strong`).textContent });
    status.classList.add("is-success");
  } catch (error) {
    status.classList.remove("is-success");
    if (error?.name === "AbortError") status.textContent = t("agentInstallCancelled");
    else status.textContent = error?.message || t("agentInstallFailed");
  } finally {
    button.disabled = false;
  }
}

async function downloadAgentSkill() {
  try {
    const skill = await fetchAgentSkillFile(AGENT_SKILL_URL);
    const url = URL.createObjectURL(new Blob([skill], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    $("#agentInstallStatus").textContent = error?.message || t("agentSkillLoadFailed");
  }
}

function loadAgentSetup() {
  hideTableOfContents();
  document.querySelectorAll(".editor-only, .reader-only").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".status-only").forEach((el) => { el.hidden = false; });
  elements.editorView.hidden = true;
  elements.readerView.hidden = true;
  elements.conversationView.hidden = true;
  elements.statusView.hidden = true;
  elements.systemStatusView.hidden = true;
  elements.agentSetupView.hidden = false;
  document.title = t("agentPageTitle");
  updateAgentInstaller();
}

function forkDocument(data) {
  try {
    sessionStorage.setItem(FORK_DRAFT_KEY, JSON.stringify({
      version: 1,
      mode: "fork",
      title: t("forkedTitle", { title: data.title }),
      author: "",
      content: data.content,
      ttl: "604800",
      slug: "",
      updatedAt: Date.now(),
    }));
    location.href = "/?fork=1";
  } catch {
    showToast(t("manageLoadFailed"));
  }
}

async function loadShare(slug) {
  document.querySelectorAll(".editor-only").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".reader-only").forEach((el) => { el.hidden = false; });
  elements.editorView.hidden = true;
  elements.forkDocumentButton.hidden = true;
  elements.forkDocumentButton.onclick = null;

  try {
    const response = await fetch(`/api/shares/${encodeURIComponent(slug)}`);
    const data = await response.json();
    if (!response.ok) {
      showStatus(response.status, data.error);
      return;
    }
    document.title = `${data.title} — ${t("brandName")}`;
    if (data.kind === "conversation") {
      $("#conversationSource").textContent = `${data.source || "Codex"} ${t("conversationSuffix")}`;
      $("#conversationTitle").textContent = data.title;
      $("#conversationMeta").textContent = t("turnsMeta", { count: data.turns.length, date: formatDate(data.createdAt) });
      $("#conversationExpiry").textContent = formatExpiry(data.expiresAt);
      $("#rawLink").href = `/api/conversations/${encodeURIComponent(slug)}/raw`;
      $("#rawLink").textContent = "JSON";
      renderConversation(data);
      await enhanceRenderedMarkdown(elements.conversationFeed);
      elements.conversationView.hidden = false;
      requestAnimationFrame(() => navigateToConversationHash());
      return;
    }
    $("#readerTitle").textContent = data.title;
    $("#readerMeta").textContent = [data.author, formatDate(data.createdAt)].filter(Boolean).join(" · ");
    $("#readerBody").innerHTML = data.html;
    await enhanceRenderedMarkdown($("#readerBody"));
    buildReaderTableOfContents();
    $("#expiryLabel").textContent = formatExpiry(data.expiresAt);
    $("#rawLink").href = `/api/docs/${encodeURIComponent(slug)}/raw`;
    $("#rawLink").textContent = "Markdown";
    elements.forkDocumentButton.hidden = false;
    elements.forkDocumentButton.onclick = () => forkDocument(data);
    elements.readerView.hidden = false;
  } catch {
    hideTableOfContents();
    showStatus(503, t("loadFailed"));
  }
}

function showStatus(code, message) {
  hideTableOfContents();
  elements.readerView.hidden = true;
  elements.conversationView.hidden = true;
  elements.statusView.hidden = false;
  $("#statusCode").textContent = String(code);
  $("#statusTitle").textContent = code === 410 ? t("documentExpired") : code === 404 ? t("notFoundTitle") : t("openFailed");
  $("#statusMessage").textContent = translateServerError(message, locale) || t("notFoundMessage");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  showToast(t("copied"));
}

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.querySelectorAll("[data-agent]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedAgent = button.dataset.agent;
    updateAgentInstaller();
  });
});
document.querySelectorAll("[data-scope]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedAgentScope = button.dataset.scope;
    updateAgentInstaller();
  });
});
$("#agentInstallButton").addEventListener("click", installAgentSkill);
$("#agentCopyCommand").addEventListener("click", async () => {
  await navigator.clipboard.writeText(agentInstallCommand());
  showToast(t("agentCommandCopied"));
});
$("#agentDownloadSkill").addEventListener("click", downloadAgentSkill);

function closeUtilityMenu(menu, restoreFocus = false) {
  const trigger = menu.querySelector("[data-utility-trigger]");
  const popover = menu.querySelector(".utility-menu-popover");
  popover.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function openUtilityMenu(menu, focusFirst = false) {
  document.querySelectorAll("[data-utility-menu]").forEach((candidate) => {
    if (candidate !== menu) closeUtilityMenu(candidate);
  });
  const trigger = menu.querySelector("[data-utility-trigger]");
  const popover = menu.querySelector(".utility-menu-popover");
  popover.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  if (focusFirst) popover.querySelector('[role="menuitem"]')?.focus();
}

document.querySelectorAll("[data-utility-menu]").forEach((menu) => {
  const trigger = menu.querySelector("[data-utility-trigger]");
  const popover = menu.querySelector(".utility-menu-popover");
  trigger.addEventListener("click", () => {
    if (popover.hidden) openUtilityMenu(menu);
    else closeUtilityMenu(menu);
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    openUtilityMenu(menu, true);
  });
  popover.addEventListener("keydown", (event) => {
    const items = [...popover.querySelectorAll('[role="menuitem"]')];
    const current = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[(current + offset + items.length) % items.length]?.focus();
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  });
});

document.addEventListener("click", (event) => {
  document.querySelectorAll("[data-utility-menu]").forEach((menu) => {
    if (!menu.contains(event.target)) closeUtilityMenu(menu);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const openMenu = [...document.querySelectorAll("[data-utility-menu]")]
    .find((menu) => !menu.querySelector(".utility-menu-popover").hidden);
  if (openMenu) closeUtilityMenu(openMenu, true);
});

elements.publishButton.addEventListener("click", openPublishDialog);
$("#closePublishDialog").addEventListener("click", () => elements.publishDialog.close());
$("#publishForm").addEventListener("submit", (event) => {
  event.preventDefault();
  publish();
});
$("#copyLinkButton").addEventListener("click", () => copyText(location.href));
$("#copySuccessLink").addEventListener("click", () => copyText($("#shareUrlInput").value));
$("#copyManageTokenButton").addEventListener("click", async () => {
  if (!currentManageToken) return;
  await navigator.clipboard.writeText(currentManageToken);
  showToast(t("managementTokenCopied"));
});
$("#continueEditingButton").addEventListener("click", () => elements.successDialog.close());
$("#closeManageShareDialog").addEventListener("click", () => {
  managedSettingsEntry = null;
  elements.manageShareDialog.close();
});
$("#manageShareForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveManagedShareSettings();
});
document.querySelectorAll("[data-language-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!elements.editorView.hidden) saveDraft();
    localStorage.setItem(LOCALE_KEY, locale === "zh" ? "en" : "zh");
    location.reload();
  });
});
elements.tocToggle.addEventListener("click", () => {
  setTocCollapsed(!elements.tocPanel.classList.contains("is-collapsed"), { persist: true });
});
elements.conversationSearch.addEventListener("input", () => {
  clearTimeout(conversationSearchTimer);
  conversationSearchTimer = setTimeout(() => applyConversationSearch(), 100);
});
elements.conversationSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !elements.conversationSearch.value) return;
  event.preventDefault();
  clearConversationSearch({ focus: true });
});
elements.conversationSearchClear.addEventListener("click", () => clearConversationSearch({ focus: true }));
$("#conversationNoResultsClear").addEventListener("click", () => clearConversationSearch({ focus: true }));
elements.conversationAnswerToggle.addEventListener("click", () => {
  setConversationAnswerOnly(!conversationAnswerOnly);
});
elements.conversationDisclosureToggle.addEventListener("click", toggleAllConversationDisclosures);
window.addEventListener("hashchange", navigateToConversationHash);

elements.markdownInput.addEventListener("input", () => {
  currentMarkdown = elements.markdownInput.value;
  resizeTextarea();
  scheduleEditorTableOfContents();
  scheduleDraftSave();
});

elements.markdownInput.addEventListener("paste", (event) => {
  const images = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (images.length === 0) return;
  event.preventDefault();
  insertImagesInSource(images).catch((error) => showToast(error.message || t("imageUploadFailed")));
});

window.addEventListener("dragover", (event) => {
  const items = Array.from(event.dataTransfer?.items ?? []);
  const handlesDrop = items.some((item) => item.type === "text/markdown")
    || (currentMode === "source" && items.some((item) => item.type.startsWith("image/")));
  if (!handlesDrop) return;
  event.preventDefault();
  elements.dropZone.classList.add("is-dragging");
});

window.addEventListener("dragleave", () => elements.dropZone.classList.remove("is-dragging"));
window.addEventListener("drop", (event) => {
  elements.dropZone.classList.remove("is-dragging");
  const files = Array.from(event.dataTransfer?.files ?? []);
  const markdownFile = files.find((file) => file.name.toLowerCase().endsWith(".md") || file.type === "text/markdown");
  if (markdownFile) {
    event.preventDefault();
    event.stopPropagation();
    importMarkdown(markdownFile);
    return;
  }
  if (currentMode === "source" && files.some((file) => file.type.startsWith("image/"))) {
    event.preventDefault();
    insertImagesInSource(files).catch((error) => showToast(error.message || t("imageUploadFailed")));
  }
});

for (const input of [elements.titleInput, elements.authorInput, elements.ttlSelect, elements.slugInput]) {
  input.addEventListener("input", scheduleDraftSave);
  input.addEventListener("change", scheduleDraftSave);
}
elements.slugInput.addEventListener("input", () => {
  elements.slugInput.value = elements.slugInput.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
});
$("#slugPrefix").textContent = `${location.host}/`;

const slug = decodeURIComponent(location.pathname.slice(1)).replace(/\/$/, "");
if (slug === "status") loadSystemStatus();
else if (slug === "agents") loadAgentSetup();
else if (slug === "mine") loadManagedShares();
else if (slug) loadShare(slug);
else initializeVisualEditor();
