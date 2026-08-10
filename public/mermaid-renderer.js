import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "neutral",
  fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, sans-serif",
  flowchart: { htmlLabels: true, useMaxWidth: true },
});

let sequence = 0;
let renderQueue = Promise.resolve();

function normalizeSvgForImage(svg) {
  const document = new DOMParser().parseFromString(svg, "text/html");
  const element = document.querySelector("svg");
  if (!element) throw new Error("Mermaid did not return an SVG");
  return new XMLSerializer().serializeToString(element);
}

async function renderRequest(data) {
  try {
    const source = typeof data.source === "string" ? data.source : "";
    if (source.length > 200_000) throw new Error("Mermaid source is too large");
    const { svg } = await mermaid.render(`notelet-mermaid-frame-${++sequence}`, source);
    parent.postMessage({
      channel: "notelet-mermaid",
      type: "result",
      id: data.id,
      svg: normalizeSvgForImage(svg),
    }, location.origin);
  } catch (error) {
    parent.postMessage({
      channel: "notelet-mermaid",
      type: "result",
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    }, location.origin);
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const data = event.data;
  if (!data || data.channel !== "notelet-mermaid" || data.type !== "render") return;
  renderQueue = renderQueue.then(() => renderRequest(data));
});

parent.postMessage({ channel: "notelet-mermaid", type: "ready" }, location.origin);
