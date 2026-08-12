import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../public/mermaid-renderer.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Mermaid editing preview", () => {
  it("renders Mermaid in an isolated frame and exposes a source/diagram toggle", () => {
    expect(app).toContain("createMermaidPreviewFeature");
    expect(app).toContain('mermaidRendererFrame.src = "/mermaid-renderer.html"');
    expect(app).toContain("data:image/svg+xml");
    expect(app).toContain("showDiagramOnly");
    expect(app).not.toContain('import("mermaid")');
    expect(renderer).toContain('securityLevel: "strict"');
    expect(renderer).toContain("htmlLabels: true");
    expect(renderer).toContain("new XMLSerializer().serializeToString(element)");
    expect(styles).toContain(".mermaid-editor-preview-toolbar");
  });

  it("shares preview typography tokens with ProseMirror", () => {
    expect(styles).toContain("--content-font-size: 17px");
    expect(styles).toContain(".markdown-body,\n.visual-editor .milkdown .ProseMirror");
    expect(styles).toContain(".visual-editor .milkdown .ProseMirror h1 { font-size: 1.8em; }");
    expect(styles).toContain(".list-item:has(> .children > [data-content-dom] > p:first-child) > .label-wrapper");
  });

  it("lets readers enlarge and zoom rendered diagrams", () => {
    expect(app).toContain('createMermaidDiagram(source, { expandable: true })');
    expect(app).toContain('expandButton.textContent = t("openDiagramViewer")');
    expect(app).toContain("elements.diagramViewer.showModal()");
    expect(app).toContain('event.key.toLowerCase() === "f"');
    expect(renderer).toContain('element.setAttribute("width", String(viewBox[2]))');
    expect(styles).toContain(".diagram-viewer-canvas");
    expect(styles).toContain(".diagram-expand-button");
  });
});
