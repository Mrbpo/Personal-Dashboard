export type Urgency = "urgent" | "soon" | "upcoming" | "review";
export type CanvasStatus =
  | "due_today"
  | "due_soon"
  | "upcoming"
  | "overdue_open"
  | "locked"
  | "not_open"
  | "completed"
  | "possibly_superseded"
  | "needs_review";

export type LearningTask = {
  id: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  sourceType: string;
  sourceId: string;
  sourceUrl: string | null;
  title: string;
  action: string;
  requirements: string[];
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  canvasStatus: CanvasStatus;
  localStatus: "active" | "completed" | "ignored";
  urgency: Urgency;
  confidence: "certain" | "inferred";
  evidence: string;
  estimatedMinutes: number | null;
  updatedAt: string;
};

export type CanvasSource = {
  id: string;
  courseId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  body: string;
  sourceUrl: string | null;
  updatedAt: string | null;
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  submissionState?: string | null;
  submittedAt?: string | null;
  pointsPossible?: number | null;
  file?: { url: string; name: string; size: number; contentType: string } | null;
};

export type ExtractedAnalysis = {
  summary: string;
  actions: Array<{
    title: string;
    action: string;
    requirements: string[];
    inferredDueAt: string | null;
    confidence: "certain" | "inferred";
    evidence: string;
    estimatedMinutes: number | null;
    possiblyCancelled: boolean;
  }>;
  notes: string[];
};
