import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PlantProfile } from "../domain";
import { Card, ScreenTitle, formatValue } from "../components/ui";
import type { AppSettings, ObservedPot } from "../services/plantData";

export function WaterScreen({ plants, settings, online, brokerOnline, reservoirAvailable, sendingPotId, wateringSecondsByPot, message, onWater, onStop, onOpenSettings }: {
  plants: ObservedPot[];
  settings: AppSettings;
  online: boolean;
  brokerOnline: boolean;
  reservoirAvailable: boolean | undefined;
  sendingPotId: string | null;
  wateringSecondsByPot: Record<string, number>;
  message: string | null;
  onWater: (potId: string) => void;
  onStop: (potId: string) => void;
  onOpenSettings: () => void;
}) {
  const connected = online && brokerOnline && reservoirAvailable !== false;
  const canStop = online && brokerOnline;
  const commandDuration = settings.pulseDurationSeconds === null || settings.maximumRuntimeSeconds === null ? null : Math.min(settings.pulseDurationSeconds, settings.maximumRuntimeSeconds);
  return <>
    <ScreenTitle title="Watering" subtitle="Start or stop watering for each plant." />
    <View style={[styles.connection, connected ? styles.connectionOn : styles.connectionOff]}>
      <View style={[styles.dot, connected && styles.dotOn]} /><Text style={styles.connectionText}>{!online ? "Watering device is offline" : !brokerOnline ? "Watering service is disconnected" : reservoirAvailable === false ? "Water tank is empty" : "Ready to water"}</Text>
    </View>

    <Card>
      <View style={styles.modeRow}><View style={styles.modeCopy}><Text style={styles.modeTitle}>Automatic watering</Text><Text style={styles.modeBody}>{settings.autoWaterEnabled ? "On while the app is open" : "Off"}</Text></View><View style={[styles.modeBadge, settings.autoWaterEnabled ? styles.modeBadgeOn : styles.modeBadgeOff]}><Text style={[styles.modeBadgeText, settings.autoWaterEnabled && styles.modeBadgeTextOn]}>{settings.autoWaterEnabled ? "ON" : "OFF"}</Text></View></View>
      <Text style={styles.modeNote}>When a plant gets drier than your chosen level, PotBuddy waters it once. It can water it again after the soil reaches your target level.</Text>
      <Pressable onPress={onOpenSettings}><Text style={styles.settingsLink}>Change automatic watering</Text></Pressable>
    </Card>

    <Text style={styles.sectionTitle}>Water a plant</Text>
    {plants.length === 0 ? <Card><Text style={styles.emptyTitle}>No plants found yet</Text><Text style={styles.emptyBody}>Connect a soil sensor to the watering device. Your plants will appear here when it sends a reading.</Text></Card> : plants.map((plant) => {
      const profile: PlantProfile | undefined = settings.profiles[plant.potId];
      const isSending = sendingPotId === plant.potId;
      const wateringSeconds = wateringSecondsByPot[plant.potId] ?? 0;
      return <Card key={plant.potId}>
        <View style={styles.potHeader}><View style={styles.potCopy}><Text style={styles.potName}>{profile?.name || plant.potId}</Text><Text style={styles.potDetail}>Soil moisture · {formatValue(plant.moisturePct, "%")}</Text></View><Text style={[styles.pumpState, plant.pumpState === "running" && styles.running]}>{plant.pumpState === "running" ? "Watering" : plant.pumpState === "stopped" ? "Not watering" : "Status unavailable"}</Text></View>
        <View style={styles.controls}>
          <Pressable accessibilityRole="button" disabled={!connected || commandDuration === null || isSending || wateringSeconds > 0} onPress={() => onWater(plant.potId)} style={[styles.start, (!connected || commandDuration === null || isSending || wateringSeconds > 0) && styles.disabled]}><Text style={styles.startText}>{isSending ? "Starting..." : wateringSeconds > 0 ? `Watering · ${wateringSeconds}s` : commandDuration === null ? "Set watering time" : `Water for ${commandDuration} sec`}</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={!canStop} onPress={() => onStop(plant.potId)} style={[styles.stop, !canStop && styles.stopDisabled]}><Text style={styles.stopText}>Stop</Text></Pressable>
        </View>
      </Card>;
    })}
    {message && <Card><Text style={styles.message}>{message}</Text></Card>}
    <Text style={styles.disclaimer}>PotBuddy shows the pump status when the watering device reports it.</Text>
  </>;
}

const styles = StyleSheet.create({
  connection: { flexDirection: "row", alignItems: "center", gap: 8, padding: 13, borderRadius: 15, marginBottom: 13 },
  connectionOn: { backgroundColor: "#dff3e6" },
  connectionOff: { backgroundColor: "#fff1d9" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ad762b" },
  dotOn: { backgroundColor: "#267449" },
  connectionText: { color: "#496655", fontSize: 11, fontWeight: "700" },
  modeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modeCopy: { flex: 1 },
  modeTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  modeBody: { color: "#748078", fontSize: 11, marginTop: 3 },
  modeBadge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  modeBadgeOn: { backgroundColor: "#d9f1e2" },
  modeBadgeOff: { backgroundColor: "#edf0ec" },
  modeBadgeText: { color: "#748078", fontSize: 9, fontWeight: "800" },
  modeBadgeTextOn: { color: "#216b4a" },
  modeNote: { color: "#748078", fontSize: 10, lineHeight: 15, marginTop: 10 },
  settingsLink: { color: "#216b4a", fontSize: 11, fontWeight: "800", marginTop: 12 },
  sectionTitle: { color: "#1d2e25", fontSize: 17, fontWeight: "800", marginBottom: 9 },
  emptyTitle: { color: "#1d2e25", fontSize: 14, fontWeight: "800" },
  emptyBody: { color: "#748078", fontSize: 11, lineHeight: 17, marginTop: 4 },
  potHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  potCopy: { flex: 1 },
  potName: { color: "#1d2e25", fontSize: 14, fontWeight: "800" },
  potDetail: { color: "#748078", fontSize: 10, marginTop: 3 },
  pumpState: { color: "#748078", fontSize: 10, fontWeight: "700" },
  running: { color: "#216b4a" },
  controls: { flexDirection: "row", gap: 8, marginTop: 14 },
  start: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: "#216b4a" },
  startText: { color: "white", fontSize: 12, fontWeight: "800" },
  disabled: { backgroundColor: "#aab4ad" },
  stop: { width: 72, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: "#f5e5e3" },
  stopDisabled: { backgroundColor: "#edf0ec" },
  stopText: { color: "#a43b35", fontSize: 12, fontWeight: "800" },
  message: { color: "#216b4a", fontSize: 12, lineHeight: 17 },
  disclaimer: { color: "#89948d", fontSize: 10, lineHeight: 15, paddingHorizontal: 5, marginBottom: 14 },
});

