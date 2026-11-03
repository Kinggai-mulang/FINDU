import { useRef, useState } from 'react';
import { Button, Collapse, Input, Space, Tag, Tooltip } from 'antd';
import { systemNames } from '../services/product-compare';
import {
  classGroups,
  groupSatellites,
  invertExcluded,
  parseSatellites,
  satelliteGroups,
  setExcluded,
  toggleExcluded,
} from '../services/satellite-select';

/** GPS first, then the systems in the order the comparison pages list them. */
const SYSTEM_ORDER = ['G', 'E', 'C', 'R', 'J'];

/**
 * Pick the satellites that are left out of the statistics. A satellite is a toggle button; whole systems, BeiDou
 * generations and orbit types, the satellites the comparison flagged, and ranges typed as text change many at once, and
 * shift-click selects a stretch of one system. Every change is reported at once; the page recomputes after a pause.
 */
export function SatellitePicker({
  satellites,
  excluded,
  flagged,
  busy,
  classes = {},
  onChange,
}: {
  satellites: string[];
  excluded: string[];
  /** Satellites the comparison marked as outliers; offered as a one-click exclusion. */
  flagged: string[];
  busy?: boolean;
  /** GEO / IGSO / MEO per satellite, measured from an orbit file; without it only the BeiDou generations are offered. */
  classes?: Record<string, string>;
  onChange: (excluded: string[]) => void;
}) {
  const [typed, setTyped] = useState('');
  const [unknown, setUnknown] = useState<string[]>([]);
  const last = useRef<string | undefined>(undefined);
  const systems = [...new Set(satellites.map((s) => s[0]))].sort(
    (a, b) => SYSTEM_ORDER.indexOf(a) - SYSTEM_ORDER.indexOf(b) || (a < b ? -1 : 1),
  );
  const off = new Set(excluded);
  const inList = excluded.filter((s) => satellites.includes(s));
  const apply = (exclude: boolean) => {
    const { sats, unknown: miss } = parseSatellites(typed, satellites);
    setUnknown(miss);
    if (sats.length) onChange(setExcluded(excluded, sats, exclude));
  };
  const click = (sat: string, range: boolean, list: string[]) => {
    const exclude = !off.has(sat);
    const from = last.current && last.current[0] === sat[0] ? list.indexOf(last.current) : -1;
    if (range && from >= 0) {
      const [a, b] = [from, list.indexOf(sat)].sort((x, y) => x - y);
      onChange(setExcluded(excluded, list.slice(a, b + 1), exclude));
    } else onChange(setExcluded(excluded, [sat], exclude));
    last.current = sat;
  };
  const fresh = flagged.filter((s) => !off.has(s));
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'satellites',
          label: (
            <Space>
              <span>卫星筛选</span>
              <Tag color={inList.length ? 'orange' : undefined} data-testid="satellite-summary">
                参与统计 {satellites.length - inList.length} / {satellites.length} 颗
              </Tag>
              {busy && <span className="chart-note">重新计算中…</span>}
            </Space>
          ),
          children: (
            <div className="satellite-picker">
              <Space wrap>
                <Button disabled={fresh.length === 0} onClick={() => onChange(setExcluded(excluded, fresh, true))}>
                  剔除标红的异常卫星{fresh.length ? `（${fresh.length}）` : ''}
                </Button>
                <Button disabled={inList.length === 0} onClick={() => onChange([])}>
                  恢复全部
                </Button>
                <Space.Compact>
                  <Input
                    aria-label="按范围选择卫星"
                    style={{ width: 280 }}
                    value={typed}
                    status={unknown.length ? 'error' : undefined}
                    placeholder="范围：C01-C10 G13 E（只写字母表示整个系统）"
                    onChange={(e) => {
                      setTyped(e.target.value);
                      setUnknown([]);
                    }}
                    onPressEnter={() => apply(true)}
                  />
                  <Button disabled={!typed.trim()} onClick={() => apply(true)}>
                    剔除
                  </Button>
                  <Button disabled={!typed.trim()} onClick={() => apply(false)}>
                    恢复
                  </Button>
                </Space.Compact>
                {unknown.length > 0 && <span className="chart-note">没有这些卫星：{unknown.join(' ')}</span>}
              </Space>
              <div className="chart-note">点击卫星切换是否剔除；按住 Shift 点击可连选同一系统中的一段。</div>
              {systems.map((system) => {
                const list = satellites.filter((s) => s[0] === system);
                const gone = list.filter((s) => off.has(s));
                return (
                  <div key={system} className="satellite-system" data-system={system}>
                    <div className="satellite-system-head">
                      <strong>{systemNames[system] ?? system}</strong>
                      <span className="chart-note">
                        参与 {list.length - gone.length} / {list.length}
                      </span>
                      <Button size="small" type="link" onClick={() => onChange(setExcluded(excluded, list, true))}>
                        全部剔除
                      </Button>
                      <Button size="small" type="link" onClick={() => onChange(setExcluded(excluded, list, false))}>
                        全部恢复
                      </Button>
                      <Button size="small" type="link" onClick={() => onChange(invertExcluded(excluded, list))}>
                        反选
                      </Button>
                      {[
                        ...(satelliteGroups[system] ?? []).map((g) => ({
                          key: g.key,
                          label: g.label,
                          hint: g.hint,
                          members: groupSatellites(system, g, satellites),
                        })),
                        ...classGroups(system, classes, satellites).map((g) => ({
                          ...g,
                          hint: '按轨道形状判定（半长轴和轨道倾角）',
                        })),
                      ].map((group) => {
                        const { members } = group;
                        if (!members.length) return null;
                        const all = members.every((s) => off.has(s));
                        return (
                          <Tooltip
                            key={group.key}
                            title={`${group.hint}：${members.length} 颗，点击${all ? '恢复' : '剔除'}`}
                          >
                            <Button
                              size="small"
                              type={all ? 'primary' : 'default'}
                              danger={all}
                              aria-label={`${all ? '恢复' : '剔除'}${group.label}`}
                              onClick={() => onChange(toggleExcluded(excluded, members))}
                            >
                              {group.label}
                            </Button>
                          </Tooltip>
                        );
                      })}
                    </div>
                    <div className="satellite-chips">
                      {list.map((sat) => (
                        <button
                          key={sat}
                          type="button"
                          aria-pressed={!off.has(sat)}
                          title={flagged.includes(sat) ? `${sat}（被标为异常）` : sat}
                          className={`satellite-chip${off.has(sat) ? ' off' : ''}${flagged.includes(sat) ? ' flagged' : ''}`}
                          onClick={(e) => click(sat, e.shiftKey, list)}
                        >
                          {sat}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ),
        },
      ]}
    />
  );
}
