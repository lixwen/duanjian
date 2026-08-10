import "./styles.css";
import "@phosphor-icons/webcomponents/PhCaretRight";
import "@phosphor-icons/webcomponents/PhDotsThree";
import "@phosphor-icons/webcomponents/PhGlobeSimple";
import "@phosphor-icons/webcomponents/PhPlugsConnected";
import "@phosphor-icons/webcomponents/PhPulse";
import { applyStaticTranslations, createTranslator, detectLocale, translateServerError } from "./i18n.js";

const $ = (selector) => document.querySelector(selector);
const DRAFT_KEY = "duanjian-draft-v1";
const TOC_COLLAPSED_KEY = "duanjian-toc-collapsed-v1";
const LOCALE_KEY = "duanjian-locale-v1";
const locale = detectLocale(localStorage.getItem(LOCALE_KEY), navigator.language);
const t = createTranslator(locale);
applyStaticTranslations(locale);

const elements = {
  editorView: $("#editorView"),
  readerView: $("#readerView"),
  conversationView: $("#conversationView"),
  conversationFeed: $("#conversationFeed"),
  statusView: $("#statusView"),
  systemStatusView: $("#systemStatusView"),
  agentSetupView: $("#agentSetupView"),
  titleInput: $("#titleInput"),
  authorInput: $("#authorInput"),
  markdownInput: $("#markdownInput"),
  visualEditor: $("#visualEditor"),
  editorLoading: $("#editorLoading"),
  dropZone: $("#dropZone"),
  publishDialog: $("#publishDialog"),
  successDialog: $("#successDialog"),
  publishButton: $("#publishButton"),
  confirmPublishButton: $("#confirmPublishButton"),
  ttlSelect: $("#ttlSelect"),
  slugInput: $("#slugInput"),
  tocPanel: $("#tocPanel"),
  tocToggle: $("#tocToggle"),
  tocLabel: $("#tocLabel"),
  tocNav: $("#tocNav"),
  toast: $("#toast"),
};

let crepe = null;
let replaceAllCommand = null;
let currentMarkdown = "";
let currentMode = "visual";
let toastTimer;
let draftTimer;
let tocScrollHandler = null;
let editorTocTimer;
let mermaidRendererPromise;
let mermaidRendererFrame;
let mermaidRequestId = 0;
const mermaidRequests = new Map();
const AGENT_SKILL_URL = "/skills/notelet-publish/SKILL.md";
const AGENT_SKILL_NAME = "notelet-publish";
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

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    version: 1,
    title: elements.titleInput.value,
    author: elements.authorInput.value,
    content: currentMarkdown,
    ttl: elements.ttlSelect.value,
    slug: elements.slugInput.value,
    updatedAt: Date.now(),
  }));
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

async function initializeVisualEditor() {
  const draft = readDraft();
  if (draft?.version === 1) {
    elements.titleInput.value = typeof draft.title === "string" ? draft.title : "";
    elements.authorInput.value = typeof draft.author === "string" ? draft.author : "";
    elements.ttlSelect.value = typeof draft.ttl === "string" ? draft.ttl : "604800";
    elements.slugInput.value = typeof draft.slug === "string" ? draft.slug : "";
    currentMarkdown = typeof draft.content === "string" ? draft.content : "";
  }
  elements.markdownInput.value = currentMarkdown;

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

  elements.confirmPublishButton.disabled = true;
  elements.confirmPublishButton.textContent = t("publishing");
  try {
    const response = await fetch("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: inferTitleFromMarkdown(content, elements.titleInput.value),
        author: elements.authorInput.value,
        content,
        slug: elements.slugInput.value,
        ttl: Number(elements.ttlSelect.value),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(translateServerError(data.error, locale) || t("publishFailed"));
    saveDraft();
    $("#shareUrlInput").value = data.url;
    $("#openDocumentLink").href = data.url;
    elements.publishDialog.close();
    elements.successDialog.showModal();
  } catch (error) {
    showToast(error.message || t("publishFailed"));
  } finally {
    elements.confirmPublishButton.disabled = false;
    elements.confirmPublishButton.textContent = t("confirmPublish");
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

  const tocItems = items.map((item, index) => ({ ...item, tocId: `${prefix}-${index + 1}` }));
  const links = new Map();
  const fragment = document.createDocumentFragment();
  tocItems.forEach((item) => {
    if (assignElementIds && item.element) item.element.id = item.tocId;
    const link = document.createElement("a");
    link.href = `#${item.tocId}`;
    link.dataset.level = String(item.level);
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
  setActive(`${prefix}-1`);
  const getHeadings = getScrollHeadings ?? (() => tocItems.map((item) => item.element).filter(Boolean));
  tocScrollHandler = () => {
    const headings = getHeadings();
    if (headings.length === 0) return;
    const marker = window.innerHeight * 0.3;
    const currentIndex = headings.reduce((activeIndex, heading, index) => {
      const distance = Math.abs(heading.getBoundingClientRect().top - marker);
      const activeDistance = Math.abs(headings[activeIndex].getBoundingClientRect().top - marker);
      return distance < activeDistance ? index : activeIndex;
    }, 0);
    setActive(`${prefix}-${currentIndex + 1}`);
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

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
  return details;
}

function renderConversation(data) {
  elements.conversationFeed.replaceChildren();
  const navigation = [];

  data.turns.forEach((turn, index) => {
    const article = document.createElement("article");
    article.className = "conversation-turn";
    article.dataset.turn = String(index + 1);

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

    elements.conversationFeed.append(article);
    navigation.push({ element: article, level: 1, text: `${String(index + 1).padStart(2, "0")}  ${turn.label}` });
  });

  renderTableOfContents(navigation, {
    label: t("conversationToc"),
    prefix: "turn",
    assignElementIds: true,
    navigate: (item) => {
      scrollToHeading(item.element);
      history.replaceState(null, "", `#${item.tocId}`);
    },
  });
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

function agentInstallPath() {
  return agentDirectories[selectedAgent][selectedAgentScope];
}

function agentInstallCommand() {
  const root = agentInstallPath().replace(/^~/, "$HOME");
  const target = `${root}/${AGENT_SKILL_NAME}`;
  return `mkdir -p "${target}" && curl -fsSL "${location.origin}${AGENT_SKILL_URL}" -o "${target}/SKILL.md"`;
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

async function fetchAgentSkill() {
  const response = await fetch(AGENT_SKILL_URL);
  if (!response.ok) throw new Error(t("agentSkillLoadFailed"));
  return response.text();
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
    const [skill, root] = await Promise.all([
      fetchAgentSkill(),
      window.showDirectoryPicker({ mode: "readwrite" }),
    ]);
    const directory = await root.getDirectoryHandle(AGENT_SKILL_NAME, { create: true });
    const file = await directory.getFileHandle("SKILL.md", { create: true });
    const writable = await file.createWritable();
    await writable.write(skill);
    await writable.close();
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
    const skill = await fetchAgentSkill();
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

async function loadShare(slug) {
  document.querySelectorAll(".editor-only").forEach((el) => { el.hidden = true; });
  document.querySelectorAll(".reader-only").forEach((el) => { el.hidden = false; });
  elements.editorView.hidden = true;

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
$("#continueEditingButton").addEventListener("click", () => elements.successDialog.close());
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
else if (slug) loadShare(slug);
else initializeVisualEditor();
