import { useEffect, useMemo, useState } from "react";
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { DeviceSnapshot, PlantProfile, WaterRequestRecord } from "../domain";
import { plantImages } from "../assets/plantImages";
import { SensorChart } from "../components/SensorChart";
import { Card, ScreenTitle, formatValue } from "../components/ui";
import { getPotHistory, getPlantProfile, type AppSettings, type ObservedPot } from "../services/plantData";
import { moistureState } from "./HomeScreen";

export function PlantsScreen({ snapshot, plants, settings, requests, onSaveProfile, onWater, onStop, controllerOnline, brokerOnline, reservoirAvailable, sending }: {
  snapshot: DeviceSnapshot | null;
  plants: ObservedPot[];
  settings: AppSettings;
  requests: WaterRequestRecord[];
  onSaveProfile: (potId: string, profile: PlantProfile) => void;
  onWater: (potId: string) => void;
  onStop: (potId: string) => void;
  controllerOnline: boolean;
  brokerOnline: boolean;
  reservoirAvailable: boolean | undefined;
  sending: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMoistureGuide, setShowMoistureGuide] = useState(false);
  const selectedPot = plants.find((plant) => plant.potId === selectedId);
  const profile = useMemo(() => selectedPot ? getPlantProfile(settings, selectedPot.potId) : null, [selectedPot?.potId, settings.profiles]);
  const history = useMemo(() => selectedPot && snapshot ? getPotHistory(snapshot.readings, selectedPot.potId, snapshot.deviceId) : [], [selectedPot, snapshot]);
  const lastWaterRequest = selectedPot ? [...requests].filter((request) => request.potId === selectedPot.potId).sort((a, b) => b.issuedAt - a.issuedAt)[0] : null;
  const today = new Date();
  const requestsToday = selectedPot ? requests.filter((request) => {
    const date = new Date(request.issuedAt);
    return request.potId === selectedPot.potId && date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  }).length : 0;

  if (selectedPot && profile) return <PlantDetail
    pot={selectedPot}
    profile={profile}
    history={history}
    lastWaterRequest={lastWaterRequest ?? null}
    requestsToday={requestsToday}
    controllerOnline={controllerOnline}
    brokerOnline={brokerOnline}
    reservoirAvailable={reservoirAvailable}
    wateringConfigured={settings.pulseDurationSeconds !== null && settings.maximumRuntimeSeconds !== null}
    sending={sending}
    onBack={() => setSelectedId(null)}
    onSave={(next) => onSaveProfile(selectedPot.potId, next)}
    onWater={() => onWater(selectedPot.potId)}
    onStop={() => onStop(selectedPot.potId)}
  />;

  return <>
    <ScreenTitle title="My plants" subtitle="See how each plant is doing." />
    <View style={styles.guideActionRow}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showMoistureGuide }} onPress={() => setShowMoistureGuide((open) => !open)} style={styles.guideButton}>
        <Text style={styles.guideButtonIcon}>◉</Text><Text style={styles.guideButtonText}>{showMoistureGuide ? "Close moisture guide" : "Moisture guide"}</Text><Text style={styles.guideChevron}>{showMoistureGuide ? "⌃" : "⌄"}</Text>
      </Pressable>
    </View>
    {showMoistureGuide ? <MoistureGuide /> : null}
    {plants.length === 0 ? <Card><Text style={styles.emptyTitle}>No plants found yet</Text><Text style={styles.emptyBody}>Connect a soil sensor to the watering device. Your plants will appear here when it sends a reading.</Text></Card> : plants.map((pot) => {
      const current = getPlantProfile(settings, pot.potId);
      const image = current.imageKey ? plantImages[current.imageKey] : null;
      return <Pressable key={pot.potId} accessibilityRole="button" onPress={() => setSelectedId(pot.potId)} style={styles.plantCard}>
        {image ? <Image source={image} style={styles.plantImage} resizeMode="cover" /> : <View style={styles.plantPlaceholder}><Text style={styles.placeholderLetter}>{(current.name || pot.potId).slice(0, 1).toUpperCase()}</Text></View>}
        <View style={styles.plantInfo}><Text style={styles.potId}>{pot.potId}</Text><Text style={styles.name}>{current.name}</Text><Text style={styles.species}>{current.species || "Add a plant type"}</Text><Text style={styles.state}>{moistureState(pot.moisturePct, current)}</Text><Text style={styles.cardTemperature}>Temperature · {formatValue(pot.temperatureC, "°C")}</Text></View>
        <View style={styles.moistureBox}><Text style={styles.moisture}>{formatValue(pot.moisturePct, "%")}</Text><View style={styles.track}><View style={[styles.fill, { width: `${Math.max(0, Math.min(pot.moisturePct ?? 0, 100))}%` }]} /></View><Text style={styles.open}>Details</Text></View>
      </Pressable>;
    })}
  </>;
}

const moistureGuide = [
  { id: "succulent", title: "Succulents & Cacti", start: 25, stop: 35, link: "https://highlandmoss.com/shop-2/house-plants/succulents/easy-to-care-large-cactus/", note: "Prefer dry soil between watering. Avoid keeping the soil continuously wet." },
  { id: "snake", title: "Snake Plants & ZZ Plants", start: 30, stop: 40, link: "https://www.thespruce.com/snake-plant-care-overview-1902772", note: "These plants tolerate dry soil. Let the soil dry well before watering again." },
  { id: "pothos", title: "Pothos & Philodendrons", start: 40, stop: 55, note: "Water when the soil begins to dry. Avoid leaving the roots in waterlogged soil." },
  { id: "lily", title: "Peace Lilies", start: 45, stop: 60, link: "https://600flora.ae/product/peace-lilies/", note: "Keep soil lightly moist and water before it dries out completely." },
  { id: "fern", title: "Ferns", start: 50, stop: 65, link: "https://bloomscape.com/green-living/ferns-for-every-room-in-your-home/", note: "Ferns prefer evenly moist soil. Check them often in warm, dry weather." },
];

function MoistureGuide() {
  return <View style={styles.guideCard}>
    <View style={styles.guideHeading}><View style={styles.guideHeadingCopy}><Text style={styles.guideTitle}>Plant moisture guide</Text><Text style={styles.guideIntro}>Suggested soil sensor levels for common houseplants.</Text></View></View>
    <View style={styles.levelLegend}></View>
    {moistureGuide.map((item) => {
      return <View key={item.id} style={styles.guideItem}>
        <Pressable accessibilityRole={item.link ? "link" : undefined} accessibilityLabel={`Open ${item.title} photo`} disabled={!item.link} onPress={() => item.link && void Linking.openURL(item.link)}>
          <GuidePhoto photoKey={item.id === "snake" ? "plant-3" : item.id === "fern" ? "plant-4" : item.id === "pothos" ? "plant-1" : "plant-2"} />
        </Pressable>
        <View style={styles.guideItemContent}>
          <Text style={styles.guideCategory}>{item.title}</Text>
          <View style={styles.guideThresholds}><Text style={styles.startPill}>Below {item.start}%</Text><Text style={styles.stopPill}>{item.stop}% target</Text></View>
          <Text style={styles.guideNote}>{item.note}</Text>
        </View>
      </View>;
    })}
    <Text style={styles.guideFootnote}>Sensor readings vary by soil and pot. These are starting points; adjust them to suit your plant.</Text>
  </View>;
}

function GuidePhoto({ photoKey }: { photoKey: string }) {
  return <Image source={plantImages[photoKey]!} style={styles.guideImage} resizeMode="cover" />;
}

function PlantDetail({ pot, profile, history, lastWaterRequest, requestsToday, controllerOnline, brokerOnline, reservoirAvailable, wateringConfigured, sending, onBack, onSave, onWater, onStop }: {
  pot: ObservedPot;
  profile: PlantProfile;
  history: ReturnType<typeof getPotHistory>;
  lastWaterRequest: WaterRequestRecord | null;
  requestsToday: number;
  controllerOnline: boolean;
  brokerOnline: boolean;
  reservoirAvailable: boolean | undefined;
  wateringConfigured: boolean;
  sending: boolean;
  onBack: () => void;
  onSave: (profile: PlantProfile) => void;
  onWater: () => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState(profile);
  useEffect(() => setDraft(profile), [pot.potId, profile]);
  const image = draft.imageKey ? plantImages[draft.imageKey] : null;
  const canWater = controllerOnline && brokerOnline && reservoirAvailable !== false && wateringConfigured && !sending;
  const canStop = controllerOnline && brokerOnline && !sending;

  return <>
    <Pressable onPress={onBack} style={styles.back}><Text style={styles.backText}>‹  All plants</Text></Pressable>
    <View style={styles.detailHero}>
      {image ? <Image source={image} style={styles.heroImage} resizeMode="cover" /> : <View style={[styles.heroImage, styles.plantPlaceholder]}><Text style={styles.placeholderLetter}>{(draft.name || pot.potId).slice(0, 1).toUpperCase()}</Text></View>}
      <View style={styles.heroContent}>
        <Text style={styles.detailPot}>{pot.potId}</Text>
        <TextInput value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} onEndEditing={() => onSave(draft)} placeholder="Plant name" placeholderTextColor="#879188" style={styles.nameInput} />
        <TextInput value={draft.species} onChangeText={(species) => setDraft({ ...draft, species })} onEndEditing={() => onSave(draft)} placeholder="Plant type" placeholderTextColor="#879188" style={styles.speciesInput} />
        <View style={styles.currentRow}>
          <View style={styles.currentMetric}><Text style={styles.currentLabel}>Soil moisture</Text><Text style={styles.currentValue}>{formatValue(pot.moisturePct, "%")}</Text><Text style={styles.state}>{moistureState(pot.moisturePct, draft)}</Text></View>
          <View style={[styles.currentMetric, styles.temperatureMetric]}><Text style={styles.currentLabel}>Temperature</Text><Text style={styles.temperatureValue}>{formatValue(pot.temperatureC, "°C")}</Text><Text style={styles.temperatureNote}>Around this pot</Text></View>
        </View>
        <View style={styles.trackLarge}><View style={[styles.fillLarge, { width: `${Math.max(0, Math.min(pot.moisturePct ?? 0, 100))}%` }]} /></View>
      </View>
    </View>

    <Card>
      <Text style={styles.cardTitle}>Plant photo</Text>
      <Text style={styles.help}>Choose a photo for this plant.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imageChoices}>
        {Object.entries(plantImages).map(([key, source]) => <Pressable key={key} onPress={() => { const next = { ...draft, imageKey: key }; setDraft(next); onSave(next); }} style={[styles.imageOption, draft.imageKey === key && styles.imageOptionSelected]}><Image source={source} style={styles.optionImage} /><Text style={styles.optionText}>{draft.imageKey === key ? "Selected" : "Choose"}</Text></Pressable>)}
      </ScrollView>
    </Card>

    <Card>
      <Text style={styles.cardTitle}>Watering history</Text>
      <View style={styles.statRow}><Stat label="Last watered" value={lastWaterRequest ? timeAgo(lastWaterRequest.issuedAt) : "Not yet"} /><Stat label="Times watered today" value={String(requestsToday)} /></View>
      <Text style={styles.help}>Watering activity is saved on this device.</Text>
    </Card>

    <SensorChart title="Soil moisture" unit="%" color="#21825a" readings={history} metric="moisturePct" min={0} max={100} />

    <View style={styles.controls}>
      <Pressable accessibilityRole="button" disabled={!canWater} onPress={onWater} style={[styles.waterButton, !canWater && styles.disabled]}><Text style={styles.waterText}>{sending ? "Starting..." : !wateringConfigured ? "Set watering time" : "Water now"}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={!canStop} onPress={onStop} style={[styles.stopButton, !canStop && styles.stopDisabled]}><Text style={styles.stopText}>Stop</Text></Pressable>
    </View>
  </>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function timeAgo(timestamp: number) {
  const hours = Math.floor(Math.max(0, Date.now() - timestamp) / 3_600_000);
  if (hours < 1) return "Less than an hour ago";
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} day ago`;
}

const styles = StyleSheet.create({
  guideActionRow: { alignItems: "flex-end", marginTop: -8, marginBottom: 12 },
  guideButton: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#eaf5ed", borderColor: "#d7eadd", borderWidth: 1, borderRadius: 15, paddingHorizontal: 13, paddingVertical: 10 },
  guideButtonIcon: { color: "#21825a", fontSize: 15, fontWeight: "800" },
  guideButtonText: { color: "#216b4a", fontSize: 12, fontWeight: "800" },
  guideChevron: { color: "#508466", fontSize: 15, fontWeight: "800" },
  guideCard: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e5ece5", borderRadius: 23, padding: 15, marginBottom: 14, shadowColor: "#18271e", shadowOpacity: 0.04, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  guideHeading: { flexDirection: "row", alignItems: "center", marginBottom: 15 },
  guideHeadingIcon: { width: 42, height: 42, borderRadius: 15, backgroundColor: "#e7f5ee", alignItems: "center", justifyContent: "center", marginRight: 11 },
  guideHeadingEmoji: { fontSize: 20 },
  guideHeadingCopy: { flex: 1 },
  guideTitle: { color: "#1d2e25", fontSize: 17, fontWeight: "800" },
  guideIntro: { color: "#748078", fontSize: 11, lineHeight: 16, marginTop: 3 },
  levelLegend: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "#edf0ec" },
  levelLegendText: { color: "#829087", fontSize: 9, letterSpacing: 0.55, fontWeight: "800" },
  guideItem: { flexDirection: "row", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#edf0ec" },
  guideImage: { width: 68, height: 77, borderRadius: 15, backgroundColor: "#edf3ed" },
  guideItemContent: { flex: 1, paddingLeft: 11, justifyContent: "center" },
  guideCategory: { color: "#223229", fontSize: 13, fontWeight: "800" },
  guideThresholds: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  startPill: { color: "#14804d", backgroundColor: "#e0f4e8", overflow: "hidden", borderRadius: 9, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: "800" },
  stopPill: { color: "#4c6f94", backgroundColor: "#eaf2fb", overflow: "hidden", borderRadius: 9, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: "800" },
  guideNote: { color: "#637169", fontSize: 10, lineHeight: 15, marginTop: 6 },
  guideMapping: { color: "#216b4a", fontSize: 10, fontWeight: "700", marginTop: 5 },
  guideFootnote: { color: "#89948d", fontSize: 10, lineHeight: 15, marginTop: 11 },
  emptyTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  emptyBody: { color: "#748078", fontSize: 12, lineHeight: 18, marginTop: 6 },
  plantCard: { backgroundColor: "white", borderRadius: 22, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#e8ece6", flexDirection: "row", alignItems: "center" },
  plantImage: { width: 78, height: 78, borderRadius: 18 },
  plantPlaceholder: { backgroundColor: "#e2f2e7", alignItems: "center", justifyContent: "center" },
  placeholderLetter: { color: "#216b4a", fontSize: 27, fontWeight: "800" },
  plantInfo: { flex: 1, paddingHorizontal: 12 },
  potId: { color: "#879188", fontSize: 9, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" },
  name: { color: "#1d2e25", fontSize: 15, fontWeight: "800", marginTop: 3 },
  species: { color: "#748078", fontSize: 11, marginTop: 2 },
  state: { color: "#63806d", fontSize: 10, marginTop: 6 },
  cardTemperature: { color: "#a66b35", fontSize: 10, fontWeight: "700", marginTop: 4 },
  moistureBox: { width: 73, alignItems: "center" },
  moisture: { color: "#216b4a", fontSize: 15, fontWeight: "800" },
  track: { width: 61, height: 5, borderRadius: 4, backgroundColor: "#e8eee8", marginTop: 5, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: "#27905a", borderRadius: 4 },
  open: { color: "#216b4a", fontSize: 9, fontWeight: "700", marginTop: 7 },
  back: { paddingVertical: 7, alignSelf: "flex-start" },
  backText: { color: "#216b4a", fontSize: 13, fontWeight: "800" },
  detailHero: { backgroundColor: "white", borderRadius: 24, overflow: "hidden", borderWidth: 1, borderColor: "#e8ece6", marginBottom: 13 },
  heroImage: { width: "100%", height: 175, backgroundColor: "#e2f2e7" },
  heroContent: { padding: 17 },
  detailPot: { color: "#879188", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  nameInput: { color: "#1d2e25", fontSize: 22, fontWeight: "800", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: "#edf0ec", marginTop: 3 },
  speciesInput: { color: "#748078", fontSize: 14, paddingVertical: 5 },
  currentRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 12 },
  currentMetric: { flex: 1 },
  temperatureMetric: { alignItems: "flex-end" },
  currentLabel: { color: "#748078", fontSize: 10, fontWeight: "700", marginBottom: 2 },
  currentValue: { color: "#216b4a", fontSize: 28, fontWeight: "800" },
  temperatureValue: { color: "#b16c2c", fontSize: 28, fontWeight: "800" },
  temperatureNote: { color: "#8b928d", fontSize: 10, marginTop: 6 },
  trackLarge: { width: "100%", height: 9, borderRadius: 6, backgroundColor: "#e8eee8", marginTop: 8, overflow: "hidden" },
  fillLarge: { height: "100%", backgroundColor: "#27905a", borderRadius: 6 },
  cardTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  help: { color: "#748078", fontSize: 11, lineHeight: 16, marginTop: 5 },
  imageChoices: { gap: 10, paddingTop: 12 },
  imageOption: { width: 85, padding: 4, borderWidth: 1, borderColor: "#e8ece6", borderRadius: 15, alignItems: "center" },
  imageOptionSelected: { borderColor: "#216b4a", backgroundColor: "#eff8f1" },
  optionImage: { width: 73, height: 65, borderRadius: 11 },
  optionText: { color: "#216b4a", fontSize: 9, fontWeight: "700", marginVertical: 4 },
  statRow: { flexDirection: "row", marginTop: 14 },
  stat: { flex: 1, alignItems: "center", paddingVertical: 7 },
  statValue: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  statLabel: { color: "#748078", fontSize: 10, marginTop: 4 },
  controls: { flexDirection: "row", gap: 10, marginBottom: 15 },
  waterButton: { flex: 1, backgroundColor: "#216b4a", borderRadius: 16, minHeight: 52, justifyContent: "center", alignItems: "center" },
  waterText: { color: "white", fontSize: 14, fontWeight: "800" },
  stopButton: { width: 90, backgroundColor: "#f5e5e3", borderRadius: 16, minHeight: 52, justifyContent: "center", alignItems: "center" },
  stopDisabled: { backgroundColor: "#edf0ec" },
  stopText: { color: "#a43b35", fontSize: 13, fontWeight: "800" },
  disabled: { backgroundColor: "#aab4ad" },
});

