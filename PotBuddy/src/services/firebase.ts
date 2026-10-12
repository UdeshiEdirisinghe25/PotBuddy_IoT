
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  initializeAuth,
  signInAnonymously,
  type Auth,
  type Persistence,
} from "firebase/auth";
import * as FirebaseAuth from "firebase/auth";

function readExpoValue(value: string | undefined): string {
  let normalized = (value ?? "").trim().replace(/,\s*$/, "");
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

const firebaseConfig = {
  apiKey: readExpoValue(process.env["EXPO_PUBLIC_FIREBASE_API_KEY"]),
  authDomain: readExpoValue(process.env["EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN"]),
  projectId: readExpoValue(process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"]),
  appId: readExpoValue(process.env["EXPO_PUBLIC_FIREBASE_APP_ID"]),
};


export const firebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.length > 0
);

const firebaseApp: FirebaseApp | null = firebaseConfigured
  ? getApps().length ? getApp() : initializeApp(firebaseConfig)
  : null;

const getRNPersistence = (
  FirebaseAuth as typeof FirebaseAuth & {
    getReactNativePersistence: (storage: typeof AsyncStorage) => Persistence;
  }
).getReactNativePersistence;

let firebaseAuth: Auth | null = null;

if (firebaseApp && Platform.OS === "web") {
  firebaseAuth = getAuth(firebaseApp);
} else if (firebaseApp) {
  try {
    if (typeof getRNPersistence !== "function") {
      throw new Error("Firebase Auth did not load its React Native entry point. Restart Metro with a cleared cache.");
    }
    firebaseAuth = initializeAuth(firebaseApp, {
      persistence: getRNPersistence(AsyncStorage),
    });
  } catch (error) {
    // Fast Refresh can evaluate this module again after Auth was initialized.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "auth/already-initialized"
    ) {
      firebaseAuth = getAuth(firebaseApp);
    } else {
      throw error;
    }
  }
}

export async function ensureAnonymousSession(): Promise<void> {
  if (!firebaseConfigured || !firebaseAuth) {
    throw new Error("Check your Firebase configuration.");
  }

  if (!firebaseAuth.currentUser) {
    await signInAnonymously(firebaseAuth);
  }
}

export async function getApiToken(): Promise<string> {
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured.");
  }
  const user = firebaseAuth.currentUser;

  if (!user) {
    throw new Error("Firebase sign-in is not ready yet.");
  }

  return user.getIdToken();
}

export function getCurrentUserId(): string | null {
  return firebaseAuth?.currentUser?.uid ?? null;
}
