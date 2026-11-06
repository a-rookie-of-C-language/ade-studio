//! `openidea-server --stdio`: the IDE backend for remote development, serving
//! one desktop client over stdin / stdout (started by the client over SSH).

use ide_host::plugins::remote::{RemotePluginLanguages, SYNC_COMMAND};
use ide_host::plugins::remote_host::RemotePlugins;
use ide_host::rpc::{self, Dispatcher};
use ide_host::{Host, HostConfig};
use ide_language::LanguageRegistry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

fn bind_arg(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--mobile-bind" {
            return iter.next().cloned();
        }
        if let Some(addr) = arg.strip_prefix("--mobile-bind=") {
            return Some(addr.to_owned());
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!(
            "openidea-server {} (protocol {}, mobile {})",
            env!("CARGO_PKG_VERSION"),
            rpc::PROTOCOL_VERSION,
            ide_host::mobile::MOBILE_PROTOCOL
        );
        return;
    }
    let stdio = args.iter().any(|a| a == "--stdio");
    let with_mobile = args.iter().any(|a| a == "--mobile");
    if !stdio && !with_mobile {
        eprintln!(
            "usage: openidea-server --stdio [--mobile [--mobile-bind ADDR]] | openidea-server --mobile [--mobile-bind ADDR] | --version"
        );
        std::process::exit(2);
    }
    let bind = bind_arg(&args).unwrap_or_else(|| ide_host::mobile::DEFAULT_BIND.to_owned());
    // stdout carries the protocol: logs go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("OPENIDEA_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    let home = dirs::home_dir().unwrap_or_default();
    let base = std::env::var_os("OPENIDEA_SERVER_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".openidea"));
    // An SSH exec channel gets a minimal environment: take the login shell's, read
    // afresh on every start, plus the IDE-managed tools. Before any other thread starts.
    ide_host::shell_env::inherit_login_shell_env("openidea-server");
    let data_dir = base.join("data");
    ide_tools::extend_process_path(&data_dir);
    ide_dap::adapter::set_tools_root(ide_tools::tools_dir(&data_dir));
    ide_sdk::java::add_jdk_root(&ide_tools::jdk::jdks_dir(&data_dir));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = runtime.block_on(run(base, stdio, with_mobile, bind));
    std::process::exit(code);
}

async fn run(base: PathBuf, stdio: bool, with_mobile: bool, bind: String) -> i32 {
    let (config_dir, data_dir) = (base.join("config"), base.join("data"));
    for dir in [&config_dir, &data_dir] {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("cannot create {}: {e}", dir.display());
            return 1;
        }
    }
    let languages = match LanguageRegistry::load(Some(&config_dir.join("languages"))) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            eprintln!("language definitions: {e}");
            return 1;
        }
    };
    // The desktop's plugin languages (`plugin_sync_languages`); programs pinned on this machine.
    let plugin_languages = RemotePluginLanguages::new(Some(&data_dir));
    languages.attach_plugins(plugin_languages.store().clone());
    let peer = Arc::new(OnceLock::new());
    let sink_peer = peer.clone();
    let plugins_data = data_dir.clone();
    let host = Arc::new(Host::new(HostConfig {
        config_dir,
        local_data_dir: data_dir.clone(),
        data_dir,
        languages,
        syntax: Arc::default(),
        sink_for: Box::new(move |window| rpc::event_sink(sink_peer.clone(), Some(window.to_owned()))),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: true,
    }));
    // The desktop's code plugins run here, next to the project (`plugin_sync_packages`).
    let plugins = match RemotePlugins::start(&plugins_data, &host, peer.clone()) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!("plugins are unavailable: {e}");
            None
        }
    };
    tracing::info!("openidea-server {} ready", env!("CARGO_PKG_VERSION"));
    let mut dispatcher = Dispatcher::standard();
    if let Some(plugins) = &plugins {
        plugins.register(&mut dispatcher);
    }
    dispatcher.add(SYNC_COMMAND, move |c| {
        let remote = plugin_languages.clone();
        async move {
            let report = remote.sync(c.arg("languages")?);
            c.host.plugin_languages_changed();
            Ok(report)
        }
    });
    if with_mobile && !stdio {
        // Phone-only mode: the WebSocket companion protocol replaces the SSH stdio one.
        let result = ide_host::mobile::serve_mobile(host.clone(), dispatcher, &bind, host.config_dir.clone()).await;
        if let Err(e) = &result {
            tracing::warn!("mobile companion stopped: {e}");
        }
        finish(&host, plugins.as_deref()).await;
        return if result.is_ok() { 0 } else { 1 };
    }
    if with_mobile {
        let mobile_host = host.clone();
        let mobile_dispatcher = dispatcher.clone();
        let mobile_config = host.config_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = ide_host::mobile::serve_mobile(mobile_host, mobile_dispatcher, &bind, mobile_config).await {
                tracing::warn!("mobile companion stopped: {e}");
            }
        });
    }
    rpc::serve(host.clone(), dispatcher, peer, tokio::io::stdin(), tokio::io::stdout()).await;
    finish(&host, plugins.as_deref()).await;
    0
}

/// Shuts plugins and language servers down after the last client leaves.
async fn finish(host: &Arc<Host>, plugins: Option<&RemotePlugins>) {
    if let Some(plugins) = plugins {
        plugins.host().shutdown();
    }
    // `process::exit` skips destructors: nothing started for the client may outlive it.
    if tokio::time::timeout(std::time::Duration::from_secs(10), host.shutdown()).await.is_err() {
        tracing::warn!("language servers did not shut down in time");
    }
}
