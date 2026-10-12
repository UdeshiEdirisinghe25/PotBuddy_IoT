
import type { PropsWithChildren } from "react";
import { Ionicons } from "@expo/vector-icons";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export function ScreenTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.intro}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          disabled={!onAction}
        >
          <Text style={styles.action}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type MetricTileProps = {
  label: string;
  value: string;
  unit?: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  note?: string;
};

export function MetricTile({
  label,
  value,
  unit,
  icon,
  tint,
  note,
}: MetricTileProps) {
  // Append a unit to measurements, but leave statuses as plain text.
  const displayValue =
    value === "Not available" ? value : `${value}${unit ?? ""}`;

  return (
    <View style={styles.metric}>
      <View style={[styles.icon, { backgroundColor: tint }]}>
        <Ionicons name={icon} size={19} color="#216b4a" />
      </View>

      <Text style={styles.metricLabel}>{label}</Text>

      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={styles.metricValue}
      >
        {displayValue}
      </Text>

      {note ? (
        <Text style={styles.metricNote}>{note}</Text>
      ) : null}
    </View>
  );
}

export function formatValue(
  value: number | undefined,
  unit = "",
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Not available";
  }

  return `${Number(value.toFixed(1))}${unit}`;
}

const styles = StyleSheet.create({
  intro: {
    paddingTop: 9,
    paddingBottom: 18,
  },
  title: {
    color: "#1d2e25",
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  subtitle: {
    color: "#748078",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 5,
  },
  card: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#e8ece6",
    borderRadius: 23,
    padding: 18,
    marginBottom: 14,
    shadowColor: "#18271e",
    shadowOpacity: 0.035,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  section: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 13,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 17,
    color: "#1d2e25",
    fontWeight: "800",
  },
  action: {
    color: "#216b4a",
    fontSize: 12,
    fontWeight: "700",
  },
  metric: {
    flexBasis: "47%",
    flexGrow: 1,
    minHeight: 144,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e8ece6",
    borderRadius: 22,
    padding: 15,
    shadowColor: "#18271e",
    shadowOpacity: 0.035,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  icon: {
    height: 36,
    width: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  metricLabel: {
    color: "#738078",
    fontSize: 12,
    marginTop: 11,
  },
  metricValue: {
    color: "#1d2e25",
    fontSize: 25,
    fontWeight: "800",
    marginTop: 2,
  },
  metricNote: {
    color: "#89948d",
    fontSize: 10,
    marginTop: 3,
  },
});
