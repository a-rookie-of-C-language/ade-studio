import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { tooltipAttrs } from "./Tooltip";
import styles from "./Sidebar.module.css";

export type SidebarChildDef = {
  id: string;
  label: string;
  badge?: string | number;
};

export type SidebarItemDef = {
  id: string;
  label: string;
  icon?: IconName;
  badge?: string | number;
  /** Expandable workspace / child entries, like the motion sidebar the user picked. */
  children?: SidebarChildDef[];
};

export type SidebarSectionDef = {
  title?: string;
  items: SidebarItemDef[];
};

const SidebarContext = createContext({ collapsed: false });
/** Use inside `header` / `footer` / `children` to adapt to the icon-only state. */
export const useSidebar = () => useContext(SidebarContext);

export interface SidebarProps {
  sections: SidebarSectionDef[];
  activeId: string;
  onActiveChange: (id: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  navLabel: string;
  collapseLabel: string;
  expandLabel: string;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** When set, the collapsed state persists across restarts. */
  storageKey?: string;
  className?: string;
}

function readStored(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    return window.localStorage.getItem(key) === "1" ? true : fallback;
  } catch {
    return fallback;
  }
}

/** Ids of items that start expanded because the active id lives inside them. */
function initiallyOpen(sections: SidebarSectionDef[], activeId: string): Set<string> {
  const open = new Set<string>();
  for (const section of sections)
    for (const item of section.items) {
      if (item.children?.length && item.children.some((c) => c.id === activeId)) open.add(item.id);
      // The workspace entry starts expanded so recent workspaces are one click away
      // (children may stream in after recents load, so match on the key, not the count).
      if (item.id === "projects" && item.children !== undefined) open.add(item.id);
    }
  return open;
}

/**
 * Collapsible icon rail, adapted from the motion-based sidebar the user picked:
 * spring-ish width, a hover pill that glides between items, a measured active
 * pill, and native tooltips in the icon-only state. Motion is pure CSS so the
 * component stays dependency-free; collapsed tooltips reuse `data-tooltip`.
 */
export function Sidebar({
  sections,
  activeId,
  onActiveChange,
  header,
  footer,
  children,
  navLabel,
  collapseLabel,
  expandLabel,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  storageKey,
  className,
}: SidebarProps) {
  const [internal, setInternal] = useState(() => readStored(storageKey, defaultCollapsed));
  const controlled = collapsedProp !== undefined;
  const collapsed = controlled ? collapsedProp : internal;
  const [hover, setHover] = useState<{ top: number; height: number } | null>(null);
  const [active, setActive] = useState<{ top: number; height: number } | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => initiallyOpen(sections, activeId));
  const navRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const setCollapsed = (next: boolean) => {
    if (!controlled) setInternal(next);
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* private mode: keep the in-memory state */
      }
    }
    onCollapsedChange?.(next);
  };

  const measure = (id: string) => {
    const nav = navRef.current;
    const el = itemRefs.current.get(id);
    if (!nav || !el) return null;
    const box = el.getBoundingClientRect();
    const origin = nav.getBoundingClientRect();
    return { top: box.top - origin.top + nav.scrollTop, height: box.height };
  };

  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- pill position must be measured from the DOM after layout.
    setActive(measure(activeId));
  }, [activeId, collapsed, sections]);

  // Revealing a child (e.g. a workspace becoming active) unfolds its parent.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- unfolds the parent when an outside event activates a child.
    setOpen((prev) => {
      let next: Set<string> | null = null;
      for (const section of sections)
        for (const item of section.items) {
          if (item.children?.some((c) => c.id === activeId) && !prev.has(item.id)) {
            next ??= new Set(prev);
            next.add(item.id);
          }
        }
      return next ?? prev;
    });
  }, [activeId, sections]);

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleLabel = collapsed ? expandLabel : collapseLabel;
  return (
    <SidebarContext.Provider value={{ collapsed }}>
      <aside className={clsx(styles.sidebar, collapsed && styles.collapsed, className)}>
        {header && <div className={styles.header}>{header}</div>}
        <nav ref={navRef} aria-label={navLabel} className={styles.nav} onMouseLeave={() => setHover(null)}>
          {hover && (
            <span
              aria-hidden
              className={clsx(styles.pill, styles.hoverPill)}
              style={{ top: hover.top, height: hover.height, opacity: 1 }}
            />
          )}
          {active && (
            <span
              aria-hidden
              className={clsx(styles.pill, styles.activePill)}
              style={{ top: active.top, height: active.height, opacity: 1 }}
            />
          )}
          {sections.map((section, i) => (
            <div key={section.title ?? i} className={styles.section}>
              {section.title && !collapsed && <p className={styles.sectionTitle}>{section.title}</p>}
              {section.items.map((item) => {
                const hasChildren = !!item.children?.length;
                const kids = item.children ?? [];
                const childActive = hasChildren && kids.some((c) => c.id === activeId);
                const isActive = item.id === activeId || childActive;
                const isOpen = hasChildren && open.has(item.id) && !collapsed;
                return (
                  <div key={item.id} className={styles.group}>
                    <button
                      ref={(el) => {
                        if (el) itemRefs.current.set(item.id, el);
                        else itemRefs.current.delete(item.id);
                      }}
                      type="button"
                      aria-label={item.label}
                      aria-current={isActive ? "page" : undefined}
                      aria-expanded={hasChildren ? isOpen : undefined}
                      className={clsx(styles.item, isActive && styles.itemActive)}
                      onClick={() => {
                        if (collapsed && hasChildren) {
                          setCollapsed(false);
                          setOpen((prev) => new Set(prev).add(item.id));
                        } else if (hasChildren) {
                          // Re-clicking the open parent folds it; otherwise unfold.
                          // Navigation still happens so the list page stays reachable.
                          if (item.id === activeId && open.has(item.id)) toggleOpen(item.id);
                          else setOpen((prev) => new Set(prev).add(item.id));
                        }
                        onActiveChange(item.id);
                      }}
                      onMouseEnter={() => setHover(measure(item.id))}
                      onFocus={() => setHover(measure(item.id))}
                      onBlur={() => setHover(null)}
                      {...tooltipAttrs(collapsed ? item.label : undefined)}
                    >
                      {item.icon && (
                        <span className={styles.itemIcon}>
                          <Icon name={item.icon} size={18} />
                        </span>
                      )}
                      {!collapsed && <span className={styles.itemLabel}>{item.label}</span>}
                      {!collapsed && item.badge !== undefined && <span className={styles.itemBadge}>{item.badge}</span>}
                      {!collapsed && hasChildren && (
                        <span className={clsx(styles.chev, isOpen && styles.chevOpen)} aria-hidden>
                          <Icon name="chevron-right" size={14} />
                        </span>
                      )}
                    </button>
                    {hasChildren && !collapsed && (
                      <div className={clsx(styles.subWrap, isOpen && styles.subWrapOpen)}>
                        <div className={styles.subInner}>
                          <div className={styles.subList}>
                            {kids.map((child) => {
                              const childIsActive = child.id === activeId;
                              return (
                                <button
                                  key={child.id}
                                  ref={(el) => {
                                    if (el) itemRefs.current.set(child.id, el);
                                    else itemRefs.current.delete(child.id);
                                  }}
                                  type="button"
                                  aria-current={childIsActive ? "page" : undefined}
                                  className={clsx(styles.child, childIsActive && styles.childActive)}
                                  onClick={() => onActiveChange(child.id)}
                                  onMouseEnter={() => setHover(measure(child.id))}
                                  onFocus={() => setHover(measure(child.id))}
                                  onBlur={() => setHover(null)}
                                >
                                  <span aria-hidden className={clsx(styles.dot, childIsActive && styles.dotActive)} />
                                  <span className={styles.childLabel}>{child.label}</span>
                                  {child.badge !== undefined && (
                                    <span className={styles.childBadge}>{child.badge}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
        {/* Always rendered: doubles as the spacer that pins the footer down. */}
        <div className={styles.children}>{children}</div>
        <div className={styles.footer}>
          {footer}
          <button
            type="button"
            aria-label={toggleLabel}
            className={styles.toggle}
            onClick={() => setCollapsed(!collapsed)}
            {...tooltipAttrs(collapsed ? toggleLabel : undefined)}
          >
            <span className={styles.itemIcon}>
              <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={18} />
            </span>
            {!collapsed && <span className={styles.toggleLabel}>{toggleLabel}</span>}
          </button>
        </div>
      </aside>
    </SidebarContext.Provider>
  );
}
