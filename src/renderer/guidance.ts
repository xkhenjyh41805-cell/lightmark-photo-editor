// 阶段 3 引导相关的类型与常量

export type StepId = 'basic' | 'tone' | 'color' | 'detail' | 'wb'

export interface StepDef {
  id: StepId
  label: string        // 导航栏显示名
  groupTitle: string   // 对应调整面板里的分组标题
  hint: string         // 这一步在做什么
}

// 步骤顺序（导航栏从左到右）
export const STEPS: StepDef[] = [
  { id: 'basic', label: '基础校正', groupTitle: '基础校正', hint: '先定整体明暗' },
  { id: 'tone', label: '影调', groupTitle: '影调', hint: '分区域调亮度' },
  { id: 'wb', label: '白平衡', groupTitle: '白平衡', hint: '调冷暖' },
  { id: 'color', label: '色彩', groupTitle: '色彩', hint: '调浓淡' },
  { id: 'detail', label: '细节', groupTitle: '细节', hint: '清与糊' },
]

// 新手/专业模式。专业模式额外露出更多滑块（目前定义：专业才显示"白色/黑色"等）。
export type Mastery = 'novice' | 'pro'
