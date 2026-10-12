import { Pressable, StyleSheet, Text, View } from "react-native";
import { Card, ScreenTitle } from "../components/ui";

export type PotBuddyAlert = { id: string; title: string; body: string; createdAt: number; severity: "warning" | "critical" | "info" };

export function AlertsScreen({ alerts, acknowledged, onAcknowledge, onAcknowledgeAll }: { alerts: PotBuddyAlert[]; acknowledged: string[]; onAcknowledge: (id: string) => void; onAcknowledgeAll: () => void }) {
  const unread = alerts.filter((alert) => !acknowledged.includes(alert.id));
  return <>
    <View style={styles.titleRow}><View style={styles.titleCopy}><ScreenTitle title="Alerts" subtitle="Updates that may need your attention." /></View>{unread.length > 0 && <Pressable onPress={onAcknowledgeAll}><Text style={styles.action}>Mark all as read</Text></Pressable>}</View>
    {alerts.length === 0 ? <Card><Text style={styles.emptyTitle}>All clear</Text><Text style={styles.emptyBody}>We’ll let you know if a plant needs water, the temperature is too high, or the watering device goes offline.</Text></Card> : alerts.map((alert) => {
      const read = acknowledged.includes(alert.id);
      return <Card key={alert.id} style={read ? styles.readCard : undefined}>
        <View style={styles.alertHeader}><View style={[styles.badge, alert.severity === "critical" ? styles.critical : alert.severity === "warning" ? styles.warning : styles.info]}><Text style={styles.badgeText}>{alert.severity === "critical" ? "URGENT" : alert.severity === "warning" ? "CHECK THIS" : "INFO"}</Text></View><Text style={styles.time}>{new Date(alert.createdAt).toLocaleString()}</Text></View>
        <Text style={styles.alertTitle}>{alert.title}</Text><Text style={styles.alertBody}>{alert.body}</Text>
        <Pressable onPress={() => onAcknowledge(alert.id)} style={styles.acknowledge}><Text style={styles.acknowledgeText}>{read ? "Read" : "Mark as read"}</Text></Pressable>
      </Card>;
    })}``
  </>;
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "center" },
  titleCopy: { flex: 1 },
  action: { color: "#216b4a", fontSize: 11, fontWeight: "800" },
  emptyTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800" },
  emptyBody: { color: "#748078", fontSize: 12, lineHeight: 18, marginTop: 5 },
  readCard: { opacity: 0.72 },
  alertHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 },
  critical: { backgroundColor: "#fbe9e7" },
  warning: { backgroundColor: "#fff1d9" },
  info: { backgroundColor: "#e2f2f7" },
  badgeText: { color: "#75531e", fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  time: { color: "#89948d", fontSize: 9 },
  alertTitle: { color: "#1d2e25", fontSize: 15, fontWeight: "800", marginTop: 12 },
  alertBody: { color: "#748078", fontSize: 12, lineHeight: 18, marginTop: 4 },
  acknowledge: { alignSelf: "flex-end", borderRadius: 14, backgroundColor: "#d9f1e2", paddingHorizontal: 14, paddingVertical: 9, marginTop: 14 },
  acknowledgeText: { color: "#216b4a", fontSize: 11, fontWeight: "800" },
});
