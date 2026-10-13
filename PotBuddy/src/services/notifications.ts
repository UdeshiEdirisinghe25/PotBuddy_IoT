import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function getPotBuddyPushToken(devicePushToken?: Notifications.DevicePushToken): Promise<string | null> {
  if (Platform.OS === "web") return null;
  if (Constants.appOwnership === "expo") return null;

  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.["eas"]?.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("alerts", {
      name: "Plant alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#21825a",
    });
  }

  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return null;

  const result = await Notifications.getExpoPushTokenAsync({ projectId, ...(devicePushToken ? { devicePushToken } : {}) });
  return result.data;
}
