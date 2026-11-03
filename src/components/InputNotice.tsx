import { Alert } from 'antd';
import { problem, without, type Inputs } from '../services/compare-inputs';

/**
 * Says right above the product boxes what will be compared and what will not: the orbit / clock comparison needs SP3
 * files on both sides, the bias comparison BIA files. A part that cannot run is named with its reason, and the other
 * part runs regardless; a greyed button with no word about it looks like a bug.
 */
export function InputNotice({ inputs }: { inputs: Inputs }) {
  const orbit = problem(inputs, 'sp3');
  const bias = problem(inputs, 'bia');
  const lines: string[] = [];
  if (orbit && bias) lines.push(`${orbit}；${bias}`);
  else if (orbit) lines.push(`轨道和钟差不比较：${orbit}`);
  else if (bias) lines.push(`偏差不比较：${bias}`);
  const noOrbit = orbit ? [] : without(inputs, 'sp3');
  const noBias = bias ? [] : without(inputs, 'bia');
  if (noOrbit.length) lines.push(`${noOrbit.join('、')} 没有 SP3 轨道文件，轨道和钟差不比较它`);
  if (noBias.length) lines.push(`${noBias.join('、')} 没有 BIA 偏差文件，偏差不比较它`);
  if (!lines.length) return null;
  return (
    <div data-testid="input-note" style={{ marginBottom: 12 }}>
      <Alert
        type={orbit && bias ? 'warning' : 'info'}
        showIcon
        message={orbit && bias ? '暂时不能对比' : '能比的部分会照常对比'}
        description={
          <ul className="product-hints">
            {lines.map((line) => (
              <li key={line}>{line}。</li>
            ))}
          </ul>
        }
      />
    </div>
  );
}

/** Products that could not be compared, each with its reason; the others are shown regardless. */
export function ComparisonFailures({ failures }: { failures: { section: string; name: string; error: string }[] }) {
  if (!failures.length) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      message={`有 ${failures.length} 项没能对比`}
      description={
        <ul className="product-hints">
          {failures.map((f) => (
            <li key={`${f.section}-${f.name}`}>
              {f.section}：{f.name}：{f.error}
            </li>
          ))}
        </ul>
      }
    />
  );
}
