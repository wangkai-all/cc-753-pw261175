import { useState } from 'react'
import { Card } from './ui'
import { useWorkbench } from '../state'
import type { FitSnapshot } from '../lib/types'
import { formatLambda, formatNumber } from '../lib/chart'

type Tab = 'data' | 'algorithm' | 'explain'

/**
 * Data and algorithm notes. Everything here is static text plus a live read of
 * the current design summary — no truth values are surfaced outside the audit
 * panel.
 */
export function ExplainCard() {
  const [tab, setTab] = useState<Tab>('data')
  const wb = useWorkbench()
  return (
    <Card title="数据与算法说明">
      <div className="tabs" role="tablist" aria-label="说明主题">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'data'}
          onClick={() => setTab('data')}
        >
          数据构成
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'algorithm'}
          onClick={() => setTab('algorithm')}
        >
          求解算法
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'explain'}
          onClick={() => setTab('explain')}
        >
          如何读结果
        </button>
      </div>
      <div className="tab-panel">
        {tab === 'data' && <DataTab />}
        {tab === 'algorithm' && <AlgorithmTab />}
        {tab === 'explain' && <ExplainTab snapshot={wb.snapshot} />}
      </div>
    </Card>
  )
}

function DataTab() {
  const wb = useWorkbench()
  const d = wb.dataset
  return (
    <div className="help-grid">
      <div>
        <h4>样品光谱</h4>
        <p>
          每条样品谱 = Σ 真值比例 × 对应组分谱 + 平滑基线漂移 + 异方差噪声 + 局部坏点
          {d.contaminant ? ' + 未建模污染' : ''}。所有数据均为<strong>虚构合成</strong>，不依赖任何外部仪器。
        </p>
        <ul>
          <li>波长 {d.wavelength[0]}–{d.wavelength[d.wavelength.length - 1]} nm，步长 1 nm，共 {d.wavelength.length} 点。</li>
          <li>有效区 {d.validRange[0]}–{d.validRange[1]} nm；两端作为无效边带默认不参与拟合。</li>
          <li>噪声随波长变化（异方差），每个样品含 3 次重复测量，仅用于估计噪声水平。</li>
        </ul>
      </div>
      <div>
        <h4>参考谱与库版本</h4>
        <ul>
          {d.libraries.map((lib) => (
            <li key={lib.id}>
              <strong>{lib.label}</strong>：{lib.references.map((r) => r.short).join('、')}。{lib.note}
            </li>
          ))}
        </ul>
        {d.contaminant && (
          <li>
            污染参考 <strong>{d.contaminant.name}</strong>（{d.contaminant.note}）<em>不在</em>任何参考库中，
            拟合时不可用，只能体现在残差里。
          </li>
        )}
      </div>
      <div>
        <h4>真值的使用边界</h4>
        <p>
          混合比例真值、基线真值与污染幅度<strong>只在“恢复误差核对”面板中读取</strong>。解算器、可辨识性判定和正则选参都
          不接触真值，只在选参时使用标定样的已知比例（这属于独立的标定数据，不是被解算样品的真值）。
        </p>
      </div>
    </div>
  )
}

function AlgorithmTab() {
  return (
    <div className="help-grid">
      <div>
        <h4>1. 非负 + 受限基线联合估计</h4>
        <p>在有效波长上最小化</p>
        <div className="equation">‖√W (y − Xc − Bβ)‖² + λb‖β‖²（+ λ₁ Σ c_j）</div>
        <ul>
          <li>c ≥ 0：组分含量非负，从根上排除“直接求逆得负浓度”。</li>
          <li>|β_a| ≤ 上限：基线为低阶多项式（切比雪夫基），系数被箱式约束。</li>
          <li>W：每通道噪声方差的倒数（噪声加权）或单位阵（等权）。</li>
        </ul>
      </div>
      <div>
        <h4>2. 可辨识性判定</h4>
        <ul>
          <li>先把每个参考谱对基线基函数做加权投影，取残差（扣除可被漂移解释的部分）。</li>
          <li>计算残差间加权相关系数 r 与子矩阵条件数 κ。</li>
          <li>|r| ≥ 0.995 或 κ ≥ 20 的组分用并查集合并成一组，只估计合计。</li>
          <li>换库、增删候选后即时重算；旧结果按当时的库版本归档保留。</li>
        </ul>
      </div>
      <div>
        <h4>3. 合并组的参数化</h4>
        <p>
          合并组用<strong>成员谱的均值</strong>作为一列，因此拟合系数直接就是该组<strong>合计</strong>。各成员单独数值不可辨识，
          结果区只显示合计，成员标记为“只能合计”，不给小数位也不给区间。
        </p>
      </div>
      <div>
        <h4>4. 正则参数从独立标定样挑选</h4>
        <p>
          λb、λ₁ 在多个标定样上扫描，按“已知比例的组分误差”或“留出样品预测残差”挑最优；λ₁ 在 2% 近优带内取更稀疏者。
          λ 都按相对尺度定义，与是否噪声加权无关。
        </p>
      </div>
      <div>
        <h4>5. 屏蔽区与区间作废</h4>
        <p>
          屏蔽峰的波长不进入设计矩阵，拟合照常进行。但一旦某组分的主峰被屏蔽或保留能量不足 45%，它原有的不确定范围
          立即作废，面板显示“峰区被屏蔽，区间作废”，不会把旧区间挪用到新设置上。
        </p>
      </div>
      <div>
        <h4>6. 不能解释的信号</h4>
        <p>
          连续超过 3.2σ 的残差区间会被列为“未解释区间”，并标注“不能解释”。它们来自参考库外的污染、
          未建模组分或未被模型覆盖的结构，不会被强行分摊给任何组分。
        </p>
        <p>
          局部坏点是另一类：单通道尖峰。判定看残差是否偏离两侧隔两个通道的连线（d = r[i] − (r[i−2]+r[i+2])/2）：
          平滑的污染线即使处在陡峭边缘，四个通道内的变化也很小，d 接近 0；真正的尖峰则不会。
          要求 |d| &gt; 5σ_d（σ_d = √1.5·σ_i）且超过 3 倍噪声 RMS，相邻两纳米内的命中合并为最强通道。
          因此一条宽污染线只形成未解释区间，而落在其肩部的尖峰仍能被单独指出。
        </p>
      </div>
    </div>
  )
}

function ExplainTab({ snapshot }: { snapshot: FitSnapshot | null }) {
  const wb = useWorkbench()
  return (
    <div className="help-grid">
      <div>
        <h4>数值的含义</h4>
        <ul>
          <li>含量为参考谱归一化后的相对强度（参考谱峰值为 1），不是绝对浓度。</li>
          <li>± 数值是 95% 区间，只在组分可单独辨识、主峰未被屏蔽且未被基线吸收时给出。</li>
          <li>合并组只给合计值；成员之间的比例在数学上不可知。</li>
          <li>“未检出”表示非负约束把该组分压到 0，不代表严格为零。</li>
        </ul>
      </div>
      <div>
        <h4>相信什么、怀疑什么</h4>
        <ul>
          <li>残差/噪声 ≈ 1：模型充分。远大于 1：有模型外信号，组分数值可能被污染带偏。</li>
          <li>条件数 κ 大或存在合并组：单个组分的区间会很宽，此时合计更可靠。</li>
          <li>屏蔽峰区后区间消失是预期行为：弱肩部无法支撑原来的精度。</li>
        </ul>
      </div>
      <div>
        <h4>当前设置快照</h4>
        {snapshot ? (
          <ul>
            <li>
              样品 {snapshot.sampleName} · 参考库 {snapshot.libraryLabel}
            </li>
            <li>
              模式 {snapshot.mode === 'sparse' ? '稀疏 L1' : '噪声加权'}，加权 {snapshot.weighting === 'noise' ? '按噪声' : '等权'}
            </li>
            <li>
              基线 {snapshot.baselineDegree} 阶，系数上限 ±{snapshot.baselineBound.toFixed(2)}
            </li>
            <li>
              λb {formatLambda(snapshot.lambdaBase)}，λ₁ {formatLambda(snapshot.lambdaL1)}
            </li>
            <li>条件数 {formatNumber(snapshot.condition, 1)}，R² {formatNumber(1 - snapshot.ssResidual / Math.max(snapshot.ssTotal, 1e-20), 5)}</li>
          </ul>
        ) : (
          <p>解算后可在此查看当前结果的设置摘要。</p>
        )}
        <p className="card-note" style={{ marginTop: 8 }}>
          当前数据：{wb.dataset.title}
        </p>
      </div>
    </div>
  )
}
