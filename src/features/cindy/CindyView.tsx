/**
 * Embedded Cindy UI: Cindy's own desktop interface (statically built into
 * this app, no sidecar process) in an iframe. Shared by the welcome home;
 * while the files are missing it shows how to build them.
 */
import { useEffect, useRef } from "react";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, EmptyState, Spinner } from "@/ui";
import { BUILD_CMD, EMBED_PATH } from "./model";
import { useCindy } from "./store";
import styles from "./Cindy.module.css";

/** postMessage protocol between the embed iframe (shim.js) and this host. */
export const CINDY_EMBED_CATALOG_REQUEST = "cindy-embed:magpie-catalog:request";
export const CINDY_EMBED_CATALOG_RESPONSE = "cindy-embed:magpie-catalog:response";

export function CindyView() {
  const status = useCindy((s) => s.status);
  const check = useCindy((s) => s.check);
  const markOnline = useCindy((s) => s.markOnline);
  const markOffline = useCindy((s) => s.markOffline);
  const tx = useTx();
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serves the embed's model catalog from Rust (the iframe cannot fetch the
  // loopback gateway itself: no CORS headers). Fail-closed: gateway down =
  // rejected load, the picker shows retry instead of hanging on loading.
  useEffect(() => {
    if (status !== "online") return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: unknown; type?: unknown; id?: unknown } | null;
      if (!data || data.source !== "cindy-embed" || data.type !== CINDY_EMBED_CATALOG_REQUEST) return;
      const id = typeof data.id === "number" ? data.id : 0;
      const reply = (payload: object) => {
        const target = (event.source as Window | null) ?? frameRef.current?.contentWindow;
        target?.postMessage({ source: "openidea-host", ...payload }, "*");
      };
      void call(commands.cindyMagpieCatalog()).then(
        (models) => reply({ type: CINDY_EMBED_CATALOG_RESPONSE, id, ok: true, models }),
        (error: unknown) =>
          reply({
            type: CINDY_EMBED_CATALOG_RESPONSE,
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [status]);

  if (status !== "online") {
    const checking = status === "checking";
    return (
      <div className={styles.view}>
        <div className={styles.setup}>
          <EmptyState title={tx("Cindy is not available")}>
            {tx("Build the embedded interface, then press Retry.")}
          </EmptyState>
          <code className={styles.cmd}>{BUILD_CMD}</code>
          <div className={styles.row}>
            <Button disabled={checking} onClick={() => void check()}>
              {checking ? tx("Checking…") : tx("Retry")}
            </Button>
          </div>
          {checking && <Spinner size={16} />}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <iframe
        ref={frameRef}
        className={styles.frame}
        title={tx("Cindy")}
        src={EMBED_PATH}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
        allow="clipboard-read; clipboard-write"
        onLoad={markOnline}
        onError={markOffline}
      />
    </div>
  );
}
