export const InspirationStatus = {
  draft: 'draft',
  tagging: 'tagging',
  timingMissing: 'timing_missing',
  ready: 'ready',
  scheduled: 'scheduled',
  shot: 'shot',
  archived: 'archived',
  dropped: 'dropped',
} as const;
export type InspirationStatus = (typeof InspirationStatus)[keyof typeof InspirationStatus];

export const INSPIRATION_TERMINAL: InspirationStatus[] = ['archived', 'dropped'];

export const AlbumStatus = {
  planning: 'planning',
  collecting: 'collecting',
  ready: 'ready',
  published: 'published',
  archived: 'archived',
} as const;
export type AlbumStatus = (typeof AlbumStatus)[keyof typeof AlbumStatus];

export const PlanStatus = {
  planned: 'planned',
  cancelled: 'cancelled',
  done: 'done',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const ReminderStatus = {
  pending: 'pending',
  notified: 'notified',
  done: 'done',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
  expired: 'expired',
} as const;
export type ReminderStatus = (typeof ReminderStatus)[keyof typeof ReminderStatus];

export const REMINDER_TERMINAL: ReminderStatus[] = ['done', 'dismissed', 'expired'];

export const GapStatus = {
  open: 'open',
  filled: 'filled',
  waived: 'waived',
} as const;
export type GapStatus = (typeof GapStatus)[keyof typeof GapStatus];

export const TagDomain = {
  light: 'light',
  scene: 'scene',
  color: 'color',
  composition: 'composition',
} as const;
export type TagDomain = (typeof TagDomain)[keyof typeof TagDomain];
export const TAG_DOMAINS: TagDomain[] = ['light', 'scene', 'color', 'composition'];

export const TAG_DOMAIN_LABEL: Record<TagDomain, string> = {
  light: '光线',
  scene: '建筑场景',
  color: '色彩',
  composition: '构图',
};

export const TimeAnchor = {
  sunrise: 'sunrise',
  sunrisePlus: 'sunrise_plus',
  goldenAm: 'golden_am',
  solarNoon: 'solar_noon',
  goldenPm: 'golden_pm',
  sunset: 'sunset',
  sunsetMinus: 'sunset_minus',
  bluePm: 'blue_pm',
  blueAm: 'blue_am',
  night: 'night',
  fixedClock: 'fixed_clock',
} as const;
export type TimeAnchor = (typeof TimeAnchor)[keyof typeof TimeAnchor];
export const TIME_ANCHORS: TimeAnchor[] = [
  'sunrise',
  'sunrise_plus',
  'golden_am',
  'solar_noon',
  'golden_pm',
  'sunset',
  'sunset_minus',
  'blue_pm',
  'blue_am',
  'night',
  'fixed_clock',
];

export const TIME_ANCHOR_LABEL: Record<TimeAnchor, string> = {
  sunrise: '日出',
  sunrise_plus: '日出后 N 分钟',
  golden_am: '黄金时刻（晨）',
  solar_noon: '正午（太阳过中天）',
  golden_pm: '黄金时刻（昏）',
  sunset: '日落',
  sunset_minus: '日落前 N 分钟',
  blue_pm: '蓝调时刻（昏）',
  blue_am: '蓝调时刻（晨）',
  night: '夜间（太阳仰角 < -12°）',
  fixed_clock: '固定钟点',
};

export const WeatherPhenomenon = {
  clear: 'clear',
  thinCloud: 'thin_cloud',
  overcast: 'overcast',
  afterRain: 'after_rain',
  fog: 'fog',
  snow: 'snow',
  wetGround: 'wet_ground',
  neonReflection: 'neon_reflection',
  strongWind: 'strong_wind',
  any: 'any',
} as const;
export type WeatherPhenomenon = (typeof WeatherPhenomenon)[keyof typeof WeatherPhenomenon];

export const WEATHER_PHENOMENON_LABEL: Record<WeatherPhenomenon, string> = {
  clear: '晴朗',
  thin_cloud: '薄云',
  overcast: '阴天',
  after_rain: '雨后',
  fog: '雾',
  snow: '雪',
  wet_ground: '湿地面反射',
  neon_reflection: '霓虹反光',
  strong_wind: '大风',
  any: '任意天气',
};

export const WindowVerdict = {
  good: 'good',
  marginal: 'marginal',
  bad: 'bad',
} as const;
export type WindowVerdict = (typeof WindowVerdict)[keyof typeof WindowVerdict];

export const FuzzLevel = {
  exact: 'exact',
  g100: 'g100',
  g500: 'g500',
  g1k: 'g1k',
  neighborhood: 'neighborhood',
  district: 'district',
} as const;
export type FuzzLevel = (typeof FuzzLevel)[keyof typeof FuzzLevel];

/** 对外分享允许的最小精度（g500 及更粗） */
export const SHARE_ALLOWED_FUZZ_LEVELS: FuzzLevel[] = ['g500', 'g1k', 'neighborhood', 'district'];

export const FUZZ_LEVEL_LABEL: Record<FuzzLevel, string> = {
  exact: '精确坐标（仅自己）',
  g100: '约 100m 网格',
  g500: '约 500m 网格',
  g1k: '约 1km 网格',
  neighborhood: '街区',
  district: '行政区',
};

export const FUZZ_LEVEL_GEOHASH_LEN: Record<FuzzLevel, number> = {
  exact: 12,
  g100: 8,
  g500: 7,
  g1k: 6,
  neighborhood: 5,
  district: 4,
};

export const HitLevel = {
  hit: 'hit',
  partial: 'partial',
  miss: 'miss',
} as const;
export type HitLevel = (typeof HitLevel)[keyof typeof HitLevel];

export const HIT_LEVEL_LABEL: Record<HitLevel, string> = {
  hit: '拍到了',
  partial: '差一点',
  miss: '没拍成',
};

export const MissReason = {
  weatherMismatch: 'weather_mismatch',
  timingOff: 'timing_off',
  lightDirectionWrong: 'light_direction_wrong',
  blockedOnSite: 'blocked_on_site',
  siteRebuilt: 'site_rebuilt',
  tooCrowded: 'too_crowded',
  didNotArrive: 'did_not_arrive',
  other: 'other',
} as const;
export type MissReason = (typeof MissReason)[keyof typeof MissReason];

export const MISS_REASON_LABEL: Record<MissReason, string> = {
  weather_mismatch: '天气不符',
  timing_off: '时间差了',
  light_direction_wrong: '光位不对',
  blocked_on_site: '现场被遮挡',
  site_rebuilt: '现场已改造',
  too_crowded: '人太多',
  did_not_arrive: '自己没到',
  other: '其他',
};

export const AssetRole = {
  reference: 'reference',
  detail: 'detail',
  panorama: 'panorama',
  result: 'result',
} as const;
export type AssetRole = (typeof AssetRole)[keyof typeof AssetRole];

export const AnnotationKind = {
  ruleOfThirds: 'rule_of_thirds',
  leadingLine: 'leading_line',
  frame: 'frame',
  negativeSpace: 'negative_space',
  lightArrow: 'light_arrow',
} as const;
export type AnnotationKind = (typeof AnnotationKind)[keyof typeof AnnotationKind];

export const ANNOTATION_KIND_LABEL: Record<AnnotationKind, string> = {
  rule_of_thirds: '三分线交点',
  leading_line: '引导线',
  frame: '框架边界',
  negative_space: '留白区',
  light_arrow: '光位箭头',
};

export const TagSource = {
  manual: 'manual',
  bulk: 'bulk',
  albumGap: 'album_gap',
  suggested: 'suggested',
} as const;
export type TagSource = (typeof TagSource)[keyof typeof TagSource];

export const ReminderActionKind = {
  fillTiming: 'fill_timing',
  openPlan: 'open_plan',
  resolveWeatherChange: 'resolve_weather_change',
  resolveRouteConflict: 'resolve_route_conflict',
  fillResult: 'fill_result',
  fillAlbumGap: 'fill_album_gap',
  renewShare: 'renew_share',
  reviewYear: 'review_year',
  none: 'none',
} as const;
export type ReminderActionKind = (typeof ReminderActionKind)[keyof typeof ReminderActionKind];

// --------------------------------------------------------------- 取景路线

export const RouteStatus = {
  draft: 'draft',
  active: 'active',
  completed: 'completed',
  archived: 'archived',
} as const;
export type RouteStatus = (typeof RouteStatus)[keyof typeof RouteStatus];

export const RouteStopStatus = {
  planned: 'planned',
  arrived: 'arrived',
  late: 'late',
  skipped: 'skipped',
} as const;
export type RouteStopStatus = (typeof RouteStopStatus)[keyof typeof RouteStopStatus];

/** 冲突类型：时段重叠 / 通勤不可达（赶不到）/ 气象降级换窗 / 人工改序 */
export const RouteConflictKind = {
  overlap: 'overlap',
  commuteUnreachable: 'commute_unreachable',
  weatherShift: 'weather_shift',
  manualReorder: 'manual_reorder',
  offlineStale: 'offline_stale',
} as const;
export type RouteConflictKind = (typeof RouteConflictKind)[keyof typeof RouteConflictKind];

export const ROUTE_CONFLICT_KIND_LABEL: Record<RouteConflictKind, string> = {
  overlap: '时段重叠',
  commute_unreachable: '通勤赶不到',
  weather_shift: '气象变化换窗',
  manual_reorder: '人工改序',
  offline_stale: '离线晚到确认过期',
};

export const RouteConflictStatus = {
  open: 'open',
  keptAuto: 'kept_auto',
  keptManual: 'kept_manual',
  resolved: 'resolved',
  ignored: 'ignored',
} as const;
export type RouteConflictStatus = (typeof RouteConflictStatus)[keyof typeof RouteConflictStatus];

/** 冲突来源：谁/什么触发的，决定取舍时必须可追溯 */
export const RouteConflictSource = {
  autoPlan: 'auto_plan',
  weatherRescan: 'weather_rescan',
  manual: 'manual',
  offline: 'offline',
} as const;
export type RouteConflictSource = (typeof RouteConflictSource)[keyof typeof RouteConflictSource];
