import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import {
  ROUTE_CONFLICT_KIND_LABEL,
  ROUTE_TRIGGER_LABEL,
  type RouteConflictDto,
  type RouteConflictSource,
  type RouteDto,
  type RouteRevisionDto,
  type RouteStopDto,
} from '@flil/shared';
import {
  useConfirmRouteStop,
  useManualReorder,
  useResolveRouteConflict,
  useResequenceRoute,
  useRoute,
} from '../api/hooks.js';
import { fmtDateTime, fmtTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

const VERDICT_LABEL: Record<string, string> = { good: '可拍', marginal: '勉强', bad: '不可拍' };
const VERDICT_COLOR: Record<string, string> = { good: 'green', marginal: 'orange', bad: 'default' };

function SourceView({ source, tz }: { source: RouteConflictSource; tz: string }) {
  if (source.type === 'window') {
    return (
      <li>
        窗口来源：「{source.inspirationTitle}」{fmtTime(source.startAt, tz)}–{fmtTime(source.endAt, tz)}，判定
        <Tag color={VERDICT_COLOR[source.verdict]} style={{ marginLeft: 4 }}>
          {VERDICT_LABEL[source.verdict]}
        </Tag>
        {source.computedAt ? `（判定于 ${fmtDateTime(source.computedAt, tz)}）` : ''}
        {source.reasons.length > 0 ? (
          <div style={{ color: '#888', fontSize: 12 }}>
            {source.reasons.slice(0, 3).map((r) => r.text).join('；')}
          </div>
        ) : null}
      </li>
    );
  }
  if (source.type === 'commute') {
    return (
      <li>
        通勤来源：约 {source.minutes} 分钟（距离 {source.distanceKm} km，
        {source.source === 'estimate' ? '距离估算' : source.source === 'plan' ? '计划通勤' : '人工填写'}）
      </li>
    );
  }
  return (
    <li>
      离线确认来源：客户端操作 {source.clientOpId ?? '（无 ID）'}，基于版本 v{source.baseVersion}，当前 v
      {source.currentVersion}，尝试于 {fmtDateTime(source.attemptedAt, tz)}
    </li>
  );
}

function ConflictCard({ route, conflict }: { route: RouteDto; conflict: RouteConflictDto }) {
  const tz = useSession((s) => s.libraryTz);
  const resolve = useResolveRouteConflict();
  const [resolution, setResolution] = useState<string>('accept_current');
  const [rationale, setRationale] = useState('');
  const [dropStopId, setDropStopId] = useState<string | undefined>();

  const resolutions = [
    { value: 'accept_current', label: '保持当前顺序（接受冲突）' },
    { value: 'drop_stop', label: '移除一个站点并重排' },
    ...(conflict.kind === 'stale_confirmation'
      ? [{ value: 'apply_stale_confirmation', label: '接受这条晚到确认（人工拍板）' }]
      : []),
  ];

  async function submit() {
    if (rationale.trim().length < 4) {
      message.warning('请填写取舍依据（至少 4 个字）');
      return;
    }
    try {
      await resolve.mutateAsync({
        routeId: route.id,
        conflictId: conflict.id,
        resolution,
        rationale: rationale.trim(),
        stopId: resolution === 'drop_stop' ? dropStopId : undefined,
      });
      message.success('冲突已处理，依据已留痕');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Alert
      type={conflict.status === 'open' ? 'warning' : 'info'}
      showIcon
      message={
        <Space>
          <Tag color={conflict.status === 'open' ? 'orange' : 'default'}>
            {ROUTE_CONFLICT_KIND_LABEL[conflict.kind]}
          </Tag>
          {conflict.summary}
        </Space>
      }
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong style={{ fontSize: 12 }}>
              来源：
            </Typography.Text>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {conflict.sources.map((s, i) => (
                <SourceView key={i} source={s} tz={tz} />
              ))}
            </ul>
          </div>
          {conflict.status === 'resolved' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已处理：{conflict.resolution} · 依据：{conflict.rationale} ·{' '}
              {conflict.resolvedAt ? fmtDateTime(conflict.resolvedAt, tz) : ''}
            </Typography.Text>
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Space wrap>
                <Select
                  size="small"
                  style={{ width: 240 }}
                  value={resolution}
                  onChange={setResolution}
                  options={resolutions}
                />
                {resolution === 'drop_stop' ? (
                  <Select
                    size="small"
                    style={{ width: 200 }}
                    placeholder="选择要移除的站"
                    value={dropStopId}
                    onChange={setDropStopId}
                    options={route.stops.map((s) => ({ value: s.id, label: s.inspirationTitle }))}
                  />
                ) : null}
              </Space>
              <Input.TextArea
                rows={2}
                placeholder="人工取舍依据（必填，会永久留在冲突记录里）"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
              <Button size="small" type="primary" loading={resolve.isPending} onClick={() => void submit()}>
                提交取舍
              </Button>
            </Space>
          )}
        </Space>
      }
    />
  );
}

function ReorderModal({ route, open, onClose }: { route: RouteDto; open: boolean; onClose: () => void }) {
  const [order, setOrder] = useState<RouteStopDto[]>(route.stops);
  const [rationale, setRationale] = useState('');
  const reorder = useManualReorder();

  function move(idx: number, dir: -1 | 1) {
    const next = order.slice();
    const [item] = next.splice(idx, 1);
    next.splice(idx + dir, 0, item);
    setOrder(next);
  }

  async function submit() {
    if (rationale.trim().length < 4) {
      message.warning('请填写调序依据（至少 4 个字）');
      return;
    }
    try {
      await reorder.mutateAsync({
        id: route.id,
        stopIds: order.map((s) => s.id),
        rationale: rationale.trim(),
        baseVersion: route.version,
      });
      message.success('已按人工顺序重排');
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Modal
      title={`人工调序（基于版本 v${route.version}）`}
      open={open}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={reorder.isPending}
      okText="提交调序"
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {order.map((s, idx) => (
          <Space key={s.id}>
            <Tag>{idx + 1}</Tag>
            {s.inspirationTitle}
            <Button size="small" disabled={idx === 0} onClick={() => move(idx, -1)}>
              ↑
            </Button>
            <Button size="small" disabled={idx === order.length - 1} onClick={() => move(idx, 1)}>
              ↓
            </Button>
          </Space>
        ))}
        <Input.TextArea
          rows={2}
          placeholder="调序依据（必填，如：东滩潮汐只在傍晚前可进）"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Space>
    </Modal>
  );
}

function RevisionList({ revisions }: { revisions: RouteRevisionDto[] }) {
  const tz = useSession((s) => s.libraryTz);
  return (
    <Collapse
      size="small"
      items={revisions.map((r) => ({
        key: r.version,
        label: (
          <Space>
            <Tag>v{r.version}</Tag>
            <Tag color="blue">{ROUTE_TRIGGER_LABEL[r.trigger]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {fmtDateTime(r.createdAt, tz)}
            </Typography.Text>
          </Space>
        ),
        children: (
          <Space direction="vertical" size={4}>
            {r.reasons.map((reason, i) => (
              <Typography.Text key={i} style={{ fontSize: 12 }}>
                · {reason}
              </Typography.Text>
            ))}
            {r.inputs?.alternatives?.length ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                被放弃的候选：
                {r.inputs.alternatives.map((a, i) => (
                  <div key={i}>
                    方案 {a.order.length} 站 · 冲突 {a.conflicts} 个 · 通勤 {a.commuteMin} 分钟 —— {a.note}
                  </div>
                ))}
              </Typography.Text>
            ) : null}
          </Space>
        ),
      }))}
    />
  );
}

export default function RouteDetail() {
  const { id } = useParams<{ id: string }>();
  const tz = useSession((s) => s.libraryTz);
  const route = useRoute(id);
  const resequence = useResequenceRoute();
  const confirmStop = useConfirmRouteStop();
  const [reorderOpen, setReorderOpen] = useState(false);

  if (!route.data) return <Card loading />;

  const { item, conflicts, revisions } = route.data;
  const openConflicts = conflicts.filter((c) => c.status === 'open');
  const closedConflicts = conflicts.filter((c) => c.status === 'resolved');

  async function doResequence() {
    try {
      const res = await resequence.mutateAsync({ id: item.id });
      message.success(`已重排到 v${res.version}，新增 ${res.conflicts} 个待决冲突`);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function doConfirm(stopId: string) {
    try {
      await confirmStop.mutateAsync({ routeId: item.id, stopId, baseVersion: item.version });
      message.success('已确认到场');
    } catch (err) {
      // 409：路线已被重排，这条确认没生效 —— 页面已自动刷新为新顺序
      message.warning((err as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            {item.title}
            <Tag>v{item.version}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {item.date}
              {item.originText ? ` · 从${item.originText}出发` : ''}
            </Typography.Text>
          </Space>
        }
        extra={
          <Space>
            <Button onClick={() => void doResequence()} loading={resequence.isPending}>
              系统重排
            </Button>
            <Button onClick={() => setReorderOpen(true)}>人工调序</Button>
          </Space>
        }
      >
        <Timeline
          items={item.stops.map((s) => ({
            color: s.confirmedAt ? 'green' : s.window?.verdict === 'bad' ? 'gray' : 'blue',
            children: (
              <Space direction="vertical" size={2}>
                <Space wrap>
                  <Tag>{s.seq}</Tag>
                  <Link to={`/inspirations/${s.inspirationId}`}>{s.inspirationTitle}</Link>
                  {s.window ? (
                    <Tag color={VERDICT_COLOR[s.window.verdict]}>
                      窗口 {fmtTime(s.window.startAt, tz)}–{fmtTime(s.window.endAt, tz)} ·{' '}
                      {VERDICT_LABEL[s.window.verdict]}
                    </Tag>
                  ) : (
                    <Tag>窗口缺失</Tag>
                  )}
                  {s.confirmedAt ? <Tag color="green">已确认 {fmtTime(s.confirmedAt, tz)}</Tag> : null}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.commuteFromPrevMin !== null
                    ? `上段通勤 ${s.commuteFromPrevMin} 分钟（${
                        s.commuteSource === 'estimate' ? '估算' : s.commuteSource === 'plan' ? '计划' : '人工'
                      }） · `
                    : ''}
                  到达 {fmtTime(s.arriveAt, tz)} · 离开 {fmtTime(s.departAt, tz)} · 停留 {s.dwellMin} 分钟
                </Typography.Text>
                {!s.confirmedAt && item.status === 'active' ? (
                  <Button size="small" onClick={() => void doConfirm(s.id)}>
                    确认到场（v{item.version}）
                  </Button>
                ) : null}
              </Space>
            ),
          }))}
        />
      </Card>

      {openConflicts.length > 0 || closedConflicts.length > 0 ? (
        <Card title={`时段冲突（未决 ${openConflicts.length}）`}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {openConflicts.map((c) => (
              <ConflictCard key={c.id} route={item} conflict={c} />
            ))}
            {closedConflicts.map((c) => (
              <ConflictCard key={c.id} route={item} conflict={c} />
            ))}
          </Space>
        </Card>
      ) : null}

      <Card title="版本记录（每次重排的来源与理由）">
        <RevisionList revisions={revisions} />
      </Card>

      <ReorderModal route={item} open={reorderOpen} onClose={() => setReorderOpen(false)} />
    </Space>
  );
}
