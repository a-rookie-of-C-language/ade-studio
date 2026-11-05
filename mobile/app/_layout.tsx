import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function Layout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#14171c" },
          headerTintColor: "#e8eaf0",
          contentStyle: { backgroundColor: "#0e1116" },
        }}
      >
        <Stack.Screen name="index" options={{ title: "OpenIDEA" }} />
        <Stack.Screen name="pair" options={{ title: "Pair phone" }} />
        <Stack.Screen name="home" options={{ title: "Projects", headerBackVisible: false }} />
      </Stack>
    </>
  );
}
