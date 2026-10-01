import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Checkbox, DatePicker, Input, Modal, Space, Table, Tag, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { PlanDto } from '@flil/shared';
import { useCreateRoute, usePlans, useRoutes } from '../api/hooks.js';
import { fmtDate, fmtTime } from '../lib/format.js';
import { useSession } from '../stores/session.js';

export default function Routes() {
  const tz = useSession((s) => s.libraryTz);
  const navigate = useNavigate();
  const routes = useRoutes();
  const plans = usePlans();
  const createRoute = useCreateRoute();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [originText, setOriginText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  // 只有"待出发"且带窗口的计划才能进路线；按窗口时间排序展示
  const candidates = useMemo(
    () =>
      (plans.data?.items ?? [])
        .filter((p) => p.status === 'planned')
        .slice()
        .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt)),
    [plans.data],
  );

  async function submit() {
    if (!title.trim()) {
      message.warning('请填写路线名称');
      return;
    }
    if (selected.length === 0) {
      message.warning('至少选择一个计划');
      return;
    }
    try {
      const res = await createRoute.mutateAsync({
        title: title.trim(),
        date: date.format('YYYY-MM-DD'),
        planIds: selected,
        originText: originText.trim() || null,
      });
      message.success('路线已创建并完成首次排序');
      setOpen(false);
      setSelected([]);
      setTitle('');
      navigate(`/routes/${res.id}`);
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="取景路线"
        extra={
          <Button type="primary" onClick={() => setOpen(true)}>
            新建路线
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          dataSource={routes.data?.items ?? []}
          loading={routes.isLoading}
          pagination={false}
          columns={[
            {
              title: '路线',
              render: (_, r) => (
                <Space>
                  <Link to={`/routes/${r.id}`}>{r.title}</Link>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.date}
                  </Typography.Text>
                </Space>
              ),
            },
            { title: '站点', width: 70, render: (_, r) => r.stops.length },
            {
              title: '版本',
              width: 80,
              render: (_, r) => <Tag>v{r.version}</Tag>,
            },
            {
              title: '状态',
              width: 90,
              render: (_, r) => (
                <Tag color={r.status === 'active' ? 'blue' : 'default'}>
                  {r.status === 'active' ? '进行中' : r.status === 'done' ? '已完成' : '已取消'}
                </Tag>
              ),
            },
            {
              title: '未决冲突',
              width: 110,
              render: (_, r) =>
                r.openConflicts > 0 ? <Badge count={r.openConflicts} /> : <Tag color="green">无</Tag>,
            },
            {
              title: '最近更新',
              width: 150,
              render: (_, r) => fmtDate(r.updatedAt, tz),
            },
          ]}
        />
      </Card>

      <Modal
        title="新建取景路线"
        open={open}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        confirmLoading={createRoute.isPending}
        okText="创建并排序"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input
            placeholder="路线名称（如：周六双机位）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Space>
            <Typography.Text type="secondary">日期</Typography.Text>
            <DatePicker value={date} onChange={(d) => d && setDate(d)} allowClear={false} />
            <Input
              placeholder="出发点（如：家）"
              style={{ width: 160 }}
              value={originText}
              onChange={(e) => setOriginText(e.target.value)}
            />
          </Space>
          <Typography.Text type="secondary">
            选择同日计划（创建时会校验窗口日期一致）：
          </Typography.Text>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {candidates.length === 0 ? (
              <Typography.Text type="secondary">暂无待出发计划，先去「今日」接单。</Typography.Text>
            ) : (
              candidates.map((p: PlanDto) => (
                <div key={p.id} style={{ padding: '4px 0' }}>
                  <Checkbox
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                      )
                    }
                  >
                    {p.inspirationTitle} · {fmtDate(p.plannedAt, tz)} {fmtTime(p.plannedAt, tz)}
                  </Checkbox>
                </div>
              ))
            )}
          </div>
        </Space>
      </Modal>
    </Space>
  );
}
