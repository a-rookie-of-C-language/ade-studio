/** Everything that needs xterm.js; loaded on first use through `loader.ts`. */
export {
  activeSession,
  applySettingsToAll,
  applyThemeToAll,
  closeAll,
  getSession,
  newTab,
  newTabAt,
  requestCloseSession,
  requestCloseTab,
  selectTab,
  sessionForTerminalId,
  sessionFromElement,
  splitTab,
  startDirectory,
  tabTitle,
  unsplit,
  useTerminals,
} from "./store";
export { TerminalTabs, TerminalView } from "./TerminalView";
export { applyThemeToEmbedded, createEmbeddedTerminal } from "./embedded";
export { closeTerminalFind, openTerminalFind, useTerminalFind } from "./FindBar";
