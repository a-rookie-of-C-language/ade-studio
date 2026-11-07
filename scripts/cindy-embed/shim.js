// window.electronAPI stub for running Cindy's renderer in a plain browser.
// Boot-only (P0): every unknown namespace absorbs calls and yields a
// chainable stub; subscriptions return no-op unsubscribers. Real bridges
// replace namespaces one by one in P2+.
//
// Every absorbed call is recorded on window.__ipcCalls (capped) so the
// harness can surface swallowed errors and build the bridge gap list.
(function () {
  // Storage isolation: the embed shares its origin with OpenIDEA, but both
  // apps use overlapping localStorage keys (notably "openidea.workspace.root"
  // on both sides with different shapes). Prefix every key so neither app can
  // clobber the other. `clear()` only drops prefixed keys. `storage` events
  // still cross the boundary with prefixed keys; both sides ignore unknown
  // keys, so listeners just miss (no crash).
  function prefixedStorage(native, prefix) {
    const facade = {
      get length() {
        let n = 0;
        for (let i = 0; i < native.length; i++) {
          const k = native.key(i);
          if (k && k.indexOf(prefix) === 0) n++;
        }
        return n;
      },
      key(i) {
        let n = -1;
        for (let k = 0; k < native.length; k++) {
          const key = native.key(k);
          if (key && key.indexOf(prefix) === 0) {
            n++;
            if (n === i) return key.slice(prefix.length);
          }
        }
        return null;
      },
      getItem(k) {
        return native.getItem(prefix + k);
      },
      setItem(k, v) {
        native.setItem(prefix + k, String(v));
      },
      removeItem(k) {
        native.removeItem(prefix + k);
      },
      clear() {
        const doomed = [];
        for (let i = 0; i < native.length; i++) {
          const key = native.key(i);
          if (key && key.indexOf(prefix) === 0) doomed.push(key);
        }
        doomed.forEach((k) => native.removeItem(k));
      },
    };
    return facade;
  }
  try {
    Object.defineProperty(window, "localStorage", {
      value: prefixedStorage(window.localStorage, "cindy-embed:"),
      configurable: true,
    });
  } catch {
    /* older engine: fall through to shared storage */
  }
  try {
    Object.defineProperty(window, "sessionStorage", {
      value: prefixedStorage(window.sessionStorage, "cindy-embed:"),
      configurable: true,
    });
  } catch {
    /* older engine: fall through to shared storage */
  }

  // ---- Embedded model catalog (real bridge, not a stub) ----
  // The iframe cannot fetch the loopback magpie gateway itself (the gateway
  // sends no CORS headers), so the parent (CindyView) serves the Rust
  // `cindy_magpie_catalog` command over postMessage. Fail-closed: a timeout
  // or gateway-down rejects, and the picker shows load-failed with retry
  // instead of hanging on "Loading model…" forever.
  var MAGPIE_REQ = "cindy-embed:magpie-catalog:request";
  var MAGPIE_RES = "cindy-embed:magpie-catalog:response";
  var magpieNextId = 1;
  var magpiePending = {};
  var magpieCache = null;
  var magpieCacheAt = 0;
  var MAGPIE_CACHE_MS = 15000;
  window.addEventListener("message", function (event) {
    var d = event.data;
    if (!d || d.source !== "openidea-host" || d.type !== MAGPIE_RES) return;
    var p = magpiePending[d.id];
    if (!p) return;
    delete magpiePending[d.id];
    clearTimeout(p.timer);
    if (d.ok) p.resolve(d.models);
    else p.reject(new Error(d.error || "magpie catalog unavailable"));
  });
  function requestMagpieCatalog() {
    var now = Date.now();
    if (magpieCache && now - magpieCacheAt < MAGPIE_CACHE_MS) return Promise.resolve(magpieCache);
    if (requestMagpieCatalog.inflight) return requestMagpieCatalog.inflight;
    var p = new Promise(function (resolve, reject) {
      var id = magpieNextId++;
      var timer = setTimeout(function () {
        delete magpiePending[id];
        reject(new Error("magpie catalog timed out"));
      }, 10000);
      magpiePending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        window.parent.postMessage({ source: "cindy-embed", type: MAGPIE_REQ, id: id }, "*");
      } catch (e) {
        delete magpiePending[id];
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    requestMagpieCatalog.inflight = p;
    p.then(
      function (models) {
        magpieCache = models;
        magpieCacheAt = Date.now();
      },
      function () {},
    ).then(function () {
      requestMagpieCatalog.inflight = null;
    });
    return p;
  }
  function magpieDefaultEffort(efforts) {
    if (!efforts || efforts.length === 0) return null;
    if (efforts.indexOf("medium") !== -1) return "medium";
    return efforts[0];
  }
  // Effort union in @cindy/model-providers: anything else breaks the picker.
  var KNOWN_EFFORTS = { minimal: 1, low: 1, medium: 1, high: 1, xhigh: 1, max: 1, ultra: 1 };
  function magpieCatalogModels(models) {
    return (models || [])
      .map(function (m) {
        var raw = Array.isArray(m.efforts) ? m.efforts : [];
        var efforts = raw.filter(function (e) {
          return typeof e === "string" && KNOWN_EFFORTS[e] === 1;
        });
        var contextWindow = typeof m.context_window === "number" && m.context_window > 0 ? m.context_window : 200000;
        var vendor = typeof m.provider === "string" && m.provider ? m.provider : undefined;
        return {
          id: m.id,
          name: m.name || m.id,
          // Real vendor ids group properly in the picker; unknown gateway
          // names ride the userProvider pass-through in isAgentSelectableModel
          // instead of being killed by the id-regex classifier. Never set a
          // known non-chat category here.
          group: vendor,
          contextWindow: contextWindow,
          efforts: efforts,
          defaultEffort: magpieDefaultEffort(efforts),
        };
      })
      .filter(function (m) {
        return typeof m.id === "string" && m.id;
      });
  }
  function magpieProviderView(models) {
    // Group rows under their real provider ids: the picker's trigger and
    // panel resolve by (providerId, modelId) with non-null assertions, so a
    // single lumped provider leaves every stored selection dangling at
    // "Model Details Unavailable" (and the panel throws on open).
    var groups = {};
    var order = [];
    (models || []).forEach(function (m) {
      var pid = typeof m.provider === "string" && m.provider ? m.provider : "magpie-local";
      if (!groups[pid]) {
        groups[pid] = [];
        order.push(pid);
      }
      groups[pid].push(m);
    });
    if (order.length === 0) order.push("magpie-local");
    var routing = function () {
      return {
        upstream: "http://127.0.0.1:3425",
        authStrategy: "none",
        modelsUrl: "http://127.0.0.1:3425/v1/models",
      };
    };
    var providers = order.map(function (pid) {
      var entries = magpieCatalogModels(groups[pid] || []);
      return {
        id: pid,
        name: pid === "magpie-local" ? "Magpie" : pid,
        source: "user",
        agents: ["claude-code", "codex", "pi"],
        auth: { method: "none" },
        routing: { "claude-code": routing(), codex: routing(), pi: routing() },
        models: { "claude-code": entries, codex: entries, pi: entries },
        connected: true,
      };
    });
    return {
      dataOwnerId: "local",
      ownerGeneration: 1,
      providers: providers,
      providerOrder: order,
    };
  }
  function magpieCapabilities(models) {
    var entries = magpieCatalogModels(models);
    var seen = {};
    var effortLevels = [];
    entries.forEach(function (m) {
      m.efforts.forEach(function (e) {
        if (!seen[e]) {
          seen[e] = true;
          // MobileChoiceOption is { id, label }: displayName renders blank.
          effortLevels.push({ id: e, label: e.charAt(0).toUpperCase() + e.slice(1) });
        }
      });
    });
    return {
      availableModels: entries.map(function (m) {
        return {
          id: m.id,
          displayName: m.name,
          contextWindow: m.contextWindow,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort,
        };
      }),
      hasFastMode: false,
      effortLevels: effortLevels,
      permissionModes: [{ id: "default", label: "Default" }],
    };
  }

  var MAX_CALLS = 800;

  function fmtArg(a) {
    if (typeof a === "function") return "[function]";
    try {
      var s = JSON.stringify(a);
      return s === undefined ? String(a) : s.slice(0, 200);
    } catch {
      return Object.prototype.toString.call(a);
    }
  }

  function record(text) {
    try {
      if (window.__ipcCalls.length < MAX_CALLS) window.__ipcCalls.push(text);
    } catch {
      /* ignore */
    }
  }

  // Stable identities per path: every evaluation of the same access chain
  // returns the SAME proxy. Otherwise each render creates fresh objects and
  // any setState/proxy-in-deps turns into an infinite render loop.
  var proxyCache = new Map();
  function anyProxy(path) {
    var hit = proxyCache.get(path);
    if (hit) return hit;
    var fn = function () {
      return proxy;
    };
    var proxy = new Proxy(fn, {
      get: function (t, p) {
        if (p === "then") return undefined;
        if (p === Symbol.toPrimitive)
          return function () {
            return "";
          };
        // Spreads, for..of, Maps/Sets over stub data yield nothing instead
        // of throwing: an absent backend means empty lists, not a crash.
        // Must be a factory (the protocol calls it); a bare iterator object
        // is not callable and still throws. `then` stays undefined so
        // await/Promise assimilation stays safe.
        if (p === Symbol.iterator)
          return function () {
            return [].values();
          };
        if (p === Symbol.asyncIterator) return undefined;
        if (p === "__v_isRef" || p === "__v_isReactive" || p === "__v_skip") return undefined;
        return anyProxy(path + "." + String(p));
      },
      apply: function (t, thisArg, args) {
        record(path + "(" + Array.prototype.map.call(args, fmtArg).join(", ") + ")");
        return proxy;
      },
      construct: function () {
        record(path + " [construct]");
        return proxy;
      },
      getOwnPropertyDescriptor: function () {
        return { configurable: true, enumerable: false };
      },
    });
    proxyCache.set(path, proxy);
    return proxy;
  }

  function isSubscribeName(p) {
    return typeof p === "string" && /^(on|add|subscribe|once)[A-Z]/.test(p);
  }

  function isDunder(p) {
    return p === "then" || p === "toJSON" || p === "toString" || p === "valueOf";
  }

  // Namespaces with concrete boot-safe answers. Missing keys on them fall
  // back to the absorbing stub, so P2 bridges only replace what they own.
  function namespace(path, concrete) {
    var hit = proxyCache.get(path);
    if (hit) return hit;
    var proxy = new Proxy(concrete, {
      get: function (t, p) {
        if (p in t) return t[p];
        if (isSubscribeName(p)) {
          return function () {
            record("subscribe " + path + "." + String(p));
            return function () {};
          };
        }
        if (isDunder(p)) return undefined;
        return anyProxy(path + "." + String(p));
      },
      set: function () {
        return true;
      },
    });
    proxyCache.set(path, proxy);
    return proxy;
  }

  var NAMESPACES = {
    // Explicit `.then()` chains need real promises (the absorbing stub has
    // no `then`, by design, so async assimilation stays safe).
    appearanceSettings: {
      getSync: function () {
        return undefined;
      },
      // No `value` key: the refresh path skips apply past the `'value' in` guard.
      get: function () {
        return Promise.resolve({});
      },
      setPatch: function () {
        return Promise.resolve(undefined);
      },
    },
    localDb: namespace("electronAPI.localDb", {
      maintenance: namespace("electronAPI.localDb.maintenance", {
        getStartupProgress: function () {
          return Promise.resolve(null);
        },
        // Null: no slimming result to celebrate or mourn.
        getLastResult: function () {
          return Promise.resolve(null);
        },
      }),
      // Empty session lists: chat/task UI renders its empty state.
      sessions: namespace("electronAPI.localDb.sessions", {
        list: function () {
          return Promise.resolve([]);
        },
        // No interrupted sessions: the resume dialog stays shut.
        // (A proxy here is truthy-but-empty and trips the open gate.)
        interruptedResumeCandidates: function () {
          return Promise.resolve([]);
        },
      }),
      // No project aliases in the embed.
      projectAliases: namespace("electronAPI.localDb.projectAliases", {
        list: function () {
          return Promise.resolve([]);
        },
      }),
      bots: namespace("electronAPI.localDb.bots", {
        // Empty bot profiles: teammate UI renders its empty state.
        list: function () {
          return Promise.resolve([]);
        },
        // Follow scopes stay unloaded: the `if (!api) return` guard must
        // see undefined, so this stays explicitly undefined.
        workbench: namespace("electronAPI.localDb.bots.workbench", {
          followScopes: undefined,
        }),
        readState: namespace("electronAPI.localDb.bots.readState", {
          // ownerId null: applyHostState early-returns, stays local-only.
          get: function () {
            return Promise.resolve({ ownerId: null, positions: {} });
          },
          update: function () {
            return Promise.resolve(undefined);
          },
        }),
      }),
    }),
    rsbBrowserBridge: {
      snapshot: function () {
        return Promise.resolve({ ok: true, dropped: [], kept: 0, pinnedTabIds: [] });
      },
      report: function () {
        return Promise.resolve(undefined);
      },
      release: function () {
        return Promise.resolve(undefined);
      },
      tabOpResult: function () {
        return Promise.resolve(undefined);
      },
      setForeground: function () {
        return Promise.resolve(undefined);
      },
      forceKill: function () {
        return Promise.resolve(undefined);
      },
    },
    // Quiet session lists: renderer keeps its own in-memory state.
    // Scheduler stays stubbed (out of scope for the embed).
    // Companions/groups stay disabled: their guards (`typeof x ===
    // 'function'`) must fail, so these stay explicitly undefined.
    maker: namespace("electronAPI.maker", {
      getCompanionCloudState: undefined,
      listBotGroups: undefined,
      // Real model catalog for the picker: live magpie rows via the parent.
      // Fail-closed (reject) so the selector shows retry, never infinite
      // loading — and never an empty catalog either (the panel assumes at
      // least one provider with models and throws on open otherwise).
      // Refresh affordance (selector/settings open): bust the cache so the
      // panel's own listProviders refetch sees live rows. Desktop resolves
      // { ok: true }; failures reject and callers already tolerate that.
      requestProviderModelsAutoRefresh: function () {
        magpieCache = null;
        magpieCacheAt = 0;
        return requestMagpieCatalog().then(function () {
          return { ok: true };
        });
      },
      // Manual refresh from settings: same live rows, desktop result shape.
      refreshBuiltinProviderModels: function (providerId) {
        magpieCache = null;
        magpieCacheAt = 0;
        return requestMagpieCatalog().then(function () {
          return { ok: true, providerId: providerId };
        });
      },
      listProviders: function () {
        return requestMagpieCatalog().then(function (models) {
          var view = magpieProviderView(models);
          var total = view.providers.reduce(function (n, p) {
            return (
              n + (p.models["claude-code"] || []).length + (p.models.codex || []).length + (p.models.pi || []).length
            );
          }, 0);
          if (total === 0) return Promise.reject(new Error("magpie catalog empty"));
          return view;
        });
      },
      getCapabilities: function () {
        return requestMagpieCatalog().then(magpieCapabilities);
      },
      listActive: function () {
        return Promise.resolve([]);
      },
      listSessionBackgroundActivity: function () {
        return Promise.resolve({ sessionIds: [] });
      },
      projectAutomation: namespace("electronAPI.maker.projectAutomation", {
        listPendingImports: function () {
          return Promise.resolve([]);
        },
      }),
    }),
    // No controlled devices in the embed: empty controller list.
    deviceLink: namespace("electronAPI.deviceLink", {
      getState: function () {
        return Promise.resolve({ controlledBy: [] });
      },
    }),
    // No remote-desktop panel in the embed (renders nothing on null).
    remoteDesktop: {
      state: function () {
        return Promise.resolve(null);
      },
    },
    // Default three-pane layout (session list + chat/tools split): without
    // it the layout engine renders an empty content area.
    layout: namespace("electronAPI.layout", {
      getStateSync: function () {
        return {
          layout: {
            schemaVersion: 1,
            sidebar: { type: "pane", id: "sessions", panelKind: "session-list", edge: "left" },
            content: {
              type: "split",
              id: "root",
              direction: "row",
              children: [
                { fraction: 0.5, node: { type: "pane", id: "chat", panelKind: "chat-main", minWidth: 400 } },
                { fraction: 0.5, node: { type: "pane", id: "right", panelKind: "right-tabs" } },
              ],
            },
            float: [],
          },
        };
      },
      set: function () {
        return Promise.resolve(undefined);
      },
    }),
    // No PR refs in the embed: empty list (null also works, [] is simpler).
    gitContext: namespace("electronAPI.gitContext", {
      listAllPrRefs: function () {
        return Promise.resolve([]);
      },
    }),
    // No plugins in the embed: empty roster, sidebar shows builtins only.
    ghosts: namespace("electronAPI.ghosts", {
      listSync: function () {
        return { ghosts: [] };
      },
      uiPrompts: function () {
        return Promise.resolve([]);
      },
      listPickerModels: function () {
        return Promise.resolve([]);
      },
    }),
    // No voice calls in the embed (test mock resolves null too).
    voiceConversation: namespace("electronAPI.voiceConversation", {
      callStatus: function () {
        return Promise.resolve(null);
      },
    }),
    // Voice shortcut recovery never pending: no listener to recover.
    voiceInput: namespace("electronAPI.voiceInput", {
      consumeShortcutRecoveryFailure: function () {
        return Promise.resolve({ failed: false });
      },
    }),
    // No plugin removals in the embed: null means nothing pending.
    pluginMarket: namespace("electronAPI.pluginMarket", {
      consumeRemovalNotice: function () {
        return Promise.resolve(null);
      },
    }),
    // No pending daemon upgrades in the embed.
    remoteSsh: {
      ccMgrListPendingUpgrades: function () {
        return Promise.resolve({ pending: [] });
      },
    },
    // Idle updater: no banner in the embed.
    legacyMigration: {
      getState: function () {
        return Promise.resolve({ phase: null });
      },
    },
    // Null-safe list results keep theme stores on builtins.
    localThemes: {
      listSync: function () {
        return { success: true, themes: [] };
      },
      list: function () {
        return Promise.resolve({ success: true, themes: [] });
      },
    },
  };

  var prev = window.electronAPI && typeof window.electronAPI === "object" ? window.electronAPI : {};
  var base = {
    platform: "win32",
    windowBackdropMaterial: "none",
    __CINDY_EMBED__: true,
    logToMain: function (level, scope, message) {
      record("LOG [" + level + "] " + scope + ": " + message);
      return Promise.resolve();
    },
    // Analytics stays fail-closed in the embed: never report.
    getAnalyticsSettings: function () {
      return Promise.resolve({ allowed: false });
    },
    // Default to local mode: the embed has no sign-in backend, so boot
    // straight into the local owner instead of parking on the login wall.
    // GuestRoute navigates on a real mode === 'local'; dataOwnerId and the
    // generation are stable values (never null/proxy) for owner fencing.
    authInitialize: function () {
      return Promise.resolve({
        mode: "local",
        isAuthenticated: false,
        canEnterApp: true,
        user: null,
        dataOwnerId: "local",
        ownerGeneration: 1,
        ownerBoundaryPending: false,
        isCanary: false,
        deviceId: "embed-dev",
        hasAccountDeletionReceipt: false,
        accountDeletionRestored: false,
        credentialStoreUnavailable: false,
      });
    },
    // Local-mode entry: GuestRoute navigates away only on a real
    // mode === 'local'. Data owner is a stable string (never null here)
    // so owner fencing, stores and IPC params see sane values.
    authEnterLocal: function () {
      return Promise.resolve({
        mode: "local",
        isAuthenticated: false,
        canEnterApp: true,
        user: null,
        dataOwnerId: "local",
        ownerGeneration: 1,
        ownerBoundaryPending: false,
        isCanary: false,
        deviceId: "embed-dev",
        hasAccountDeletionReceipt: false,
        accountDeletionRestored: false,
        credentialStoreUnavailable: false,
      });
    },
    // Idle updater: no banner in the embed.
    getUpdateStatus: function () {
      return Promise.resolve({ status: "idle" });
    },
    // No account-deletion receipt in the embed.
    authConsumeAccountDeletionRestoredNotice: function () {
      return Promise.resolve(false);
    },
    // Absent bridges: the `if (!api?.method)` guards must fail so callers
    // keep their degraded defaults (idle status, no project-order sync).
    modelAccess: undefined,
    // Sidebar settings are read synchronously at mount, so this bridge
    // returns a real empty snapshot instead of staying undefined.
    sidebarSettings: namespace("electronAPI.sidebarSettings", {
      loadSnapshot: function () {
        return {
          dataOwnerId: "local",
          ownerGeneration: 1,
          pinnedOrderIsAuthoritative: false,
          pinnedOrder: [],
          hiddenProjectKeys: [],
          hiddenMainViewGhostIds: [],
        };
      },
      getProjectOrder: function () {
        return Promise.resolve({
          authoritative: false,
          available: true,
          manualProjectOrder: [],
          projectOrder: "activity",
        });
      },
      applyProjectOrder: function () {
        return Promise.resolve({ kind: "unavailable" });
      },
    }),
    // Update channel settings: stock defaults, nothing customized.
    getUpdateChannelSettings: function () {
      return Promise.resolve({});
    },
    // Feature bridges absent in the embed: their `if (!api) return` guards
    // must see undefined, so these stay explicitly undefined.
    performanceTrace: undefined,
    regionScreenshotCompose: undefined,
  };
  for (var k in prev) {
    if (!(k in base)) {
      try {
        base[k] = prev[k];
      } catch {
        /* ignore */
      }
    }
  }

  window.__ipcCalls = [];
  window.electronAPI = new Proxy(base, {
    get: function (t, p) {
      if (p in t) return t[p];
      if (typeof p === "string" && p in NAMESPACES) return namespace("electronAPI." + p, NAMESPACES[p]);
      if (isSubscribeName(p)) {
        return function () {
          record("subscribe " + String(p));
          return function () {};
        };
      }
      if (isDunder(p)) return undefined;
      return anyProxy("electronAPI." + String(p));
    },
    set: function () {
      return true;
    },
    has: function (t, p) {
      return p in t;
    },
  });
  window.__CINDY_EMBED__ = true;
})();
