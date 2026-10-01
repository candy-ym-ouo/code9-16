import type {
  AlbumStatus,
  AnnotationKind,
  AssetRole,
  FuzzLevel,
  GapStatus,
  HitLevel,
  InspirationStatus,
  MissReason,
  PlanStatus,
  ReminderActionKind,
  ReminderStatus,
  RouteConflictKind,
  RouteStatus,
  RouteTrigger,
  TagDomain,
  TagSource,
  TimeAnchor,
  WeatherPhenomenon,
  WindowVerdict,
} from './enums.js';
import type { PaletteColor } from './palette.js';

export interface WeatherProfile {
  cloudCoverPct?: { min: number; max: number };
  precipProbPctMax?: number;
  visibilityKmMin?: number;
  windSpeedMax?: number;
  tempC?: { min: number; max: number };
  phenomena?: WeatherPhenomenon[];
  hardRequirements?: string[];
}

export interface TimingDto {
  timeAnchor: TimeAnchor;
  anchorOffsetMin: number;
  elevationRange: number[];
  azimuthRange: number[] | null;
  azimuthTolerance: number;
  windowToleranceMin: number;
  weatherProfile: WeatherProfile;
  seasonWindow: { fromMonth: number; toMonth: number } | null;
  notes: string | null;
}

export interface WindowReasonDto {
  code: string;
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

export interface ReproWindowDto {
  id: string | null;
  inspirationId: string;
  date: string;
  startAt: string;
  endAt: string;
  anchorAt: string;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  weatherDegraded: boolean;
  stale: boolean;
  computedAt: string | null;
}

export interface TagDto {
  id: string;
  domain: TagDomain;
  parentId: string | null;
  name: string;
  slug: string;
  isBuiltin: boolean;
  disabled: boolean;
  sortOrder: number;
  usageCount: number;
  children?: TagDto[];
}

export interface PaletteDto extends PaletteColor {}

export interface AssetDto {
  id: string;
  inspirationId: string;
  role: AssetRole;
  width: number;
  height: number;
  shotAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  hasGpsExif: boolean;
  palette: PaletteColor[];
  sunElevation: number | null;
  sunAzimuth: number | null;
  weatherSnapshot: Record<string, unknown> | null;
  fileUrl: string;
  thumbUrl: string;
  createdAt: string;
}

export interface AnnotationDto {
  id: string;
  assetId: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  label: string | null;
}

export interface FuzzResult {
  fuzzLevel: FuzzLevel;
  lat: number | null;
  lng: number | null;
  geohash: string;
  label: string;
}

export interface SpotDto {
  id: string;
  placeId: string;
  placeName: string;
  city: string | null;
  district: string | null;
  tz: string;
  cameraBearing: number;
  elevationM: number | null;
  accessNote: string | null;
  bestTimeNote: string | null;
  visibility: 'private' | 'fuzzy_shared';
  /** 精确坐标：仅 owner 且仅在编辑场景返回 */
  precise: { lat: number; lng: number } | null;
  fuzz: FuzzResult;
}

export interface InspirationDto {
  id: string;
  title: string;
  note: string | null;
  status: InspirationStatus;
  seasonTags: number[];
  hitCount: number;
  partialCount: number;
  missCount: number;
  hitRate: number;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  tags: { id: string; domain: TagDomain; name: string; slug: string; source: TagSource }[];
  assets: AssetDto[];
  spot: SpotDto | null;
  timing: TimingDto | null;
  windowSummary: { nextGoodAt: string | null; goodIn30d: number } | null;
}

export interface ReminderDto {
  id: string;
  subjectType: string;
  subjectId: string;
  ruleCode: string | null;
  title: string;
  body: string | null;
  actionKind: ReminderActionKind;
  actionPayload: Record<string, unknown> | null;
  status: ReminderStatus;
  dueAt: string;
  expireAt: string | null;
  createdAt: string;
}

export interface PlanDto {
  id: string;
  inspirationId: string;
  inspirationTitle: string;
  windowId: string | null;
  plannedAt: string;
  leaveAt: string | null;
  commuteMin: number;
  companions: string | null;
  gearNote: string | null;
  status: PlanStatus;
  cancelReason: string | null;
  result: {
    id: string;
    hitLevel: HitLevel;
    missReasons: MissReason[];
    note: string | null;
    filledAt: string;
  } | null;
}

export interface AlbumGapDto {
  id: string;
  kind: 'tag' | 'anchor' | 'weather' | 'count' | 'result';
  requirement: Record<string, unknown>;
  currentCount: number;
  requiredCount: number;
  isRequired: boolean;
  status: GapStatus;
  waiveReason: string | null;
  actionLabel: string;
  actionHref: string;
}

export interface AlbumDto {
  id: string;
  title: string;
  themeNote: string | null;
  status: AlbumStatus;
  rules: Record<string, unknown>;
  itemCount: number;
  openRequiredGaps: number;
  coverThumbUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface SearchRelaxation {
  field: string;
  from: string;
  to: string;
  note: string;
}

export interface SearchResult {
  items: InspirationDto[];
  total: number;
  relaxed: SearchRelaxation[];
  suggestions?: { tagIds: string[]; tagNames: string[]; message: string } | null;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  libraryId: string;
  role: 'owner' | 'member';
}

// ---------------------------------------------------------------- 取景路线

export interface RouteStopWindowDto {
  id: string | null;
  startAt: string;
  endAt: string;
  verdict: WindowVerdict;
  weatherDegraded: boolean;
  computedAt: string | null;
}

export interface RouteStopDto {
  id: string;
  planId: string;
  inspirationId: string;
  inspirationTitle: string;
  seq: number;
  arriveAt: string | null;
  departAt: string | null;
  dwellMin: number;
  commuteFromPrevMin: number | null;
  commuteSource: 'plan' | 'estimate' | 'manual' | null;
  confirmedAt: string | null;
  /** 确认时基于的路线版本：小于当前版本说明是晚到确认（不会被应用） */
  confirmedVersion: number | null;
  window: RouteStopWindowDto | null;
}

/**
 * 冲突来源：每条时段冲突都必须能回溯到具体的窗口 / 通勤段 / 客户端操作。
 * 坐标不出现在这里（路线为 owner 私有，但距离只保留一位小数）。
 */
export type RouteConflictSource =
  | {
      type: 'window';
      stopId: string;
      inspirationTitle: string;
      windowId: string | null;
      startAt: string;
      endAt: string;
      verdict: WindowVerdict;
      computedAt: string | null;
      reasons: WindowReasonDto[];
    }
  | {
      type: 'commute';
      fromStopId: string;
      toStopId: string;
      distanceKm: number;
      minutes: number;
      source: 'plan' | 'estimate' | 'manual';
    }
  | {
      type: 'client_op';
      clientOpId: string | null;
      stopId: string;
      baseVersion: number;
      currentVersion: number;
      attemptedAt: string;
    };

export interface RouteConflictDto {
  id: string;
  routeId: string;
  kind: RouteConflictKind;
  status: 'open' | 'resolved';
  summary: string;
  sources: RouteConflictSource[];
  resolution: string | null;
  rationale: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface RouteRevisionDto {
  version: number;
  trigger: RouteTrigger;
  reasons: string[];
  /** 重排来源快照：用到的窗口判定、通勤段、被放弃的候选顺序 */
  inputs: {
    generatedAt: string;
    windows: { stopId: string; windowId: string | null; startAt: string; endAt: string; verdict: WindowVerdict; computedAt: string | null }[];
    legs: { fromStopId: string | null; toStopId: string; minutes: number; source: string; distanceKm: number | null }[];
    alternatives: { order: string[]; conflicts: number; missedMin: number; commuteMin: number; note: string }[];
  } | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RouteDto {
  id: string;
  title: string;
  date: string;
  version: number;
  status: RouteStatus;
  originText: string | null;
  stops: RouteStopDto[];
  openConflicts: number;
  createdAt: string;
  updatedAt: string;
}
