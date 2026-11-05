import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { MobileClient } from "../src/transport/client";
import { generateKeyPair, publicKeyToBase64 } from "../src/transport/e2ee";
import { decodePairingUrl } from "../src/transport/pairing";
import { installMobileCrypto, openSocket } from "../src/transport/rn";
import { saveSession } from "../src/storage/session";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export default function Pair() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [endpoint, setEndpoint] = useState("ws://192.168.1.20:6768");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Deep link: openidea://pair?code=… from the desktop QR fills the form.
  useEffect(() => {
    const take = (u: string | null) => {
      if (u && decodePairingUrl(u)) setUrl(u);
    };
    Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener("url", (e) => take(e.url));
    return () => sub.remove();
  }, []);

  async function finish(
    client: MobileClient,
    keys: { publicKey: Uint8Array; secretKey: Uint8Array },
    token: string,
    ep: string,
  ) {
    await client.auth(token);
    const hello = await client.initialize(token);
    if (hello.protocol !== 2) throw new Error(`server speaks protocol ${hello.protocol}, want 2`);
    await saveSession({
      endpoint: ep,
      deviceToken: token,
      serverPublicKeyB64: client.serverPublicKeyB64,
      serverKeyPinned: client.serverKeyPinned,
      clientPublicB64: publicKeyToBase64(keys.publicKey),
      clientSecretB64: b64(keys.secretKey),
    });
    client.close();
    router.replace("/home");
  }

  async function pairWithUrl() {
    const offer = decodePairingUrl(url);
    if (!offer) {
      setError("That pairing link did not parse. Paste the full openidea://pair?code=… URL.");
      return;
    }
    setBusy("Connecting…");
    setError(null);
    const client = new MobileClient();
    try {
      installMobileCrypto();
      const keys = generateKeyPair();
      await client.connect(offer, keys, openSocket);
      await finish(client, keys, offer.deviceToken, offer.endpoint);
    } catch (e) {
      client.close();
      setError(e instanceof Error ? e.message : "pairing failed");
    } finally {
      setBusy(null);
    }
  }

  async function pairWithCode() {
    if (!endpoint.trim() || !code.trim()) {
      setError("Enter the endpoint and the 6-digit code from the desktop.");
      return;
    }
    setBusy("Exchanging code…");
    setError(null);
    const client = new MobileClient();
    try {
      installMobileCrypto();
      const keys = generateKeyPair();
      // No pinned key: the server advertises it in e2ee_ready (trust-on-first-use).
      await client.connect({ endpoint: endpoint.trim() }, keys, openSocket);
      const token = await client.pairExchange(code.trim(), "phone");
      // The advertised key is now pinned for later launches.
      await finish(client, keys, token, endpoint.trim());
    } catch (e) {
      client.close();
      setError(e instanceof Error ? e.message : "pairing failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.body}>
      <Text style={styles.h1}>Pair this phone</Text>
      <Text style={styles.hint}>Option 1: paste the pairing URL from the desktop (or scan the QR).</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="openidea://pair?code=…"
        placeholderTextColor="#5b636e"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable style={styles.primary} onPress={pairWithUrl} disabled={busy !== null}>
        <Text style={styles.primaryText}>Connect with pairing URL</Text>
      </Pressable>
      <Text style={styles.hint}>Option 2: type the endpoint and the 6-digit code.</Text>
      <TextInput
        style={styles.input}
        value={endpoint}
        onChangeText={setEndpoint}
        placeholder="ws://192.168.1.20:6768"
        placeholderTextColor="#5b636e"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        placeholder="123456"
        placeholderTextColor="#5b636e"
        keyboardType="number-pad"
        maxLength={6}
      />
      <Text style={styles.warn}>Manual codes cannot pin the server key: only use them on a network you trust.</Text>
      <Pressable style={styles.secondary} onPress={pairWithCode} disabled={busy !== null}>
        <Text style={styles.secondaryText}>Pair with manual code</Text>
      </Pressable>
      {busy ? (
        <View style={styles.row}>
          <ActivityIndicator color="#8ab4ff" />
          <Text style={styles.hint}>{busy}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#0e1116" },
  body: { padding: 20, gap: 12 },
  h1: { color: "#e8eaf0", fontSize: 22, fontWeight: "700" },
  hint: { color: "#9aa3af", fontSize: 14, lineHeight: 20 },
  warn: { color: "#d9a13b", fontSize: 13, lineHeight: 18 },
  error: { color: "#ff8080", fontSize: 14, lineHeight: 20 },
  input: {
    color: "#e8eaf0",
    backgroundColor: "#14171c",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#23272e",
  },
  primary: { backgroundColor: "#8ab4ff", borderRadius: 10, padding: 14, alignItems: "center" },
  primaryText: { color: "#0e1116", fontSize: 16, fontWeight: "700" },
  secondary: {
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#8ab4ff",
  },
  secondaryText: { color: "#8ab4ff", fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
});
