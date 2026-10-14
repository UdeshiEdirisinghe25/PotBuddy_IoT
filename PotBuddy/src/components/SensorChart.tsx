import { useMemo } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { SensorReading } from "../domain";

type Metric = "moisturePct" | "temperatureC" | "humidityPct";
type Props = { title: string; unit: string; color: string; readings: SensorReading[]; metric: Metric; min?: number; max?: number };

export function SensorChart({ title, unit, color, readings, metric, min, max }: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = Math.max(240, screenWidth - 76);
  const chartHeight = 150;
  const graphWidth = chartWidth - 36;
  const graphHeight = chartHeight - 52;
  const values = readings.map((reading) => reading[metric]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const dataLow = values.length ? Math.min(...values) : 0;
  const dataHigh = values.length ? Math.max(...values) : 1;
  const dataRange = dataHigh - dataLow;
  const axisPadding = dataRange > 0 ? dataRange * 0.15 : Math.max(Math.abs(dataLow) * 0.05, 1);
  const axisLow = min ?? dataLow - axisPadding;
  const axisHigh = Math.max(max ?? dataHigh + axisPadding, axisLow + 1);
  const points = useMemo(() => {
    const sorted = [...readings].sort((left, right) => left.receivedAt - right.receivedAt);
    if (sorted.filter((reading) => typeof reading[metric] === "number").length < 2) return [];
    const range = axisHigh - axisLow;
    return sorted.flatMap((reading, index) => {
      const value = reading[metric];
      if (typeof value !== "number" || !Number.isFinite(value)) return [];
      const x = 30 + index * (graphWidth / Math.max(sorted.length - 1, 1));
      const y = 8 + graphHeight - ((value - axisLow) / range) * graphHeight;
      return [{ x, y, value, time: reading.receivedAt }];
    });
  }, [readings, metric, axisLow, axisHigh, graphWidth, graphHeight]);
  const latest = points.at(-1);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View><Text style={styles.title}>{title}</Text><Text style={styles.caption}>Recent readings</Text></View>
        <Text style={[styles.latest, { color }]}>{latest ? `${latest.value.toFixed(1)}${unit}` : "Not available"}</Text>
      </View>
      {points.length < 2 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>A trend will appear when there are more readings.</Text></View>
      ) : (
        <View style={{ width: chartWidth, height: chartHeight }}>
          {[0, 1, 2, 3].map((row) => {
            const y = 10 + row * (graphHeight / 3);
            const label = (axisHigh - ((axisHigh - axisLow) * row) / 3).toFixed(0);
            return <View key={row} style={[styles.gridRow, { top: y }]}><Text style={styles.axis}>{label}</Text><View style={styles.gridLine} /></View>;
          })}
          {points.slice(1).map((point, index) => {
            const previous = points[index]!;
            const dx = point.x - previous.x;
            const dy = point.y - previous.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) * (180 / Math.PI);
            return <View key={`line-${index}`} style={[styles.segment, { width: length, left: (previous.x + point.x - length) / 2, top: (previous.y + point.y) / 2, backgroundColor: color, transform: [{ rotate: `${angle}deg` }] }]} />;
          })}
          {points.map((point, index) => <View key={`point-${index}`} style={[styles.dot, { left: point.x - 4, top: point.y - 4, backgroundColor: color }]} />)}
          <View style={styles.xLabels}><Text numberOfLines={1} style={[styles.axis, styles.xAxisLabel]}>{formatTime(points[0]!.time)}</Text><Text numberOfLines={1} style={[styles.axis, styles.xAxisLabel, styles.xAxisLabelRight]}>{formatTime(latest!.time)}</Text></View>
        </View>
      )}
    </View>
  );
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 23, borderWidth: 1, borderColor: "#e8ece6", padding: 17, marginBottom: 14, overflow: "hidden" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  caption: { color: "#879188", fontSize: 11, marginTop: 3 },
  latest: { fontSize: 18, fontWeight: "800" },
  empty: { height: 110, alignItems: "center", justifyContent: "center" },
  emptyText: { color: "#879188", fontSize: 12 },
  gridRow: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", height: 1 },
  axis: { width: 27, color: "#89948c", fontSize: 9 },
  xAxisLabel: { width: undefined, flexShrink: 1 },
  xAxisLabelRight: { textAlign: "right" },
  gridLine: { height: 1, flex: 1, backgroundColor: "#edf0ec" },
  segment: { position: "absolute", height: 3, borderRadius: 2 },
  dot: { position: "absolute", width: 8, height: 8, borderWidth: 2, borderColor: "white", borderRadius: 5 },
  xLabels: { position: "absolute", bottom: 0, left: 29, right: 5, flexDirection: "row", justifyContent: "space-between" },
});

