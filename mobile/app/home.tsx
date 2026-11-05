import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { MobileClient } from "../src/transport/client";
import { installMobileCrypto, openSocket } from "../src/transport/rn";
import { clearSession, loadSession, type SavedSession } from "../src/storage/session";

function secretBytes(s: SavedSession): Uint8Array {
  return new Uint8Array(Buffer.from(s.clientSecretB64, "base64"));
}
function publicBytes(s: SavedSession): Uint8Array {
  return new Uint8Array(Buffer.from(s.clientPublicB64 || "", "base64"));
}

type Project = { name?: string; path?: string; kind?: string };

export default function Home() {
  const router = useRouter();
  const [session, setSession] = useState<SavedSession | null>(null);
  const [serverVersion, setServerVersion] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    const saved = await loadSession();
    if (!saved) {
      router.replace("/pair");
      return;
    }
    setSession(saved);
    setError(null);
    setStatus("Connecting…");
    const client = new MobileClient();
    try {
      installMobileCrypto();
      await client.connect(saved, { publicKey: publicBytes(saved), secretKey: secretBytes(saved) }, openSocket);
      await client.auth(saved.deviceToken);
      const hello = await client.initialize(saved.deviceToken);
      setServerVersion(hello.serverVersion);
      setStatus(await client.ping().then((ok) => (ok ? "Online" : "Ping failed")));
      const list = await client.projects();
      setProjects((list as Project[]).filter((p) => typeof p === "object" && p !== null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "connection failed");
      setStatus("Offline");
    } finally {
      client.close();
    }
  }, [router]);

  useEffect(() => {
    // Initial dial on mount: this effect synchronizes with the companion server.
    // eslint-disable-next-line react/set-state-in-effect
    void connect();
  }, [connect]);

  async function forget() {
    await clearSession();
    router.replace("/pair");
  }

  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Text style={styles.endpoint}>{session?.endpoint ?? "…"}</Text>
        <Text style={styles.meta}>
          {status}
          {serverVersion ? ` · server ${serverVersion}` : ""}
          {session && !session.serverKeyPinned ? " · key not pinned (TOFU)" : ""}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={() => void connect()}>
            <Text style={styles.btnText}>Reconnect</Text>
          </Pressable>
          <Pressable style={styles.btnGhost} onPress={() => void forget()}>
            <Text style={styles.btnGhostText}>Unpair</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.section}>Projects</Text>
      {projects.length === 0 ? (
        <View style={styles.row}>
          <ActivityIndicator color="#8ab4ff" size="small" />
          <Text style={styles.meta}>Waiting for the project list…</Text>
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p, i) => `${p.path ?? p.name ?? i}`}
          renderItem={({ item }) => (
            <View style={styles.proj}>
              <Text style={styles.projName}>{item.name ?? "(unnamed)"}</Text>
              <Text style={styles.projPath}>{item.path ?? ""}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0e1116", padding: 16, gap: 12 },
  card: { backgroundColor: "#14171c", borderRadius: 12, padding: 16, gap: 8, borderWidth: 1, borderColor: "#23272e" },
  endpoint: { color: "#e8eaf0", fontSize: 16, fontWeight: "700" },
  meta: { color: "#9aa3af", fontSize: 13 },
  error: { color: "#ff8080", fontSize: 13 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  btn: { backgroundColor: "#8ab4ff", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 },
  btnText: { color: "#0e1116", fontWeight: "700" },
  btnGhost: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: "#5b636e" },
  btnGhostText: { color: "#9aa3af", fontWeight: "600" },
  section: { color: "#e8eaf0", fontSize: 16, fontWeight: "700", marginTop: 8 },
  proj: {
    backgroundColor: "#14171c",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#23272e",
  },
  projName: { color: "#e8eaf0", fontSize: 15, fontWeight: "600" },
  projPath: { color: "#5b636e", fontSize: 12, marginTop: 2 },
});
