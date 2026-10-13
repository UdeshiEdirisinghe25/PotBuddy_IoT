import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import type { DeviceSnapshot, PlantProfile, WaterCommand } from "./domain";
import { apiConfigured, getBackendStatus, getReadings, registerNotificationSettings, sendDeviceConfiguration, sendPotWaterCommand, sendStopCommand, type BackendStatus } from "./services/api";
import { ensureAnonymousSession, firebaseConfigured } from "./services/firebase";
import { getPotBuddyPushToken } from "./services/notifications";
import * as Notifications from "expo-notifications";
import { HomeScreen } from "./screens/HomeScreen";
import { PlantsScreen } from "./screens/PlantsScreen";
import { WaterScreen } from "./screens/WaterScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AlertsScreen, type PotBuddyAlert } from "./screens/AlertsScreen";
import { alertKey, emptySettings, getObservedPots, getPlantProfile, getPotsFromReading, type AppSettings } from "./services/plantData";
import { isValidDuration, isValidMoisture, loadSettings, saveSettings } from "./services/settings";

type Tab = "Home" | "Plants" | "Watering" | "History" | "Settings" | "Alerts";
type AuthState = "loading" | "ready" | "error";
const tabs: Array<{ key: Exclude<Tab, "Alerts">; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap }> = [
  { key: "Home", icon: "home-outline", activeIcon: "home" },
  { key: "Plants", icon: "leaf-outline", activeIcon: "leaf" },
  { key: "Watering", icon: "water-outline", activeIcon: "water" },
  { key: "History", icon: "time-outline", activeIcon: "time" },
  { key: "Settings", icon: "settings-outline", activeIcon: "settings" },
];

export default function PotBuddyApp() {
  const [tab, setTab] = useState<Tab>("Home");
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authError, setAuthError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(emptySettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [deviceConfigError, setDeviceConfigError] = useState<string | null>(null);
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [sendingPotId, setSendingPotId] = useState<string | null>(null);
  const [wateringSecondsByPot, setWateringSecondsByPot] = useState<Record<string, number>>({});
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const commandInFlightRef = useRef(false);
  const autoReadingRef = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings>(emptySettings);
  const plants = useMemo(() => getObservedPots(snapshot), [snapshot]);

  useEffect(() => {
    if (Object.keys(wateringSecondsByPot).length === 0) return;
    const timer = setInterval(() => {
      setWateringSecondsByPot((current) => Object.fromEntries(
        Object.entries(current)
          .map(([potId, seconds]) => [potId, seconds - 1] as const)
          .filter(([, seconds]) => seconds > 0),
      ));
    }, 1000);
    return () => clearInterval(timer);
  }, [wateringSecondsByPot]);

  const updateSettings = useCallback((update: (current: AppSettings) => AppSettings) => {
    const next = update(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next).then(() => setSettingsError(null)).catch(() => setSettingsError("Your settings could not be saved. Please try again."));
  }, []);

  const refresh = useCallback(async () => {
    if (authState !== "ready" || !apiConfigured) return;
    setLoading(true);
    try {
      const next = await getReadings();
      setSnapshot(next);
      setDataError(null);
    } catch (error) {
      setDataError("Plant information could not be loaded. Check your connection and try again.");
    }
    try {
      setBackend(await getBackendStatus());
    } catch {
      setBackend(null);
    } finally {
      setLoading(false);
    }
  }, [authState]);

  useEffect(() => {
    let active = true;
    void loadSettings().then((stored) => {
      if (active) { settingsRef.current = stored; setSettings(stored); setSettingsLoaded(true); }
    });
    void ensureAnonymousSession().then(() => {
      if (active) setAuthState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setAuthError(getAuthErrorMessage(error));
      setAuthState("error");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void getPotBuddyPushToken().then((token) => {
      if (active) setExpoPushToken(token);
    }).catch((error: unknown) => console.warn("Push notification setup failed", error));
    const tokenSubscription = Notifications.addPushTokenListener((token) => setExpoPushToken(token.data));
    const responseSubscription = Notifications.addNotificationResponseReceivedListener(() => setTab("Alerts"));
    return () => { active = false; tokenSubscription.remove(); responseSubscription.remove(); };
  }, []);

  useEffect(() => {
    if (!expoPushToken || !snapshot?.deviceId || authState !== "ready" || !settingsLoaded) return;
    const profiles = Object.fromEntries(Object.entries(settings.profiles).map(([potId, profile]) => [potId, { name: profile.name, startBelowPct: profile.startBelowPct }]));
    void registerNotificationSettings(snapshot.deviceId, {
      expoPushToken,
      lowMoistureAlerts: settings.lowMoistureAlerts,
      lowReservoirAlerts: settings.lowReservoirAlerts,
      deviceOfflineAlerts: settings.deviceOfflineAlerts,
      temperatureAlertC: settings.temperatureAlertC,
      profiles,
    }).catch((error: unknown) => console.warn("Push notification registration failed", error));
  }, [expoPushToken, snapshot?.deviceId, authState, settingsLoaded, settings]);

  useEffect(() => {
    if (!snapshot?.deviceId || authState !== "ready" || !settingsLoaded) return;
    const potIds = ["pot-1", "pot-2", "pot-3"];
    const profiles = Object.fromEntries(potIds.map((potId) => {
      const profile = settings.profiles[potId];
      return [potId, { startBelowPct: profile?.startBelowPct ?? null, targetPct: profile?.targetPct ?? null }];
    }));
    const profilesReady = potIds.every((potId) => {
      const profile = profiles[potId];
      return profile?.startBelowPct !== null && profile?.startBelowPct !== undefined && profile?.targetPct !== null && profile?.targetPct !== undefined && profile.startBelowPct < profile.targetPct;
    });
    if (settings.autoWaterEnabled && !profilesReady) {
      setDeviceConfigError("Set valid moisture levels for pots 1–3 before enabling automatic watering.");
      return;
    }
    setDeviceConfigError(null);
    void sendDeviceConfiguration(snapshot.deviceId, {
      type: "config",
      autoWaterEnabled: settings.autoWaterEnabled,
      pulseDurationSeconds: settings.pulseDurationSeconds,
      maximumRuntimeSeconds: settings.maximumRuntimeSeconds,
      profiles,
    }).catch((error: unknown) => {
      console.warn("Could not sync automatic watering configuration", error);
      setDeviceConfigError("Automatic watering settings could not reach the controller. Check the backend configuration endpoint and connection.");
      if (settings.autoWaterEnabled) updateSettings((current) => ({ ...current, autoWaterEnabled: false }));
    });
  }, [snapshot?.deviceId, authState, settingsLoaded, settings.autoWaterEnabled, settings.pulseDurationSeconds, settings.maximumRuntimeSeconds, settings.profiles, updateSettings]);

  useEffect(() => {
    if (authState !== "ready") return;
    void refresh();
    const timer = setInterval(() => void refresh(), settings.checkIntervalSeconds * 1000);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => { clearInterval(timer); appStateSubscription.remove(); };
  }, [authState, refresh, settings.checkIntervalSeconds]);

  const recordRequest = useCallback((command: WaterCommand) => {
    if (command.action !== "water" || command.durationSeconds === undefined) return;
    const request = { potId: command.potId ?? snapshot?.deviceId ?? "", issuedAt: command.issuedAt, durationSeconds: command.durationSeconds };
    updateSettings((current) => ({ ...current, requests: [...current.requests, request].slice(-100) }));
  }, [updateSettings, snapshot?.deviceId]);

  const sendWater = useCallback(async (potId: string, automatic = false) => {
    if (commandInFlightRef.current) return false;
    const durationSeconds = settings.pulseDurationSeconds === null || settings.maximumRuntimeSeconds === null ? null : Math.min(settings.pulseDurationSeconds, settings.maximumRuntimeSeconds);
    if (durationSeconds === null || !isValidDuration(durationSeconds)) {
      setCommandMessage("Choose a watering time in Settings first.");
      return false;
    }
    commandInFlightRef.current = true;
    setSendingPotId(potId);
    setCommandMessage(null);
    try {
      const result = await sendPotWaterCommand(potId, durationSeconds);
      recordRequest(result.command);
      setWateringSecondsByPot((current) => ({ ...current, [potId]: durationSeconds }));
      setCommandMessage(`${automatic ? "Automatic watering started for" : "Watering started for"} ${getPlantProfile(settings, potId).name || potId}.`);
      return true;
    } catch (error) {
      setCommandMessage(getFriendlyCommandError(error, "Watering could not start. Check the connection and try again."));
      return false;
    } finally {
      commandInFlightRef.current = false;
      setSendingPotId(null);
      void refresh();
    }
  }, [settings, recordRequest, refresh]);

  const sendStop = useCallback(async (potId: string) => {
    setCommandMessage(null);
    try {
      await sendStopCommand(potId);
      setWateringSecondsByPot((current) => {
        const next = { ...current };
        delete next[potId];
        return next;
      });
      setCommandMessage(`Watering stopped for ${getPlantProfile(settings, potId).name || potId}.`);
    } catch (error) {
      setCommandMessage(getFriendlyCommandError(error, "Watering could not be stopped. Check the connection and try again."));
    } finally {
      void refresh();
    }
  }, [settings, refresh]);

  useEffect(() => {
    const reading = snapshot?.latest;
    if (!settingsLoaded || !settings.autoWaterEnabled || !reading || !snapshot?.online || !backend?.mqttConnected || snapshot.reservoirAvailable === false || settings.pulseDurationSeconds === null || settings.maximumRuntimeSeconds === null || sendingPotId) return;
    if (autoReadingRef.current === reading.receivedAt) return;
    autoReadingRef.current = reading.receivedAt;
    const latches = new Set(settings.autoWaterLatches);
    let latchChanged = false;
    for (const observed of getPotsFromReading(reading, snapshot.deviceId)) {
      const profile = getPlantProfile(settings, observed.potId);
      if (!isValidMoisture(profile.startBelowPct) || !isValidMoisture(profile.targetPct) || profile.startBelowPct >= profile.targetPct || observed.moisturePct === undefined) continue;
      if (observed.moisturePct >= profile.targetPct && latches.has(observed.potId)) {
        latches.delete(observed.potId);
        latchChanged = true;
        continue;
      }
      if (observed.moisturePct < profile.startBelowPct && !latches.has(observed.potId)) {
        latches.add(observed.potId);
        updateSettings((current) => ({ ...current, autoWaterLatches: [...latches] }));
        void sendWater(observed.potId, true).then((sent) => {
          if (!sent) updateSettings((current) => ({ ...current, autoWaterLatches: current.autoWaterLatches.filter((id) => id !== observed.potId) }));
        });
        return;
      }
    }
    if (latchChanged) updateSettings((current) => ({ ...current, autoWaterLatches: [...latches] }));
  }, [snapshot, backend?.mqttConnected, settingsLoaded, settings, sendingPotId, updateSettings, sendWater]);

  const updateProfile = useCallback((potId: string, profile: PlantProfile) => {
    updateSettings((current) => {
      const profiles = { ...current.profiles, [potId]: profile };
      const allRequiredProfilesReady = ["pot-1", "pot-2", "pot-3"].every((requiredPotId) => {
        const item = profiles[requiredPotId];
        return item?.startBelowPct !== null && item?.startBelowPct !== undefined && item?.targetPct !== null && item?.targetPct !== undefined && item.startBelowPct < item.targetPct;
      });
      const thresholdsReady = allRequiredProfilesReady && plants.length > 0 && plants.every((plant) => {
        const item = profiles[plant.potId];
        return item?.startBelowPct !== null && item?.startBelowPct !== undefined && item?.targetPct !== null && item?.targetPct !== undefined && item.startBelowPct < item.targetPct;
      });
      return { ...current, profiles, autoWaterEnabled: current.autoWaterEnabled && thresholdsReady, autoWaterLatches: current.autoWaterLatches.filter((id) => id !== potId) };
    });
  }, [plants, updateSettings]);

  const activeAlerts = useMemo(() => buildAlerts(snapshot, plants, settings), [snapshot, plants, settings]);
  const unreadCount = activeAlerts.filter((alert) => !settings.acknowledgedAlerts.includes(alert.id)).length;
  const acknowledge = (id: string) => updateSettings((current) => ({ ...current, acknowledgedAlerts: [...new Set([...current.acknowledgedAlerts, id])] }));
  const acknowledgeAll = () => updateSettings((current) => ({ ...current, acknowledgedAlerts: [...new Set([...current.acknowledgedAlerts, ...activeAlerts.map((alert) => alert.id)])] }));

  useEffect(() => {
    const activeIds = new Set(activeAlerts.map((alert) => alert.id));
    const retained = settings.acknowledgedAlerts.filter((id) => activeIds.has(id));
    if (retained.length !== settings.acknowledgedAlerts.length) updateSettings((current) => ({ ...current, acknowledgedAlerts: retained }));
  }, [activeAlerts, settings.acknowledgedAlerts, updateSettings]);

  const screenStatus = !firebaseConfigured
    ? "PotBuddy sign-in is not set up yet. Please check the app setup."
    : authState === "loading" ? "Signing in..."
    : authState === "error" ? (authError ?? "Could not sign in. Please try again.")
    : !apiConfigured ? "PotBuddy cannot reach the watering service. Check your connection and try again."
    : dataError ?? settingsError;

  const screenTitles: Record<Tab, string> = { Home: "PotBuddy", Plants: "My Plants", Watering: "Watering", History: "History", Settings: "Settings", Alerts: "Alerts" };
  return <SafeAreaProvider>
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.brandMark}><Ionicons name="leaf-outline" size={23} color="white" /></View>
        <Text style={styles.brand}>{screenTitles[tab]}</Text>
        <View style={styles.headerSpacer} />
        <View style={[styles.connectionPill, snapshot?.online ? styles.connectionOnline : styles.connectionOffline]}><View style={[styles.connectionDot, snapshot?.online && styles.connectionDotOnline]} /><Text style={[styles.connectionText, snapshot?.online && styles.connectionTextOnline]}>{snapshot?.online ? "Device" : "Offline"}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`${unreadCount} unread alerts`} onPress={() => setTab("Alerts")} style={styles.bell}><Ionicons name="notifications-outline" size={22} color="#1d2e25" />{unreadCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text></View>}</Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {screenStatus && <View style={styles.notice}><Text style={styles.noticeText}>{screenStatus}</Text></View>}
        {tab === "Home" && <HomeScreen snapshot={snapshot} plants={plants} profiles={settings.profiles} requests={settings.requests} loading={loading} onRefresh={() => void refresh()} onOpenPlants={() => setTab("Plants")} onOpenWatering={() => setTab("Watering")} onOpenHistory={() => setTab("History")} />}
        {tab === "Plants" && <PlantsScreen snapshot={snapshot} plants={plants} settings={settings} requests={settings.requests} onSaveProfile={updateProfile} onWater={(potId) => void sendWater(potId)} onStop={(potId) => void sendStop(potId)} controllerOnline={snapshot?.online === true} brokerOnline={backend?.mqttConnected === true} reservoirAvailable={snapshot?.reservoirAvailable} sending={sendingPotId !== null} />}
        {tab === "Watering" && <WaterScreen plants={plants} settings={settings} online={snapshot?.online === true} brokerOnline={backend?.mqttConnected === true} reservoirAvailable={snapshot?.reservoirAvailable} sendingPotId={sendingPotId} wateringSecondsByPot={wateringSecondsByPot} message={commandMessage} onWater={(potId) => void sendWater(potId)} onStop={(potId) => void sendStop(potId)} onOpenSettings={() => setTab("Settings")} />}
        {tab === "Settings" && <SettingsScreen
          plants={plants}
          settings={settings}
          deviceOnline={snapshot?.online === true}
          brokerOnline={backend?.mqttConnected === true}
          reservoirAvailable={snapshot?.reservoirAvailable}
          deviceConfigError={deviceConfigError}
          onToggleAuto={(enabled) => updateSettings((current) => ({ ...current, autoWaterEnabled: enabled }))}
          onSetDuration={(duration) => updateSettings((current) => ({ ...current, pulseDurationSeconds: duration }))}
          onSetMaximumRuntime={(seconds) => updateSettings((current) => ({ ...current, maximumRuntimeSeconds: seconds }))}
          onSetCheckInterval={(seconds) => updateSettings((current) => ({ ...current, checkIntervalSeconds: seconds }))}
          onSetTemperatureLimit={(limit) => updateSettings((current) => ({ ...current, temperatureAlertC: limit }))}
          onToggleLowAlerts={(enabled) => updateSettings((current) => ({ ...current, lowMoistureAlerts: enabled }))}
          onToggleReservoirAlerts={(enabled) => updateSettings((current) => ({ ...current, lowReservoirAlerts: enabled }))}
          onToggleOfflineAlerts={(enabled) => updateSettings((current) => ({ ...current, deviceOfflineAlerts: enabled }))}
          onSaveProfile={updateProfile}
        />}
        {tab === "History" && <HistoryScreen snapshot={snapshot} plants={plants} names={Object.fromEntries(Object.entries(settings.profiles).map(([id, profile]) => [id, profile.name]))} />}
        {tab === "Alerts" && <AlertsScreen alerts={activeAlerts} acknowledged={settings.acknowledgedAlerts} onAcknowledge={acknowledge} onAcknowledgeAll={acknowledgeAll} />}
      </ScrollView>

      <View style={styles.tabBar}>{tabs.map((item) => {
        const active = tab === item.key;
        return <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => setTab(item.key)} style={[styles.tabButton, active && styles.tabButtonActive]}><Ionicons name={active ? item.activeIcon : item.icon} size={21} color={active ? "#216b4a" : "#7c887f"} /><Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.key}</Text></Pressable>;
      })}</View>
    </SafeAreaView>
  </SafeAreaProvider>;
}

function buildAlerts(snapshot: DeviceSnapshot | null, plants: ReturnType<typeof getObservedPots>, settings: AppSettings): PotBuddyAlert[] {
  const alerts: PotBuddyAlert[] = [];
  if (settings.lowReservoirAlerts && snapshot?.reservoirAvailable === false) {
    alerts.push({ id: alertKey("reservoir", snapshot.deviceId, "empty"), title: "Water tank is empty", body: "Refill the tank before watering your plants.", createdAt: snapshot.lastSeenAt ?? Date.now(), severity: "critical" });
  }
  if (settings.deviceOfflineAlerts && snapshot && snapshot.lastSeenAt !== null && !snapshot.online) {
    alerts.push({ id: alertKey("offline", snapshot.deviceId, "active"), title: "Watering device is offline", body: "The device has stopped sending updates. Check that it has power and is connected to Wi-Fi.", createdAt: snapshot.lastSeenAt, severity: "critical" });
  }
  for (const plant of plants) {
    const profile = getPlantProfile(settings, plant.potId);
    if (settings.lowMoistureAlerts && plant.moisturePct !== undefined && profile.startBelowPct !== null && plant.moisturePct < profile.startBelowPct) {
      alerts.push({ id: alertKey("moisture", plant.potId, "active"), title: `${profile.name || plant.potId} needs water`, body: `Soil moisture is ${plant.moisturePct.toFixed(1)}%, below the ${profile.startBelowPct}% level you chose.`, createdAt: plant.receivedAt, severity: "warning" });
    }
    if (settings.temperatureAlertC !== null && plant.temperatureC !== undefined && plant.temperatureC > settings.temperatureAlertC) {
      alerts.push({ id: alertKey("temperature", plant.potId, "active"), title: `It is warm near ${profile.name || plant.potId}`, body: `The temperature is ${plant.temperatureC.toFixed(1)}°C, above the ${settings.temperatureAlertC}°C level you chose.`, createdAt: plant.receivedAt, severity: "warning" });
    }
  }
  return alerts.sort((a, b) => b.createdAt - a.createdAt);
}

function getAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("api-key-not-valid")) return "PotBuddy sign-in could not start. Please check the app setup.";
  return "Could not sign in. Please check your connection and try again.";
}

function getFriendlyCommandError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("wait a few seconds")) return "Please wait a few seconds before watering again.";
  if (message.includes("reservoir") || message.includes("water tank")) return "The water tank is empty. Refill it before watering.";
  if (message.includes("device is offline") || message.includes("controller is offline")) return "The watering device is offline. Check its power and Wi-Fi.";
  if (message.includes("broker") || message.includes("mqtt")) return "The watering service is disconnected. Please try again in a moment.";
  if (message.includes("not authorized")) return "This watering device is not set up for your account.";
  return fallback;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f7f2" },
  header: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 9, flexDirection: "row", alignItems: "center", backgroundColor: "#f5f7f2", gap: 9 },
  brandMark: { width: 40, height: 40, borderRadius: 15, backgroundColor: "#216b4a", alignItems: "center", justifyContent: "center" },
  brand: { color: "#1c2a22", fontSize: 19, fontWeight: "800", letterSpacing: -0.5 },
  headerSpacer: { flex: 1 },
  connectionPill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 24, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#f1e9d7" },
  connectionOnline: { backgroundColor: "#d9f1e2" },
  connectionOffline: { backgroundColor: "#f1e9d7" },
  connectionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#aa7629" },
  connectionDotOnline: { backgroundColor: "#28704e" },
  connectionText: { fontSize: 10, color: "#8a642c", fontWeight: "800" },
  connectionTextOnline: { color: "#216b4a" },
  bell: { width: 40, height: 40, borderRadius: 15, backgroundColor: "white", alignItems: "center", justifyContent: "center", position: "relative" },
  badge: { position: "absolute", top: -4, right: -3, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", backgroundColor: "#d94c48" },
  badgeText: { color: "white", fontSize: 8, fontWeight: "900" },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 25 },
  notice: { padding: 12, marginBottom: 12, backgroundColor: "#fff1d9", borderRadius: 14 },
  noticeText: { color: "#865a1e", fontSize: 11, lineHeight: 17, fontWeight: "600" },
  tabBar: { minHeight: 67, flexDirection: "row", alignItems: "center", justifyContent: "space-around", backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: "#e7ebe5", paddingHorizontal: 7, paddingBottom: 3 },
  tabButton: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 6, gap: 2, borderRadius: 19 },
  tabButtonActive: { backgroundColor: "#d9f2e3" },
  tabLabel: { color: "#7c887f", fontSize: 9, fontWeight: "600" },
  tabLabelActive: { color: "#216b4a", fontWeight: "800" },
});


