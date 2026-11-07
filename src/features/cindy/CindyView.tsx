/**
 * Embedded Cindy UI: Cindy's own desktop interface (statically built into
 * this app, no sidecar process) in an iframe. Shared by the welcome home;
 * while the files are missing it shows how to build them.
 */
import { useEffect } from "react";
import { useTx } from "@/platform/i18n";
import { Button, EmptyState, Spinner } from "@/ui";
import { BUILD_CMD, EMBED_PATH } from "./model";
import { useCindy } from "./store";
import styles from "./Cindy.module.css";

export function CindyView() {
  const status = useCindy((s) => s.status);
  const check = useCindy((s) => s.check);
  const markOnline = useCindy((s) => s.markOnline);
  const markOffline = useCindy((s) => s.markOffline);
  const tx = useTx();

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
