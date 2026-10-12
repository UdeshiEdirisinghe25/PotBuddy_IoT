
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type {
  DeviceSnapshot,
  PlantProfile,
  WaterRequestRecord,
} from "../domain";
import type { ObservedPot } from "../services/plantData";
import { Card, MetricTile, SectionTitle, formatValue } from "../components/ui";

export function HomeScreen({
  snapshot,
  plants,
  profiles,
  requests,
  loading,
  onRefresh,
  onOpenPlants,
  onOpenWatering,
  onOpenHistory,
}: {
  snapshot: DeviceSnapshot | null;
  plants: ObservedPot[];
  profiles: Record<string, PlantProfile>;
  requests: WaterRequestRecord[];
  loading: boolean;
  onRefresh: () => void;
  onOpenPlants: () => void;
  onOpenWatering: () => void;
  onOpenHistory: () => void;
}) {
  const hour = new Date().getHours();
  const greeting =
    hour < 12
      ? "Good morning"
      : hour < 18
        ? "Good afternoon"
        : "Good evening";

  const moisture = plants
    .map((plant) => plant.moisturePct)
    .filter((value): value is number => typeof value === "number");

  const temperatures = plants
    .map((plant) => plant.temperatureC)
    .filter((value): value is number => typeof value === "number");



  const avgMoisture = moisture.length
    ? moisture.reduce((sum, value) => sum + value, 0) / moisture.length
    : undefined;

  const averagePotTemperature = temperatures.length
    ? temperatures.reduce((sum, value) => sum + value, 0) /
      temperatures.length
    : undefined;
  // Controllers may report one ambient temperature at the top level while
  // reporting soil moisture under `pots`. In that payload shape, temperature
  // is not attached to an individual ObservedPot, so use the device reading.
  const deviceTemperature = snapshot?.latest?.temperatureC;
  const avgTemperature = averagePotTemperature ?? (
    typeof deviceTemperature === "number" && Number.isFinite(deviceTemperature)
      ? deviceTemperature
      : undefined
  );


  const activePumps = plants.filter(
    (plant) => plant.pumpState === "running",
  ).length;

  const pumpKnown =
    plants.length > 0 &&
    plants.every((plant) => plant.pumpState !== undefined);

  const lastRequest = [...requests].sort(
    (a, b) => b.issuedAt - a.issuedAt,
  )[0];

  return (
    <>
      <View style={styles.greetingRow}>
        <View style={styles.greetingCopy}>
          <Text style={styles.greeting}>
            {greeting}, plant parent
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh plant information"
          onPress={onRefresh}
          style={styles.refresh}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#216b4a" />
          ) : (
            <Text style={styles.refreshText}>Refresh</Text>
          )}
        </Pressable>
      </View>

      <View
        style={[
          styles.deviceBanner,
          snapshot?.online
            ? styles.deviceBannerOn
            : styles.deviceBannerOff,
        ]}
      >
        <View
          style={[
            styles.dot,
            snapshot?.online && styles.dotOn,
          ]}
        />
        <View style={styles.bannerCopy}>
          <Text style={styles.bannerTitle}>
            {snapshot?.online
              ? "Watering device connected"
              : snapshot
                ? "Watering device is offline"
                : "Waiting for watering device"}
          </Text>
          <Text style={styles.bannerBody}>
            {snapshot?.lastSeenAt
              ? `Last update ${timeAgo(snapshot.lastSeenAt)}`
              : "Plant information will appear when the watering device sends an update."}
          </Text>
        </View>
      </View>

      <View style={styles.metrics}>
        <MetricTile
          icon="water-outline"
          tint="#d8f2e3"
          label="Average soil moisture"
          value={formatValue(avgMoisture)}
          unit="%"
          note={
            moisture.length
              ? `Average for ${moisture.length} ${moisture.length === 1 ? "plant" : "plants"}`
              : "No soil readings yet"
          }
        />

        <MetricTile
          icon="thermometer-outline"
          tint="#fff0d0"
          label="Temperature"
          value={formatValue(avgTemperature)}
          unit="°C"
          note={averagePotTemperature !== undefined ? "Average for your plants" : "From your watering device"}
        />

        <MetricTile
          icon="beaker-outline"
          tint="#f8e4dc"
          label="Water reservoir"
          value={
            snapshot?.reservoirLevelPct !== undefined
              ? `${snapshot.reservoirLevelPct}%`
              : snapshot?.reservoirAvailable === undefined
              ? "Not available"
              : snapshot.reservoirAvailable
                ? "Available"
                : "Empty"
          }
          note="From your watering device"
        />

        <MetricTile
          icon="hardware-chip-outline"
          tint="#e2f2e7"
          label="Pumps running"
          value={pumpKnown ? String(activePumps) : "Not available"}
          note={
            pumpKnown
              ? "From your watering device"
              : "Status not available yet"
          }
        />
      </View>

      <SectionTitle
        title="My plants"
        action="View all"
        onAction={onOpenPlants}
      />

      {plants.length === 0 ? (
        <Card>
          <Text style={styles.emptyTitle}>
            No plants found yet
          </Text>
          <Text style={styles.emptyBody}>Your plants will appear here after the watering device sends their soil readings.</Text>
        </Card>
      ) : (
        plants.map((plant) => {
          const profile = profiles[plant.potId];

          return (
            <Pressable
              key={plant.potId}
              onPress={onOpenPlants}
              style={styles.plantRow}
            >
              <View style={styles.plantAvatar}>
                <Text style={styles.avatarText}>
                  {(profile?.name || plant.potId)
                    .slice(0, 1)
                    .toUpperCase()}
                </Text>
              </View>

              <View style={styles.plantCopy}>
                <Text style={styles.plantName}>
                  {profile?.name || plant.potId}
                </Text>
                <Text style={styles.plantSpecies}>
                  {profile?.species || plant.potId}
                </Text>
                <Text style={styles.plantState}>
                  {moistureState(plant.moisturePct, profile)}
                </Text>
              </View>

              <View style={styles.moistureValue}>
                <Text style={styles.moistureNumber}>
                  {formatValue(plant.moisturePct, "%")}
                </Text>
                <Ionicons name="chevron-forward" size={18} color="#78867d" />
              </View>
            </Pressable>
          );
        })
      )}

      <SectionTitle
        title="Recent watering"
        action="History"
        onAction={onOpenHistory}
      />

      <Card>
        {lastRequest ? (
          <>
            <Text style={styles.cardTitle}>
              {profiles[lastRequest.potId]?.name ||
                lastRequest.potId}
            </Text>
            <Text style={styles.cardBody}>
              Asked to water for {lastRequest.durationSeconds} sec
              {" · "}
              {timeAgo(lastRequest.issuedAt)}
            </Text>
            <Text style={styles.disclaimer}>
              Pump status updates when the watering device sends a reading.
            </Text>
          </>
        ) : (
          <Text style={styles.cardBody}>
            No watering activity yet.
          </Text>
        )}

        <Pressable
          onPress={onOpenWatering}
          style={styles.waterLink}
        >
          <Text style={styles.waterLinkText}>
            Water a plant
          </Text>
        </Pressable>
      </Card>
    </>
  );
}

export function moistureState(
  value: number | undefined,
  profile?: PlantProfile,
) {
  if (value === undefined) return "No moisture reading";

  if (
    profile?.startBelowPct != null &&
    value < profile.startBelowPct
  ) {
    return "Soil is drier than your chosen level";
  }

  if (
    profile?.targetPct != null &&
    value >= profile.targetPct
  ) {
    return "Your target moisture is reached";
  }

  if (profile?.startBelowPct != null) {
    return "Soil moisture is in your chosen range";
  }

  return "Choose soil moisture levels";
}

function timeAgo(timestamp: number) {
  const mins = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60_000),
  );

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;

  return `${Math.floor(hours / 24)} day ago`;
}

const styles = StyleSheet.create({
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 17,
  },
  greetingCopy: { flex: 1, paddingRight: 8 },
  greeting: {
    color: "#1d2e25",
    fontSize: 23,
    lineHeight: 29,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  subtitle: {
    color: "#748078",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  refresh: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  refreshText: {
    color: "#216b4a",
    fontSize: 11,
    fontWeight: "700",
  },
  deviceBanner: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    borderRadius: 18,
    padding: 15,
    marginBottom: 13,
  },
  deviceBannerOn: { backgroundColor: "#dff3e6" },
  deviceBannerOff: { backgroundColor: "#fff1d9" },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#b37b2b",
  },
  dotOn: { backgroundColor: "#267449" },
  bannerCopy: { flex: 1 },
  bannerTitle: {
    color: "#24593e",
    fontSize: 13,
    fontWeight: "800",
  },
  bannerBody: {
    color: "#6c8274",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  emptyTitle: {
    color: "#1d2e25",
    fontSize: 15,
    fontWeight: "800",
  },
  emptyBody: {
    color: "#748078",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  plantRow: {
    backgroundColor: "white",
    padding: 13,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#e8ece6",
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  plantAvatar: {
    width: 48,
    height: 48,
    borderRadius: 17,
    backgroundColor: "#e2f2e7",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#216b4a",
    fontSize: 18,
    fontWeight: "800",
  },
  plantCopy: { flex: 1, paddingHorizontal: 12 },
  plantName: {
    color: "#1d2e25",
    fontSize: 14,
    fontWeight: "800",
  },
  plantSpecies: {
    color: "#748078",
    fontSize: 11,
    marginTop: 2,
  },
  plantState: {
    color: "#63806d",
    fontSize: 10,
    marginTop: 4,
  },
  moistureValue: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  moistureNumber: {
    color: "#216b4a",
    fontSize: 14,
    fontWeight: "800",
  },
  cardTitle: {
    color: "#1d2e25",
    fontSize: 15,
    fontWeight: "800",
  },
  cardBody: {
    color: "#748078",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  disclaimer: {
    color: "#89948d",
    fontSize: 10,
    lineHeight: 15,
    marginTop: 9,
  },
  waterLink: { alignSelf: "flex-start", paddingTop: 13 },
  waterLinkText: {
    color: "#216b4a",
    fontSize: 12,
    fontWeight: "800",
  },
});
