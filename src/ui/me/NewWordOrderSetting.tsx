import { SegmentedControl } from '../components/SegmentedControl'
import { SettingRow } from '../components/SettingRow'
import {
  NEW_WORD_ORDER_HINT,
  NEW_WORD_ORDER_OPTIONS,
  type NewWordOrder,
} from '../../app/hooks/newWordOrder'

export interface NewWordOrderSettingProps {
  value: NewWordOrder
  onChange: (value: NewWordOrder) => void
}

/**
 * 设置页「新词顺序」行（task-48）：词库顺序 / 随机乱序 二选一。
 * 当天计划不重排；改学习量保持同一随机序列。
 */
export function NewWordOrderSetting({ value, onChange }: NewWordOrderSettingProps) {
  return (
    <SettingRow
      label="新词顺序"
      hint={NEW_WORD_ORDER_HINT}
      control={
        <SegmentedControl<NewWordOrder>
          ariaLabel="新词顺序"
          value={value}
          onChange={onChange}
          options={NEW_WORD_ORDER_OPTIONS}
        />
      }
    />
  )
}
