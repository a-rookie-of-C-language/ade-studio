/**
 * The message box of the New Task page and of sessions: `@` file and folder references
 * (project index search), `/` agent commands, ↑ / ↓ history, pasted or dropped images, Shift+Tab to cycle
 * the agent's mode. Its draft lives in the store under `id`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentCommand, AgentConfigOption, AgentImage } from "@/bindings";
// Static import on purpose: a dynamic `import()` loads the real Tauri module
// past `vi.mock` in tests (same reason as `WelcomeView`), breaking suites
// that mount the composer with `isTauri()` true.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call, commands, isTauri } from "@/platform/ipc";
import { nativeDropPoint } from "@/platform/nativeDrop";
import { invokeLocal } from "@/platform/tauriCore";
import { useTx } from "@/platform/i18n";
import { basename } from "@/platform/project";
import { notifications, OWNS_FILE_DROP } from "@/workbench/contributions";
import { Icon, IconButton, Popup, fileIconName, tooltipAttrs } from "@/ui";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  applyCompletion,
  atEdgeLine,
  effectiveFiles,
  effectivePastes,
  foldPasted,
  isPathQuery,
  mergeMatches,
  resolveTyped,
  completionAt,
  imageFromDataUrl,
  matchCommands,
  mentionOf,
  modeOption,
  nextValue,
  recall,
  removeMention,
  removePasteToken,
  shouldFoldPasted,
  type Completion,
  type FileRef,
  type PastedText,
} from "./composerModel";
import { composerDraft, updateComposer, useAgents } from "./store";
import { ImagePreview, imageSrc } from "./ImagePreview";
import { useCompletionAnchor } from "./useCompletionAnchor";
import styles from "./Composer.module.css";
import { isImeKey } from "@/platform/ime";

const MAX_PROMPT_HEIGHT = 280;
const MAX_ITEMS = 12;

type Item = { kind: "file"; path: string; rel: string; dir?: boolean } | { kind: "command"; command: AgentCommand };

export interface ComposerProps {
  /** Store key of the draft. */
  id: string;
  placeholder: string;
  /** Directory `@` references resolve in (the task's worktree, or the project root). */
  root: string;
  /** The project root the file index covers. */
  projectRoot: string;
  commands: readonly AgentCommand[];
  /** Sent messages, newest first. */
  history: readonly string[];
  /** Settings; Shift+Tab cycles the mode one. */
  config: readonly AgentConfigOption[];
  onConfig?: (option: string, value: string) => void;
  /** `now`: ⌘↵ (send even while the agent works, interrupting it). */
  onSubmit: (now: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Left of the bottom row: agent / model / mode pickers. */
  toolbar?: ReactNode;
  /** Right of the bottom row: send / stop buttons. */
  actions?: ReactNode;
  className?: string;
}

export function Composer(props: ComposerProps) {
  const { id, root, projectRoot } = props;
  const tx = useTx();
  const draft = useAgents((s) => s.composers.get(id));
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const [preview, setPreview] = useState<AgentImage | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [files, setFiles] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const recalled = useRef<{ index: number; stash: string }>({ index: -1, stash: "" });
  /** Files still mentioned in the text: rendered as chips, sent with the prompt. */
  const referenced = effectiveFiles({ text, files: draft?.files ?? [], images, pastes: draft?.pastes ?? [] });

  /** Unreferences a file: its chip and every `@rel` go away together. */
  const removeRef = (ref: FileRef) => {
    const current = composerDraft(id);
    updateComposer(id, {
      text: removeMention(current.text, ref.rel),
      files: current.files.filter((f) => f.path !== ref.path),
    });
    setCompletion(null);
  };
  /** Pastes still tokenized in the text: rendered as chips, expanded on send. */
  const pasted = effectivePastes({ text, files: [], images: [], pastes: draft?.pastes ?? [] });

  /** Unfolds nothing: dropping a paste removes its chip and its token line together. */
  const removePaste = (paste: PastedText) => {
    const current = composerDraft(id);
    updateComposer(id, {
      text: removePasteToken(current.text, paste.id),
      pastes: current.pastes.filter((p) => p.id !== paste.id),
    });
    setCompletion(null);
  };

  /** Long pastes land as a token line plus a chip instead of flooding the box. */
  const insertPaste = (pastedText: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const { paste, token } = foldPasted(pastedText);
    const before = text.slice(0, start);
    const after = text.slice(end);
    const glueBefore = before === "" || before.endsWith("\n") ? "" : "\n";
    const glueAfter = after === "" || after.startsWith("\n") ? "" : "\n";
    const next = `${before}${glueBefore}${token}${glueAfter}${after}`;
    updateComposer(id, { text: next, pastes: [...composerDraft(id).pastes, paste] });
    setText(next, before.length + glueBefore.length + token.length + (glueAfter ? 1 : 0));
  };

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);

  const focus = useAgents((s) => (s.focus?.key === id ? s.focus.seq : 0));
  useEffect(() => {
    const el = ref.current;
    if (!focus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [focus]);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_PROMPT_HEIGHT)}px`;
  }, [text]);

  // `@` completion: project file search, mapped into the task's directory.
  useEffect(() => {
    if (completion?.kind !== "file") return;
    let alive = true;
    const query = completion.query;
    const timer = setTimeout(() => {
      if (isPathQuery(query)) {
        // Outside the index: list the directory typed so far.
        const typed = /(^|\/)\.\.?$/.test(query) ? `${query}/` : query;
        const dirPart = typed.slice(0, typed.lastIndexOf("/") + 1);
        const last = typed.slice(dirPart.length);
        call(commands.pathCompletions(`${typed.startsWith("/") ? "" : root}/_`, typed))
          .then((found) => {
            if (!alive) return;
            setFiles(
              found
                .filter((f) => f.name.toLowerCase().startsWith(last.toLowerCase()))
                .slice(0, MAX_ITEMS)
                .map((f) => {
                  const rel = `${dirPart}${f.name}`;
                  return { kind: "file", rel, dir: f.dir, path: resolveTyped(root, rel) };
                }),
            );
          })
          .catch(() => alive && setFiles([]));
        return;
      }
      Promise.all([call(commands.findFiles(query, MAX_ITEMS)), call(commands.findDirs(query, MAX_ITEMS))])
        .then(([found, dirs]) => {
          if (!alive) return;
          setFiles(
            mergeMatches(found, dirs, MAX_ITEMS).map((f) => ({
              kind: "file",
              rel: f.rel,
              dir: f.dir,
              path: root === projectRoot ? f.path : `${root}/${f.rel}`,
            })),
          );
        })
        .catch(() => alive && setFiles([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [completion?.kind, completion?.query, root, projectRoot]);

  const items: Item[] = useMemo(() => {
    if (!completion) return [];
    if (completion.kind === "file") return files;
    return matchCommands(props.commands, completion.query)
      .slice(0, MAX_ITEMS)
      .map((command) => ({ kind: "command", command }));
  }, [completion, files, props.commands]);
  const open = !!completion && items.length > 0;
  const completionAnchor = useCompletionAnchor(ref, open ? completion.to : null, text);

  const setText = (value: string, caret?: number, restoreSelection = true) => {
    updateComposer(id, { text: value });
    const c = caret ?? value.length;
    setCompletion(completionAt(value, c));
    setActive(0);
    if (caret !== undefined && restoreSelection) {
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    }
  };

  /** Enter or a click references the item; Tab on a folder keeps completing inside it. */
  const accept = (item: Item | undefined, descend = false) => {
    if (!item || !completion) return;
    if (item.kind === "file") {
      const rel = item.dir ? `${item.rel}/` : item.rel;
      // A folder stays referenced while its `@folder/` is left as typed (`toPrompt`).
      const current = composerDraft(id);
      updateComposer(id, { files: [...current.files, { path: item.path, rel } satisfies FileRef] });
      if (item.dir && descend) {
        const insert = mentionOf(rel);
        setText(text.slice(0, completion.from) + insert + text.slice(completion.to), completion.from + insert.length);
        return;
      }
      const next = applyCompletion(text, completion, mentionOf(rel));
      setText(next.text, next.caret);
    } else {
      const next = applyCompletion(text, completion, `/${item.command.name}`);
      setText(next.text, next.caret);
    }
    setCompletion(null);
  };

  const addImages = (list: AgentImage[]) => {
    if (list.length) updateComposer(id, { images: [...composerDraft(id).images, ...list] });
  };

  const readImageFiles = (picked: Iterable<File>) => {
    for (const file of picked) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        notifications().notify({ level: "warning", title: "Image too large", body: tx`${file.name} is over 5 MB.` });
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const image = typeof reader.result === "string" ? imageFromDataUrl(reader.result, file.name || "image") : null;
        if (image) addImages([image]);
      };
      reader.readAsDataURL(file);
    }
  };

  // Files dropped from the OS onto the box: images are attached, other files referenced.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop" || !p.paths.length) return;
        const box = boxRef.current?.getBoundingClientRect();
        const { x, y } = nativeDropPoint(p.position);
        if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
        const refs: FileRef[] = [];
        for (const path of p.paths) {
          if (IMAGE_EXTENSIONS.test(path)) {
            void invokeLocal<string>("fs_read_image", { path }).then((url) => {
              const image = imageFromDataUrl(url, basename(path));
              if (image) addImages([image]);
            });
          } else {
            refs.push({ path, rel: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path });
          }
        }
        if (refs.length) {
          const current = composerDraft(id);
          const mentions = refs.map((r) => mentionOf(r.rel)).join(" ");
          const glue = current.text && !/\s$/.test(current.text) ? " " : "";
          updateComposer(id, { text: `${current.text}${glue}${mentions} `, files: [...current.files, ...refs] });
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribe only when the target changes
  }, [id, root]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + d + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[active], e.key === "Tab");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCompletion(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!props.disabled) props.onSubmit(e.metaKey || e.ctrlKey);
      recalled.current = { index: -1, stash: "" };
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      const mode = modeOption(props.config);
      const value = mode && nextValue(mode);
      if (mode && value && props.onConfig) {
        e.preventDefault();
        props.onConfig(mode.id, value);
      }
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.metaKey) {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const el = e.currentTarget;
      const r = recalled.current;
      // Only from an empty box or one showing a recalled message, with the caret on the edge line.
      const fresh = r.index === -1 ? text === "" : text === props.history[r.index];
      if (!fresh || !atEdgeLine(text, el.selectionStart, dir)) return;
      const next = recall(props.history, r.index, dir);
      if (next === null) return;
      e.preventDefault();
      if (r.index === -1) r.stash = text;
      r.index = next;
      const value = next === -1 ? r.stash : props.history[next]!;
      setText(value, value.length);
      setCompletion(null);
    }
  };

  return (
    <div
      ref={boxRef}
      className={clsx(styles.composer, props.className)}
      {...OWNS_FILE_DROP}
      onClick={() => ref.current?.focus()}
    >
      {open && completionAnchor && (
        <Popup
          open
          anchor={completionAnchor}
          placement="bottom-start"
          autoFocus={false}
          restoreFocus={false}
          closeOnOutsideClick={false}
          onClose={() => setCompletion(null)}
          className={styles.popup}
          role="listbox"
          aria-label={tx(completion.kind === "file" ? "Files" : "Commands")}
        >
          <div className={styles.items}>
            {items.map((item, i) => (
              <div
                key={item.kind === "file" ? item.path : item.command.name}
                role="option"
                aria-selected={i === active}
                className={clsx(styles.item, i === active && styles.active)}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                {item.kind === "file" ? (
                  <>
                    <Icon name={item.dir ? "folder" : fileIconName(basename(item.rel), item.rel)} size={16} />
                    <span className={styles.itemName}>
                      {basename(item.rel)}
                      {item.dir && "/"}
                    </span>
                    <span className={styles.itemDetail}>{item.rel}</span>
                  </>
                ) : (
                  <>
                    <span className={styles.itemName}>/{item.command.name}</span>
                    {item.command.hint && <span className={styles.itemHint}>{item.command.hint}</span>}
                    <span className={styles.itemDetail}>{item.command.description}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </Popup>
      )}
      {referenced.length > 0 && (
        <div className={styles.refs} onClick={(e) => e.stopPropagation()}>
          {referenced.map((f) => {
            const dir = f.rel.endsWith("/");
            const base = basename(dir ? f.rel.slice(0, -1) : f.rel);
            return (
              <span key={f.path} className={styles.ref} {...tooltipAttrs(f.rel)}>
                <Icon name={dir ? "folder" : fileIconName(base, f.rel)} size={14} />
                <span className={styles.refName}>
                  {base}
                  {dir && "/"}
                </span>
                <button
                  type="button"
                  className={styles.removeRef}
                  aria-label={tx("Remove reference")}
                  onClick={() => removeRef(f)}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {pasted.length > 0 && (
        <div className={styles.refs} onClick={(e) => e.stopPropagation()}>
          {pasted.map((p) => {
            const lines = p.text.split("\n").length;
            return (
              <span key={p.id} className={styles.ref} {...tooltipAttrs(p.text.slice(0, 240))}>
                <Icon name="paste" size={14} />
                <span className={styles.refName}>
                  {lines} {tx(lines === 1 ? "line" : "lines")}
                </span>
                <button
                  type="button"
                  className={styles.removeRef}
                  aria-label={tx("Remove pasted text")}
                  onClick={() => removePaste(p)}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {images.length > 0 && (
        <div className={styles.images} onClick={(e) => e.stopPropagation()}>
          {images.map((img, i) => (
            <span key={i} className={styles.image} {...tooltipAttrs(img.name ?? undefined)}>
              <button type="button" className={styles.previewImage} onClick={() => setPreview(img)}>
                <img src={imageSrc(img)} alt={img.name ?? tx("Image")} />
              </button>
              <button
                type="button"
                className={styles.removeImage}
                aria-label={tx("Remove Image")}
                onClick={() => updateComposer(id, { images: images.filter((_, j) => j !== i) })}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <ImagePreview image={preview} onClose={() => setPreview(null)} />
        </div>
      )}
      <textarea
        ref={ref}
        className={styles.textarea}
        rows={2}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={text}
        aria-label={tx("Message")}
        placeholder={tx(props.placeholder)}
        onChange={(e) => setText(e.target.value, e.target.selectionStart, false)}
        onSelect={(e) => setCompletion(completionAt(e.currentTarget.value, e.currentTarget.selectionStart))}
        onBlur={() => setCompletion(null)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pastedFiles = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (pastedFiles.length) {
            e.preventDefault();
            readImageFiles(pastedFiles);
            return;
          }
          const pastedText = e.clipboardData.getData("text");
          if (pastedText && shouldFoldPasted(pastedText)) {
            e.preventDefault();
            insertPaste(pastedText);
          }
        }}
      />
      <div className={styles.bar} onClick={(e) => e.stopPropagation()}>
        <div className={styles.toolbar}>{props.toolbar}</div>
        <div className={styles.actions}>
          <IconButton
            icon="file"
            title="Reference a File (@)"
            size="small"
            onClick={() => {
              const glue = text && !/\s$/.test(text) ? " " : "";
              setText(`${text}${glue}@`, text.length + glue.length + 1);
            }}
          />
          <IconButton
            icon="file-image"
            title="Attach Image…"
            size="small"
            onClick={() => imageInput.current?.click()}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              readImageFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <span className={styles.spacer} />
          {props.actions}
        </div>
      </div>
    </div>
  );
}
