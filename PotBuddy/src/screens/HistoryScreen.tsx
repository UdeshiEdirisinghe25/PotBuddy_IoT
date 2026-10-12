import { StyleSheet, Text, View } from "react-native";
import type { SensorReading, DeviceSnapshot } from "../domain";
import { SensorChart } from "../components/SensorChart";
import { Card, ScreenTitle, formatValue } from "../components/ui";
import { getPotHistory, type ObservedPot } from "../services/plantData";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
type MetricKey = "moisturePct" | "temperatureC" ;

export function HistoryScreen({ snapshot, plants, names }: { snapshot: DeviceSnapshot | null; plants: ObservedPot[]; names: Record<string, string> }) {
  const now = Date.now();
  const thisWeekStart = now - WEEK_MS;
  const previousWeekStart = now - 2 * WEEK_MS;
  const samples = dedupeSamples(snapshot?.readings ?? [], snapshot?.latest ?? null);
  const weekLabel = `${new Date(thisWeekStart).toLocaleDateString()} – ${new Date(now).toLocaleDateString()}`;
  const previousWeekLabel = `${new Date(previousWeekStart).toLocaleDateString()} – ${new Date(thisWeekStart).toLocaleDateString()}`;

  return <>
    <ScreenTitle title="History" subtitle="See how your plants have changed over time." />
    <View style={styles.summary}><View><Text style={styles.number}>{samples.length}</Text><Text style={styles.label}>readings available</Text></View><View style={styles.summaryDivider} /><View style={styles.summaryHint}><Text style={styles.summaryHintTitle}>Your plant data</Text><Text style={styles.note}>Based on updates from your watering device.</Text></View></View>
    {!snapshot || samples.length === 0 ? <Card><Text style={styles.emptyTitle}>No history yet</Text><Text style={styles.emptyBody}>Your charts will appear here after the watering device sends its first readings.</Text></Card> : plants.length === 0 ? <Card><Text style={styles.emptyTitle}>No plant readings found</Text><Text style={styles.emptyBody}>The watering device needs to send soil readings for each plant.</Text></Card> : plants.map((plant) => {
      const history = getPotHistory(samples, plant.potId, snapshot.deviceId);
      const thisWeek = history.filter((reading) => reading.receivedAt >= thisWeekStart && reading.receivedAt <= now);
      const previousWeek = history.filter((reading) => reading.receivedAt >= previousWeekStart && reading.receivedAt < thisWeekStart);
      const latest = thisWeek[thisWeek.length - 1];
      return <View key={plant.potId}>
        <View style={styles.plantHeading}><View style={styles.plantMark}><Text style={styles.plantMarkText}>{(names[plant.potId] || plant.potId).slice(0, 1).toUpperCase()}</Text></View><View style={styles.plantHeadingCopy}><Text style={styles.potTitle}>{names[plant.potId] || plant.potId}</Text><Text style={styles.plantId}>{plant.potId}</Text></View><View style={styles.sampleBadge}><Text style={styles.sampleBadgeValue}>{thisWeek.length}</Text><Text style={styles.sampleBadgeLabel}>readings this week</Text></View></View>
        <SensorChart title="Soil moisture" unit="%" color="#21825a" readings={thisWeek} metric="moisturePct" min={0} max={100} />
        {thisWeek.some((reading) => reading.temperatureC !== undefined) && <SensorChart title="Temperature" unit="°C" color="#d78a32" readings={thisWeek} metric="temperatureC" />}

        <Card style={styles.periodCard}>
          <View style={styles.periodHeader}><View><Text style={styles.periodTitle}>Past 7 days details</Text><Text style={styles.periodDate}>{weekLabel}</Text></View><View style={styles.periodTag}><Text style={styles.periodTagText}>DETAILS</Text></View></View>
          <Text style={styles.periodBody}>{thisWeek.length} {thisWeek.length === 1 ? "reading" : "readings"}{latest ? ` · Latest ${new Date(latest.receivedAt).toLocaleString()}` : ""}</Text>
          <MetricSummary readings={thisWeek} />
          {!thisWeek.length && <Text style={styles.emptyBody}>No readings in this period.</Text>}
        </Card>
        <Card style={styles.previousCard}>
          <View style={styles.periodHeader}><View><Text style={styles.periodTitle}>Previous week</Text><Text style={styles.periodDate}>{previousWeekLabel}</Text></View><View style={styles.previousCount}><Text style={styles.previousCountNumber}>{previousWeek.length}</Text><Text style={styles.previousCountLabel}>readings</Text></View></View>
          {previousWeek.length ? <MetricSummary readings={previousWeek} compact /> : <Text style={styles.emptyBody}>No readings available for this week.</Text>}
        </Card>
        <Card style={styles.recentCard}>
          <Text style={styles.recentTitle}>Latest reading</Text>
          {history.length > 0 ? <View style={styles.sampleRow}><Text style={styles.sampleTime}>{new Date(history[history.length - 1]!.receivedAt).toLocaleString()}</Text><Text style={styles.sampleValue}>{formatValue(history[history.length - 1]!.moisturePct, "%")}</Text></View> : <Text style={styles.emptyBody}>No measurements for this pot.</Text>}
        </Card>
      </View>;
    })}
  </>;
}

function MetricSummary({ readings, compact = false }: { readings: SensorReading[]; compact?: boolean }) {
  const metrics: Array<{ key: MetricKey; label: string; unit: string }> = [
    { key: "moisturePct", label: "Moisture", unit: "%" },
    { key: "temperatureC", label: "Temperature", unit: "°C" }
  ];
  return <View style={[styles.metricRows, compact && styles.metricRowsCompact]}>
    {metrics.map(({ key, label, unit }) => {
      const values = readings.map((reading) => reading[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (values.length === 0) return null;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      return <View key={key} style={styles.metricRow}>
        <Text style={styles.metricLabel}>{label}</Text>
        <View style={styles.metricStats}><Text style={styles.metricAverage}>{formatValue(average, unit)}<Text style={styles.metricAverageLabel}> average</Text></Text><Text style={styles.metricRange}>Lowest {formatValue(Math.min(...values), unit)}  ·  Highest {formatValue(Math.max(...values), unit)}</Text></View>
      </View>;
    })}
  </View>;
}

function dedupeSamples(readings: SensorReading[], latest: SensorReading | null): SensorReading[] {
  const byTime = new Map<number, SensorReading>();
  for (const reading of readings) byTime.set(reading.receivedAt, reading);
  if (latest) byTime.set(latest.receivedAt, latest);
  return [...byTime.values()].sort((left, right) => left.receivedAt - right.receivedAt);
}

const styles = StyleSheet.create({
  summary: { minHeight: 82, padding: 15, borderRadius: 20, backgroundColor: "#e2f2e7", marginBottom: 17, flexDirection: "row", alignItems: "center", gap: 14 },
  number: { color: "#216b4a", fontSize: 24, fontWeight: "800" },
  label: { color: "#216b4a", fontSize: 10, fontWeight: "700", marginTop: 1 },
  summaryDivider: { width: 1, height: 42, backgroundColor: "#c9e2d2" },
  summaryHint: { flex: 1 },
  summaryHintTitle: { color: "#24593e", fontSize: 12, fontWeight: "800" },
  note: { color: "#648574", fontSize: 10, lineHeight: 14, marginTop: 3 },
  emptyTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  emptyBody: { color: "#748078", fontSize: 12, lineHeight: 18, marginTop: 5 },
  plantHeading: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 10 },
  plantMark: { width: 39, height: 39, borderRadius: 14, backgroundColor: "#dff1e5", alignItems: "center", justifyContent: "center" },
  plantMarkText: { color: "#216b4a", fontSize: 15, fontWeight: "800" },
  plantHeadingCopy: { flex: 1 },
  potTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  plantId: { color: "#89948d", fontSize: 10, marginTop: 2 },
  sampleBadge: { alignItems: "flex-end" },
  sampleBadgeValue: { color: "#216b4a", fontSize: 13, fontWeight: "800" },
  sampleBadgeLabel: { color: "#89948d", fontSize: 9, marginTop: 1 },
  periodCard: { paddingVertical: 15, marginBottom: 11 },
  previousCard: { paddingVertical: 14, marginBottom: 12, backgroundColor: "#fbfcfa" },
  periodHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  periodTitle: { color: "#1d2e25", fontSize: 13, fontWeight: "800" },
  periodTag: { backgroundColor: "#e5f3e9", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  periodTagText: { color: "#216b4a", fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  previousCount: { alignItems: "flex-end" },
  previousCountNumber: { color: "#557563", fontSize: 12, fontWeight: "800" },
  previousCountLabel: { color: "#89948d", fontSize: 9 },
  periodDate: { color: "#748078", fontSize: 10, marginTop: 3 },
  periodBody: { color: "#648574", fontSize: 10, lineHeight: 15, marginTop: 7 },
  metricRows: { marginTop: 11, gap: 8 },
  metricRowsCompact: { marginTop: 9 },
  metricRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: "#edf0ec", paddingTop: 8 },
  metricLabel: { color: "#748078", fontSize: 10, fontWeight: "700", width: 68 },
  metricStats: { alignItems: "flex-end", flex: 1 },
  metricAverage: { color: "#216b4a", fontSize: 12, fontWeight: "800" },
  metricAverageLabel: { color: "#89948d", fontSize: 9, fontWeight: "600" },
  metricRange: { color: "#89948d", fontSize: 9, marginTop: 2 },
  recentCard: { paddingVertical: 12 },
  recentTitle: { color: "#1d2e25", fontSize: 12, fontWeight: "800" },
  sampleRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 7 },
  sampleTime: { color: "#748078", fontSize: 10 },
  sampleValue: { color: "#216b4a", fontSize: 11, fontWeight: "800" },
});
