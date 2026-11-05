/**
 * An issue row. First line: the open/closed state icon, the title (full title
 * as tooltip when cut off), assignee avatars and the comment counter on the
 * right. Second line, one size smaller and grey: `#N · updated {date}, by
 * {login}` with the label dots.
 */
import { memo, type PointerEvent } from "react";
import { Icon } from "@/ui";
import { AvatarStack, AVATAR_SIZE } from "../ui/Avatar";
import { prettyDate } from "../ui/prettyDate";
import type { GHIssue } from "./model";
import styles from "./Issues.module.css";

/** The participant icons a row shows (`MAX_PARTICIPANT_ICONS` in the PR list). */
const MAX_AVATARS = 2;

/** Sets the full title as the tooltip only while it is cut off. */
function titleTooltip(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth) el.dataset.tooltip = el.textContent ?? "";
  else delete el.dataset.tooltip;
}

export const IssueRow = memo(function IssueRow({ issue }: { issue: GHIssue }) {
  const labels = issue.labels.slice(0, 3);
  const assignees = issue.assignees.slice(0, MAX_AVATARS);
  const author = issue.author?.login ?? "ghost";
  return (
    <div className={styles.row}>
      <div className={styles.line}>
        <div className={styles.left}>
          <span className={issue.state === "open" ? styles.stateOpen : styles.stateClosed}>
            <Icon name={issue.state === "open" ? "github-issue-open" : "github-issue-closed"} size={16} />
          </span>
          <span className={styles.title} onMouseEnter={titleTooltip}>
            {issue.title}
          </span>
        </div>
        <div className={styles.right}>
          {assignees.length > 0 && (
            <AvatarStack
              items={assignees.map((u) => ({ key: u.login, url: u.avatarUrl, name: u.login }))}
              size={AVATAR_SIZE.BASE}
            />
          )}
          {issue.commentCount > 0 && (
            <span className={styles.comments}>
              <Icon name="review-comment" size={14} />
              {issue.commentCount}
            </span>
          )}
        </div>
      </div>
      <div className={styles.info}>
        #{issue.number} · updated {prettyDate(issue.updatedAt)}, by {author}
        {labels.map((l) => ` · ${l.name}`)}
      </div>
    </div>
  );
});
