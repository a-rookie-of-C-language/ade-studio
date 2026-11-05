import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { loadSession } from "../src/storage/session";

export default function Gate() {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    loadSession().then((s) => {
      if (!live) return;
      router.replace(s ? "/home" : "/pair");
    });
    return () => {
      live = false;
    };
  }, [router]);
  return (
    <View style={styles.box}>
      <ActivityIndicator size="large" color="#8ab4ff" />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0e1116" },
});
