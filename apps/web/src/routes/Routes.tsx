import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  ROUTE_CONFLICT_KIND_LABEL,
  type RouteConflictDto,
  type RouteDto,
} from '@flil/shared';
import {
  useCreateRoute,
  usePendingRouteConfirmations,
  usePreviewRoute,
  useResolvePendingRoute,
  useRouteActions,
  useRoutes,
  type RoutePreview,
} from '../api/hooks.js';
import { fmtDateTime, fmtTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

const VERDICT_COLOR: Record<string, string> = { good: 'green', marginal: 'orange', bad: 'red' };
const SOURCE_LABEL: Record<string, string> = {
  auto_plan: '自动规划',
  weather_rescan: '气象重算',
  manual: '人工',
  offline: '离线确认',
};

function ConflictTags({ conflicts }: { conflicts: RouteConflictDto[] }) {
  const open = conflicts.filter((c) => c.status === 'open');
  if (!open.length) return <Tag color="green">无待取舍冲突</Tag>;
  const byKind = new Map<string, number>();
  for (const c of open) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  return (
    <Space size={4} wrap>
      {[...byKind.entries()].map(([kind, n]) => (
        <Tag key={kind} color={kind === 'offline_stale' || kind === 'weather_shift' ? 'gold' : 'red'}>
          {ROUTE_CONFLICT_KIND_LABEL[kind as keyof typeof ROUTE_CONFLICT_KIND_LABEL] ?? kind} ×{n}
        </Tag>
      ))}
    </Space>
  );
}

function ConflictPanel({ route, onResolved }: { route: RouteDto; onResolved: () => void }) {
  const actions = useRouteActions();
  const [basis, setBasis] = useState<Record<string, string>>({});
  type PersistedConflict = RouteConflictDto & { id: string };

  async function resolve(c: PersistedConflict, resolution: 'keep_auto' | 'keep_manual' | 'ignore') {
    const reason = basis[c.id]?.trim();
    if (!reason) {
      message.error('必须填写人工取舍依据');
      return;
    }
    try {
      await actions.resolveConflict.mutateAsync({
        id: route.id,
        conflictId: c.id!,
        resolution,
        basis: reason,
      });
      message.success('已记录取舍依据');
      onResolved();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  const open = route.conflicts.filter(
    (c): c is RouteConflictDto & { id: string } => c.status === 'open' && c.id !== null,
  );
  if (!open.length) return null;

  return (
    <Card size="small" title={<Space><Tag color="red">待人工取舍</Tag>每处冲突都带来源与可复算依据</Space>} style={{ marginBottom: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {open.map((c) => (
          <Alert
            key={c.id}
            type={c.kind === 'weather_shift' || c.kind === 'offline_stale' ? 'warning' : 'error'}
            showIcon
            message={
              <Space wrap>
                <Tag>{ROUTE_CONFLICT_KIND_LABEL[c.kind]}</Tag>
                <Tag color="blue">来源：{SOURCE_LABEL[c.source] ?? c.source}</Tag>
                <Typography.Text>{c.message}</Typography.Text>
              </Space>
            }
            description={
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  依据：<code>{JSON.stringify(c.evidence)}</code>
                </Typography.Text>
                <Input.TextArea
                  rows={1}
                  placeholder="人工取舍依据（必填）：为什么保留/忽略这一处"
                  value={basis[c.id] ?? ''}
                  onChange={(e) => setBasis((b) => ({ ...b, [c.id!]: e.target.value }))}
                />
                <Space>
                  <Button size="small" onClick={() => void resolve(c, 'keep_auto')}>
                    采纳自动顺序
                  </Button>
                  <Button size="small" type="primary" onClick={() => void resolve(c, 'keep_manual')}>
                    采纳当前（人工）顺序
                  </Button>
                  <Button size="small" onClick={() => void resolve(c, 'ignore')}>
                    忽略并留痕
                  </Button>
                </Space>
              </Space>
            }
          />
        ))}
      </Space>
    </Card>
  );
}

function PendingPanel({ onChange }: { onChange: () => void }) {
  const { data } = usePendingRouteConfirmations();
  const resolve = useResolvePendingRoute();
  const [basis, setBasis] = useState<Record<string, string>>({

  });

  const items = data?.items ?? [];
  if (!items.length) return null;

  async function decide(pendingId: string, decision: 'apply' | 'discard') {
    const reason = basis[pendingId]?.trim();
    if (!reason) {
      message.error('必须说明取舍依据');
      return;
    }
    try {
      await resolve.mutateAsync({ pendingId, decision, basis: reason });
      message.success(decision === 'apply' ? '已作用到当前最新顺序' : '已丢弃');
      onChange();
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card size="small" title={<Tag color="gold">离线晚到确认 · 挂起 {items.length} 条（不会覆盖新顺序）</Tag>} style={{ marginBottom: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        {items.map((p) => (
          <Alert
            key={p.id}
            type="warning"
            showIcon
            message={
              <Space wrap>
                <Tag>到达确认</Tag>
                <Typography.Text>路线版本 {p.baseVersion} → 当前 {p.currentVersion}</Typography.Text>
              </Space>
            }
            description={
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.reason}</Typography.Text>
                <Input.TextArea
                  rows={1}
                  placeholder="取舍依据（必填）"
                  value={basis[p.id] ?? ''}
                  onChange={(e) => setBasis((b) => ({ ...b, [p.id]: e.target.value }))}
                />
                <Space>
                  <Button size="small" type="primary" onClick={() => void decide(p.id, 'apply')}>
                    核对后应用到当前顺序
                  </Button>
                  <Popconfirm title="丢弃这条晚到确认？" onConfirm={() => void decide(p.id, 'discard')}>
                    <Button size="small">丢弃</Button>
                  </Popconfirm>
                </Space>
              </Space>
            }
          />
        ))}
      </Space>
    </Card>
  );
}

function RouteDetail({ route, onClose }: { route: RouteDto; onClose: () => void }) {
  const tz = useSession((s) => s.libraryTz);
  const actions = useRouteActions();
  const [rationale, setRationale] = useState('');
  const [order, setOrder] = useState<string[]>(route.stops.map((s) => s.inspirationId));

  const move = (id: string, dir: -1 | 1) => {
    const idx = order.indexOf(id);
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[idx], next[j]] = [next[j], next[idx]];
    setOrder(next);
  };

  async function saveOrder() {
    if (!rationale.trim()) {
      message.error('人工改序必须填写取舍依据');
      return;
    }
    try {
      await actions.reorder.mutateAsync({
        id: route.id,
        baseVersion: route.version,
        orderedInspirationIds: order,
        rationale: rationale.trim(),
      });
      message.success('顺序已更新（版本 +1）');
      setRationale('');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function arrive(stopId: string) {
    try {
      await actions.arrive.mutateAsync({ id: route.id, stopId, baseVersion: route.version });
      message.success('已确认到达');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function rescan() {
    try {
      const r = await actions.rescan.mutateAsync({ id: route.id, baseVersion: route.version });
      message.success(r.changed ? '气象变化导致换窗，已生成新顺序，待你确认' : '窗口无变化');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function acceptRescan() {
    const basis = window.prompt('接受气象重排后的新顺序？请给出依据：');
    if (!basis?.trim()) return;
    try {
      await actions.acceptRescan.mutateAsync({ id: route.id, basis: basis.trim() });
      message.success('已接受新顺序');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      width={860}
      footer={null}
      title={
        <Space wrap>
          <span>{route.title}</span>
          <Tag>{route.date}</Tag>
          <Tag color="blue">v{route.version}</Tag>
          {route.needsReview ? <Tag color="gold">待确认</Tag> : null}
          <ConflictTags conflicts={route.conflicts} />
        </Space>
      }
    >
      <ConflictPanel route={route} onResolved={onClose} />

      <Space style={{ marginBottom: 12 }}>
        <Button size="small" onClick={() => void rescan()}>按最新气象重排</Button>
        {route.needsReview ? (
          <Button size="small" type="primary" ghost onClick={() => void acceptRescan()}>
            接受重排新顺序
          </Button>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          总通勤 {route.totalCommuteMin} 分 / {route.totalDistanceKm} km
          {route.weatherDegraded ? ' · 天气降级（未含天气）' : ''}
        </Typography.Text>
      </Space>

      <Timeline
        items={[...route.stops]
          .sort((a, b) => order.indexOf(a.inspirationId) - order.indexOf(b.inspirationId))
          .map((s, i, arr) => ({
            color: s.leg.feasible ? 'green' : 'red',
            children: (
              <Space direction="vertical" size={2}>
                <Space wrap>
                  <Button size="small" disabled={i === 0} onClick={() => move(s.inspirationId, -1)}>↑</Button>
                  <Button size="small" disabled={i === arr.length - 1} onClick={() => move(s.inspirationId, 1)}>↓</Button>
                  <Link to={`/inspirations/${s.inspirationId}`}>{s.inspirationTitle}</Link>
                  <Tag color={VERDICT_COLOR[s.verdict]}>{s.verdict}</Tag>
                  <Tag>{fmtTime(s.startAt, tz)}–{fmtTime(s.endAt, tz)}</Tag>
                  {s.status === 'arrived' ? <Tag color="green">已到</Tag> : null}
                  {s.status === 'late' ? <Tag color="orange">晚到</Tag> : null}
                  {!s.leg.feasible ? <Tag color="red">通勤 {s.leg.commuteMin}分 赶不到</Tag> : null}
                  {s.leg.departAt ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fmtDateTime(s.leg.departAt, tz)} 出发 · {s.leg.distanceKm}km
                    </Typography.Text>
                  ) : null}
                  {s.status === 'planned' ? (
                    <Button size="small" type="primary" onClick={() => void arrive(s.id)}>确认到达</Button>
                  ) : null}
                </Space>
              </Space>
            ),
          }))}
      />

      <Card size="small" title="人工改序（需取舍依据）" style={{ marginTop: 8 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea
            rows={2}
            placeholder="为什么这么排？例如：远处天台的光只有这一刻，宁可提前出门"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
          <Button type="primary" onClick={() => void saveOrder()}>保存新顺序（乐观锁 v{route.version}）</Button>
        </Space>
      </Card>
    </Modal>
  );
}

export default function Routes() {
  const tz = useSession((s) => s.libraryTz);
  const routes = useRoutes();
  const create = useCreateRoute();
  const preview = usePreviewRoute();
  const [selected, setSelected] = useState<RouteDto | null>(null);
  const [form] = Form.useForm();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [previewData, setPreviewData] = useState<RoutePreview | null>(null);

  const dateStr = date.format('YYYY-MM-DD');
  const selectedFresh = useMemo(
    () => routes.data?.items.find((r) => r.id === selected?.id) ?? selected,
    [routes.data, selected],
  );

  async function runPreview(values: Record<string, unknown>) {
    const body = {
      date: dateStr,
      origin: values.originLat != null ? { lat: Number(values.originLat), lng: Number(values.originLng) } : null,
      earliestDepartAt: values.earliestDepart
        ? date.hour(0).minute(0).second(0).add(Number(values.earliestDepart), 'minute').toISOString()
        : null,
      speedKmh: Number(values.speedKmh ?? 25),
      slackMin: Number(values.slackMin ?? 0),
      minVerdict: 'marginal',
    };
    try {
      const r = await preview.mutateAsync(body);
      setPreviewData(r);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function doCreate() {
    if (!previewData) return;
    const values = form.getFieldsValue();
    try {
      const r = await create.mutateAsync({
        title: (values.title as string) || `${dateStr} 取景路线`,
        date: dateStr,
        origin: values.originLat != null ? { lat: Number(values.originLat), lng: Number(values.originLng) } : null,
        earliestDepartAt: values.earliestDepart
          ? date.hour(0).minute(0).second(0).add(Number(values.earliestDepart), 'minute').toISOString()
          : null,
        speedKmh: Number(values.speedKmh ?? 25),
        slackMin: Number(values.slackMin ?? 0),
        minVerdict: 'marginal',
      });
      message.success('路线已创建');
      setPreviewData(null);
      setSelected(r.item);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <PendingPanel onChange={() => void routes.refetch()} />

      <Card title="规划新路线">
        <Form form={form} layout="inline" onFinish={runPreview} initialValues={{ speedKmh: 25, slackMin: 0 }}>
          <Form.Item label="日期">
            <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} />
          </Form.Item>
          <Form.Item name="title" label="名称">
            <Input placeholder="默认用日期" />
          </Form.Item>
          <Form.Item name="originLat" label="出发点纬度"><InputNumber /></Form.Item>
          <Form.Item name="originLng" label="经度"><InputNumber /></Form.Item>
          <Form.Item name="earliestDepart" label="最早出发(当天第几分)"><InputNumber min={0} max={1439} /></Form.Item>
          <Form.Item name="speedKmh" label="速度 km/h"><InputNumber min={1} max={200} /></Form.Item>
          <Form.Item name="slackMin" label="间隔冗余(分)"><InputNumber min={0} max={240} /></Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={preview.isPending}>预览重排</Button>
              <Button disabled={!previewData} onClick={() => void doCreate()} loading={create.isPending}>
                据此创建
              </Button>
            </Space>
          </Form.Item>
        </Form>

        {previewData ? (
          <div style={{ marginTop: 12 }}>
            <Space style={{ marginBottom: 8 }}>
              <Tag color="blue">候选 {previewData.candidateCount}</Tag>
              <Tag>{previewData.stops.length} 站</Tag>
              <Tag>通勤 {previewData.totalCommuteMin} 分 / {previewData.totalDistanceKm} km</Tag>
              {previewData.hasBlockingConflict ? <Tag color="red">存在赶不到/重叠</Tag> : <Tag color="green">时序可行</Tag>}
            </Space>
            <Table
              size="small"
              rowKey="windowId"
              pagination={false}
              dataSource={previewData.stops}
              columns={[
                { title: '#', width: 40, render: (_, __, i) => i + 1 },
                { title: '灵感卡', dataIndex: 'inspirationTitle' },
                {
                  title: '窗口',
                  render: (_, s) => `${fmtTime(s.startAt, tz)}–${fmtTime(s.endAt, tz)}`,
                },
                { title: '判定', dataIndex: 'verdict', render: (v: string) => <Tag color={VERDICT_COLOR[v]}>{v}</Tag> },
                { title: '通勤(分)', render: (_, s) => s.leg.commuteMin },
                {
                  title: '可达',
                  render: (_, s) => (s.leg.feasible ? <Tag color="green">赶得到</Tag> : <Tag color="red">赶不到</Tag>),
                },
              ]}
            />
            {previewData.conflicts.length ? (
              <Space direction="vertical" style={{ marginTop: 8, width: '100%' }}>
                {previewData.conflicts.map((c, i) => (
                  <Alert
                    key={i}
                    type="error"
                    showIcon
                    message={
                      <Space wrap>
                        <Tag>{ROUTE_CONFLICT_KIND_LABEL[c.kind]}</Tag>
                        <Tag color="blue">来源：{SOURCE_LABEL[c.source]}</Tag>
                        {c.message}
                      </Space>
                    }
                    description={<Typography.Text type="secondary" style={{ fontSize: 12 }}><code>{JSON.stringify(c.evidence)}</code></Typography.Text>}
                  />
                ))}
              </Space>
            ) : null}
            {previewData.dropped.length ? (
              <Alert
                style={{ marginTop: 8 }}
                type="warning"
                showIcon
                message={`${previewData.dropped.length} 张卡当日无窗口被放弃`}
              />
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title="我的路线">
        <Table<RouteDto>
          rowKey="id"
          size="small"
          dataSource={routes.data?.items ?? []}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'title' },
            { title: '日期', dataIndex: 'date' },
            { title: '版本', dataIndex: 'version', width: 60, render: (v: number) => <Tag>v{v}</Tag> },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (v: string, r) => (
                <Badge status={r.needsReview ? 'warning' : r.hasBlockingConflict ? 'error' : 'success'} text={v} />
              ),
            },
            { title: '站数', render: (_, r) => r.stops.length },
            { title: '冲突', render: (_, r) => <ConflictTags conflicts={r.conflicts} /> },
            {
              title: '操作',
              width: 100,
              render: (_, r) => (
                <Button size="small" type="primary" onClick={() => setSelected(r)}>
                  打开
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {selectedFresh ? <RouteDetail route={selectedFresh} onClose={() => setSelected(null)} /> : null}
    </Space>
  );
}
