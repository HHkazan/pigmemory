import type { EpochMs } from "../types.js";

export interface RelayItem {
  id: string;
  payload: string;
  receivedAt: EpochMs;
}

export interface LocationSample {
  id: string;
  relayItemId: string;
  deviceId: string;
  sampledAt: EpochMs;
  receivedAt: EpochMs;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  quality: "accepted" | "inaccurate" | "out_of_order";
  processedAt: EpochMs;
}

export interface LocationDeviceState {
  deviceId: string;
  currentVisitId: string | null;
  anchorLatitude: number | null;
  anchorLongitude: number | null;
  anchorSampleCount: number;
  candidateStartedAt: EpochMs | null;
  departureAnchorLatitude: number | null;
  departureAnchorLongitude: number | null;
  departureStartedAt: EpochMs | null;
  departureSampleCount: number;
  lastSampleAt: EpochMs | null;
  updatedAt: EpochMs;
}

export interface SemanticPlace {
  id: string;
  name: string | null;
  city: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface LocationVisit {
  id: string;
  deviceId: string;
  placeId: string;
  placeName: string | null;
  city: string | null;
  arrivedAt: EpochMs;
  departedAt: EpochMs | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export type LocationNotificationKind = "arrival" | "departure" | "name_prompt" | "named";

export interface LocationNotification {
  id: string;
  placeId: string;
  visitId: string;
  kind: LocationNotificationKind;
  message: string;
  dueAt: EpochMs;
  status: "pending" | "claimed" | "sent" | "failed" | "skipped";
  claimToken: string | null;
  claimedAt: EpochMs | null;
  leaseExpiresAt: EpochMs | null;
  sentAt: EpochMs | null;
  channel: string | null;
  targetId: string | null;
  externalMessageId: string | null;
  error: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface OwnTracksLocationPayload {
  _type: "location";
  lat: number;
  lon: number;
  acc?: number;
  tst: number;
  topic?: string;
  tid?: string;
}
