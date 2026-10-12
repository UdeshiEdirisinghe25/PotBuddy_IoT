import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { PlantProfile } from "../domain";
import { Card, ScreenTitle } from "../components/ui";
import type { AppSettings, ObservedPot } from "../services/plantData";

export function SettingsScreen({ plants, settings, deviceOnline, brokerOnline, reservoirAvailable, onToggleAuto, onSetDuration, onSetMaximumRuntime, onSetCheckInterval, onSetTemperatureLimit, onToggleLowAlerts, onToggleReservoirAlerts, onToggleOfflineAlerts, onSaveProfile }: {
  plants: ObservedPot[];
  settings: AppSettings;
  deviceOnline: boolean;
  brokerOnline: boolean;
  reservoirAvailable: boolean | undefined;
  onToggleAuto: (enabled: boolean) => void;
  onSetDuration: (duration: number | null) => void;
  onSetMaximumRuntime: (seconds: number | null) => void;
  onSetCheckInterval: (seconds: number) => void;
  onSetTemperatureLimit: (limit: number | null) => void;
  onToggleLowAlerts: (enabled: boolean) => void;
  onToggleReservoirAlerts: (enabled: boolean) => void;
  onToggleOfflineAlerts: (enabled: boolean) => void;
  onSaveProfile: (potId: string, profile: PlantProfile) => void;
}) {
  const autoReady = settings.pulseDurationSeconds !== null && settings.maximumRuntimeSeconds !== null && plants.length > 0 && plants.every((plant) => {
    const profile = settings.profiles[plant.potId];
    return profile?.startBelowPct !== null && profile?.startBelowPct !== undefined && profile?.targetPct !== null && profile?.targetPct !== undefined && profile.startBelowPct < profile.targetPct;
  });

  return <>
    <ScreenTitle title="Settings" subtitle="Choose how PotBuddy cares for your plants." />
    <Text style={styles.sectionTitle}>Automatic watering</Text>
    <Card>
      <View style={styles.switchRow}><View style={styles.grow}><Text style={styles.rowTitle}>Enable automatic watering</Text><Text style={styles.help}>Checks your plants while PotBuddy is open.</Text></View><Switch value={settings.autoWaterEnabled} onValueChange={onToggleAuto} trackColor={{ false: "#d9dfda", true: "#9dc7aa" }} thumbColor={settings.autoWaterEnabled ? "#216b4a" : "#f5f5f5"} /></View>
      {settings.autoWaterEnabled && !autoReady && <Text style={styles.warning}>Automatic watering is on but not ready. Set a dry-soil level and a target for each plant, then choose how long to water it.</Text>}
      {settings.autoWaterEnabled && autoReady && (!deviceOnline || !brokerOnline || reservoirAvailable === false) && <Text style={styles.warning}>Automatic watering is paused. Make sure the watering device is online and the tank has water.</Text>}
      <NumberField label="Watering time" value={settings.pulseDurationSeconds} unit="sec" min={1} max={120} integer onSave={onSetDuration} />
      <NumberField label="Longest watering time" value={settings.maximumRuntimeSeconds} unit="sec" min={1} max={120} integer allowEmpty onSave={onSetMaximumRuntime} />
      <NumberField label="Check plants every" value={settings.checkIntervalSeconds} unit="sec" min={5} max={3600} integer onSave={(value) => { if (value !== null) onSetCheckInterval(value); }} />
      <Text style={styles.help}>Watering stops after the time you choose. Automatic watering only works while PotBuddy is open.</Text>
    </Card>

    <Text style={styles.sectionTitle}>Soil moisture levels</Text>
    {plants.length === 0 ? <Card><Text style={styles.help}>Moisture settings will appear when the watering device finds your plants.</Text></Card> : plants.map((plant) => {
      const profile = settings.profiles[plant.potId] ?? { name: plant.potId, species: "", startBelowPct: null, targetPct: null };
      return <Card key={plant.potId}>
        <Text style={styles.rowTitle}>{profile.name || plant.potId}</Text>
        <Text style={styles.help}>Current soil moisture: {formatPercent(plant.moisturePct)}</Text>
        <NumberField label="Water when below" value={profile.startBelowPct} unit="%" min={0} max={100} allowEmpty onSave={(value) => onSaveProfile(plant.potId, { ...profile, startBelowPct: value })} />
        <NumberField label="Water until it reaches" value={profile.targetPct} unit="%" min={0} max={100} allowEmpty onSave={(value) => onSaveProfile(plant.potId, { ...profile, targetPct: value })} />
        {profile.startBelowPct !== null && profile.targetPct !== null && profile.startBelowPct >= profile.targetPct && <Text style={styles.warning}>Choose a target level higher than the level that starts watering.</Text>}
      </Card>;
    })}

    <Text style={styles.sectionTitle}>Alerts</Text>
    <Card>
      <Preference label="Dry soil" detail="Alerts you when a plant drops below its chosen moisture level." value={settings.lowMoistureAlerts} onChange={onToggleLowAlerts} />
      <Preference label="Low water tank" detail="Alerts you when the tank is empty." value={settings.lowReservoirAlerts} onChange={onToggleReservoirAlerts} />
      <Preference label="Device offline" detail="Alerts you when PotBuddy can no longer reach the watering device." value={settings.deviceOfflineAlerts} onChange={onToggleOfflineAlerts} />
      <NumberField label="Temperature alert above" value={settings.temperatureAlertC} unit="°C" min={-50} max={100} onSave={onSetTemperatureLimit} allowEmpty />
      <Text style={styles.help}>Alerts appear here in PotBuddy.</Text>
    </Card>

    <Text style={styles.sectionTitle}>Connection</Text>
    <Card>
      <Connection label="Watering device" value={deviceOnline ? "Online" : "Offline"} active={deviceOnline} />
      <Connection label="Watering service" value={brokerOnline ? "Connected" : "Disconnected"} active={brokerOnline} />
      <Connection label="Water tank" value={reservoirAvailable === undefined ? "No update yet" : reservoirAvailable ? "Water available" : "Empty"} active={reservoirAvailable === true} />
      <Text style={styles.help}>Both connections need to be ready before you can water a plant.</Text>
    </Card>
  </>;
}

function NumberField({ label, value, unit, min, max, onSave, allowEmpty = false, integer = false }: { label: string; value: number | null; unit: string; min: number; max: number; onSave: (value: number | null) => void; allowEmpty?: boolean; integer?: boolean }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    if (text.trim() === "" && allowEmpty) { onSave(null); return; }
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed))) onSave(parsed);
    else setText(value === null ? "" : String(value));
  };
  return <View style={styles.fieldRow}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.inputGroup}><TextInput value={text} onChangeText={setText} onEndEditing={commit} keyboardType="numeric" placeholder="Set" placeholderTextColor="#9aa49d" style={styles.input} /><Text style={styles.unit}>{unit}</Text></View></View>;
}

function Preference({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return <View style={styles.preference}><View style={styles.grow}><Text style={styles.rowTitle}>{label}</Text><Text style={styles.help}>{detail}</Text></View><Switch value={value} onValueChange={onChange} trackColor={{ false: "#d9dfda", true: "#9dc7aa" }} thumbColor={value ? "#216b4a" : "#f5f5f5"} /></View>;
}

function Connection({ label, value, active }: { label: string; value: string; active: boolean }) {
  return <View style={styles.connection}><Text style={styles.fieldLabel}>{label}</Text><Text style={[styles.connectionValue, active && styles.active]}>{value}</Text></View>;
}

function formatPercent(value: number | undefined) { return value === undefined ? "Not available" : `${value.toFixed(1)}%`; }

const styles = StyleSheet.create({
  sectionTitle: { color: "#1d2e25", fontSize: 17, fontWeight: "800", marginTop: 8, marginBottom: 9 },
  switchRow: { flexDirection: "row", alignItems: "center", paddingBottom: 12 },
  grow: { flex: 1, paddingRight: 10 },
  rowTitle: { color: "#1d2e25", fontSize: 13, fontWeight: "800" },
  help: { color: "#748078", fontSize: 10, lineHeight: 15, marginTop: 4 },
  warning: { color: "#9a641e", fontSize: 10, lineHeight: 15, marginTop: 9 },
  fieldRow: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#edf0ec", marginTop: 7, paddingTop: 6 },
  fieldLabel: { color: "#56635b", fontSize: 11, flex: 1 },
  inputGroup: { flexDirection: "row", alignItems: "center", borderRadius: 11, backgroundColor: "#f5f7f2", paddingHorizontal: 9, minWidth: 77, justifyContent: "center" },
  input: { minWidth: 40, textAlign: "right", color: "#1d2e25", fontSize: 13, fontWeight: "700", paddingVertical: 7 },
  unit: { color: "#748078", fontSize: 10, marginLeft: 4 },
  preference: { minHeight: 55, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#edf0ec", marginBottom: 5 },
  connection: { minHeight: 36, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  connectionValue: { color: "#9a641e", fontSize: 11, fontWeight: "700" },
  active: { color: "#216b4a" },
});


