import { useEffect, useRef, useState, type MouseEvent } from "react";

type MermaidBlockProps = {
  value: string;
  copyUseModifier: boolean;
};

type RenderState =
  | { status: "idle" }
  | { status: "rendering" }
  | { status: "success"; svg: string }
  | { status: "error"; message: string };

function detectMermaidTheme(): "dark" | "default" {
  const dataTheme = document.documentElement.dataset.theme;
  if (dataTheme === "light") return "default";
  if (dataTheme === "dark" || dataTheme === "dim") return "dark";
  if (window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "default";
  }
  return "dark";
}

export default function MermaidBlock({
  value,
  copyUseModifier,
}: MermaidBlockProps) {
  const [renderState, setRenderState] = useState<RenderState>({
    status: "idle",
  });
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const copyTimeoutRef = useRef<number | null>(null);
  const idRef = useRef(`mermaid-${crypto.randomUUID()}`);

  // debounce value for streaming output – use a longer delay to avoid
  // repeatedly re-rendering expensive Mermaid diagrams while chunks arrive.
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), 800);
    return () => window.clearTimeout(timer);
  }, [value]);

  // render mermaid diagram
  useEffect(() => {
    let cancelled = false;
    setRenderState({ status: "rendering" });

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const theme = detectMermaidTheme();
        mermaid.initialize({
          startOnLoad: false,
          theme,
          securityLevel: "strict",
          fontFamily:
            "ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif",
        });

        // mermaid.render requires a unique id each call
        const id = `${idRef.current}-${Date.now()}`;
        const { svg } = await mermaid.render(id, debouncedValue);
        if (!cancelled) {
          setRenderState({ status: "success", svg });
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : String(error);
          setRenderState({ status: "error", message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedValue, renderKey]);

  // re-render on theme change
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === "data-theme") {
          setRenderKey((prev) => prev + 1);
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const fencedValue = `\`\`\`mermaid\n${value}\n\`\`\``;

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    try {
      const shouldFence = copyUseModifier ? event.altKey : true;
      const nextValue = shouldFence ? fencedValue : value;
      await navigator.clipboard.writeText(nextValue);
      setCopied(true);
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch {
      // clipboard errors can occur in restricted contexts
    }
  };

  const handleToggleSource = () => {
    setShowSource((prev) => !prev);
  };

  return (
    <div className="markdown-codeblock markdown-mermaidblock">
      <div className="markdown-codeblock-header">
        <span className="markdown-codeblock-language">Mermaid</span>
        <div className="markdown-mermaidblock-actions">
          <button
            type="button"
            className="ghost markdown-codeblock-copy"
            onClick={handleToggleSource}
          >
            {showSource ? "Preview" : "Source"}
          </button>
          <button
            type="button"
            className={`ghost markdown-codeblock-copy${copied ? " is-copied" : ""}`}
            onClick={handleCopy}
            aria-label="Copy mermaid source"
            title={copied ? "Copied" : "Copy"}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {showSource ? (
        <pre>
          <code className="language-mermaid">{value}</code>
        </pre>
      ) : renderState.status === "success" ? (
        <div
          className="markdown-mermaidblock-diagram"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : renderState.status === "error" ? (
        <div className="markdown-mermaidblock-error">
          <div className="markdown-mermaidblock-error-hint">
            Render failed: {renderState.message}
          </div>
          <pre>
            <code className="language-mermaid">{value}</code>
          </pre>
        </div>
      ) : (
        <div className="markdown-mermaidblock-loading">
          Rendering diagram...
        </div>
      )}
    </div>
  );
}
