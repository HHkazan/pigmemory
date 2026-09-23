import type {
  ProactiveInteractionDTO,
  UserDailyMemoryDTO,
  UserProfileFactDTO,
} from "../../agent-contract/dto.js";
import type { OwnerFields } from "../runtime/namespace.js";

export interface UserContextInboxRow extends OwnerFields {
  id: string;
  subjectId: string;
  sessionId: string;
  episodeId: string | null;
  traceId: string | null;
  localDate: string;
  ts: number;
  userText: string;
  agentText: string;
  context: Record<string, unknown>;
  processedAt: number | null;
  createdAt: number;
}

export interface UserProfileFactRow extends UserProfileFactDTO {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
}

export interface UserDailyMemoryRow extends UserDailyMemoryDTO {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
}

export interface ProactiveInteractionRow extends ProactiveInteractionDTO {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
  claimToken: string | null;
  leaseExpiresAt: number | null;
}

export interface UserProfileJobRow extends OwnerFields {
  subjectId: string;
  memoryDate: string;
  status: "running" | "completed" | "failed";
  attempts: number;
  startedAt: number | null;
  completedAt: number | null;
  leaseExpiresAt: number | null;
  error: string | null;
  model: string | null;
  stats: Record<string, unknown>;
  updatedAt: number;
}

export interface UserProfileOwnerSubject extends OwnerFields {
  subjectId: string;
}

export interface UserProfileExtraction {
  profileFacts: Array<{
    dimension: string;
    claim: string;
    evidenceKind: "explicit" | "inferred";
    confidence: number;
    evidenceInboxIds: string[];
  }>;
  summary: string;
  highlights: string[];
  events: UserDailyMemoryDTO["events"];
  openLoops: string[];
  moodSignals: string[];
  proactiveCandidate: {
    reason: string;
    message: string;
    score: number;
  } | null;
}
