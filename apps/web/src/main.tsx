import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const root = document.getElementById("root") as HTMLElement;

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    return { error: message };
  }

  override componentDidCatch(error: unknown): void {
    console.error("app-render-failed", error);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return React.createElement(
        "pre",
        {
          style: {
            whiteSpace: "pre-wrap",
            padding: "16px",
            color: "#fbd5d5",
            background: "#120808",
            border: "1px solid #4c1d1d",
            borderRadius: "12px"
          }
        },
        this.state.error
      );
    }

    return this.props.children;
  }
}

void (async () => {
  try {
    const { default: App } = await import("./App");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    console.error("app-render-failed", error);
    root.innerHTML = `<pre style="white-space:pre-wrap;padding:16px;color:#fbd5d5;background:#120808;border:1px solid #4c1d1d;border-radius:12px;">${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  }
})();
